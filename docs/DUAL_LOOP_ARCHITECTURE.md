# Agent Architecture — Dual-Loop Execution Mode

## Lumin — Runtime Mode Switching: Single-Loop / Dual-Loop

> **Status**: Implemented (TS + Rust), validated with real LLM
> **Runtimes**: TypeScript (primary), Rust (core-parity — see §10 for divergences)
> **Mode**: `LUMIN_LOOP_MODE=single` (default) | `dual`
> **Tests**: TS 521, Rust 491, total 1,012 + stress 16
> **Rev**: 5 — Incorporates architecture review feedback (2026-03-23)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────┐
│       Single-Loop Mode (default)              │
│  chat.send → PrismerAgent loop → chat.final  │
│  Synchronous: caller blocked until complete   │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│       Dual-Loop Mode (LUMIN_LOOP_MODE=dual)  │
│                                              │
│  Outer Loop (HIL):                           │
│    user input → create Task → return quickly │
│    artifact store, task state machine        │
│                                              │
│  Inner Loop (EL): background execution       │
│    PrismerAgent → tools → checkpoints        │
│    results via EventBus (chat.final)         │
└──────────────────────────────────────────────┘
```

Both modes conform to the same `IAgentLoop` interface. Server code (`server.ts` / `http.rs`) is mode-agnostic.

---

## 2. Implementation Status

### What's Implemented (TS + Rust)

| Component | TS | Rust | Status |
|-----------|:--:|:----:|--------|
| `IAgentLoop` interface | ✓ | ✓ | Both conform |
| `SingleLoopAgent` → `PrismerAgent` | ✓ | ✓ | Full agent loop |
| `DualLoopAgent` with background execution | ✓ | ✓ | `tokio::spawn` / fire-and-forget |
| Task state machine (6 states, validated transitions) | ✓ | ✓ | Complete |
| `InMemoryTaskStore` (CRUD, active detection) | ✓ | ✓ | Complete |
| `InMemoryArtifactStore` (add, assign, filter) | ✓ | ✓ | Complete |
| `WorldModel` (handoff context, fact extraction) | ✓ | ✓ | Regex path + measurement extraction |
| `DirectiveRouter` (realtime/checkpoint/HIL routing) | ✓ | — | TS only |
| `AgentViewStack` (multi-agent UI state) | ✓ | — | TS only |
| `FallbackProvider` (retry + model chain) | ✓ | ✓ | 429/5xx retry, exponential backoff |
| Session persistence (user input in history) | ✓ | ✓ | Fixed: user messages persisted |
| Memory tools (`memory_store`, `memory_recall`) | ✓ | ✓ | File-based, keyword search |
| HTTP `/v1/chat` (single + dual mode) | ✓ | ✓ | Same JSON schema (camelCase) |
| WebSocket `/v1/stream` | ✓ | ✓ | Same event protocol |
| `chat.final` emission from dual-loop | ✓ | ✓ | Background → EventBus → client |
| Approval gates (sensitive tool confirmation) | ✓ | — | TS only |

### What's Not Yet Implemented

| Feature | Notes |
|---------|-------|
| Mid-execution pause/resume (clarification gates) | State machine supports it, not wired |
| Sub-agent delegation (`spawn_agent`, `@mention`) | TS has `@mention` in single-loop only |
| Cancellation (`AbortSignal`) | TS has basic cancel, Rust has `cancelled` flag — see §4.3 |
| Multimodal content (`ContentBlock[]`) | TS only, Rust uses `Option<String>` |
| Thinking level control (`thinkingLevel`) | TS only |
| Channel adapters (Telegram, CloudIM) | TS implemented, Rust stubs |
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

### 4.2 Dual-Loop

```
POST /v1/chat { content, sessionId }
  │
  ├── Assign unassigned artifacts to new task
  ├── Create Task (status: pending → executing)
  ├── Create WorldModel for task
  ├── Publish agent.start event
  │
  ├── Return immediately: { status: "success", response: "Task {id} created...", taskId: "{id}" }
  │
  └── Background (tokio::spawn / fire-and-forget):
        ├── Build system prompt with handoff context
        ├── Create fresh PrismerAgent
        ├── Run inner loop (same as single-loop agent)
        ├── On success:
        │     ├── Complete task (status → completed)
        │     ├── Publish task.completed event
        │     └── Publish chat.final event (content, toolsUsed, taskId)
        └── On error:
              ├── Fail task (status → failed)
              └── Publish error event
```

**Client-side integration for dual-loop:**

The caller should not rely on the HTTP response text for the task result. Instead:
1. Read `taskId` from the immediate HTTP response
2. Listen for `chat.final` or `task.completed` event on WebSocket with matching `taskId`
3. If the WebSocket disconnects and reconnects, the client should query task status via `/health` or a future `/v1/tasks/:id` endpoint

> **Known limitation**: There is currently no persistent event replay or task result polling endpoint. If the client is disconnected when `chat.final` fires, the result is lost. See §13 Known Limitations.

### 4.3 Cancellation

```
Client calls cancel() / sends chat.cancel WS message
  │
  ├── TS: AbortSignal triggers at next iteration boundary (before LLM call)
  │     → agent returns '[Cancelled]', bus emits chat.cancelled
  │
  └── Rust: cancelled Mutex flag set to true
        → DualLoopAgent.cancel() also transitions active task → failed
        → Inner loop does NOT currently check the flag mid-execution
```

> **Gap**: Rust inner loop does not poll the `cancelled` flag between iterations. A long-running Rust dual-loop task cannot be interrupted until the current LLM call + tool execution completes.

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
| P7 | Dual-loop: both return quickly with task info |
| P8 | Dual-loop health: both report `loopMode: "dual"` |
| P9 | WebSocket: both produce `open → connected → chat.final` |
| P10 | Errors: both handle empty content gracefully |
| P11 | Concurrency: both handle 3 parallel requests |

### Rust Divergences

Rust implements **core agent loop parity** (single-loop, dual-loop, tools, sessions, memory, config, provider with fallback). The following TS-only capabilities are **not** in Rust:

| Missing in Rust | Impact |
|-----------------|--------|
| `DirectiveRouter`, `AgentViewStack` | No directive routing by delivery mode |
| Approval gates (`needsApproval`, `waitForApproval`) | **Security: sensitive tools execute without confirmation** |
| `@mention` delegation, `delegate` tool | No sub-agent orchestration |
| Multimodal `ContentBlock[]` in Message | Image/file content blocks silently downgraded to empty string |
| `thinkingLevel` / `temperature` control | No per-request LLM parameter tuning |
| Channel adapters (Telegram, CloudIM) | No messaging platform integration |

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

### WorldModel is per-task, not persisted

WorldModel is created fresh for each dual-loop task and discarded on completion. Extracted knowledge facts are not written to the persistent MemoryStore. This means **cross-task knowledge continuity does not exist in dual-loop mode** — each task starts with a blank WorldModel. This directly limits the value of sequential complex task chains where earlier discoveries inform later tasks.

**Mitigation path**: Write `knowledgeBase` facts to MemoryStore on task completion; reload via keyword recall on next task start (§12 item 2 in original design).

### In-memory stores have no eviction

`InMemoryTaskStore` and `InMemoryArtifactStore` grow unbounded. A long-running server instance accumulating completed tasks will leak memory. `SessionStore` has idle-timeout cleanup (TS only), but task/artifact stores do not.

**Mitigation path**: Add TTL-based eviction for completed/failed tasks, or replace with persistent storage.

### Dual-loop result delivery is fire-and-forget

When the inner loop completes, `chat.final` is published to the EventBus. If no subscriber is listening (client disconnected), the result is lost. There is no persistent event log, no retry, and no polling endpoint for task results.

**Mitigation path**: Add `GET /v1/tasks/:id` endpoint that returns task status + result from `InMemoryTaskStore`.

### Rust cancellation is incomplete

The Rust `DualLoopAgent.cancel()` sets a `cancelled` flag and transitions the task to `failed`, but the inner loop does not check this flag between iterations. A running Rust inner loop continues until the current agent cycle naturally completes.

---

## Appendix: Design Principles

**Zero regression**: Dual-loop mode is opt-in via `LUMIN_LOOP_MODE=dual`. Single-loop path is completely unchanged.

**In-process first**: Task store, artifact store, world model are all in-memory. Can be replaced with Redis/DB without changing the `IAgentLoop` interface.

**Context budget per agent**: Each sub-agent gets a fresh session with configurable handoff context (default ≤ 3K chars, ~750 tokens). Context budget is per-agent, not per-task — scales to arbitrarily complex tasks.

**Additive events**: New SSE/WS event types (`task.completed`, `chat.final`) are additive. Old clients ignore unknown types.

**camelCase JSON**: All HTTP/WS/IPC interfaces use camelCase field names. Rust structs use `#[serde(rename_all = "camelCase")]`. Legacy `session_id` alias accepted but deprecated.
