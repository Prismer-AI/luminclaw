# Dual-Loop Agent Architecture — Research, Design, and Audit

**Status:** Research complete, design draft, audit findings
**Date:** 2026-04-13
**Scope:** Validate and redesign luminclaw's dual-loop based on Claude Code reference architecture

---

## 0. Motivation

Luminclaw has a dual-loop agent (Phase 4). Structural tests pass. But the **value claims** — async decoupling of dialogue/execution, mid-flight steering, proactive messaging, disconnect resilience — are **not validated**. We have plumbing, not proven capability.

We had no mature reference architecture. This document fills that gap by studying Claude Code (CC) at `ref/CC-Source/src/` (an agent with Devin-like proactive long-running task handling), distilling the architectural patterns it uses, auditing our current implementation against them, and proposing a target design.

---

## 1. Claude Code — Essential Architectural Patterns

Seven patterns together produce the dual-loop experience. Take them as a set — removing any one breaks the model.

### Pattern 1: Process-global Message Queue (the central pivot)

**File:** `src/utils/messageQueueManager.ts`, consumed in `src/query.ts:1570-1643`

A process-scoped FIFO queue of user commands/notifications sits between the dialogue loop and the execution loop. New user input does not interrupt; it is **enqueued**. The execution loop polls the queue at natural iteration boundaries and injects queued items as `attachment` messages into the next LLM turn.

```typescript
// Simplified: dialogue enqueues
enqueueCommand({ mode: 'prompt', content: userText, priority: 'next' });

// Execution loop polls at boundary
const queuedCommandsSnapshot = getCommandsByMaxPriority('next');
// Convert queued → attachment messages → yield to next turn
for await (const attachment of getAttachmentMessages(..., queuedCommandsSnapshot, ...)) {
  yield attachment;
  toolResults.push(attachment);
}
removeFromQueue(consumedCommands);
```

**Why it matters:** User input never racing with execution. The execution loop stays in-context; it simply sees "user said X" as its next attachment. The model decides whether to steer or ignore. No synchronization primitives. No callback machinery. The queue IS the contract.

### Pattern 2: Tasks as Cross-Turn First-Class State

**Files:** `src/Task.ts:44-57`, `src/utils/task/framework.ts:48-117`, `src/state/AppStateStore.ts:158-167`

Tasks live in a global `AppState.tasks: Record<taskId, TaskState>` map, **not scoped to the current turn**. A task outlives the query turn that spawned it. Six specialized types (`LocalAgent`, `RemoteAgent`, `LocalShell`, `InProcessTeammate`, `Dream`, `LocalMainSession`) share a common `TaskStateBase`:

```typescript
type TaskStateBase = {
  id: string           // typed prefix: 'a'/'r'/'b'
  type: TaskType
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  startTime: number
  endTime?: number
  outputFile: string   // disk-backed log
  outputOffset: number // polling cursor
  notified: boolean    // atomic anti-double-notify guard
}
```

**Why it matters:** Tasks are not events, they're **entities**. They have files on disk. They have terminal states. They can be enumerated, resumed, killed, retained for UI display. "A task" is a thing you can point at, not an event you have to catch.

### Pattern 3: Polling Loop (not callbacks)

**File:** `src/utils/task/framework.ts:255-269`, `POLL_INTERVAL_MS = 1000`

A separate 1-second polling loop runs in the UI render cycle, independent of query execution:
- Reads task output file deltas via `outputOffset` cursor
- Detects terminal transitions
- Enqueues completion notifications (which the execution loop picks up via the message queue — Pattern 1)
- Evicts terminal+notified tasks after grace period (30s for foregrounded tasks)

**Why it matters:** Explicit decoupling. The task subprocess/generator doesn't need to know about the dialogue. Output flows to disk, polling reads it. If the process crashes or the network drops, next poll picks up where it left off. **No event loss.**

### Pattern 4: Disk-backed Output + Metadata Enables Resume

**File structure:**
```
~/.cc/sessions/{sessionId}/
├── tasks/{taskId}.txt                  # streaming output
├── agents/{agentId}.jsonl               # per-message transcript
├── agents/{agentId}.meta.json           # agent metadata for --resume
└── remote-agents/remote-agent-{id}.meta.json  # CCR session binding
```

On `--resume`, the CLI enumerates metadata files, re-registers tasks in AppState, and resumes polling. Local agents restore full transcript from JSONL. Remote agents reconnect to CCR sessions by `sessionId`.

**Why it matters:** The state machine IS the disk. An in-memory task registry is a cache. This buys resilience to crashes, reconnects, and multi-session continuity — for free, without a database.

### Pattern 5: Event Emission, Not Lifecycle Hooks

**File:** `src/utils/sdkEventQueue.ts:6-134`

Task lifecycle emits SDK events (`task_started`, `task_progress`, `task_terminated`, `session_state_changed`) into a queue. Consumers subscribe; there are no registered callbacks on tasks themselves. The `notified` flag on task state is atomic — set via `setAppState` with check-and-set to prevent double-emission.

```typescript
// Atomic guard against double-notify
let suppressed = false;
setAppState(prev => {
  if (!prevTask || prevTask.notified) return prev;  // already done
  suppressed = true;
  return { ...prev, tasks: { ...prev.tasks, [taskId]: { ...prevTask, notified: true } } };
});
if (suppressed) {
  emitTaskTerminatedSdk(taskId, 'stopped', { ... });
}
```

**Why it matters:** Loose coupling. New SDK consumers (TUI, API, recording, monitoring) subscribe to the event stream without changing task code. The atomic flag is the critical invariant — tasks absolutely cannot notify twice, even under racing update paths.

### Pattern 6: Abort as Structured Signal + Synthetic Results

**File:** `src/services/tools/StreamingToolExecutor.ts:210-291`

Cancellation propagates through `AbortController.signal` with structured reasons:
- `'user_interrupted'` — new user prompt arrived
- `'sibling_error'` — concurrent tool failed
- `'streaming_fallback'` — stream parse error

When an abort is detected at a tool boundary, the executor **generates synthetic `tool_result` blocks** so the message history stays well-formed. The model sees "tool X was aborted because Y" rather than a hanging orphan.

**Why it matters:** Aborts don't produce broken message history. The LLM can reason about cancellations as first-class events. Recovery paths (continue after partial abort) are natural.

### Pattern 7: Permission Mode + requiresUserInteraction

**Files:** `src/types/permissions.ts:16-38`, `src/Tool.ts:435, 500-503`

`PermissionMode` is a core state in `toolPermissionContext.mode`: `'default' | 'plan' | 'auto' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'bubble'`. Tools gate visibility and behavior by mode. Every tool declares:

```typescript
interface Tool {
  requiresUserInteraction(): boolean;
  checkPermissions(input): Promise<PermissionResult>;
  // PermissionResult: { behavior: 'allow' | 'ask' | 'deny', ... }
}
```

Plan mode transitions store `prePlanMode` and strip dangerous permission rules, restored on exit. In headless/channel contexts (Discord/Telegram), tools with `requiresUserInteraction() === true` are automatically hidden.

**Why it matters:** The distinction between "agent can do this now" and "agent needs user present" is a first-class property of every tool. This naturally disables tools in proactive/background contexts while keeping the same codebase.

---

## 2. Audit — luminclaw vs. the 7 Patterns

| # | Pattern | luminclaw Current State | Gap |
|---|---|---|---|
| 1 | **Message queue between loops** | Absent. New user input creates a new task. Running tasks see nothing. | **Fundamental** — no way to steer in-flight work |
| 2 | **Tasks as cross-turn state** | Partial. `InMemoryTaskStore` exists. Lost on restart. No polling cursor. No output file. | Significant |
| 3 | **Polling loop for output** | Absent. Only `chat.final` fires at completion. No incremental output delivery. | Significant |
| 4 | **Disk-backed resume** | Absent. Tasks are in-memory only. `--resume` not implemented. | Significant |
| 5 | **Event emission + atomic notify** | Partial. `chat.final` via `EventBus`. No atomic notified flag — doc §13 warns of fire-and-forget result loss. | Medium |
| 6 | **Structured abort + synthetic results** | Broken. Rust cancel flag not checked (doc §4.3). TS checks at iteration boundary only, no synthetic results. | Significant |
| 7 | **Permission mode + requiresUserInteraction** | Absent. Approval gates are binary per-tool (TS only). No plan mode. No `requiresUserInteraction` concept. | Significant |

**Summary:** Pattern 1 (message queue) is the root of everything — its absence makes Patterns 3 (polling) and 5 (event emission) unusable for their intended purpose (steering, notification back into dialogue). Without Pattern 2 (persistent tasks) and Pattern 4 (disk resume), the system loses state on any disconnect. Without Pattern 6 (structured abort) tasks can't be cleanly stopped. Without Pattern 7 (permission modes) we can't safely run autonomously.

### Current implementation honestly assessed

What currently works:
- `POST /v1/chat` in dual mode returns `taskId` in < 100ms
- Inner loop runs to completion in background
- `chat.final` publishes when inner loop exits cleanly
- Task state machine transitions are validated

What the doc claims but isn't true end-to-end:
- "Validated with real LLM" — only structural validation. No test proves dialogue latency is independent of task duration.
- "Dual-loop task completion via EventBus" — fire-and-forget. If no subscriber is attached when `chat.final` fires, the result is lost forever. Documented as limitation §13 but advertised as working.
- "Cancellation" — TS checks `AbortSignal` at iteration boundaries only (cannot interrupt mid-LLM-call or mid-tool-call). Rust has a cancel flag that is never read.

---

## 3. Target Design for luminclaw

Adopt CC's patterns wholesale, adapted to our runtime (TS primary, Rust parity). The goal: a working dual-loop where the dialogue and execution genuinely decouple, the user can steer mid-flight, disconnects don't lose data, and we can cancel reliably.

### 3.1 Architecture Diagram (Target)

```
┌───────────────────────────────────────────────────────────────┐
│                        Dialogue Layer                         │
│                                                               │
│   Client (WS/HTTP) ──► Enqueue user input to MessageQueue    │
│                        Subscribe to EventBus                  │
│   Client ◄──── EventBus (task events + progress + final)     │
└───────────────────────────────────┬───────────────────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          │              MessageQueue (process-global)         │
          │  FIFO prioritized: { mode, content, targetTaskId } │
          └─────────────────────────┬─────────────────────────┘
                                    │
     ┌──────────────────────────────┴──────────────────────────────┐
     │                                                              │
     ▼                                                              ▼
┌──────────────────────────┐                   ┌────────────────────────────────┐
│   Execution Loop (N)     │                   │      Polling Loop (1s)         │
│   Inner loop per task    │                   │   - Read output deltas         │
│                          │                   │   - Detect terminal transitions│
│   while (!done) {        │                   │   - Enqueue completion notices │
│     llm.call(...)        │                   │   - Evict terminal tasks       │
│     tools.run(...)       │                   │   - Stall watchdog (45s)       │
│     pollQueue()   ◄──────┼───────────────────┤                                │
│     checkAbort() │       │                   └────────────────────────────────┘
│   }              │       │                                ▲
└──────────────────┼───────┘                                │
                   │                                        │
                   ▼                                        │
       ┌───────────────────────┐              ┌─────────────┴──────────────┐
       │  Output file + events │──────────────►  TaskStore + disk meta     │
       │  ~/.lumin/tasks/*.log │              │  ~/.lumin/sessions/...     │
       └───────────────────────┘              └────────────────────────────┘
```

### 3.2 Module Additions

| Module | Responsibility | Inspired by CC |
|--------|---------------|----------------|
| `src/messageQueue.ts` | Process-global FIFO with `mode` + `priority` | `messageQueueManager.ts` |
| `src/tasks/framework.ts` | `registerTask`, `updateTaskState<T>`, `stopTask`, `pollTasks` | `utils/task/framework.ts` |
| `src/tasks/TaskStore.ts` (evolve from InMemoryTaskStore) | Map + output cursor + eviction with grace | `AppStateStore.tasks` |
| `src/tasks/DiskPersistence.ts` | Read/write metadata JSON + output log | `utils/sessionStorage.ts` |
| `src/tasks/types.ts` | `TaskStateBase` + specialized variants (agent/shell/teammate/remote) | `Task.ts`, `tasks/*Task/types.ts` |
| `src/permissions.ts` | `PermissionMode` enum + `checkPermissions()` protocol | `types/permissions.ts`, `Tool.ts:500` |
| `src/abort.ts` | Structured abort reasons + synthetic tool result generation | `StreamingToolExecutor.ts:210-291` |

### 3.3 Data Contracts

```typescript
// messageQueue.ts
type QueuedCommand =
  | { mode: 'prompt'; content: string; uuid: string; priority: 'next' | 'later'; targetTaskId?: string }
  | { mode: 'task-notification'; content: string; uuid: string; priority: 'next' | 'later'; targetTaskId: string }
  | { mode: 'cancel'; targetTaskId: string; reason: AbortReason };

// tasks/types.ts
type TaskStateBase = {
  id: string;
  type: 'agent' | 'shell' | 'teammate';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
  sessionId: string;
  startTime: number;
  endTime?: number;
  outputFile: string;
  outputOffset: number;
  notified: boolean;
  progress?: { toolUseCount: number; tokenCount: number; lastActivity: number };
  error?: string;
};

// abort.ts
type AbortReason =
  | 'user_interrupted'      // new user prompt
  | 'user_explicit_cancel'  // /cancel command
  | 'timeout'
  | 'sibling_error'
  | 'server_shutdown';

// permissions.ts
type PermissionMode = 'default' | 'plan' | 'auto' | 'bypass';

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'ask'; message: string; suggestions?: string[] }
  | { behavior: 'deny'; message: string; reason: string };
```

### 3.4 The Critical Loop Invariant

Every inner loop iteration follows this contract:

```typescript
while (!done && !hardAbort) {
  // 1. Drain queue BEFORE next LLM call — injects user steering
  const queued = messageQueue.pollForTask(taskId);
  for (const cmd of queued) {
    if (cmd.mode === 'cancel') { abort(cmd.reason); break; }
    messages.push(asAttachment(cmd));
  }
  messageQueue.consume(queued.map(c => c.uuid));

  // 2. Check structured abort
  if (abortController.signal.aborted) {
    const reason = abortController.signal.reason;
    yield syntheticAbortResult(reason);
    break;
  }

  // 3. Call LLM (streaming, abort-aware)
  const { assistant, toolBlocks } = await llm.call(messages, abortSignal);

  // 4. Execute tools (may run concurrently if is_concurrency_safe)
  const toolResults = await executor.run(toolBlocks, abortSignal);
  messages.push(assistant, ...toolResults);

  // 5. Persist turn to disk — survives restart
  await taskStore.appendTurn(taskId, { assistant, toolResults });

  // 6. Update progress — polling loop picks this up
  taskStore.updateProgress(taskId, { toolUseCount: +toolBlocks.length, ... });

  done = toolBlocks.length === 0;
}

// Terminal transition with atomic notified guard
await taskStore.terminate(taskId, done ? 'completed' : 'killed');
```

Three invariants that must hold:
1. **Queue drain happens before LLM call**, not after. User steering takes effect next turn, not turn after next.
2. **Every turn is persisted before the next turn starts**. If the process crashes, output file + metadata are consistent.
3. **Terminal transition is atomic** (check-and-set on `notified`), emits exactly one `task_terminated` event.

---

## 4. Audit Table (Current Implementation)

| Claim in DUAL_LOOP_ARCHITECTURE.md | Reality | Target |
|---|---|---|
| "validated with real LLM" | Structural only — no dialogue-latency test, no mid-flight steering test, no disconnect recovery test | Add capability tests (see §5) |
| "Dual-loop: outer returns, inner runs, `chat.final` publishes" | True only if client stays connected. No persistence. | Add disk persistence (Pattern 4) + `GET /v1/tasks/:id` polling |
| "Cancellation: AbortSignal triggers at iteration boundary" (TS) | True but insufficient — can't interrupt mid-LLM-call | Pass `abortSignal` to LLM fetch + tool execution; implement Pattern 6 |
| "Rust: `cancelled` Mutex flag" | **Flag is never read inside inner loop** (doc §4.3 admits this) | Port Pattern 6 structured abort to Rust |
| "Multi-turn: session persists user input" | True in single-loop. Dual-loop: new `/v1/chat` creates new task with no queue delivery | Replace "new message → new task" with "new message → enqueue to existing task" (Pattern 1) |
| "Task state machine: pending → planning → executing → paused → ..." | State machine exists. `paused` never reached. `planning` hard-coded to skip to `executing`. | Either wire `paused` (clarification gates) or remove `planning`/`paused` from doc |
| "WorldModel for handoff context" | Created fresh per task, discarded on completion (doc §13) — zero cross-task continuity | Write `knowledgeBase` facts to MemoryStore on task end |
| "In-memory stores" | Unbounded growth on long-running server (doc §13) | Add TTL-based eviction (Pattern 2 grace period) |
| "Rust approval gates" | "TS only" (doc §10) — **security gap: Rust dual-loop runs tools without confirmation** | Port Pattern 7 permission mode to Rust before promoting Rust dual-loop for production |

---

## 5. Capability Tests — What "Validated" Must Mean

Before claiming dual-loop works, these end-to-end tests must pass. Each targets a specific value claim.

### C1. Dialogue-Execution Clock Decoupling

**Setup:** Start a long-running task (instruct agent to bash-sleep 60s then report).
**Action:** Every 5s, send an unrelated user message (e.g., "hello?").
**Assertion:** Response latency for the conversational message is ≤ 3s (just an LLM turn), independent of task duration. The long task continues running.

Currently: **cannot pass** — new messages start new tasks, the sleeping task is invisible.

### C2. Mid-Flight Steering

**Setup:** Agent starts a task "summarize all .md files in this repo".
**Action:** 5s later, user sends "actually skip node_modules and docs/".
**Assertion:** The running task sees the steering message as an attachment on its next LLM turn and adjusts.

Currently: **cannot pass** — no queue between dialogue and execution.

### C3. Disconnect Recovery

**Setup:** Client starts a task. Disconnects 2s in. Reconnects 20s later.
**Action:** Client queries `GET /v1/tasks/:id`.
**Assertion:** Returns current progress. When task terminates, client receives `chat.final` via the subsequent subscription.

Currently: **cannot pass** — no polling endpoint, no persistent event log.

### C4. Reliable Cancel

**Setup:** Agent running a multi-step task (3+ tool calls).
**Action:** Send `POST /v1/tasks/:id/cancel`.
**Assertion:** Within 5s, task transitions to `killed`, `task_terminated` event fires exactly once, synthetic tool_result blocks fill any in-flight tool calls.

Currently: **cannot pass in Rust**; TS passes only at iteration boundary, not mid-tool.

### C5. Proactive Progress

**Setup:** Agent running a 30s multi-tool task.
**Action:** Client listens on `/v1/stream`.
**Assertion:** `task_progress` events fire periodically (every 1s or after each tool) with current tool-use count, token count, and last-activity timestamp.

Currently: **not implemented** — only `chat.final` at end.

### C6. Concurrent Task Isolation

**Setup:** Three simultaneous `POST /v1/chat` (dual mode) with independent content.
**Assertion:** All three tasks complete, each `chat.final` has correct `taskId` binding, no cross-contamination of session history or tool results.

Currently: **untested** — in-memory stores with no explicit isolation verification.

### C7. Cross-Task Knowledge Continuity

**Setup:** Task 1 discovers fact F (e.g., a file path). Task 2 starts 10 min later on related query.
**Assertion:** Task 2's system prompt includes F (via MemoryStore recall).

Currently: **cannot pass** — WorldModel discarded, facts not written to MemoryStore.

---

## 6. Phased Roadmap

Each phase is independently valuable and separately validatable.

### Phase A: Message Queue + Task Polling Endpoint (highest leverage)

Unlocks tests C1, C3, C5. Without this, nothing else is useful.

- **A1.** Add `src/messageQueue.ts` — process-global FIFO with priority + dequeue-by-predicate
- **A2.** Modify inner loop (`PrismerAgent.processMessage`) to drain queue at iteration start
- **A3.** Modify outer loop (dual-loop `/v1/chat` handler): instead of "new message → new task", check if sessionId has an active task; if yes, enqueue message targeting that task
- **A4.** Add `GET /v1/tasks/:id` — returns `{ status, progress, outputTail, endTime? }`
- **A5.** Add `task_progress` event to EventBus, emitted per iteration

### Phase B: Disk Persistence + Resume

Unlocks tests C3 robustly, enables server restart without data loss.

- **B1.** Add `TaskStore.appendTurn` writing turn to `~/.lumin/sessions/{sessionId}/tasks/{taskId}.jsonl`
- **B2.** Add `TaskStore.writeMeta` / `readMeta` for `~/.lumin/sessions/{sessionId}/tasks/{taskId}.meta.json`
- **B3.** On server startup, enumerate metadata files with non-terminal status, re-register in AppState (do not auto-resume execution — mark as `interrupted` unless explicitly resumed)
- **B4.** Add `POST /v1/tasks/:id/resume` (explicit resume from last turn)

### Phase C: Structured Abort + Synthetic Results

Unlocks test C4 reliably in both runtimes.

- **C1.** Add `AbortReason` enum + `AbortController.signal.reason` propagation (TS) / `CancellationToken` with reason (Rust)
- **C2.** Pass abort signal into LLM fetch, check between streaming chunks
- **C3.** Pass abort signal into tool execution, tools may check `ctx.abortSignal`
- **C4.** On abort, generate synthetic `tool_result` block: `"[Aborted: ${reason}]"` for each in-flight tool
- **C5.** **Rust:** actually check cancelled flag in inner loop (fix documented bug)

### Phase D: Permission Mode + Plan Mode

Required before dual-loop is safe for autonomous production use.

- **D1.** Add `PermissionMode` enum + `toolPermissionContext` to session state
- **D2.** Each tool implements `requiresUserInteraction()` + `checkPermissions()`
- **D3.** In headless/dual-loop context, tools with `requiresUserInteraction: true` are automatically denied
- **D4.** Implement `EnterPlanMode` / `ExitPlanMode` as special tools that flip the mode
- **D5.** **Rust parity:** port the permission context to Rust (currently TS only)

### Phase E: Cross-Task Knowledge + Eviction

Unlocks test C7, fixes unbounded-growth bug.

- **E1.** On task completion, write `WorldModel.knowledgeBase` facts to `MemoryStore`
- **E2.** On task start, MemoryStore.recall using the new task's goal keywords, inject into system prompt
- **E3.** Add TTL-based eviction to `TaskStore` (default: 1h for terminal tasks, 30s grace for UI-held)

### Phase F: Capability Test Suite

Translate §5 C1–C7 to executable tests (real LLM required).

---

## 7. What We Are Not Copying from CC

To be explicit about scope boundaries. These CC features are **out of scope** for luminclaw (for now):

- **React/Ink TUI** — we use WebSocket + HTTP clients, not an in-process TUI
- **Bridge to remote CCR** — we have our own remote execution model (Cloud IM channel)
- **Dream task** — memory consolidation is done via MemoryStore compaction, not a background subagent
- **Mailbox pattern for teammates** — we have sub-agent `@mention`, sufficient for current scale
- **Buddy/companion notifications** — not a feature we want
- **Ultraplan / ultrareview / autofix-pr** — these are CC-specific remote task kinds

---

## 8. Honest Doc Updates (Immediate)

Before any implementation begins, fix documented lies in `docs/DUAL_LOOP_ARCHITECTURE.md`:

- Change "**Status**: Implemented (TS + Rust), validated with real LLM" → "**Status**: Structural scaffolding implemented. Capability validation pending — see `docs/superpowers/plans/2026-04-13-dual-loop-research-and-audit.md`"
- Change "dual-loop: both return quickly with task info" (sync parity P7) → explicitly note this is "immediate task_id return" not "task execution completes successfully end-to-end without client subscription"
- Add to §13 Known Limitations: "Dialogue cannot steer running tasks; new messages create independent tasks" (this is the real Pattern 1 gap)

---

## 9. Next Step

Pick ONE:

1. **Execute Phase A** — message queue + polling endpoint. 2-3 days. Unlocks C1, C3, C5 tests. Biggest single leap in actual capability.
2. **Update docs first** — 30 min. Stop the bleeding on over-claims while we design.
3. **Build C1 capability test against current code** — 1 hour. Prove the gap concretely with numbers, then prioritize Phase A with evidence.

Recommend: (2) then (3) then (1). Stop overclaiming, prove the gap, then fix the root cause.

---

## Appendix: Reference File Map

Claude Code source files to re-read when implementing each phase:

| Phase | CC Reference |
|-------|------|
| A (message queue) | `src/utils/messageQueueManager.ts`, `src/query.ts:1570-1643` |
| B (persistence) | `src/utils/sessionStorage.ts`, `src/tasks/LocalAgentTask/` resume paths |
| C (abort) | `src/services/tools/StreamingToolExecutor.ts:210-291`, `src/query.ts:1015-1051` |
| D (permissions) | `src/types/permissions.ts`, `src/Tool.ts:435,500-503`, `src/tools/EnterPlanModeTool/`, `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` |
| E (memory continuity) | `src/utils/memoryTools/*`, auto-dream memory consolidation |
