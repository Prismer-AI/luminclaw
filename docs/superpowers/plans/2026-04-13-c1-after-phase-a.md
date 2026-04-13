---
title: C1 Capability Test — After Phase A (A1–A6)
date: 2026-04-10
branch_sha: f0f756eb1e09a1e17df4c8e50aaf67c74d6d6290
llm_model: openai/gpt-oss-120b
llm_endpoint: http://34.60.178.0:3000/v1
loop_mode: dual
server_binary: node dist/cli.js serve --port 3001
companion_doc: docs/superpowers/plans/2026-04-13-c1-baseline.md
phase_a_commits:
  - 0369b22 feat(A1) MessageQueue
  - d485807 feat(A2) TaskStore.getActiveForSession + updateProgress + TaskProgress type
  - c8810aa feat(A3) route subsequent messages to active task via MessageQueue
  - d3529d4 feat(A4) add onIterationStart callback to PrismerAgent for queue polling
  - 115735f feat(A5) drain MessageQueue + emit task.progress per iteration
  - f0f756e test(A6) verify TaskProgress appears in GET /v1/tasks/:id response
purpose: Acceptance test for Phase A — re-run the baseline C1/C3/C6 script against
  the post-Phase-A build and quantify the delta.
status: DONE_WITH_CONCERNS
---

# C1 Capability Test — After Phase A

## 0. Environment

- **Repo SHA at measurement:** `f0f756eb1e09a1e17df4c8e50aaf67c74d6d6290`
- **Phase A commit chain (oldest → newest):**
  - `0369b22` feat(A1) MessageQueue — in-memory FIFO keyed by taskId
  - `d485807` feat(A2) TaskStore.getActiveForSession + updateProgress + TaskProgress type
  - `c8810aa` feat(A3) route subsequent POST /v1/chat messages to an active task via MessageQueue.enqueue
  - `d3529d4` feat(A4) add onIterationStart callback to PrismerAgent for queue polling
  - `115735f` feat(A5) drain MessageQueue + emit task.progress per iteration
  - `f0f756e` test(A6) verify TaskProgress appears in GET /v1/tasks/:id response
- **Build:** `npx tsc` clean (no output, success).
- **Server:** `LUMIN_LOOP_MODE=dual node dist/cli.js serve --port 3001`, in-process, no Rust sidecar.
- **Health probe before tests:** `GET /health` → `{"status":"degraded","version":"0.3.1","runtime":"lumin","loopMode":"dual","uptime":3.0,"checks":{"plugin":"not found: "}}` — `degraded` is expected (no workspace plugin), HTTP path healthy.
- **LLM:** `openai/gpt-oss-120b` at `http://34.60.178.0:3000/v1` (OpenAI-compatible).
- **Host:** darwin 25.5.0.
- **Environment caveat — bash tool now actually executes:** unlike the baseline run where `bash` returned `spawnSync /bin/sh ENOENT`, this host successfully ran the bash tool via `execFileSync('/bin/sh', …)`. However, because it uses the **synchronous** `execFileSync`, the 30-step-with-sleep command blocks Node's event loop for ~30 s, freezing every other HTTP request in the server. This is a pre-existing design issue (unchanged in Phase A), and it made the original baseline script untestable verbatim — the second POST and even GET /v1/tasks/:id were stalled behind the blocked event loop. We re-ran C1 with a pure-LLM long-ish prompt (multi-sentence counting) to exercise the dialogue-execution decoupling path without the event-loop freeze. Baseline's mechanical C1 check is preserved: second POST → same taskId + enqueue path.

## 1. Test C1 — Dialogue-Execution Decoupling (post-Phase A)

### Setup

Two separate sub-scenarios were exercised:

**Scenario 1a — baseline-exact bash command (exposes event-loop freeze):**

```
sessionId = c1-final-1776061016
POST /v1/chat { content: "Run: bash -c 'for i in $(seq 30); do echo step $i; sleep 1; done'", sessionId }
sleep 5
POST /v1/chat { content: "Actually, please tell me what you're doing right now", sessionId }
```

**Scenario 1b — pure-LLM slow task (exercises enqueue path cleanly):**

```
sessionId = c1-final2-1776061080
POST /v1/chat { content: "Count slowly from 1 to 10, explaining each number in 2 sentences. Take your time and think carefully.", sessionId }
sleep 2
POST /v1/chat { content: "Actually, please tell me what you're doing right now", sessionId }
```

### Measured — Scenario 1a (bash, blocked by execFileSync)

| Metric | Value |
|---|---|
| First POST wall-clock | 0.041 s |
| GET /v1/tasks/:id during execution (at T+2 s) | **29.66 s** — blocked behind synchronous bash |
| Second POST wall-clock | 0.045 s (but fired **after** T+35 s because the curl before it was stalled) |
| taskId 1 | `113d3efe-d1e7-4fe3-9dd2-898ed3d7bf03` |
| taskId 2 | `745d8a0f-6b46-457c-800f-30932c2a2a2d` **(new, different)** |
| Same taskId? | **no** — by the time POST 2 actually reached the server, task 1 had already finished (status ≠ executing), so getActiveForSession returned undefined → new task created |
| Conclusion | **inconclusive for A3** — the synchronous `bash` tool (src/loop/dual.ts:248 `execFileSync`) froze Node for ~30 s; POST 2 never saw an active task. This is an independent, pre-existing bug and does not invalidate the A3 enqueue path; it just makes the baseline script's exact command unsuitable for measuring A3 on this host. |

### Measured — Scenario 1b (pure-LLM, event-loop free)

| Metric | Value |
|---|---|
| First POST wall-clock | 0.035 s |
| Second POST wall-clock (at T+2 s) | 0.046 s |
| taskId returned by POST 1 | `6427c6ca-eb84-44c6-b8b8-1dda1fb78416` |
| taskId returned by POST 2 | **`6427c6ca-eb84-44c6-b8b8-1dda1fb78416`** — **same** |
| POST 2 response `response` field | `"Message queued for task 6427c6ca-eb84-44c6-b8b8-1dda1fb78416."` |
| POST 2 response `queued` field | **absent (undefined)** — see §1.2 below |
| POST 2 response `events` count | 1 (the `task.message.enqueued` event was published to the bus) |
| Same sessionId used? | yes (`c1-final2-1776061080`) |

### Response bodies (Scenario 1b, verbatim)

POST 1:
```json
{"status":"success",
 "response":"Task 6427c6ca-eb84-44c6-b8b8-1dda1fb78416 created and executing.",
 "directives":[],"toolsUsed":[],
 "sessionId":"c1-final2-1776061080","iterations":0,
 "taskId":"6427c6ca-eb84-44c6-b8b8-1dda1fb78416",
 "loopMode":"dual","events":3}
```

POST 2 (2 s later, same session):
```json
{"status":"success",
 "response":"Message queued for task 6427c6ca-eb84-44c6-b8b8-1dda1fb78416.",
 "directives":[],"toolsUsed":[],
 "sessionId":"c1-final2-1776061080","iterations":0,
 "taskId":"6427c6ca-eb84-44c6-b8b8-1dda1fb78416",
 "loopMode":"dual","events":1}
```

### 1.1 A3 routing verdict

**Mechanical enqueue works:** second POST resolves to the same `taskId` and returns the `"Message queued for task …"` ACK path (dual.ts line 79). This is a **substantive win over the baseline**, which created two independent tasks.

### 1.2 `queued: true` flag absent from HTTP response — server.ts gap

The result object returned by `DualLoopAgent.processMessage` sets `queued: true` (src/loop/dual.ts:85), but `handleChat` in `src/server.ts:256-268` does not forward this field in the JSON body. Downstream clients currently cannot programmatically detect the queue path; they must substring-match `"queued for task"` in `response`.

**Impact:** C1's routing primitive is live, but the wire contract promised by Phase A (`{ queued: true }` discoverable in POST body) is incomplete.

### 1.3 Steering injection into the running task — NOT verified

The queued message was enqueued but the task's own LLM loop completed in 1 iteration (the counting prompt was a single-turn response). A5's drain fires at the *start* of each iteration; with only one iteration, onIterationStart ran once (iteration=1) before the queue contained the steering message. The message therefore stayed on the queue until task completion, never being drained. No subsequent iteration existed to process it.

This exposes an architectural edge: for single-iteration tasks, **no drain ever happens**, and queued messages are lost when the task completes. The A5 contract ("drain per iteration") is honoured, but it fails to cover the trailing case where the producer enqueues after the last iteration started. Phase A's scope did not address this; it is a live gap.

### 1.4 Conclusion

| Claim | Verdict |
|---|---|
| Second POST to live session returns same `taskId` | **PASS** (Scenario 1b) |
| Second POST response includes `queued: true` field | **FAIL** (serializer gap in `handleChat`) |
| Steering message visibly influences running task behavior | **UNVERIFIED** (single-iteration task consumed before drain could fire; no multi-iteration test produced a clean trace in this run) |
| Second POST doesn't spawn a new task | **PASS** (same taskId returned) |

Net: A3 enqueue-routing is real; the POST body contract (A3) is incomplete; A5 end-to-end steering is not demonstrated by this measurement.

## 2. Test C3 — Polling + TaskProgress field

### Measured

| Metric | Value |
|---|---|
| `GET /v1/tasks/:id` responds 200 while executing | yes |
| Polls at T+0.2 / 0.5 / 1.0 / 1.5 / 2.0 s (task `2a498c42`) observed statuses | `planning, planning, executing, executing, completed` |
| `progress` field in any of those poll responses | **None** (absent in every poll, executing or completed) |
| Number of checkpoints during executing | 1 (`Planning complete: N steps identified`) |
| Number of checkpoints at completion | 2 (planning + result) |
| `task.progress` EventBus events emitted | Present in code (dual.ts:310-313) but unobservable over HTTP — no SSE endpoint, only WebSocket |
| Iterations reflected in final checkpoint's `data.iterations` | yes (values of 1, 2, 3 seen across runs) |

### 2.1 `progress` field absent from HTTP response — DualLoopAgent.getTask projection gap

**Root cause located.** `DualLoopAgent.getTask(id)` in `src/loop/dual.ts:408-423` returns a manually-constructed projection that whitelists fields:

```ts
return { id, sessionId, instruction, status, artifactIds, checkpoints, result, error, createdAt, updatedAt };
```

`progress` is **not** in the whitelist, so even when `updateProgress` correctly persists `TaskProgress` into the in-memory store (verified by A6's three store-layer unit tests), the HTTP GET response never surfaces it.

A6's commit message asserts "handleGetTask is a full pass-through (json(res, 200, task))" — this is true for `handleGetTask` itself, but the Task passed in comes from `loop.getTask?.(taskId)` (server.ts:313), which for dual-loop mode is `DualLoopAgent.getTask` — the whitelisted projection. The A6 unit tests exercise `InMemoryTaskStore.get` directly, not the IAgentLoop path, so they pass while the HTTP contract fails.

**This is the principal Phase A defect surfaced by this measurement.**

### 2.2 task.progress events are emitted into the bus but unobservable

`dual.ts:310-313` publishes `{ type: 'task.progress', data: { taskId, iteration, toolsUsed, lastActivity } }` on the outerBus for every iteration. On the HTTP-only test path (`curl`, no WS client attached), nobody subscribes, so these events are fire-and-forget. There is no SSE HTTP endpoint; the stream is WebSocket-only at `/v1/stream`.

### 2.3 Conclusion

- **A5's event emission: PARTIALLY PASS** — the code publishes `task.progress`, but only a WebSocket subscriber can observe it.
- **A5's persistence to store: PASS at unit-test level**, but **FAIL at HTTP contract level** due to the `DualLoopAgent.getTask` whitelist.
- **A6's claim that "progress already surfaces in HTTP response": FALSE** as currently wired. A one-line fix (add `progress: t.progress` to the `getTask` projection in dual.ts) would close this.

## 3. Test C6 — Concurrent Task Isolation

Not re-measured in this Phase A acceptance test. No regression-risk change was introduced between `5aeecfb` (baseline) and `f0f756e` for the C6 code path — the session→task binding logic is untouched. Baseline result (N=1 smoke-pass, 3 concurrent tasks with correct sessionId binding and zero cross-contamination) is carried forward unchanged.

## 4. Summary — Audit-Claim Verification

| Phase A claim | Baseline (5aeecfb) | After Phase A (f0f756e) | Verdict |
|---|---|---|---|
| A1 MessageQueue exists and enqueues | N/A (file absent) | Present (src/task/message-queue.ts) | **PASS** |
| A2 TaskStore.getActiveForSession | N/A | Implemented + tested | **PASS** |
| A2 TaskStore.updateProgress | N/A | Implemented + tested (3 unit tests) | **PASS** |
| A3 second POST routes to enqueue path | second POST creates new task | second POST returns same taskId with `"Message queued for task …"` response text | **PASS** (mechanical) |
| A3 POST response includes `queued: true` boolean | N/A | **field is NOT serialized** in handleChat JSON response | **FAIL** |
| A4 onIterationStart callback wired in | N/A | Present (agent.ts:372-376, dual.ts:295) | **PASS** (structural) |
| A5 drain MessageQueue at iteration boundary | N/A | Drains, but single-iteration tasks never drain queued messages | **PARTIAL** |
| A5 publish `task.progress` event per iteration | no incremental events | Published to bus (dual.ts:310), but only visible over WS | **PARTIAL** (emitted but not reachable over HTTP) |
| A5 persist TaskProgress to store | N/A | Store correctly holds `{iterations, toolsUsed, lastActivity}` | **PASS at store layer** |
| A6 TaskProgress surfaces in GET /v1/tasks/:id | N/A | **NOT surfaced** — DualLoopAgent.getTask whitelist omits `progress` | **FAIL** |
| Overall "user can steer a running task via second POST" | no queue — new task spawned | Mechanical routing works; end-to-end steering not demonstrated due to §1.3 edge + §2.1 observability gap | **PARTIAL** |

### Overall

Phase A's wiring is largely in place at the type and store layer (A1, A2, A4), and the primary user-visible routing change (A3's enqueue path for same-session POST) works: the second POST returns the same taskId. **Two HTTP-contract gaps** prevent this acceptance test from claiming full Phase A pass:

1. `POST /v1/chat` response does not include `{ queued: true }` (src/server.ts:256 whitelist incomplete).
2. `GET /v1/tasks/:id` response does not include `progress` (src/loop/dual.ts:408 whitelist incomplete).

Both are one-line fixes; both are independent of baseline gaps and are new contract regressions introduced alongside Phase A. Additionally, A5's drain does not run for single-iteration tasks, which is an edge in A5's design that Phase A did not address.

Marking as **DONE_WITH_CONCERNS**: the plumbing exists, the contracts promised to consumers are incomplete.

## 5. Machine-readable metric table

```yaml
test_id: c1-after-phase-a
measured_at: 2026-04-10T06:17:00Z
git_sha: f0f756eb1e09a1e17df4c8e50aaf67c74d6d6290
baseline_git_sha: 5aeecfb5c92ceba7248b6199fb14d61c8d533e6b
phase_a_commits:
  a1: 0369b22
  a2: d485807
  a3: c8810aa
  a4: d3529d4
  a5: 115735f
  a6: f0f756e
llm:
  model: openai/gpt-oss-120b
  endpoint: http://34.60.178.0:3000/v1
server:
  loop_mode: dual
  port: 3001
  version: 0.3.1

c1_scenario_1a_bash:
  note: baseline-exact script; synchronous bash freezes event loop
  first_post_duration_s: 0.041
  get_task_during_exec_duration_s: 29.66
  second_post_duration_s: 0.045
  task1_id: 113d3efe-d1e7-4fe3-9dd2-898ed3d7bf03
  task2_id: 745d8a0f-6b46-457c-800f-30932c2a2a2d
  same_task_id: false
  reason: execFileSync blocked node while first task ran; by the time POST2 landed, task1 had already completed → getActiveForSession returned undefined → new task
  verdict: inconclusive_for_a3_due_to_unrelated_blocking_io_bug

c1_scenario_1b_pure_llm:
  note: pure-LLM prompt; no event-loop freeze; exercises enqueue path cleanly
  first_post_duration_s: 0.035
  second_post_duration_s: 0.046
  same_session_id: true
  same_task_id: true
  task_id: 6427c6ca-eb84-44c6-b8b8-1dda1fb78416
  post2_response_text: "Message queued for task 6427c6ca-eb84-44c6-b8b8-1dda1fb78416."
  post2_queued_field_in_json_body: false
  post2_events_count: 1
  steering_message_drained_into_running_task: false
  steering_drain_failure_reason: task_completed_in_single_iteration_before_drain_could_fire
  verdict: a3_mechanical_pass_a3_contract_incomplete_a5_end_to_end_unverified

c3:
  get_tasks_id_exists: true
  get_tasks_id_returns_progress_field: false
  progress_field_absent_root_cause: DualLoopAgent.getTask projection in dual.ts:408 does not include progress in whitelist
  task_progress_event_published_to_bus: true
  task_progress_event_reachable_over_http: false
  task_progress_event_reachable_over_ws: true
  checkpoints_during_executing: 1
  checkpoints_at_completion: 2
  incremental_progress_events: emitted_but_unreachable_over_http
  iterations_per_task_progress_event: 1
  verdict: partial_pass_with_http_contract_gap

c6:
  re_measured: false
  reason: no_regression_risk_change_since_baseline
  baseline_result_carried_forward: smoke_pass_n_eq_1

phase_a_contract_gaps:
  - server.ts_handleChat_does_not_serialize_queued_field
  - dual.ts_getTask_projection_does_not_include_progress
  - a5_drain_never_fires_for_single_iteration_tasks
  - execFileSync_in_dual_ts_bash_tool_blocks_event_loop (pre-existing)

known_environment_issues:
  - workspace_plugin_not_configured_health_degraded
  - no_sse_http_endpoint_only_websocket_at_v1_stream
```

## 6. Delta from baseline

| Metric | Baseline (`5aeecfb`) | After Phase A (`f0f756e`) | Direction |
|---|---|---|---|
| **`same_task_id`** (2nd POST, same session) | **false** | **true** (Scenario 1b) | **✅ FIXED** |
| **`queued` boolean in POST2 response body** | N/A | **false (field absent from JSON)** | **❌ CONTRACT GAP** |
| **`iterations` per task.progress event** | no `task_progress` events | events published per iteration but only over WS | **PARTIAL** |
| `progress` field in GET /v1/tasks/:id response | N/A | **absent** (DualLoopAgent.getTask whitelist omits it) | **❌ CONTRACT GAP** |
| First POST duration | 0.040 s | 0.035–0.041 s | no change |
| Second POST duration (pure-LLM) | 0.048 s | 0.046 s | no change |
| POST 2 response text | `"Task X created and executing."` | `"Message queued for task Y."` | ✅ new ACK shape present |
| Checkpoints during `executing` | 1 (planning) | 1 (planning) | no change |
| `GET /v1/tasks/:id` exists | yes | yes | no change |
| `task.message.enqueued` event on bus | N/A | yes (1 event per POST 2) | ✅ new |
| Second task spawned on same-session POST 2 | yes (new independent task) | no (returns same taskId) | ✅ FIXED |
| Second task aware of first? | n/a (they didn't share anything) | n/a (single task now, but drain may or may not run) | ✅ architecturally replaced |
| Overall C1 verdict | confirms_audit_no_queue | a3_mechanical_pass_with_two_http_contract_gaps | ↗ improved, not yet fully delivered |

### Three critical deltas (bolded in table above)

1. **`same_task_id` flipped false → true.** The single most important C1 outcome: Phase A's routing primitive is live. Second POST no longer spawns an independent task.
2. **`queued` boolean not surfaced in POST response body.** The code sets it on the result (dual.ts:85), but server.ts does not forward it (server.ts:256). Downstream consumers cannot programmatically distinguish "enqueued" from "created" without substring-matching the `response` text.
3. **`iterations` per task.progress event.** The event fires at every iteration boundary and is reachable via WebSocket only. Over HTTP, it's not observable, and the persisted `progress` object (which the GET endpoint should have returned) is dropped by `DualLoopAgent.getTask`'s field whitelist. Both defects are one-line fixes; both were claimed delivered by A5/A6.

### Residual gap beyond Phase A scope

A5's drain fires at the **start** of each iteration. If a task completes in one iteration (a common case for short prompts), a steering message that arrives *after* that iteration started is never drained. The queue entry remains orphaned when the task terminates. Phase A does not claim to address this; it is noted here for Phase B scope.

## 7. Fix outcome

Commit `eb4b5bf` closed the two HTTP-contract regressions identified in §4.

### Re-measurement results

- **G1 (queued field):** POST 2 response now includes `"queued": true` and `"taskId": "<same-as-POST-1>"`. PASS.
- **G2 (progress field):** GET /v1/tasks/:id now includes `"progress": {"iterations": 1, "toolsUsed": [], "lastActivity": <timestamp>}` when populated. PASS.

### Remaining known edge (Gap 3 — deferred to Phase C)

A5's drain callback fires at iteration start. For single-iteration tasks, queued steering messages that arrive after iteration 1 starts but before it completes are orphaned — no iteration 2 exists to drain them. Phase C's structured abort + completion-hook work will naturally address this by adding a drain-on-completion step. Tracked as Phase A residual.
