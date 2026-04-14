# Phase C — Structured Abort + Synthetic Results + Gap 3 Drain

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cancellation interrupt mid-LLM-call and mid-tool-execution (not just at iteration boundary). Replace boolean `cancelled` with structured `AbortReason`. Generate synthetic `tool_result` blocks for in-flight tools on abort. Fix Gap 3 from Phase A (drain queued messages at task completion).

**Architecture:** Introduce `AbortReason` enum shared across TS + Rust. TS: use native `AbortController.abort(reason)` — Node 18+ carries the reason on `signal.reason`. Rust: upgrade `cancelled: Arc<Mutex<bool>>` to `cancelled: Arc<Mutex<Option<AbortReason>>>`. Thread `abortSignal`/`cancelled` into LLM provider calls and tool-execution contexts so they check mid-operation. On abort with in-flight tools, emit synthetic `{tool_use_id, output: "[Aborted: <reason>]"}` results so message history stays well-formed. At task terminal transition, drain remaining queued messages and include them as `task.message.orphaned` events.

**Tech Stack:** TypeScript 5, Rust (tokio, reqwest), vitest, cargo test

**Scope boundaries:**
- **In scope:** AbortReason enum, mid-call abort propagation for LLM + tools, synthetic results, task-termination drain.
- **Out of scope (Phase D):** Permission modes, Plan mode, `requiresUserInteraction`.
- **Out of scope (Phase B):** Disk-backed resume after abort.
- **Rust PARA stance (Gate 1 = c):** Rust gets the same AbortReason wire schema and flag-update behavior so the TS↔Rust protocol stays consistent. No new Rust runtime features beyond what's needed to keep the Rust runtime from silently dropping aborts mid-iteration.

---

## Current State (audit)

Findings from inspection at HEAD (`3e26dab`):

- **TS `src/agent.ts:370`** checks `this.abortSignal?.aborted` at iteration-boundary only. Mid-LLM-call is NOT abort-aware. Mid-tool-call is NOT abort-aware. On abort, sets `lastText = '[Aborted by user]'` and breaks the outer loop without synthesizing in-flight tool results.
- **TS `src/agent.ts:270`** already produces `[Aborted]` synthetic tool_result for queued-but-not-started tool calls when abort fires during the partitioned-tool-execution block. The primary gap is the LLM-streaming-call and the individual tool's execution body.
- **Rust `agent.rs:488-493`** checks `cancelled` at iteration start (contradicts the audit-doc claim that the flag is never read — doc overstated). Mid-iteration not checked.
- **Rust `loop_dual.rs:229`** sets `*self.cancelled.lock().unwrap() = true` — boolean, no reason.
- **TS `src/loop/dual.ts:~444`** `cancel()` calls `this.abortController.abort()` without a reason argument.

Gap 3 from Phase A: when the inner-loop agent terminates naturally (no more iterations because the LLM returned a final answer) but there are still messages in `this.messageQueue.drainForTask(task.id)`, those messages are orphaned. No one drains them, no event fires, they just leak in the queue.

---

## Module Changes

| File | Change |
|------|--------|
| `src/abort.ts` | **Create.** `AbortReason` enum, `createAbortError(reason)`, `isAbortError(e)` helper. |
| `src/agent.ts` | Accept `AbortSignal` in tool execution context. Check signal between streaming chunks. Generate synthetic `[Aborted: <reason>]` for in-flight tools. |
| `src/tools.ts` / `src/tools/builtins.ts` | `ToolContext.abortSignal?: AbortSignal`. Long-running tools (bash, web_fetch) check it. |
| `src/provider.ts` | Pass `signal` to `fetch()` so network cancellation propagates. Re-throw structured `AbortError` with reason. |
| `src/loop/dual.ts` | `cancel(reason?: AbortReason)` — default `'user_explicit_cancel'`. Terminal transition drains remaining queue, emits `task.message.orphaned` event. |
| `src/sse.ts` | Add `task.message.orphaned` event variant. |
| `rust/crates/lumin-core/src/agent.rs` | `cancelled: Arc<Mutex<Option<AbortReason>>>`. Check between streaming chunks + inside tool execution. Return structured error. |
| `rust/crates/lumin-core/src/provider.rs` | `chat_stream` accepts cancellation; check between SSE chunks. |
| `rust/crates/lumin-core/src/tools.rs` | `ToolContext.cancelled: Option<Arc<Mutex<Option<AbortReason>>>>`. Tools may peek. |
| `rust/crates/lumin-core/src/loop_dual.rs` | Upgrade `cancelled` Mutex to store `Option<AbortReason>`. |

---

## Tasks

### Task C1: AbortReason type + helpers

**Files:**
- Create: `src/abort.ts`
- Create: `tests/abort.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/abort.test.ts
import { describe, it, expect } from 'vitest';
import {
  AbortReason,
  createAbortError,
  isAbortError,
  getAbortReason,
  ABORT_ERROR_NAME,
} from '../src/abort.js';

describe('abort module', () => {
  it('AbortReason enum has required values', () => {
    expect(AbortReason.UserInterrupted).toBe('user_interrupted');
    expect(AbortReason.UserExplicitCancel).toBe('user_explicit_cancel');
    expect(AbortReason.Timeout).toBe('timeout');
    expect(AbortReason.SiblingError).toBe('sibling_error');
    expect(AbortReason.ServerShutdown).toBe('server_shutdown');
  });

  it('createAbortError produces Error with name=AbortError and reason', () => {
    const e = createAbortError(AbortReason.UserExplicitCancel);
    expect(e.name).toBe(ABORT_ERROR_NAME);
    expect(e.message).toContain('user_explicit_cancel');
    expect(getAbortReason(e)).toBe(AbortReason.UserExplicitCancel);
  });

  it('isAbortError recognizes errors from createAbortError', () => {
    const e = createAbortError(AbortReason.Timeout);
    expect(isAbortError(e)).toBe(true);
  });

  it('isAbortError returns false for non-abort errors', () => {
    expect(isAbortError(new Error('normal'))).toBe(false);
    expect(isAbortError('string')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it('isAbortError recognizes native DOMException AbortError', () => {
    // Native fetch() with abort signal rejects with DOMException name=AbortError
    const e = new DOMException('aborted', 'AbortError');
    expect(isAbortError(e)).toBe(true);
  });

  it('getAbortReason returns undefined when error has no encoded reason', () => {
    expect(getAbortReason(new Error('normal'))).toBeUndefined();
    expect(getAbortReason(new DOMException('x', 'AbortError'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/abort.test.ts`
Expected: FAIL — `Cannot find module '../src/abort.js'`.

- [ ] **Step 3: Implement**

```typescript
// src/abort.ts
/**
 * Structured abort reasons + helpers for encoding them in Error objects.
 *
 * Used across both dialogue and execution loops to distinguish why an
 * in-flight operation was cancelled.  TS uses native AbortController with
 * `signal.reason` carrying an Error whose `message` encodes one of these enum
 * values.
 *
 * @module abort
 */

export const ABORT_ERROR_NAME = 'AbortError';

export const AbortReason = {
  UserInterrupted: 'user_interrupted',
  UserExplicitCancel: 'user_explicit_cancel',
  Timeout: 'timeout',
  SiblingError: 'sibling_error',
  ServerShutdown: 'server_shutdown',
} as const;

export type AbortReasonValue = typeof AbortReason[keyof typeof AbortReason];

const REASON_PREFIX = 'abort:';

/** Construct an Error that both looks like a native AbortError and encodes a structured reason. */
export function createAbortError(reason: AbortReasonValue): Error {
  const err = new Error(`${REASON_PREFIX}${reason}`);
  err.name = ABORT_ERROR_NAME;
  return err;
}

/** True if the value looks like an abort (DOMException AbortError, or our structured Error). */
export function isAbortError(value: unknown): boolean {
  if (value instanceof Error && value.name === ABORT_ERROR_NAME) return true;
  if (typeof value === 'object' && value !== null && 'name' in value &&
      (value as { name?: string }).name === ABORT_ERROR_NAME) return true;
  return false;
}

/** Extract the encoded reason from a structured abort Error; undefined otherwise. */
export function getAbortReason(value: unknown): AbortReasonValue | undefined {
  if (!isAbortError(value)) return undefined;
  const msg = (value as { message?: string }).message ?? '';
  if (!msg.startsWith(REASON_PREFIX)) return undefined;
  const r = msg.slice(REASON_PREFIX.length) as AbortReasonValue;
  const known: string[] = Object.values(AbortReason);
  return known.includes(r) ? r : undefined;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/abort.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/abort.ts tests/abort.test.ts
git commit -m "feat(C1): AbortReason enum + createAbortError/isAbortError/getAbortReason helpers"
```

---

### Task C2: Abort-aware LLM provider call

**Files:**
- Modify: `src/provider.ts` — pass `signal` into `fetch()`, translate fetch-abort to structured AbortError
- Modify: `tests/provider.test.ts` (or create)

- [ ] **Step 1: Write failing test**

Add to a new test file `tests/provider-abort.test.ts` (keeps existing provider tests untouched):

```typescript
import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { AbortReason, isAbortError, getAbortReason } from '../src/abort.js';

describe('Provider — abort propagation', () => {
  it('rejects with structured AbortError when signal aborts mid-request', async () => {
    // Use an endpoint we won't actually reach — the abort fires before fetch resolves.
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1',  // unroutable
      apiKey: 'test',
      defaultModel: 'test-model',
    });

    const ctrl = new AbortController();
    // Abort ~20ms in — the fetch() will be outstanding
    setTimeout(() => ctrl.abort(new (await import('../src/abort.js')).createAbortError(AbortReason.UserExplicitCancel)), 20);

    await expect(
      provider.chat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'test-model',
        signal: ctrl.signal,
      }),
    ).rejects.toSatisfy((e: unknown) => {
      return isAbortError(e) && getAbortReason(e) === AbortReason.UserExplicitCancel;
    });
  }, 5000);
});
```

Inspect `src/provider.ts` first to see the current `chat()` signature and whether it already accepts a `signal` parameter. Adjust the test to match the actual call shape.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/provider-abort.test.ts`
Expected: FAIL — either `signal` parameter not accepted, or the abort error shape differs.

- [ ] **Step 3: Plumb signal into fetch()**

In `src/provider.ts`:

1. Find the `chat(request)` method signature. Add `signal?: AbortSignal` to the request type (or confirm it already exists).
2. Find the `fetch(url, opts)` call inside `chat()`. Pass `signal: request.signal` into the options.
3. Wrap the fetch + streaming loop in a try/catch. On catch, if `error.name === 'AbortError'` and `request.signal?.reason` has an encoded `AbortReason`, re-throw `request.signal.reason`. Otherwise re-throw the original.

```typescript
// inside chat() method, replace the catch/throw pattern around fetch()
try {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify(body),
    signal: request.signal,   // ADD THIS if not present
  });
  // ... existing streaming logic
} catch (err) {
  // Translate fetch's DOMException AbortError into our structured AbortError when a reason is attached.
  if (err instanceof DOMException && err.name === 'AbortError') {
    const attached = request.signal?.reason;
    if (attached instanceof Error) throw attached;
    throw err;
  }
  throw err;
}
```

The same wrapping applies to `chatStream` if it exists.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/provider-abort.test.ts`
Expected: PASS.

Regression:
Run: `npx vitest run tests/provider.test.ts`
Expected: existing provider tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/provider.ts tests/provider-abort.test.ts
git commit -m "feat(C2): propagate AbortSignal + structured reason into LLM fetch"
```

---

### Task C3: Abort-aware tool execution context

**Files:**
- Modify: `src/tools.ts` — add `abortSignal?: AbortSignal` to `ToolContext`
- Modify: `src/tools/builtins.ts` — long-running tools (bash, web_fetch) check the signal
- Modify: `src/agent.ts` — pass `this.abortSignal` into `ToolContext` at invocation site
- Modify: `tests/tools-abort.test.ts` (create)

- [ ] **Step 1: Write failing tests**

```typescript
// tests/tools-abort.test.ts
import { describe, it, expect } from 'vitest';
import { createTool, ToolRegistry } from '../src/tools.js';

describe('ToolContext.abortSignal', () => {
  it('exposes abortSignal to tools', async () => {
    const ctrl = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const reg = new ToolRegistry();
    reg.register(createTool(
      'peek',
      'peek at ctx',
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        seenSignal = ctx.abortSignal;
        return '';
      },
    ));
    await reg.execute('peek', {}, { workspaceDir: '/tmp', sessionId: 's', agentId: 'a', abortSignal: ctrl.signal });
    expect(seenSignal).toBe(ctrl.signal);
  });
});
```

Additionally, test that `bash` checks the signal — harder to test without spawning, so keep the unit test at the ToolContext plumbing level and validate the bash integration in Task C5's integration scenario.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tools-abort.test.ts`
Expected: FAIL — `abortSignal` not a valid ToolContext field.

- [ ] **Step 3: Extend ToolContext**

In `src/tools.ts`, find the `ToolContext` interface. Add:

```typescript
  /** Abort signal propagated from the agent loop. Long-running tools should honor it. */
  abortSignal?: AbortSignal;
```

In `ToolRegistry.execute`, ensure the context passed to the tool includes the `abortSignal` field from the input context. (If `execute` accepts a full `ToolContext`, it already flows through.)

- [ ] **Step 4: Update agent.ts invocation site**

In `src/agent.ts`, find where tools are invoked (search for `ctx:` with `workspaceDir`). Add `abortSignal: this.abortSignal` to the context object.

- [ ] **Step 5: Update bash + web_fetch to honor signal**

In `src/tools/builtins.ts`, find `bash`:

```typescript
// Inside bash execute(), pass signal to execSync / exec
// execSync can't be aborted mid-run. If abort fires, we let it complete and
// convert the post-execute result to synthetic [Aborted]. Better option:
// use child_process.spawn with a kill signal hooked to signal.addEventListener('abort', ...).
```

Choose one of:
- **A.** Replace `execSync` with `child_process.spawn` and listen for `signal.abort` to `kill()` the child. More correct but a larger code change.
- **B.** Keep `execSync` and before/after checking `ctx.abortSignal?.aborted`. Partially correct — can't interrupt mid-process.

Implement option **A** if it's straightforward given the current bash implementation; otherwise **B** with a TODO comment.

For `web_fetch`:

```typescript
// Inside web_fetch execute()
const resp = await fetch(url, {
  method,
  headers,
  body: method !== 'GET' ? body : undefined,
  signal: ctx.abortSignal,
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/tools-abort.test.ts tests/builtins.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts src/agent.ts src/tools/builtins.ts tests/tools-abort.test.ts
git commit -m "feat(C3): ToolContext.abortSignal + bash/web_fetch honor it"
```

---

### Task C4: Synthetic tool_result on abort

**Files:**
- Modify: `src/agent.ts` — in the iteration-boundary abort branch, walk pending tool_calls and emit synthetic results
- Modify: `tests/agent.test.ts` — test that aborting with pending tools produces well-formed history

- [ ] **Step 1: Inspect current abort branch**

Read `src/agent.ts` around line 270 and line 370 to see the two abort paths. The line-270 path already synthesizes `[Aborted]` for one case. The line-370 path (top of iteration loop) breaks without handling in-flight tools.

- [ ] **Step 2: Write failing test**

```typescript
// tests/agent-abort.test.ts (or extend tests/agent.test.ts)
import { describe, it, expect, vi } from 'vitest';
import { PrismerAgent } from '../src/agent.js';
import { ToolRegistry, createTool } from '../src/tools.js';
import { ConsoleObserver } from '../src/observer.js';
import { AgentRegistry } from '../src/agents.js';
import { Session } from '../src/session.js';
import { AbortReason, createAbortError, getAbortReason } from '../src/abort.js';

function drainGenerator<T>(gen: AsyncGenerator<unknown, T, unknown>): Promise<T> {
  return (async () => {
    // consume events, return final
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of gen) { /* drain */ }
    // Using `gen.return()` or final-value contract depends on existing generator shape;
    // follow the pattern used by the existing onIterationStart tests.
    return undefined as unknown as T;
  })();
}

describe('PrismerAgent — abort synthetic results', () => {
  it('emits synthetic [Aborted: <reason>] for in-flight tools on abort', async () => {
    const ctrl = new AbortController();
    // Tool that never resolves — simulates an in-flight bash
    const neverResolve = new Promise<string>(() => { /* pending forever */ });
    const tools = new ToolRegistry();
    tools.register(createTool(
      'slow',
      'slow tool',
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        // Wait for abort
        return new Promise((_resolve, reject) => {
          ctx.abortSignal?.addEventListener('abort', () => {
            reject(createAbortError(AbortReason.UserExplicitCancel));
          });
        });
      },
    ));

    const provider = {
      chat: vi.fn().mockResolvedValue({
        text: '', toolCalls: [{ id: 'call1', name: 'slow', arguments: {} }],
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    };

    const agent = new PrismerAgent({
      provider: provider as any,
      tools, observer: new ConsoleObserver(), agents: new AgentRegistry(),
      systemPrompt: 'sys', maxIterations: 3, abortSignal: ctrl.signal,
    });

    // Abort after 50ms
    setTimeout(() => ctrl.abort(createAbortError(AbortReason.UserExplicitCancel)), 50);

    const session = new Session('s');
    // Drive the generator to completion — the actual API depends on processMessage shape.
    // Follow the pattern from the A4 tests.
    try { await agent.processMessage('hi', session); } catch { /* abort may surface as thrown */ }

    // Assert that session.messages has a tool_result for call1 with [Aborted: user_explicit_cancel]
    const toolResults = session.messages.filter(m => m.role === 'tool');
    const aborted = toolResults.find(m => typeof m.content === 'string' && m.content.includes('[Aborted'));
    expect(aborted).toBeDefined();
    expect(aborted!.content).toContain('user_explicit_cancel');
  }, 5000);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/agent-abort.test.ts`
Expected: FAIL — synthetic `[Aborted: user_explicit_cancel]` not emitted.

- [ ] **Step 4: Implement**

In `src/agent.ts`:

Find both abort paths (around lines 270 and 370). For each:

1. Before breaking/returning, iterate through any `toolCalls` whose `id` has not received a matching `tool_result` in `state.messages`.
2. For each dangling tool call, push to `state.messages`:

```typescript
{
  role: 'tool',
  content: `[Aborted: ${getAbortReason(this.abortSignal?.reason) ?? 'user_interrupted'}]`,
  tool_call_id: call.id,
}
```

3. Then break/return as before.

Use `getAbortReason(signal.reason)` from `src/abort.ts`. If the signal was aborted without a reason attached, default to `AbortReason.UserInterrupted`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/agent-abort.test.ts tests/agent.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts tests/agent-abort.test.ts
git commit -m "feat(C4): synthesize [Aborted: <reason>] tool_result for in-flight tools"
```

---

### Task C5: DualLoopAgent.cancel(reason) + termination drain (Gap 3)

**Files:**
- Modify: `src/loop/dual.ts` — `cancel(reason?)`, drain queue at termination
- Modify: `src/loop/types.ts` — add `reason?: AbortReasonValue` to `cancel()` signature
- Modify: `src/sse.ts` — add `task.message.orphaned` event variant
- Modify: `tests/loop/dual-cancel.test.ts` (create)

- [ ] **Step 1: Add task.message.orphaned event**

In `src/sse.ts`, add to the AgentEvent union:

```typescript
  | { type: 'task.message.orphaned'; data: { taskId: string; messageId: string; content: string; reason: 'task_completed' | 'task_aborted' } }
```

And the Zod schema variant matching the same shape.

- [ ] **Step 2: Write failing test**

```typescript
// tests/loop/dual-cancel.test.ts
import { describe, it, expect, vi } from 'vitest';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus } from '../../src/sse.js';
import { AbortReason } from '../../src/abort.js';

describe('DualLoopAgent — cancel + termination drain', () => {
  it('cancel(reason) propagates reason to the AbortController signal', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as any, 'runInnerLoop').mockImplementation(async () => {
      // Hold the task in executing state
      await new Promise(r => setTimeout(r, 100));
    });

    const first = await agent.processMessage({ content: 'x', sessionId: 's' }, { bus: new EventBus() });
    agent.tasks.update(first.taskId!, { status: 'executing' });

    // Capture reason via the private abortController
    agent.cancel(AbortReason.Timeout);
    const reason = (agent as any).abortController?.signal?.reason;
    expect(reason).toBeDefined();
    // getAbortReason from abort module
    const { getAbortReason } = await import('../../src/abort.js');
    expect(getAbortReason(reason)).toBe(AbortReason.Timeout);
  });

  it('emits task.message.orphaned for queued messages when task terminates', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe(e => events.push(e));

    const first = await agent.processMessage({ content: 'one', sessionId: 's' }, { bus });
    agent.tasks.update(first.taskId!, { status: 'executing' });

    const second = await agent.processMessage({ content: 'two', sessionId: 's' }, { bus });
    expect((second as any).queued).toBe(true);
    expect(agent.messageQueue.pendingCount()).toBe(1);

    // Directly invoke the termination-drain helper (name per implementation)
    (agent as any).drainQueueOnTermination(first.taskId!, 'task_completed');

    const orphanEvents = events.filter(e => e.type === 'task.message.orphaned');
    expect(orphanEvents.length).toBe(1);
    expect(orphanEvents[0].data.content).toBe('two');
    expect(orphanEvents[0].data.reason).toBe('task_completed');
    expect(agent.messageQueue.pendingCount()).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/loop/dual-cancel.test.ts`
Expected: FAIL.

- [ ] **Step 4: Modify cancel()**

In `src/loop/dual.ts`:

```typescript
import { AbortReason, createAbortError, type AbortReasonValue } from '../abort.js';

// ... inside class

cancel(reason: AbortReasonValue = AbortReason.UserExplicitCancel): void {
  if (this.abortController) {
    this.abortController.abort(createAbortError(reason));
  }
  const active = this.tasks.getActive();
  if (active) {
    try { this.stateMachine.fail(active, `cancelled: ${reason}`); }
    catch { /* already terminal */ }
    log.info('task cancelled', { taskId: active.id, reason });
    this.drainQueueOnTermination(active.id, 'task_aborted');
  }
}

/** Drain any queued messages for a task that is terminating, emit orphaned events. */
private drainQueueOnTermination(taskId: string, reason: 'task_completed' | 'task_aborted'): void {
  const drained = this.messageQueue.drainForTask(taskId);
  if (!this.activeBus) return;
  for (const m of drained) {
    this.activeBus.publish({
      type: 'task.message.orphaned',
      data: { taskId, messageId: m.id, content: m.content, reason },
    });
  }
}
```

Also wire `drainQueueOnTermination(task.id, 'task_completed')` at the end of `runInnerLoop` on natural termination (success path). Find where `runInnerLoop` publishes `chat.final` or the completion checkpoint; add the drain call immediately after state transition to `completed`.

- [ ] **Step 5: Update IAgentLoop.cancel() signature**

In `src/loop/types.ts`, modify `cancel()` declaration:

```typescript
cancel(reason?: 'user_interrupted' | 'user_explicit_cancel' | 'timeout' | 'sibling_error' | 'server_shutdown'): void;
```

Or more precisely, `cancel(reason?: AbortReasonValue): void;` with an import. Match whichever style matches existing type imports in the file.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/loop/dual-cancel.test.ts tests/loop/dual-routing.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/loop/dual.ts src/loop/types.ts src/sse.ts tests/loop/dual-cancel.test.ts
git commit -m "feat(C5): DualLoopAgent.cancel(reason) + drain queue on task termination (Gap 3)"
```

---

### Task C6: Rust — upgrade cancelled flag to Option<AbortReason>

**Files:**
- Modify: `rust/crates/lumin-core/src/abort.rs` (create)
- Modify: `rust/crates/lumin-core/src/agent.rs` — use new enum, check between streaming chunks (if feasible)
- Modify: `rust/crates/lumin-core/src/loop_dual.rs` — store `Option<AbortReason>` in Mutex
- Modify: `rust/crates/lumin-core/src/lib.rs` — export `abort` module
- Modify: `rust/crates/lumin-core/tests/abort.rs` (create)

Per Gate 1 = (c) **wire-schema-only Rust parity**, Rust gets the AbortReason enum and carries it through the cancellation path but does NOT need to add mid-streaming-chunk abort polling in this phase. Goal: keep wire protocol compatible with TS; keep iteration-boundary cancellation working (which already works).

- [ ] **Step 1: Create abort.rs**

```rust
// rust/crates/lumin-core/src/abort.rs
//! Structured abort reasons.  Mirrors TS `src/abort.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AbortReason {
    UserInterrupted,
    UserExplicitCancel,
    Timeout,
    SiblingError,
    ServerShutdown,
}

impl AbortReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::UserInterrupted => "user_interrupted",
            Self::UserExplicitCancel => "user_explicit_cancel",
            Self::Timeout => "timeout",
            Self::SiblingError => "sibling_error",
            Self::ServerShutdown => "server_shutdown",
        }
    }
}
```

- [ ] **Step 2: Write failing test**

```rust
// rust/crates/lumin-core/tests/abort.rs
use lumin_core::abort::AbortReason;

#[test]
fn abort_reason_snake_case_serialization() {
    let r = AbortReason::UserExplicitCancel;
    let json = serde_json::to_string(&r).unwrap();
    assert_eq!(json, "\"user_explicit_cancel\"");
}

#[test]
fn abort_reason_as_str_matches_ts() {
    assert_eq!(AbortReason::UserInterrupted.as_str(), "user_interrupted");
    assert_eq!(AbortReason::Timeout.as_str(), "timeout");
    assert_eq!(AbortReason::ServerShutdown.as_str(), "server_shutdown");
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd rust && cargo test -p lumin-core --test abort`
Expected: FAIL — `unresolved import lumin_core::abort`.

- [ ] **Step 4: Wire module in lib.rs**

Add to `rust/crates/lumin-core/src/lib.rs`:

```rust
pub mod abort;
pub use abort::AbortReason;
```

- [ ] **Step 5: Upgrade cancelled Mutex in loop_dual.rs**

Currently: `cancelled: Arc<Mutex<bool>>`. Change to:

```rust
cancelled: Arc<Mutex<Option<AbortReason>>>,
```

And update all the set/reset/check sites:
- `Mutex::new(false)` → `Mutex::new(None)`
- `*self.cancelled.lock().unwrap() = false` → `*self.cancelled.lock().unwrap() = None`
- `*self.cancelled.lock().unwrap() = true` → `*self.cancelled.lock().unwrap() = Some(reason)` (pass reason into `cancel(reason)`)
- Check: `if *cancelled.lock().unwrap() { ... }` → `if cancelled.lock().unwrap().is_some() { ... }`

Thread the `AbortReason` into `cancel()` signature, add default when called without arg.

- [ ] **Step 6: Update agent.rs signature**

`process_message` currently takes `cancelled: Option<Arc<Mutex<bool>>>`. Change to `Option<Arc<Mutex<Option<AbortReason>>>>`. Update the check at line 489 to match the new `Option<Option<AbortReason>>` semantics.

When returning the abort error, include the reason:
```rust
if let Some(reason) = flag.lock().unwrap().as_ref() {
    return Err(format!("Cancelled: {}", reason.as_str()));
}
```

- [ ] **Step 7: Run tests**

Run: `cd rust && cargo test -p lumin-core`
Expected: all PASS (existing cancellation tests should still pass with the new signature).

Run: `cd rust && cargo test -p lumin-core --test abort`
Expected: 2 PASS.

- [ ] **Step 8: Commit**

```bash
cd rust
git add crates/lumin-core/src/abort.rs crates/lumin-core/src/lib.rs crates/lumin-core/src/loop_dual.rs crates/lumin-core/src/agent.rs crates/lumin-core/tests/abort.rs
git commit -m "feat(C6): Rust AbortReason enum + upgrade cancelled flag to Option<AbortReason>"
```

---

### Task C7: Capability test C4 — reliable cancel end-to-end

**Files:**
- Create: `docs/superpowers/plans/2026-04-13-c4-after-phase-c.md`

Re-run the C4 capability test from audit doc §2 against the post-Phase-C build.

- [ ] **Step 1: Build + start server**

```bash
cd /Users/prismer/workspace/luminclaw
npx tsc
export $(grep -v '^#' .env.test | xargs)
export LUMIN_LOOP_MODE=dual
node dist/cli.js serve --port 3001 &
SERVER_PID=$!
sleep 2
curl -s http://localhost:3001/health
```

- [ ] **Step 2: Start a task, cancel after 2s, verify it terminates within 5s**

```bash
SID="c4-$(date +%s)"

# Start a task that would run for 30s without interruption
curl -s -X POST http://localhost:3001/v1/chat \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"Run: bash -c 'for i in \$(seq 30); do echo step \$i; sleep 1; done' and report when done\", \"sessionId\": \"$SID\"}" \
  > /tmp/p1.json
TASK=$(python3 -c "import json; print(json.load(open('/tmp/p1.json'))['taskId'])")
echo "Task: $TASK"

sleep 2

# Issue cancel via the HTTP cancel endpoint (if it exists) or via internal cancel() method.
# Phase C does NOT add POST /v1/tasks/:id/cancel — that's Phase C's Phase C (roadmap task C6).
# For the acceptance measurement, approximate via SIGTERM to the server and verify
# graceful ServerShutdown abort, OR extend this task to add POST /v1/tasks/:id/cancel.

# If cancel endpoint is not yet added, this test is partial — record status and move on.
# Otherwise:
# curl -X POST http://localhost:3001/v1/tasks/$TASK/cancel -d '{"reason":"user_explicit_cancel"}'

# Poll until status changes from 'executing'
for i in $(seq 1 10); do
  STATUS=$(curl -s http://localhost:3001/v1/tasks/$TASK | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  echo "t=${i}s status=$STATUS"
  if [ "$STATUS" != "executing" ]; then break; fi
  sleep 1
done

kill $SERVER_PID 2>/dev/null
```

If no HTTP cancel endpoint exists (it doesn't in Phase C unless added), mark this test as "C4 verified at unit-level only" and add a follow-up task to expose `POST /v1/tasks/:id/cancel`.

- [ ] **Step 3: Write report**

Write `docs/superpowers/plans/2026-04-13-c4-after-phase-c.md` with the same shape as `c1-after-phase-a.md`:
- §0 Environment
- §1 C4 measurement (status transition time, synthetic tool_result presence)
- §2 AbortReason structured propagation (verified via logs)
- §3 Rust parity (verified via `cargo test`)
- §4 Summary — audit-claim verification
- §5 Machine-readable metric table

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-04-13-c4-after-phase-c.md
git commit -m "test(C7): C4 post-Phase-C measurement — structured abort verified"
```

---

## Cross-Task Summary

| Task | What | New Tests | Est. Lines |
|------|------|-----------|-----------|
| C1 | `src/abort.ts` + helpers | 6 | ~50 |
| C2 | LLM fetch abort propagation | 1 | ~15 |
| C3 | ToolContext.abortSignal | 1 | ~20 |
| C4 | Synthetic [Aborted] tool_result | 1 | ~25 |
| C5 | cancel(reason) + termination drain | 2 | ~40 |
| C6 | Rust AbortReason enum + cancelled upgrade | 2 | ~50 |
| C7 | C4 capability measurement | 0 (report) | — |
| **Total** | | **13** | **~200** |

---

## Self-Review

**Spec coverage — audit doc §3 Phase C:**
- C1 AbortReason enum → **Task C1** ✓
- C2 signal into LLM fetch → **Task C2** ✓
- C3 signal into tool execution → **Task C3** ✓
- C4 synthetic tool_result → **Task C4** ✓
- C5 Rust cancelled flag actually checked → baseline finding: already checked at iteration boundary. **Task C6** upgrades the type to carry reason. **Phase D** or **Phase C follow-up** can add mid-stream abort to Rust if needed — left as future work per Gate 1 (c).
- Gap 3 from Phase A → **Task C5** drainQueueOnTermination ✓

**Placeholder scan:** clear — all steps have concrete commands or code blocks.

**Type consistency:**
- `AbortReason` enum values: `user_interrupted | user_explicit_cancel | timeout | sibling_error | server_shutdown` — consistent between `src/abort.ts` (TS) and `rust/.../abort.rs` (Rust), snake_case over the wire.
- `AbortReasonValue` (TS) vs `AbortReason` (Rust) — the string values match.
- `createAbortError(reason)` returns an Error named `AbortError` with message `abort:<reason>` — used in C2, C5.
- `task.message.orphaned` event shape: `{ taskId, messageId, content, reason: 'task_completed' | 'task_aborted' }` — consistent across the one place it's defined (sse.ts) and published (dual.ts).

**Known open items not in this phase:**
- `POST /v1/tasks/:id/cancel` HTTP endpoint — not wired in Phase C. Add as separate HTTP surface task if users need remote cancel.
- Rust mid-stream abort polling — deferred per Gate 1 (c); iteration-boundary cancellation is sufficient for wire parity.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-13-phase-c-structured-abort-impl.md`.**

Execution via `superpowers:subagent-driven-development` — one subagent per task, spec + code quality review between tasks.
