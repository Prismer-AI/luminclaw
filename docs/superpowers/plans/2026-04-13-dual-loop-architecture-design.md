# Dual-Loop Agent Architecture — Research & Design

**Status:** Design draft (research complete, not yet implemented)
**Date:** 2026-04-13
**Reference:** Claude Code source at `ref/CC-Source/src/`
**Companion doc:** `2026-04-13-dual-loop-audit-and-roadmap.md` — current-state audit + phased improvement plan

---

## 0. Motivation

The idea behind a dual-loop agent is that **the user's dialogue cycle and the task's execution cycle operate at different clock rates** and must decouple. A user expects conversational latency (1–3 s). A complex task may take minutes. Building both on a single synchronous loop forces one to pay the cost of the other — either the user waits, or the agent can't do real work.

Devin was the first widely visible product to solve this. The experience properties we want:

1. **Dialogue never blocks on execution.** User can ask questions, clarify, steer — while a task runs.
2. **Execution can proceed without dialogue.** Long tasks continue if the user disconnects or walks away.
3. **New user input can steer in-flight execution.** The agent sees your follow-up and adjusts without a full task restart.
4. **The agent can push back proactively.** Progress updates, blockers, clarification requests flow agent → user without a user prompt.
5. **State survives disconnects.** Client crashes, network drops, server restarts — the task keeps going, the result is still retrievable.

Luminclaw's Phase-4 dual-loop gave us scaffolding (task state machine, outer/inner loops, `chat.final` events). What we did not do was derive a principled architecture from first principles or from a working reference. This document does that derivation now, using Claude Code (CC) as the reference.

The companion audit doc (`2026-04-13-dual-loop-audit-and-roadmap.md`) confronts our current implementation against this design and lays out the improvement plan.

---

## 1. Claude Code — Seven Essential Patterns

These seven patterns are a **coupled set**. Removing any one breaks the dual-loop experience. Each is presented with its CC file references and the role it plays.

### Pattern 1: Process-Global Message Queue (the central pivot)

**Files:** `src/utils/messageQueueManager.ts`, consumed in `src/query.ts:1570-1643`

A process-scoped FIFO queue of user commands sits between the dialogue loop and the execution loop. **New user input does not interrupt. It is enqueued.** The execution loop polls the queue at natural iteration boundaries and injects queued items as `attachment` messages into the next LLM turn.

```typescript
// Dialogue layer enqueues
enqueueCommand({ mode: 'prompt', content: userText, priority: 'next' });

// Execution loop polls at iteration boundary
const queuedCommandsSnapshot = getCommandsByMaxPriority('next');
for await (const attachment of getAttachmentMessages(..., queuedCommandsSnapshot, ...)) {
  yield attachment;
  toolResults.push(attachment);
}
removeFromQueue(consumedCommands);
```

**Why it matters:** User input never races with execution. The execution loop stays in-context; it simply sees "user said X" as its next attachment. The model decides whether to steer or ignore. No synchronization primitives. No callback machinery. **The queue IS the contract.**

### Pattern 2: Tasks as Cross-Turn First-Class State

**Files:** `src/Task.ts:44-57`, `src/utils/task/framework.ts:48-117`, `src/state/AppStateStore.ts:158-167`

Tasks live in a global `AppState.tasks: Record<taskId, TaskState>` map — **not scoped to the current turn.** A task outlives the query turn that spawned it. Six specialized types (`LocalAgent`, `RemoteAgent`, `LocalShell`, `InProcessTeammate`, `Dream`, `LocalMainSession`) share a common base:

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

**Why it matters:** Tasks are not events, they are **entities**. They have files on disk. They have terminal states. They can be enumerated, resumed, killed, retained for UI display. "A task" is a thing you can point at, not an event you have to catch.

### Pattern 3: Polling Loop (not callbacks)

**File:** `src/utils/task/framework.ts:255-269`, `POLL_INTERVAL_MS = 1000`

A separate 1-second polling loop runs in the UI render cycle, independent of query execution:

- Reads task output file deltas via `outputOffset` cursor
- Detects terminal transitions
- Enqueues completion notifications (which the execution loop picks up via the message queue — Pattern 1)
- Evicts terminal+notified tasks after a grace period (default 30 s for foregrounded tasks)

**Why it matters:** Explicit decoupling. The task subprocess/generator does not need to know about the dialogue. Output flows to disk, polling reads it. If the process crashes or the network drops, the next poll picks up where it left off. **No event loss by construction.**

### Pattern 4: Disk-Backed Output + Metadata Enables Resume

**File structure:**

```
~/.cc/sessions/{sessionId}/
├── tasks/{taskId}.txt                         # streaming output
├── agents/{agentId}.jsonl                      # per-message transcript
├── agents/{agentId}.meta.json                  # agent metadata for --resume
└── remote-agents/remote-agent-{id}.meta.json   # CCR session binding
```

On `--resume`, the CLI enumerates metadata files, re-registers tasks in AppState, and resumes polling. Local agents restore full transcript from JSONL. Remote agents reconnect to CCR sessions by `sessionId`.

**Why it matters:** **The state machine IS the disk.** An in-memory task registry is a cache. This buys resilience to crashes, reconnects, and multi-session continuity — without a database, without a service bus.

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

**Why it matters:** Loose coupling. New SDK consumers (TUI, API, recording, monitoring) subscribe to the event stream without changing task code. The atomic flag is the critical invariant — **tasks absolutely cannot notify twice**, even under racing update paths.

### Pattern 6: Abort as Structured Signal + Synthetic Results

**File:** `src/services/tools/StreamingToolExecutor.ts:210-291`

Cancellation propagates through `AbortController.signal` with structured reasons:

- `'user_interrupted'` — new user prompt arrived
- `'sibling_error'` — concurrent tool failed
- `'streaming_fallback'` — stream parse error

When an abort is detected at a tool boundary, the executor **generates synthetic `tool_result` blocks** so the message history stays well-formed. The model sees "tool X was aborted because Y" rather than a hanging orphan.

**Why it matters:** Aborts do not produce broken message history. The LLM can reason about cancellations as first-class events. Recovery paths (continue after partial abort) are natural.

### Pattern 7: Permission Mode + `requiresUserInteraction`

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

## 2. How the Patterns Compose

The seven patterns together produce the dual-loop experience through a specific interaction chain:

```
┌───────────────────────────────────────────────────────────────┐
│                        Dialogue Layer                          │
│                                                                │
│   Client (WS/HTTP) ──► Enqueue user input to MessageQueue     │
│                        Subscribe to EventBus                   │
│   Client ◄──── EventBus (task events + progress + final)      │
└───────────────────────────────────┬───────────────────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          │              MessageQueue (process-global)         │  ← Pattern 1
          │  FIFO prioritized: { mode, content, targetTaskId } │
          └─────────────────────────┬─────────────────────────┘
                                    │
     ┌──────────────────────────────┴──────────────────────────────┐
     │                                                              │
     ▼                                                              ▼
┌──────────────────────────┐                   ┌────────────────────────────────┐
│   Execution Loop (N)     │                   │      Polling Loop (1s)         │  ← Pattern 3
│   One per active task    │                   │   - Read output deltas         │
│                          │                   │   - Detect terminal transitions│
│   while (!done) {        │                   │   - Enqueue completion notices │
│     llm.call(...)        │                   │   - Evict terminal tasks       │
│     tools.run(...)       │                   │   - Stall watchdog (45s)       │
│     pollQueue()   ◄──────┼───────────────────┤                                │
│     checkAbort() │       │                   └────────────────────────────────┘
│   }              │                                        ▲
└──────────────────┼───────┘                                │
                   │                                        │
                   ▼                                        │
       ┌───────────────────────┐              ┌─────────────┴──────────────┐
       │  Output file + events │──────────────►  TaskStore + disk meta     │  ← Patterns 2, 4, 5
       │  ~/.lumin/tasks/*.log │              │  ~/.lumin/sessions/...     │
       └───────────────────────┘              └────────────────────────────┘

                          Abort signals propagate with reason codes       ← Pattern 6
                          Tool visibility gated by permission mode         ← Pattern 7
```

### Interaction trace — "user steers a running task"

1. Task T1 is in its inner loop, mid-LLM-call
2. User sends "also skip node_modules" to the same session
3. Dialogue layer calls `enqueueCommand({ mode: 'prompt', content, targetTaskId: T1.id })`. Returns immediately.
4. The outer loop (HTTP handler) returns `{ status: 'queued', taskId: T1.id }` to the client. Dialogue latency ~ 20 ms.
5. T1's inner loop finishes its current LLM call. Before requesting the next LLM call, it drains the queue:
   `queued = messageQueue.pollForTask(T1.id)` — returns the steering message
6. Steering message is converted to an `attachment` and appended to `messages` for the next LLM call
7. LLM sees the new instruction and adjusts its next tool calls

No locks, no race conditions, no synchronization primitives, no state-machine transitions. **Just a queue and a loop that polls it.**

### Interaction trace — "client disconnects, reconnects, retrieves result"

1. Client starts task T1, disconnects 2 s in
2. T1's inner loop continues (it does not see the disconnect)
3. Each turn, T1 appends to `~/.lumin/sessions/{sess}/tasks/{T1}.jsonl` and emits `task_progress` events to the EventBus
4. No subscribers on the EventBus; events are dropped. That's fine — state is on disk.
5. T1 terminates. `TaskStore.terminate(T1, 'completed')` atomically sets `notified=true` and emits `task_terminated`. Still no subscribers.
6. 20 s later, client reconnects. Queries `GET /v1/tasks/T1.id`.
7. Response: `{ status: 'completed', endTime, outputTail, finalContent }`. Client has the result.

**No event log replay needed.** The task entity on disk is the source of truth.

---

## 3. Target Design for luminclaw

Adopt the seven patterns wholesale, adapted to our runtime (TS primary, Rust parity).

### 3.1 Module Additions

| Module | Responsibility | CC Reference |
|--------|----------------|--------------|
| `src/messageQueue.ts` | Process-global FIFO with `mode` + `priority` + `targetTaskId` | `messageQueueManager.ts` |
| `src/tasks/framework.ts` | `registerTask`, `updateTaskState<T>`, `stopTask`, `pollTasks` | `utils/task/framework.ts` |
| `src/tasks/TaskStore.ts` (evolves from `InMemoryTaskStore`) | Map + output cursor + eviction with grace | `AppStateStore.tasks` |
| `src/tasks/DiskPersistence.ts` | Read/write metadata JSON + output log | `utils/sessionStorage.ts` |
| `src/tasks/types.ts` | `TaskStateBase` + specialized variants (agent/shell/teammate) | `Task.ts`, `tasks/*Task/types.ts` |
| `src/permissions.ts` | `PermissionMode` enum + `checkPermissions()` protocol | `types/permissions.ts`, `Tool.ts:500` |
| `src/abort.ts` | Structured abort reasons + synthetic tool result generation | `StreamingToolExecutor.ts:210-291` |

### 3.2 Data Contracts

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

### 3.3 The Critical Inner-Loop Invariant

Every inner loop iteration follows this contract. Violation of any of the three invariants below breaks the dual-loop experience.

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

**Three invariants that must hold:**

1. **Queue drain happens before the LLM call**, not after. User steering takes effect on the *next* turn, not the turn after next.
2. **Every turn is persisted before the next turn starts.** If the process crashes, output file + metadata are consistent.
3. **Terminal transition is atomic** (check-and-set on `notified`), emits exactly one `task_terminated` event.

### 3.4 HTTP/WebSocket Protocol Additions

| Endpoint / Event | Purpose | Pattern |
|------------------|---------|---------|
| `GET /v1/tasks/:id` | Poll task status + progress + output tail | 2, 3 |
| `POST /v1/tasks/:id/cancel` | Structured abort with reason | 6 |
| `POST /v1/tasks/:id/resume` | Explicit resume from last persisted turn | 4 |
| `PATCH /v1/chat` (sessionId) | Enqueue message targeting existing task (vs. creating new) | 1 |
| WS `task_progress` | Per-iteration progress, includes `toolUseCount`, `tokenCount` | 3, 5 |
| WS `task_terminated` | Terminal event, fires exactly once per task | 5 |

The existing `POST /v1/chat` keeps its current semantics. When the target session already has an active task, it enqueues to that task's queue instead of spawning a new one. This is the single biggest protocol change required.

### 3.5 Mapping to PARA v0.1 Tiers

The seven patterns are also the foundation required for luminclaw to serve as the `@prismer/adapter-luminclaw` reference adapter in **Prismer Runtime v1.9.0** (see `prismer-cloud-next/docs/ReleasePlan-1.9.0.md` §4.2, §5.3.3). The crosswalk:

| PARA Tier | Required Pattern(s) | luminclaw module producing it |
|-----------|---------------------|-------------------------------|
| L1 Discovery | — (metadata only) | `adapter-luminclaw/manifest.yaml` |
| L2 Message I/O | 1 (queue) + 2 (task entity) | `messageQueue.ts`, `TaskStore` |
| L3 Tool Call Observation | 5 (events + atomic notified) | `sdkEventQueue` equivalent |
| L4 Tool/Memory Injection | 1 (queue for injection) + 5 | `messageQueue.ts` + skill loader |
| L5 Approval Gate | 7 (PermissionMode) + 1 (remote approve flows back via queue) | `permissions.ts` + `messageQueue.ts` |
| L6 Remote Command | 1 + 2 + 6 (structured abort for cancel) | `messageQueue.ts` + `TaskStore` + `abort.ts` |
| L7 FS Delegation | 7 (delegated out-of-process) | consumed from `@prismer/sandbox-runtime` |
| L8 Session Export | 2 + 4 (disk-backed trace) | `TaskStore` + `DiskPersistence` |

**Key implication.** The pattern ordering 1 → 2/4 → 5/6/7 in this document is also the order in which PARA Tiers become honestly declarable. A luminclaw build that reports `tiersSupported: [1, 3, 7]` is internally consistent; declaring L4+ without Pattern 1 landed is the same overclaim the companion audit doc flags in §1.3.

**Design consequence.** The PARA shim (`@prismer/adapter-luminclaw`, ~300–500 LOC per v1.9.0 plan) is a translation layer *on top of* the patterns implemented here. It cannot synthesize queue semantics, atomic event emission, or a disk-resumable trace if those primitives are not present in the host runtime. **Implement the patterns first; shim second.** Any effort that tries to bridge PARA events to fire-and-forget dispatch will reproduce the race conditions enumerated in the audit doc §1.2.

---

## 4. What We Are Not Copying from CC

Out-of-scope decisions, stated explicitly:

- **React/Ink TUI** — we use WebSocket + HTTP clients, not an in-process TUI
- **Bridge to remote CCR** — we have our own remote execution model (Cloud IM channel)
- **Dream task** — memory consolidation is done via `MemoryStore` compaction, not a background subagent
- **Mailbox pattern for teammates** — we have sub-agent `@mention`, sufficient for current scale
- **Buddy/companion notifications** — not a feature we want
- **Ultraplan / ultrareview / autofix-pr** — these are CC-specific remote task kinds

---

## 5. Open Design Questions

Questions deliberately not answered in this design — surface during implementation:

1. **Queue targeting ambiguity.** When a session has an active task and the user sends a message: always enqueue to that task? Or let the user explicitly say "new task" vs "continue"? Current thought: always enqueue, but emit a soft hint if the running task is over N minutes old.

2. **Persistence format — JSONL vs SQLite.** CC uses JSONL for transcripts + small JSON metadata. Simple, append-only, easy to resume. SQLite would offer queryability but adds a dependency. Lean JSONL.

3. **Event bus replay window.** Even with disk persistence, some consumers want event-stream replay (analytics, observability). Do we keep a ring buffer of recent events in memory? Out of scope for the core design; can be added as a subscriber later.

4. **Cross-runtime parity for Permission modes.** TS has partial approval gates. Rust has nothing. Port first, or redesign first? Port first for correctness, redesign jointly in Phase D.

5. **Task type taxonomy.** CC has six task types. We likely need three initially: `agent` (primary use case), `shell` (direct bash), `teammate` (sub-agent delegation). `remote` can come later.

6. **luminclaw-rust's PARA stance.** v1.9.0 specifies `@prismer/adapter-luminclaw` as a full-Tier (L1–L8) reference. luminclaw-rust today has no equivalent of Patterns 1/2/4/6 (see audit §1.1). Three options: (a) **TS-only reference** — document luminclaw-rust as "PARA-incomplete" in v1.9.0; (b) **port patterns to Rust in-scope** — adds ≥ 10 workdays; (c) **wire-schema-only Rust parity** — defer runtime-level PARA to v2.0. Must be decided before PARA spec freeze (P0 of v1.9.0). Recommendation: (c).

---

## Appendix A: Reference File Map

| Topic | CC Files |
|-------|----------|
| Message queue | `src/utils/messageQueueManager.ts`, `src/query.ts:1570-1643` |
| Task framework | `src/utils/task/framework.ts`, `src/tasks/stopTask.ts`, `src/Task.ts` |
| Disk persistence | `src/utils/sessionStorage.ts`, resume paths in `src/tools/AgentTool/resumeAgent.ts` |
| Event emission | `src/utils/sdkEventQueue.ts` |
| Structured abort | `src/services/tools/StreamingToolExecutor.ts:210-291`, `src/query.ts:1015-1051` |
| Permission modes | `src/types/permissions.ts`, `src/Tool.ts:435,500-503` |
| Plan mode | `src/tools/EnterPlanModeTool/`, `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` |
| Proactive messaging | `src/context/notifications.tsx`, `src/Tool.ts:158-299` (ToolUseContext) |
| Multi-agent mailbox | `src/utils/teammateMailbox.ts`, `src/tools/SendMessageTool/` |

## Appendix B: Essential Glossary

- **Dialogue loop** — the code path that receives user input and sends responses. In CC: REPL + React render. In luminclaw: HTTP/WS server handlers.
- **Execution loop** — the per-task `while { llm → tools → ... }` inner loop.
- **Turn** — one iteration of the execution loop (one LLM call + its tool results).
- **Attachment** — a message appended to the next LLM call that originated from something other than a direct model output (user input, tool result, system notification).
- **Terminal state** — a task status that cannot transition further (`completed`, `failed`, `killed`).
- **Notified** — flag indicating a terminal state transition has already emitted its event. Prevents double-notify races.
- **Grace period** — interval during which a terminal task is retained in memory for UI display before eviction.
