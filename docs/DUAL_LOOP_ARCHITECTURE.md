# Agent Architecture — Dual-Loop Execution Mode

## Lumin — Runtime Mode Switching: Single-Loop / Dual-Loop

> **Status**: Capability-validated against real LLM. Phase F tests C1, C3, C4, C5, C6, C7 all pass (6/6) — see [`tests/capability/dual-loop-capabilities.test.ts`](../tests/capability/dual-loop-capabilities.test.ts) and [`docs/superpowers/plans/2026-04-13-dual-loop-audit-and-roadmap.md`](./superpowers/plans/2026-04-13-dual-loop-audit-and-roadmap.md). C2 (mid-flight steering) not yet translated to an automated test. Run with `RUN_CAPABILITY_TESTS=1 npx vitest run tests/capability/`.
> **Runtimes**: TypeScript (primary), Rust (core-parity — see §10 for divergences)
> **Mode**: `LUMIN_LOOP_MODE=single` (default) | `dual`
> **Tests**: TS ~700, Rust 619, total ~1,319 + stress 16
> **Rev**: 6 — Incorporates Phase A/B/C/D/E/F/G (2026-04-15)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────┐
│       Single-Loop Mode (default)              │
│  chat.send → PrismerAgent loop → chat.final  │
│  Synchronous: caller blocked until complete   │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│       Dual-Loop Mode (LUMIN_LOOP_MODE=dual)                  │
│                                                              │
│  Outer Loop (HIL):                                           │
│    POST /v1/chat → check active task for session             │
│      ├── no active → create Task, spawn inner loop           │
│      └── active    → enqueue on MessageQueue, return queued  │
│    artifact store, task state machine (+ `interrupted`)      │
│                                                              │
│                    ┌──────────────────┐                      │
│                    │  MessageQueue    │  (per DualLoopAgent) │
│                    │  keyed by taskId │                      │
│                    └────────┬─────────┘                      │
│                             │ drained at iteration boundary  │
│                             ▼                                │
│  Inner Loop (EL): background execution                       │
│    onIterationStart: drain queue → insert user messages      │
│    PrismerAgent → tools → checkpoints                        │
│    per iteration: emit task.progress                         │
│    results via EventBus (chat.final / task.completed)        │
│                                                              │
│  Per-task context:                                           │
│    taskContexts: Map<taskId, { abortController, bus }>       │
│                                                              │
│  Disk persistence (Phase B, TS only):                        │
│    {workspaceDir}/.lumin/sessions/{sessionId}/tasks/         │
│      {taskId}.meta.json    — task metadata                   │
│      {taskId}.jsonl        — transcript (append-only)        │
│    Re-registered as `interrupted` at server startup.         │
└──────────────────────────────────────────────────────────────┘
```

Both modes conform to the same `IAgentLoop` interface. Server code (`server.ts` / `http.rs`) is mode-agnostic.

---

## 2. Implementation Status

### What's Implemented (TS + Rust)

| Component | TS | Rust | Status / Notes |
|-----------|:--:|:----:|----------------|
| `IAgentLoop` interface | ✓ | ✓ | Both conform |
| `SingleLoopAgent` → `PrismerAgent` | ✓ | ✓ | Full agent loop |
| `DualLoopAgent` with background execution | ✓ | ✓ | `tokio::spawn` / fire-and-forget |
| Task state machine (including `interrupted`) | ✓ | ✓ | 7 states in TS (adds `interrupted`, Phase B2) |
| `InMemoryTaskStore` (CRUD, active detection) | ✓ | ✓ | — |
| `InMemoryArtifactStore` (add, assign, filter) | ✓ | ✓ | — |
| `WorldModel` (handoff context, fact extraction) | ✓ | ✓ | Regex path + measurement extraction |
| `DirectiveRouter` (realtime/checkpoint/HIL routing) | ✓ | — | TS only |
| `AgentViewStack` (multi-agent UI state) | ✓ | — | TS only |
| `FallbackProvider` (retry + model chain) | ✓ | ✓ | 429/5xx retry, exponential backoff |
| Session persistence (user input in history) | ✓ | ✓ | User messages persisted |
| Memory tools (`memory_store`, `memory_recall`) | ✓ | ✓ | File-based, keyword search |
| HTTP `/v1/chat` (single + dual mode) | ✓ | ✓ | Same JSON schema (camelCase) |
| WebSocket `/v1/stream` | ✓ | ✓ | Same event protocol |
| `chat.final` emission from dual-loop | ✓ | ✓ | Background → EventBus → client |
| Approval gates (sensitive tool confirmation) | ✓ | — | TS only |
| **MessageQueue (Phase A1)** | ✓ | — | Process-global per `DualLoopAgent`, keyed by taskId |
| **`onIterationStart` callback in PrismerAgent (Phase A4)** | ✓ | — | Drains queue at iteration boundary |
| **Per-task `AbortController` (Phase A / C-review)** | ✓ | partial | Rust: iteration-boundary check only |
| **Per-iteration `task.progress` event (Phase A5)** | ✓ | — | Data: `{taskId, iteration, toolsUsed, lastActivity}` |
| **Disk persistence (JSONL + meta.json) (Phase B1)** | ✓ | — | `{workspaceDir}/.lumin/sessions/{sessionId}/tasks/` |
| **`interrupted` task status (Phase B2)** | ✓ | — | Set on non-terminal tasks at restart |
| **Server startup re-register persisted tasks (Phase B4)** | ✓ | — | `loadPersistedTasks()` in `startServer` |
| **Resume endpoint + `resumeTask` (Phase B5)** | ✓ | — | `POST /v1/tasks/:id/resume` |
| **`AbortReason` structured enum (Phase C1/C6)** | ✓ | ✓ | Wire-parity: snake_case serde |
| **Abort propagation into LLM fetch (Phase C2)** | ✓ | — | `fetch(…, { signal })` |
| **Abort-aware tool context (Phase C3)** | ✓ | — | `ToolContext.signal` |
| **Synthetic `[Aborted: <reason>]` tool_result (Phase C4)** | ✓ | — | Filled for unresolved tool_calls |
| **Termination drain of queued messages (Phase C5, Gap 3)** | ✓ | — | Emits `task.message.orphaned` |
| **`POST /v1/tasks/:id/cancel` endpoint (Phase C7)** | ✓ | — | See §4.3 |
| **`POST /v1/tasks/:id/resume` endpoint (Phase B5)** | ✓ | — | See §4.3 / B-series |
| **PermissionMode + ToolPermissionContext (Phase D1/D3)** | ✓ | — | `src/permissions.ts` |
| **`Tool.requiresUserInteraction` + `checkPermissions` (Phase D2)** | ✓ | — | Per-tool override |
| **`enter_plan_mode` / `exit_plan_mode` tools (Phase D4)** | ✓ | — | Flip mode at runtime |
| **Auto-deny in headless mode (Phase D3)** | ✓ | — | Default for dual-loop |
| **WorldModel `knowledgeBase` persisted to MemoryStore (Phase E1/E2)** | ✓ | — | On task completion |
| **TTL-based task eviction (Phase E3)** | ✓ | — | Replaces unbounded in-memory store |
| **Capability test suite C1–C7 (Phase F)** | ✓ | — | `tests/capability/dual-loop-capabilities.test.ts` |

### What's Not Yet Implemented

| Feature | Notes |
|---------|-------|
| Clarification-gate mid-iteration pause/resume | Different from Phase B resume (interrupted tasks). State machine supports `paused`, not wired. |
| Sub-agent delegation in dual-loop | TS `@mention` works in single-loop only |
| Multimodal `ContentBlock[]` in Rust | Rust uses `Option<String>`; image/file blocks downgraded |
| `thinkingLevel` control in Rust | TS only |
| Channel adapters in Rust (Telegram, CloudIM) | TS implemented, Rust stubs |
| Directive file scanning | TS only |
| ComponentSpec serialization (Level 1/2/3) | Design only |
| PEP (Prismer Extension Protocol) | Design only |

---

## 3. Core Abstractions

### 3.1 IAgentLoop Interface

```typescript
interface IAgentLoop {
  readonly mode: 'single' | 'dual';
  processMessage(input: AgentLoopInput, opts?: AgentLoopCallOpts): Promise<AgentLoopResult>;
  addArtifact(artifact: Artifact): void;
  resume(clarification: string): void;
  cancel(): void;
  shutdown(): Promise<void>;
}
```

**Behavioral contract:**
- **Single-loop**: `processMessage()` resolves when agent finishes. Result has full text.
- **Dual-loop**: `processMessage()` resolves immediately (< 100ms). Result has task ID. Actual result arrives via `chat.final` event on EventBus.

### 3.2 TaskStatus State Machine

```
pending → planning → executing → paused → executing (resume)
                  → executing → completed (terminal)
                  → executing → failed (terminal)
pending → failed (direct)
```

All transitions validated by `TaskStateMachine`. Invalid transitions throw.

> **Note**: `planning` is a reserved state for a future lightweight planning LLM call before execution dispatch. Current implementation transitions directly from `pending` to `executing`.

### 3.3 Artifact Store

```typescript
interface Artifact {
  id: string;           // UUID, auto-generated
  url: string;
  mimeType: string;     // JSON: "mimeType"
  type: ArtifactType;   // "image" | "file" | "url", JSON: "type"
  addedBy: 'user' | 'agent';
  taskId: string | null; // null = unassigned, assigned on task creation
  addedAt: number;
}
```

Unassigned artifacts are automatically assigned to new tasks in dual-loop mode.

### 3.4 WorldModel

```typescript
interface WorldModel {
  taskId: string;
  goal: string;
  completedWork: AgentCompletionRecord[];
  knowledgeBase: KnowledgeFact[];  // regex-extracted facts
  activeComponent: string;
  openFiles: string[];
  recentArtifacts: string[];
  componentSummaries: Map<string, string>;
  handoffNotes: Map<string, string>;
}
```

`buildHandoffContext(model, targetAgentId)` produces a compact string injected into the inner loop's system prompt. Budget default is 3,000 chars (~750 tokens) — sized to leave >99% of the context window for the sub-agent's actual work. Configurable via `HANDOFF_BUDGET` constant.

`extractStructuredFacts(text, agentId)` extracts file paths (`/workspace/...`) and measurements (`42 citations`, `3 figures`) via regex — zero LLM cost.

---

## 4. Execution Flow

### 4.1 Single-Loop (Default)

```
POST /v1/chat { content, sessionId }
  │
  ├── SessionStore.getOrCreate(sessionId)
  ├── session.addMessage(user input)    ← persisted for multi-turn
  ├── session.buildMessages(systemPrompt)
  │
  └── PrismerAgent.processMessage(input, session)
        │
        └── for iteration 1..maxIterations:
              ├── LLM call (streaming via EventBus)
              ├── if no tool_calls → break, return text
              └── execute tools → push results to session
                    ├── doom-loop detection (configurable, default: 3 consecutive errors)
                    ├── repetition detection (configurable, default: 5 identical calls)
                    └── tool result compaction (>140K truncated)
  │
  └── Return { status, response, toolsUsed, sessionId, iterations }
```

Doom-loop and repetition thresholds are configurable via `AgentOptions` (`doomLoopThreshold`, `repetitionThreshold`). Defaults are empirical values that balance between premature termination and runaway loops.

### 4.2 Dual-Loop (Phase A–C)

```
POST /v1/chat { content, sessionId }
  │
  ├── active = getActiveForSession(sessionId)
  │
  ├── if active exists:
  │     ├── messageQueue.enqueue(active.taskId, { content, messageId })
  │     ├── bus.publish(task.message.enqueued)
  │     └── Return: { status: "success", queued: true, taskId: active.taskId }
  │
  ├── else (create new task):
  │     ├── Assign unassigned artifacts to new task
  │     ├── Create Task (pending → executing)
  │     ├── Create WorldModel for task
  │     ├── taskContexts.set(taskId, { abortController, bus })
  │     ├── Persist initial {taskId}.meta.json + first transcript entry (Phase B)
  │     ├── bus.publish(task.created)
  │     ├── Return: { status: "success", taskId, loopMode: "dual" }
  │     │
  │     └── Background (tokio::spawn / fire-and-forget):
  │           ├── bus.publish(task.planning)
  │           ├── (optional) planning LLM call → bus.publish(task.planned)
  │           ├── Build system prompt with handoff context
  │           ├── Create fresh PrismerAgent with:
  │           │     - signal: taskContexts.get(taskId).abortController.signal
  │           │     - onIterationStart: drain messageQueue → insert user msgs
  │           │                         + bus.publish(task.progress)
  │           ├── Run inner loop:
  │           │     for each iteration:
  │           │       ├── onIterationStart() — drain queue
  │           │       ├── LLM call (signal-aware, Phase C2)
  │           │       ├── tool execution (ToolContext.signal, Phase C3)
  │           │       └── append to {taskId}.jsonl (Phase B1)
  │           ├── On success:
  │           │     ├── Complete task (→ completed)
  │           │     ├── Persist knowledgeBase → MemoryStore (Phase E1/E2)
  │           │     ├── drainQueueOnTermination(taskId, 'task_completed')
  │           │     ├── bus.publish(task.completed)
  │           │     └── bus.publish(chat.final)
  │           └── On error / abort:
  │                 ├── Fail task (→ failed, or keep `interrupted`)
  │                 ├── Fill synthetic [Aborted: <reason>] tool_result (Phase C4)
  │                 ├── drainQueueOnTermination(taskId, 'task_aborted')
  │                 └── bus.publish(error)
```

**Startup (Phase B4):**

```
startServer()
  └── sharedLoop.loadPersistedTasks()
        └── enumerate {workspaceDir}/.lumin/sessions/*/tasks/*.meta.json
              ├── terminal tasks (completed/failed/cancelled) → restored as-is
              └── non-terminal tasks → re-registered with status: interrupted
                    (requires explicit POST /v1/tasks/:id/resume to continue)
```

**Client-side integration for dual-loop:**

1. Read `taskId` + `queued` from the HTTP response.
2. Listen for `task.progress`, `task.completed`, `chat.final` on WebSocket,
   keyed by `taskId`.
3. If the WebSocket disconnects and reconnects, poll `GET /v1/tasks/:id` to
   recover task state and result.
4. Post additional user messages to the same session — the server auto-routes
   them to the active task's queue and emits `task.message.enqueued`.

### 4.3 Cancellation (Phase C)

```
Client sends POST /v1/tasks/:id/cancel { reason: "user_explicit_cancel" }
  (or chat.cancel WebSocket message, legacy path)
  │
  ├── TS (full mid-execution abort):
  │     ├── loop.cancel(taskId, reason)
  │     ├── taskContexts.get(taskId).abortController.abort(reason)
  │     ├── AbortSignal propagates into:
  │     │     - LLM fetch (Phase C2)
  │     │     - ToolContext.signal → tool implementations (Phase C3)
  │     ├── Inner loop unwinds; unresolved tool_calls get [Aborted: <reason>]
  │     │   tool_result (Phase C4)
  │     ├── drainQueueOnTermination(taskId, 'task_aborted') (Phase C5)
  │     └── Task status → cancelled (terminal); bus emits chat.cancelled
  │
  └── Rust (iteration-boundary only):
        ├── DualLoopAgent.cancel_with_reason(reason) sets Mutex<Option<AbortReason>>
        ├── Inner loop checks the flag at the top of each iteration
        │   (agent.rs:488-493) and returns Err(...) early. (Phase C6 wire-parity)
        └── In-flight LLM call + current tool execution are NOT interruptible.
```

**Mid-execution abort availability:**

| | LLM fetch | Tool execution (normal) | Tool execution (`execFileSync` bash) |
|-|:---------:|:-----------------------:|:------------------------------------:|
| TS | ✓ (AbortSignal) | ✓ (ToolContext.signal) | ✗ (synchronous, non-interruptible) |
| Rust | ✗ (boundary only) | ✗ (boundary only) | ✗ |

> **Per Gate 1 = c**: the Rust-parity policy is "wire-schema parity only" for
> abort — the structured `AbortReason` enum matches between TS and Rust via
> snake_case serde, but runtime PARA (pause / abort / resume / ack) semantics
> are TS-first and deferred to v2.0 in Rust.

---

## 5. JSON Schema (camelCase, unified across TS/Rust)

### POST /v1/chat Request

```json
{ "content": "string", "sessionId": "string?" }
```

> **Alias deprecation**: Rust currently accepts both `sessionId` (canonical) and `session_id` (legacy alias). The `session_id` alias will be removed in a future version. Clients should use `sessionId`.

### POST /v1/chat Response

**Single-loop mode:**
```json
{
  "status": "success",
  "response": "The answer is 42.",
  "thinking": "string?",
  "sessionId": "session-abc",
  "toolsUsed": ["bash", "memory_recall"],
  "iterations": 3,
  "durationMs": 4521,
  "usage": { "promptTokens": 1200, "completionTokens": 350 }
}
```

**Dual-loop mode** (same endpoint, different semantics):
```json
{
  "status": "success",
  "response": "Task a1b2c3 created and executing.",
  "sessionId": "session-abc",
  "toolsUsed": [],
  "iterations": 0,
  "durationMs": 8
}
```

Callers can distinguish modes by: `iterations === 0` and `response` contains "Task". A future version will add an explicit `taskId` field and `mode` field to the response.

### GET /health Response

```json
{
  "status": "ok",
  "version": "0.3.1",
  "runtime": "lumin",
  "loopMode": "single",
  "uptime": 42.5
}
```

### WebSocket /v1/stream Protocol

```
Server → { type: "connected", sessionId, version, runtime }
Client → { type: "chat.send", content: "..." }
Server → { type: "text.delta", delta: "..." }    (0..N)
Server → { type: "tool.start", tool, toolId }    (0..N)
Server → { type: "tool.end", tool, toolId, result }
Server → { type: "chat.final", content, thinking, toolsUsed, sessionId }

# Dual-loop additions (Phase A/B/C)
Server → { type: "task.created",  data: { taskId, sessionId, instruction } }
Server → { type: "task.planning", data: { taskId, goal } }
Server → { type: "task.planned",  data: { taskId, steps: string[] } }
Server → { type: "task.progress", data: { taskId, iteration, toolsUsed, lastActivity } }
Server → { type: "task.message.enqueued",
           data: { taskId, messageId, content } }          # content truncated to 500 chars
Server → { type: "task.message.orphaned",
           data: { taskId, messageId, content,
                   reason: "task_completed" | "task_aborted" } }
Server → { type: "task.completed",
           data: { taskId, sessionId, result?, toolsUsed? } }
```

---

## 6. Factory & Configuration

### Mode Resolution (4-level priority)

```
1. Explicit argument to createAgentLoop(mode)   — highest
2. LUMIN_LOOP_MODE environment variable
3. DB field dbLoopMode (per-container)
4. Default: 'single'                            — lowest
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LUMIN_LOOP_MODE` | `single` | `single` or `dual` |
| `OPENAI_API_KEY` | (required) | LLM provider API key |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` | LLM endpoint |
| `AGENT_DEFAULT_MODEL` | `gpt-4o` | Model ID (prefix `prismer-gateway/` stripped) |
| `WORKSPACE_DIR` | `./workspace` (TS) / `/workspace` (Rust) | Working directory |
| `MAX_CONTEXT_CHARS` | `600000` | Compaction threshold |
| `LUMIN_PORT` | `3001` | Server port |

---

## 7. Session Persistence

User input is persisted to `session.messages` **before** calling `buildMessages()`. This ensures multi-turn conversations work correctly — the LLM sees all prior user messages and assistant responses when building the next response.

```
Request 1: "Remember code FALCON99"
  → session.messages: [user("Remember..."), assistant("I'll remember...")]

Request 2: "What was the code?"
  → buildMessages(): [system, user("Remember..."), assistant("I'll remember..."), user("What was...")]
  → LLM sees full history → recalls FALCON99
```

Previously, user input was only added to the temporary `messages` array for the LLM call but not persisted to `session.messages`, causing recall failure across requests.

---

## 8. Directive System

### 8.1 Directive Types (21 total)

| Delivery | Types |
|----------|-------|
| **Realtime** (14) | SWITCH_COMPONENT, TIMELINE_EVENT, THINKING_UPDATE, OPERATION_STATUS, UPDATE_CONTENT, UPDATE_LATEX, UPDATE_CODE, UPDATE_DATA_GRID, UPDATE_GALLERY, JUPYTER_ADD_CELL, JUPYTER_CELL_OUTPUT, EXTENSION_UPDATE, AGENT_CURSOR, HUMAN_CURSOR |
| **Checkpoint** (3) | COMPILE_COMPLETE, NOTIFICATION, COMPONENT_STATE_SYNC |
| **HIL-only** (4) | TASK_UPDATE, UPDATE_TASKS, ACTION_REQUEST, REQUEST_CONFIRMATION |

### 8.2 DirectiveRouter (TS only)

Routes directives by delivery mode. Realtime → publish immediately to EventBus. Checkpoint → buffer until next checkpoint event. HIL-only → consumed by outer loop, not forwarded.

### 8.3 AgentViewStack (TS only)

Tracks component ownership across multi-agent delegation. Push on delegate, pop on completion, restore parent's active component.

---

## 9. Built-in Agents

6 agents, identical in TS and Rust:

| ID | Mode | Tools | Purpose |
|----|------|-------|---------|
| `researcher` | Primary | `null` (no filter — all registered tools available) | Orchestrate, delegate to sub-agents |
| `latex-expert` | Subagent | latex_compile, latex_project, switch_component, update_content, bash | LaTeX writing/compilation |
| `data-analyst` | Subagent | jupyter_execute, jupyter_notebook, switch_component, update_content, bash | Data analysis |
| `literature-scout` | Subagent | arxiv_search, load_pdf, context_search, switch_component, bash | Paper discovery |
| `compaction` | Hidden | `[]` (no tools) | Conversation summarization |
| `summarizer` | Hidden | `[]` (no tools) | Title generation |

`tools: null` means no tool filtering — the agent sees all tools registered in the `ToolRegistry`. `tools: [...]` restricts to the listed names via `getSpecs(allowedTools)`.

---

## 10. Cross-Runtime Parity

### Verified by Sync Parity Test (11 tests, real LLM)

Both TS and Rust servers are started, identical requests are sent, structural equivalence is verified:

| Test | Verification |
|------|-------------|
| P1 | Health endpoint: same fields, same `loopMode` |
| P2 | Chat response: same `status`, `response`, `sessionId` |
| P3 | Tool calling: both execute `bash`, report in `toolsUsed` |
| P4 | Multi-step: both handle 2+ tool iterations |
| P5 | Session: both recall context across requests |
| P6 | Memory: both `memory_store` + `memory_recall` |
| P7 | Dual-loop: both return quickly with task info (validates immediate `taskId` return only; does NOT validate end-to-end task execution with client subscription — see audit doc §1.3) |
| P8 | Dual-loop health: both report `loopMode: "dual"` |
| P9 | WebSocket: both produce `open → connected → chat.final` |
| P10 | Errors: both handle empty content gracefully |
| P11 | Concurrency: both handle 3 parallel requests |

### Rust Divergences

Rust implements **core agent loop parity** (single-loop, dual-loop, tools, sessions, memory, config, provider with fallback). Per the **TS-first / Rust-parity** policy (Gate 1 = c), advanced runtime features land TS-first and Rust tracks wire-schema parity only until v2.0.

| Capability | TS | Rust | Notes |
|------------|:--:|:----:|-------|
| `AbortReason` enum (wire format) | ✓ | ✓ | snake_case serde, parity verified |
| `POST /v1/tasks/:id/cancel` with `reason` | ✓ | partial | Rust: iteration-boundary abort only |
| Mid-execution abort into LLM fetch | ✓ | ✗ | TS: AbortSignal on `fetch` |
| Mid-execution abort into tool context | ✓ | ✗ | TS: `ToolContext.signal` |
| Synthetic `[Aborted: <reason>]` tool_result | ✓ | ✗ | Phase C4, TS only |
| `PermissionMode` + per-tool policy | ✓ | ✗ | Phase D, TS only |
| Plan-mode tools (`enter_plan_mode` / `exit_plan_mode`) | ✓ | ✗ | Phase D4 |
| Disk persistence (`.lumin/sessions/.../tasks/*`) | ✓ | ✗ | Phase B1 |
| Task resume (`POST /v1/tasks/:id/resume`) | ✓ | ✗ | Phase B5 |
| MessageQueue routing mid-task | ✓ | ✗ | Phase A |
| Termination drain / `task.message.orphaned` | ✓ | ✗ | Phase C5 |
| Approval gates (`needsApproval`, `waitForApproval`) | ✓ | — | **Security: Rust tools execute without confirmation** |
| `DirectiveRouter`, `AgentViewStack` | ✓ | — | No directive routing by delivery mode |
| `@mention` delegation, `delegate` tool | ✓ | — | Single-loop only |
| Multimodal `ContentBlock[]` in Message | ✓ | — | Rust uses `Option<String>` |
| `thinkingLevel` / `temperature` control | ✓ | — | No per-request LLM parameter tuning |
| Channel adapters (Telegram, CloudIM) | ✓ | — | Rust stubs |

> **Security warning**: Rust runtime should not be used for untrusted tool execution in dual-loop mode until approval gates are implemented. In dual-loop mode, the inner loop executes tools autonomously without human confirmation.

---

## 11. Test Coverage

See [docs/TEST_COVERAGE.md](./TEST_COVERAGE.md) for full breakdown.

| Metric | Count |
|--------|------:|
| TS unit tests | 510 |
| TS integration + sync parity | 21 |
| Rust unit tests | 483 |
| Rust integration (LLM) | 8 |
| Stress test scenarios | 16 (8 × 2 runtimes) |
| **Total** | **1,038** |

---

## 12. Future Work

### Phase Next: Functional Dual-Loop

1. **Clarification gates**: Inner loop pauses on `REQUEST_CONFIRMATION` directive, outer loop resumes with user response
2. **Dynamic artifact reassignment**: Artifacts uploaded during task execution injected into inner loop context
3. **Task result polling**: `GET /v1/tasks/:id` endpoint for clients that miss the `chat.final` event
4. **Dual-mode response field**: Add explicit `taskId` and `mode` fields to `/v1/chat` response

### Phase Later: Multi-Agent Orchestration

5. **SubAgentManager**: `spawn_agent`, `agent_status`, `await_agent` tools for primary agent
6. **Parallel sub-agents**: Primary spawns N sub-agents, awaits all in parallel
7. **File-level write locks**: Per-path async mutex for concurrent sub-agent file access
8. **Rust approval gates**: Port TS approval mechanism to Rust

### Phase Future: ComponentSpec & PEP

9. **ComponentSpec serialization**: Level 1 (brief) / Level 2 (structured) / Level 3 (full) per component
10. **PEP (Prismer Extension Protocol)**: Agent-built runtime extensions with hot reload
11. **OT/CRDT for concurrent editing**: Agent + human co-editing same document

---

## 13. Known Limitations

### Closed since Rev 5

- ~~**WorldModel is per-task, not persisted**~~ — CLOSED by Phase E1/E2. `knowledgeBase` facts are written to MemoryStore on task completion.
- ~~**In-memory stores have no eviction**~~ — CLOSED by Phase E3. TTL-based eviction lands for completed/failed/cancelled tasks.
- ~~**Dual-loop result delivery is fire-and-forget**~~ — CLOSED. `GET /v1/tasks/:id` returns status + result; reconnecting clients can poll.
- ~~**Dialogue cannot steer running tasks**~~ — CLOSED by Phase A. MessageQueue delivers dialogue-layer messages at the next iteration boundary; `POST /v1/chat` against an active session auto-routes to the existing task.

### Still open

**Rust has no PermissionMode / approval gates.** Per Gate 1 = c, runtime PARA semantics are deferred to v2.0 in Rust. Rust tools execute autonomously in dual-loop mode without human confirmation — do not use Rust runtime for untrusted tool execution.

**Rust has no disk persistence.** Phase B is TS-only. A Rust server restart loses all in-flight task state; no `interrupted` status, no resume.

**Rust cancellation is boundary-only.** `DualLoopAgent.cancel_with_reason` sets a `Mutex<Option<AbortReason>>` that the inner loop checks at the top of each iteration (agent.rs:488-493). In-flight LLM calls and synchronous tool execution continue until the current iteration yields. Per Gate 1 = c, mid-execution abort is TS-only.

**bash `execFileSync` cannot be aborted mid-execution.** Even in TS, the synchronous bash tool implementation cannot observe an `AbortSignal` once `execFileSync` has started — the process runs to completion (or kills on timeout) before the signal is checked. Flagged multiple times in review, open.

**Clarification-gate mid-iteration pause is not wired.** The task state machine has a `paused` state, but no runtime path transitions into it mid-iteration awaiting a user clarification. This is separate from Phase B resume (`interrupted` → rerun from disk); clarification pause means the inner loop halts between a tool call and its tool_result while waiting for a dialogue answer. Future work.

**`IAgentLoop.cancel(taskId?)` has a v1 simplification.** See the JSDoc on `handleCancelTask` in `src/server.ts` for the current scope — broadly, the cancel endpoint targets the specified `taskId`, but the underlying loop's per-task cancellation is still being refined and may not distinguish siblings when multiple tasks are concurrent in future multi-task-per-session scenarios.

**Sub-agent delegation is single-loop only.** `@mention` works in the single-loop agent. Dual-loop sub-agent orchestration (`spawn_agent`, `agent_status`, `await_agent`) is future work (§12).

---

## 14. Plan Mode & Permissions (Phase D)

Phase D introduces a **permission mode** system that gates sensitive tool
execution per-task. It is the TS-side foundation for PARA (pause / abort /
resume / ack) semantics.

### 14.1 `PermissionMode`

Defined in `src/permissions.ts`:

| Mode | Behavior |
|------|----------|
| `default` | Interactive: user is prompted on `requiresUserInteraction` tools |
| `plan` | Plan mode: `requiresUserInteraction` tools are auto-denied; the agent must produce a plan rather than mutate state |
| `auto` | Headless: `requiresUserInteraction` tools are auto-denied (this is dual-loop's default) |
| `bypass` | All gates disabled (dangerous; local dev only) |

Dual-loop mode defaults to `auto` so background tasks never block awaiting a user confirmation that never arrives.

### 14.2 `Tool.requiresUserInteraction` + `checkPermissions`

Every `Tool` may declare two permission hooks:

```ts
interface Tool {
  // Coarse flag — if true, this tool is auto-denied in plan/auto modes unless
  // checkPermissions overrides.
  requiresUserInteraction?: boolean;

  // Fine-grained override. Called with the current ToolPermissionContext;
  // returns allow / deny with an optional reason string injected into the
  // tool_result when denied.
  checkPermissions?(ctx: ToolPermissionContext): { allow: boolean; reason?: string };
}
```

The `ToolPermissionContext` carries the current `mode`, the `prePlanMode`
(restored on `exit_plan_mode`), tool args, and session info.

### 14.3 Plan-mode tools

Two built-in tools flip the mode at runtime:

- **`enter_plan_mode`** — saves `prePlanMode = mode`, sets `mode = 'plan'`. The
  agent is expected to use this before producing a multi-step plan so it can
  research read-only without accidentally mutating the workspace.
- **`exit_plan_mode`** — restores `mode = prePlanMode` (or `default`). Normally
  called after the agent has drafted the plan and is ready to execute.

### 14.4 Transitional note

The `PermissionMode` type currently lives in `src/permissions.ts`. Per
`ReleasePlan-1.9.0.md` item D12, it will be replaced by a re-export from
`@prismer/sandbox-runtime` once that package publishes. Consumers should import
from `@prismer/agent-core` rather than directly from `./permissions.js` so the
eventual swap is transparent.

---

## Appendix: Design Principles

**Zero regression**: Dual-loop mode is opt-in via `LUMIN_LOOP_MODE=dual`. Single-loop path is completely unchanged.

**In-process first**: Task store, artifact store, world model are all in-memory. Can be replaced with Redis/DB without changing the `IAgentLoop` interface.

**Context budget per agent**: Each sub-agent gets a fresh session with configurable handoff context (default ≤ 3K chars, ~750 tokens). Context budget is per-agent, not per-task — scales to arbitrarily complex tasks.

**Additive events**: New SSE/WS event types (`task.completed`, `chat.final`) are additive. Old clients ignore unknown types.

**camelCase JSON**: All HTTP/WS/IPC interfaces use camelCase field names. Rust structs use `#[serde(rename_all = "camelCase")]`. Legacy `session_id` alias accepted but deprecated.
