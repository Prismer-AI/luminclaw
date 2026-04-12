# Dual-Loop Implementation — Audit & Improvement Roadmap

**Status:** Audit complete, roadmap proposed, implementation pending
**Date:** 2026-04-13
**Companion doc:** `2026-04-13-dual-loop-architecture-design.md` — research findings + target architecture
**Baseline:** `docs/DUAL_LOOP_ARCHITECTURE.md` — current implementation description (rev 5, 2026-03-23)

---

## 0. Purpose

The companion design doc derives a target architecture from Claude Code's seven essential patterns. This doc confronts that design against **what actually exists in luminclaw today**. It answers three questions:

1. How much of the claimed dual-loop capability actually works?
2. What is missing, and which missing pieces matter most?
3. What is the minimum phased path to a real dual-loop?

Read the design doc first. This doc assumes you know the seven patterns (Message Queue, Tasks-as-Entities, Polling Loop, Disk Persistence, Event Emission, Structured Abort, Permission Modes).

---

## 1. Honest Current-State Audit

### 1.1 Seven-Pattern Match Table

| # | Pattern | luminclaw current state | Gap severity |
|---|---|---|---|
| 1 | **Message queue between loops** | Absent. New user input creates a new task. Running tasks see nothing. | **Fundamental** — no way to steer in-flight work |
| 2 | **Tasks as cross-turn state** | Partial. `InMemoryTaskStore` exists. Lost on restart. No polling cursor. No output file. | Significant |
| 3 | **Polling loop for output** | Absent. Only `chat.final` fires at completion. No incremental output delivery. | Significant |
| 4 | **Disk-backed resume** | Absent. Tasks are in-memory only. `--resume` not implemented. | Significant |
| 5 | **Event emission + atomic notify** | Partial. `chat.final` via `EventBus`. No atomic `notified` flag — doc §13 warns of fire-and-forget result loss. | Medium |
| 6 | **Structured abort + synthetic results** | Broken. Rust cancel flag not checked (doc §4.3). TS checks at iteration boundary only, no synthetic results. | Significant |
| 7 | **Permission mode + `requiresUserInteraction`** | Absent. Approval gates are binary per-tool (TS only). No plan mode. No `requiresUserInteraction` concept. | Significant |

### 1.2 Architectural Root Cause

Pattern 1 (the message queue) is the root. Its absence makes Patterns 3 (polling), 5 (event emission), and 7 (permission modes) unusable for their intended purpose — steering, notification back into dialogue, and safe autonomy. Without Pattern 2 (persistent tasks) and Pattern 4 (disk resume), the system loses state on any disconnect. Without Pattern 6 (structured abort), tasks cannot be cleanly stopped.

**The current "dual-loop" is fire-and-forget task spawning with an eventual `chat.final` notification.** It is not a dual-loop in the sense the design doc describes. The outer loop does not communicate with the inner loop after spawn. The inner loop cannot receive user guidance mid-flight. The client cannot recover from a disconnect.

### 1.3 Documentation vs. Reality

These claims in `docs/DUAL_LOOP_ARCHITECTURE.md` are overstated:

| Claim | Reality |
|---|---|
| "Status: Implemented (TS + Rust), validated with real LLM" | Structural validation only. No test proves dialogue latency is independent of task duration. No test proves mid-flight steering. No test covers disconnect recovery. |
| "Dual-loop task completion via EventBus" | Fire-and-forget. If no subscriber is attached when `chat.final` fires, the result is lost forever. Doc §13 admits this as a limitation but the header describes it as working. |
| "Cancellation: AbortSignal triggers at iteration boundary" | TS: true but insufficient — cannot interrupt mid-LLM-call or mid-tool-call. Rust: documented flag that **is never read** inside the inner loop. |
| Sync parity test P7 "dual-loop: both return quickly with task info" | Only validates "task_id returns fast". Does not validate that the task actually produces a correct result observable by the client. |

### 1.4 Claim-by-Claim Audit (against DUAL_LOOP_ARCHITECTURE.md)

| Claim | Reality | Fix in roadmap |
|---|---|---|
| "validated with real LLM" | Structural only | Add capability tests (see §2) |
| "Dual-loop: outer returns, inner runs, `chat.final` publishes" | True only if client stays connected. No persistence. | Phase A + Phase B |
| "Cancellation: AbortSignal triggers at iteration boundary" (TS) | True but insufficient | Phase C |
| "Rust: `cancelled` Mutex flag" | **Flag is never read inside inner loop** | Phase C |
| "Multi-turn: session persists user input" | True in single-loop. Dual-loop: new `/v1/chat` creates new task with no queue delivery | Phase A |
| "Task state machine: pending → planning → executing → paused → ..." | `paused` never reached. `planning` hard-coded to skip to `executing`. | Wire `paused` OR remove from doc |
| "WorldModel for handoff context" | Created fresh per task, discarded on completion — zero cross-task continuity | Phase E |
| "In-memory stores" | Unbounded growth on long-running server | Phase E (TTL eviction) |
| "Rust approval gates" | TS only — **security gap: Rust dual-loop runs tools without confirmation** | Phase D |

---

## 2. Capability Tests — What "Validated" Must Mean

Before claiming dual-loop works, these end-to-end tests must pass. Each targets a specific user-visible value claim. Current code passes **zero** of them.

### C1. Dialogue–Execution Clock Decoupling

**Setup:** Start a long-running task (instruct agent to `bash -c "sleep 60"` then report).
**Action:** Every 5 s, send an unrelated user message (e.g., `"hello?"`).
**Assertion:** Response latency for the conversational message is ≤ 3 s (just an LLM turn), independent of task duration. The long task continues running.

**Currently:** Cannot pass — new messages start new tasks, the sleeping task is invisible.

### C2. Mid-Flight Steering

**Setup:** Agent starts a task: *"summarize all `.md` files in this repo"*.
**Action:** 5 s later, user sends *"actually skip node_modules and docs/"*.
**Assertion:** The running task sees the steering message as an attachment on its next LLM turn and adjusts behavior.

**Currently:** Cannot pass — no queue between dialogue and execution.

### C3. Disconnect Recovery

**Setup:** Client starts a task. Disconnects 2 s in. Reconnects 20 s later.
**Action:** Client queries `GET /v1/tasks/:id`.
**Assertion:** Returns current progress. When task terminates, client receives `chat.final` via the subsequent subscription (or the final state via `GET`).

**Currently:** Cannot pass — no polling endpoint, no persistent state, fire-and-forget event delivery.

### C4. Reliable Cancel

**Setup:** Agent running a multi-step task (3+ tool calls).
**Action:** Send `POST /v1/tasks/:id/cancel`.
**Assertion:** Within 5 s, task transitions to `killed`, `task_terminated` event fires **exactly once**, synthetic `tool_result` blocks fill any in-flight tool calls.

**Currently:** Cannot pass in Rust (flag not checked). TS passes only at iteration boundary, not mid-tool.

### C5. Proactive Progress

**Setup:** Agent running a 30 s multi-tool task.
**Action:** Client listens on `/v1/stream`.
**Assertion:** `task_progress` events fire periodically (every 1 s or after each tool) with current tool-use count, token count, and last-activity timestamp.

**Currently:** Not implemented — only `chat.final` at end.

### C6. Concurrent Task Isolation

**Setup:** Three simultaneous `POST /v1/chat` (dual mode) with independent content.
**Assertion:** All three tasks complete. Each `chat.final` has correct `taskId` binding. No cross-contamination of session history or tool results.

**Currently:** Untested. In-memory stores with no explicit isolation verification.

### C7. Cross-Task Knowledge Continuity

**Setup:** Task 1 discovers fact F (e.g., a file path). Task 2 starts 10 min later on related query.
**Assertion:** Task 2's system prompt includes F (via `MemoryStore` recall).

**Currently:** Cannot pass — `WorldModel` discarded, facts not written to `MemoryStore`.

### Acceptance criteria

A dual-loop claim is valid when C1–C7 each pass against a real LLM with recorded metrics:

- C1: p95 dialogue latency < 3 s during 60 s task
- C2: steering message influences tool call within 1 iteration
- C3: `GET /v1/tasks/:id` returns correct state 100% of runs after arbitrary disconnect timing
- C4: cancel → `killed` within 5 s in 100% of runs, exactly-one terminated event
- C5: progress event fires at least every 2 s of activity
- C6: 3 concurrent tasks all correct in 100% of 10 runs
- C7: T2 output shows knowledge of F in 100% of runs

---

## 3. Phased Improvement Roadmap

Each phase is independently valuable and separately validatable. Phases A and C are prerequisites for everything else. B, D, E can be reordered based on priority. F closes the loop with automated regression protection.

### Phase A — Message Queue + Task Polling Endpoint

**Unlocks:** C1, C3 (partial), C5.
**Estimate:** 2–3 days.
**Prerequisite:** None.
**Highest leverage of all phases.** Without this, no other phase matters for end-user experience.

Tasks:

- **A1.** Add `src/messageQueue.ts` — process-global FIFO with `priority` + `targetTaskId` + dequeue-by-predicate
- **A2.** Modify inner loop (`PrismerAgent.processMessage`) to drain queue at iteration start (before LLM call)
- **A3.** Modify dual-loop `/v1/chat` handler: instead of always creating a new task, check if sessionId has an active task; if yes, enqueue message targeting that task and return `{ status: 'queued', taskId }`
- **A4.** Add `GET /v1/tasks/:id` returning `{ status, progress, outputTail, endTime? }`
- **A5.** Add `task_progress` event to EventBus, emitted per iteration with `toolUseCount`, `tokenCount`, `lastActivity`

Exit criteria: C1 and C5 pass with real LLM; C3 passes for live-reconnect case (disk persistence is Phase B).

### Phase B — Disk Persistence + Resume

**Unlocks:** C3 robustly. Enables server restart without data loss.
**Estimate:** 3–4 days.
**Prerequisite:** Phase A (to have a well-defined task entity).

Tasks:

- **B1.** Add `TaskStore.appendTurn` writing turn to `~/.lumin/sessions/{sessionId}/tasks/{taskId}.jsonl`
- **B2.** Add `TaskStore.writeMeta` / `readMeta` for `~/.lumin/sessions/{sessionId}/tasks/{taskId}.meta.json`
- **B3.** On server startup, enumerate metadata files with non-terminal status. Re-register in `AppState`, mark as `interrupted` unless explicitly resumed
- **B4.** Add `POST /v1/tasks/:id/resume` (explicit resume from last persisted turn)

Exit criteria: C3 passes across a full server restart; recovered transcripts replay identically.

### Phase C — Structured Abort + Synthetic Results

**Unlocks:** C4 in both runtimes.
**Estimate:** 2 days.
**Prerequisite:** Phase A (cancel command flows through the queue).

Tasks:

- **C1.** Add `AbortReason` enum + `AbortController.signal.reason` propagation (TS) / `CancellationToken` with reason (Rust)
- **C2.** Pass abort signal into LLM fetch, check between streaming chunks
- **C3.** Pass abort signal into tool execution; tools may check `ctx.abortSignal`
- **C4.** On abort, generate synthetic `tool_result` block: `"[Aborted: ${reason}]"` for each in-flight tool
- **C5.** **Rust:** actually check `cancelled` flag in inner loop (fixes documented bug in DUAL_LOOP_ARCHITECTURE.md §4.3)

Exit criteria: C4 passes in both TS and Rust; synthetic results preserve message-history validity under arbitrary cancel timing.

### Phase D — Permission Mode + Plan Mode

**Unlocks:** Safe autonomous production use. Required before dual-loop is recommended for untrusted input in Rust.
**Estimate:** 3 days.
**Prerequisite:** None (can run in parallel with A/B/C).

Tasks:

- **D1.** Add `PermissionMode` enum + `toolPermissionContext` to session state
- **D2.** Each tool implements `requiresUserInteraction()` + `checkPermissions()`
- **D3.** In headless/dual-loop context, tools with `requiresUserInteraction: true` are automatically denied
- **D4.** Implement `EnterPlanMode` / `ExitPlanMode` as special tools that flip the mode
- **D5.** **Rust parity:** port the permission context to Rust (currently TS only)

Exit criteria: Rust dual-loop with `bash` tool no longer executes destructive commands without confirmation; plan-mode tool set is strictly narrower than default-mode.

### Phase E — Cross-Task Knowledge + Eviction

**Unlocks:** C7. Fixes the unbounded-growth bug documented in DUAL_LOOP_ARCHITECTURE.md §13.
**Estimate:** 1–2 days.
**Prerequisite:** Phase A + Phase B.

Tasks:

- **E1.** On task completion, write `WorldModel.knowledgeBase` facts to `MemoryStore`
- **E2.** On task start, `MemoryStore.recall` using the new task's goal keywords, inject into system prompt via `PromptBuilder`
- **E3.** Add TTL-based eviction to `TaskStore` (default: 1 h for terminal tasks, 30 s grace for UI-held)

Exit criteria: C7 passes; server running 24 h with 1000 tasks does not exhaust memory.

### Phase F — Capability Test Suite

**Unlocks:** Regression protection. Makes the dual-loop claim verifiable in CI.
**Estimate:** 2 days (assuming A–E done).
**Prerequisite:** All prior phases.

Tasks:

- **F1.** Translate C1–C7 to executable tests (real LLM required). Use the cheap OpenAI-compatible endpoint at `.env.test`
- **F2.** Mark tests `#[ignore]` by default; runnable via `--ignored` in CI nightly
- **F3.** Update `docs/DUAL_LOOP_ARCHITECTURE.md` status line based on which tests pass

Exit criteria: All seven tests pass on both TS and Rust runtimes, reproducibly.

### Total estimate

- **A → C → others:** 2–3 + 2 = 4–5 days to a usable dual-loop with cancel
- **A → B → C → F:** 2–3 + 3–4 + 2 + 2 = 9–11 days to a validated dual-loop with persistence
- **Everything including D + E:** 12–16 days to a production-grade dual-loop

---

## 4. Immediate Actions (Before Any Phase Starts)

Two items to do now regardless of which phase is chosen first:

### 4.1 Update DUAL_LOOP_ARCHITECTURE.md — Stop Overclaiming

Apply these edits immediately:

- Change status from `"Status: Implemented (TS + Rust), validated with real LLM"` to `"Status: Structural scaffolding implemented. Capability validation pending — see docs/superpowers/plans/2026-04-13-dual-loop-audit-and-roadmap.md"`
- Under sync parity P7: explicitly note this validates "immediate task_id return" only, not end-to-end task execution with client subscription
- Add to §13 Known Limitations: `"Dialogue cannot steer running tasks; new messages create independent tasks instead of injecting into the active task (see audit §1.2)"`

### 4.2 Run C1 Against Current Code

One hour of work to produce concrete data proving the gap. Script:

```bash
# Start dual-loop server
export LUMIN_LOOP_MODE=dual
export $(grep -v '^#' .env.test | xargs)
node dist/cli.js serve --port 3001 &

# Kick off a long task
SID="c1-$(date +%s)"
curl -s -X POST localhost:3001/v1/chat \
  -d "{\"content\": \"Run: bash -c 'for i in \$(seq 60); do echo step \$i; sleep 1; done'\", \"sessionId\": \"$SID\"}"

# At t=5s, send a conversational message in the same session, time the response
sleep 5
time curl -s -X POST localhost:3001/v1/chat \
  -d "{\"content\": \"Hi, what are you doing right now?\", \"sessionId\": \"$SID\"}"
```

Expected outcome: second request blocks for many seconds (current implementation serializes on sessionStore) or returns immediately but spawns a **new independent task** that knows nothing about the running one. Either way, not dual-loop decoupling.

Record the measured latency and behavior as the baseline `C1_before`. After Phase A, rerun and record `C1_after`.

---

## 5. Risks & Open Questions

### 5.1 Risks

- **Scope creep.** Phases A–F are a lot of work. Risk of over-investing in dual-loop while more valuable single-loop improvements wait. Mitigation: Phase A alone delivers most of the value; pause after A if other priorities emerge.
- **Rust parity drag.** Every TS change needs a Rust port. Parity test (`tool_registration.rs`) catches schema drift but not behavior drift. Mitigation: implement in TS first, validate, then port with characterization tests.
- **Disk format lock-in.** The JSONL transcript format chosen in Phase B becomes a long-term compat surface (resume must read old transcripts). Mitigation: include a schema version in each JSONL line; accept breaking changes between versions with an upgrade shim.

### 5.2 Open Questions (Must Answer During Implementation)

These are unresolved design questions from the companion design doc §5. Surface them to the user when encountered; do not silently pick a side:

1. **Queue targeting ambiguity.** When a session has an active task and the user sends a message: always enqueue to that task, or let the user explicitly say "new task" vs "continue"?
2. **Persistence format — JSONL vs SQLite.** Both are viable. Lean JSONL (CC's choice) for simplicity.
3. **Event bus replay window.** In-memory ring buffer for late subscribers, or rely entirely on `GET /v1/tasks/:id`?
4. **Cross-runtime parity for permission modes.** Port the TS approval gates to Rust first (correctness), or redesign jointly in Phase D?
5. **Task type taxonomy.** CC has six task types. We likely need three initially: `agent`, `shell`, `teammate`.

---

## 6. Next Step — Pick One

1. **Update docs (30 min).** Stop overclaiming. Lowest risk, highest information-value ratio.
2. **Run C1 baseline (1 hour).** Measure the gap concretely. Establishes a before/after number for Phase A.
3. **Start Phase A (2–3 days).** Highest leverage. Fundamentally changes dual-loop behavior.

Recommended order: **1 → 2 → 3.** Correct the record, quantify the gap, then fix the root cause.
