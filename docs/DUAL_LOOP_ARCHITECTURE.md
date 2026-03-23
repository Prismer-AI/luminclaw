# Agent Architecture — Dual-Loop Execution Mode

## Lumin — Runtime Mode Switching: Single-Loop / Dual-Loop

> **Status**: Implemented (TS + Rust), validated with real LLM
> **Runtimes**: TypeScript (primary), Rust (feature-parity)
> **Mode**: `LUMIN_LOOP_MODE=single` (default) | `dual`
> **Tests**: TS 521, Rust 491, Sync Parity 11, Stress 8×2
> **Rev**: 4 — Updated to reflect implemented state (2026-03-23)

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

### What's Not Yet Implemented

| Feature | Notes |
|---------|-------|
| Mid-execution pause/resume (clarification gates) | Architecture exists, not functional |
| WorldModel persistence across tasks | Fresh per task, discarded on completion |
| Sub-agent delegation (`spawn_agent`, `@mention`) | TS has `@mention` in single-loop only |
| Approval gates (sensitive tool confirmation) | TS only, not in Rust |
| Cancellation (`AbortSignal`) | TS has basic cancel, Rust has `cancelled` flag |
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

`buildHandoffContext(model, targetAgentId)` produces a compact ≤ 3,000 char string injected into the inner loop's system prompt.

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
                    ├── doom-loop detection (3 consecutive errors)
                    ├── repetition detection (5 identical calls)
                    └── tool result compaction (>140K truncated)
  │
  └── Return { status, response, toolsUsed, sessionId, iterations }
```

### 4.2 Dual-Loop

```
POST /v1/chat { content, sessionId }
  │
  ├── Assign unassigned artifacts to new task
  ├── Create Task (status: pending → executing)
  ├── Create WorldModel for task
  ├── Publish agent.start event
  │
  ├── Return immediately: "Task {id} created and executing."
  │
  └── Background (tokio::spawn / fire-and-forget):
        ├── Build system prompt with handoff context
        ├── Create fresh PrismerAgent
        ├── Run inner loop (same as single-loop agent)
        ├── On success:
        │     ├── Complete task (status → completed)
        │     ├── Publish task.completed event
        │     └── Publish chat.final event (content, toolsUsed)
        └── On error:
              ├── Fail task (status → failed)
              └── Publish error event
```

---

## 5. JSON Schema (camelCase, unified across TS/Rust)

### POST /v1/chat Request

```json
{ "content": "string", "sessionId": "string?" }
```

Rust accepts both `sessionId` and `session_id` (alias).

### POST /v1/chat Response

```json
{
  "status": "success",
  "response": "string",
  "thinking": "string?",
  "sessionId": "string",
  "toolsUsed": ["bash", "memory_recall"],
  "iterations": 3,
  "durationMs": 4521,
  "usage": { "promptTokens": 1200, "completionTokens": 350 }
}
```

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

**Key design decision** (fixed during implementation):

User input is persisted to `session.messages` **before** calling `buildMessages()`. This ensures multi-turn conversations work correctly — the LLM sees all prior user messages and assistant responses when building the next response.

```
Request 1: "Remember code FALCON99"
  → session.messages: [user("Remember..."), assistant("I'll remember...")]

Request 2: "What was the code?"
  → buildMessages(): [system, user("Remember..."), assistant("I'll remember..."), user("What was...")]
  → LLM sees full history → recalls FALCON99
```

Previously, user input was only added to the temporary `messages` array for the LLM call but not persisted to `session.messages`, causing recall failure.

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
| `researcher` | Primary | all | Orchestrate, delegate to sub-agents |
| `latex-expert` | Subagent | latex_compile, latex_project, switch_component, update_content, bash | LaTeX writing/compilation |
| `data-analyst` | Subagent | jupyter_execute, jupyter_notebook, switch_component, update_content, bash | Data analysis |
| `literature-scout` | Subagent | arxiv_search, load_pdf, context_search, switch_component, bash | Paper discovery |
| `compaction` | Hidden | — | Conversation summarization |
| `summarizer` | Hidden | — | Title generation |

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

### Known Divergences (Rust not yet implemented)

- No `DirectiveRouter` or `AgentViewStack` (TS only)
- No approval gates or `@mention` delegation
- No multimodal content (`ContentBlock[]`)
- No `thinkingLevel` / `temperature` in ChatRequest
- No channel adapters (Telegram, CloudIM)
- Config has fewer sections (no `approval`, `session`, `server`, `memory` sub-configs)

---

## 11. Test Coverage

See [docs/TEST_COVERAGE.md](./TEST_COVERAGE.md) for full breakdown.

| Metric | Value |
|--------|-------|
| TS unit tests | 510 |
| TS integration (LLM) | 10 |
| TS sync parity | 11 |
| Rust unit tests | 483 |
| Rust integration (LLM) | 8 |
| Stress test scenarios | 8 × 2 runtimes |
| **Total** | **1,030** |

---

## 12. Future Work

### Phase Next: Functional Dual-Loop

1. **Clarification gates**: Inner loop pauses on `REQUEST_CONFIRMATION` directive, outer loop resumes with user response
2. **WorldModel persistence**: Write facts to MemoryStore on task completion, reload on task start
3. **Dynamic artifact reassignment**: Artifacts uploaded during task execution injected into inner loop context

### Phase Later: Multi-Agent Orchestration

4. **SubAgentManager**: `spawn_agent`, `agent_status`, `await_agent` tools for primary agent
5. **Parallel sub-agents**: Primary spawns N sub-agents, awaits all in parallel
6. **File-level write locks**: Per-path async mutex for concurrent sub-agent file access

### Phase Future: ComponentSpec & PEP

7. **ComponentSpec serialization**: Level 1 (brief) / Level 2 (structured) / Level 3 (full) per component
8. **PEP (Prismer Extension Protocol)**: Agent-built runtime extensions with hot reload
9. **OT/CRDT for concurrent editing**: Agent + human co-editing same document

---

## Appendix: Design Principles

**Zero regression**: Dual-loop mode is opt-in via `LUMIN_LOOP_MODE=dual`. Single-loop path is completely unchanged.

**In-process first**: Task store, artifact store, world model are all in-memory. Can be replaced with Redis/DB without changing the `IAgentLoop` interface.

**Context budget per agent**: Each sub-agent gets a fresh session with ≤ 3K char handoff context. Context budget is per-agent, not per-task — scales to arbitrarily complex tasks.

**Additive events**: New SSE/WS event types (`task.completed`, `chat.final`) are additive. Old clients ignore unknown types.

**camelCase JSON**: All HTTP/WS/IPC interfaces use camelCase field names. Rust structs use `#[serde(rename_all = "camelCase")]` with snake_case aliases for backward compatibility.
