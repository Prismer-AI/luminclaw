# Phase A — Message Queue + Task Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the process-scoped message queue between dialogue and execution loops so new user messages can steer in-flight tasks; add per-iteration progress events; extend `/v1/tasks/:id` with progress field.

**Architecture:** Introduce `MessageQueue` class owned by `DualLoopAgent`. Extend `TaskStore` with `getActiveForSession` and `updateProgress`. Add optional `onIterationStart` callback to `PrismerAgent` — called at the top of each iteration, `DualLoopAgent` passes a callback that drains the queue and injects messages into the session. Emit `task.progress` events per iteration. Extend `Task` type with a `progress` field; surface it via `GET /v1/tasks/:id`.

**Tech Stack:** TypeScript 5, vitest, Node built-ins.

**Scope boundaries:**
- **In scope:** Message queue, active-task routing, per-iteration progress, extended polling response (`progress` field only).
- **Out of scope (Phase B):** Disk persistence, `outputTail` in polling response, server-restart resume.
- **Out of scope (Phase C):** Abort/cancel via queue, structured abort reasons.
- **Out of scope (Rust):** Per Gate 1 decision (c), Rust gets schema parity only — no runtime PARA. The canonical-schema test pattern (from `tests/tool-schema-parity.test.ts`) extends to new event types but no Rust implementation is built in this phase.

---

## Context Files

Before starting any task, the implementer should skim these files:

- `src/loop/dual.ts` — `DualLoopAgent.processMessage` (lines 62–130) creates a task and spawns `runInnerLoop` (line 132+) in the background. Inner loop builds provider, runs planning, then calls `agent.processMessage(...)` on a `PrismerAgent`.
- `src/task/store.ts` — `InMemoryTaskStore` with `create/get/update/addCheckpoint/getActive/list/evictCompleted`. `getActive()` currently returns first executing/paused task globally (not per session).
- `src/task/types.ts` — `Task` shape. Status enum: `pending | planning | executing | paused | completed | failed`.
- `src/agent.ts:360` — `while (state.iteration++ < this.maxIterations)` is the inner iteration loop inside PrismerAgent. Immediately after the abort-signal check and before `microcompact` is the injection point for queue polling.
- `src/agent.ts:57-75` — `AgentOptions` interface. Add `onIterationStart` here.
- `src/sse.ts` — `EventBus` with `publish`, and `AgentEvent` discriminated-union event types. New event type `task.progress` gets added to that union.
- `src/server.ts:578-580` — `handleGetTask` already exists and returns the full Task object. We just need the `progress` field to appear on that object.
- `tests/loop-integration.test.ts` — real-LLM integration test pattern (skipped when `OPENAI_API_KEY` unset).
- `docs/superpowers/plans/2026-04-13-c1-baseline.md` — the baseline C1 measurement. Task A8 re-runs this exact script and expects different (improved) behavior.

**Commit convention:** `feat(A<N>):`, `test(A<N>):`, or `refactor(A<N>):` prefixes so phase tasks are greppable.

---

### Task A1: MessageQueue class

**Files:**
- Create: `src/task/message-queue.ts`
- Create: `tests/task/message-queue.test.ts`

A process-scoped FIFO keyed by `targetTaskId`. Not a global — owned by `DualLoopAgent` (one instance per loop).

- [ ] **Step 1: Write the failing test file**

```typescript
// tests/task/message-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from '../../src/task/message-queue.js';

describe('MessageQueue', () => {
  let q: MessageQueue;
  beforeEach(() => { q = new MessageQueue(); });

  it('enqueue returns a queued message with id + timestamp', () => {
    const m = q.enqueue('task-1', 'hello');
    expect(m.id).toMatch(/^[0-9a-f-]+$/);  // uuid-like
    expect(m.targetTaskId).toBe('task-1');
    expect(m.content).toBe('hello');
    expect(m.enqueuedAt).toBeGreaterThan(0);
  });

  it('drainForTask returns messages in FIFO order for the matching taskId', () => {
    q.enqueue('task-1', 'first');
    q.enqueue('task-2', 'unrelated');
    q.enqueue('task-1', 'second');
    const drained = q.drainForTask('task-1');
    expect(drained.map(m => m.content)).toEqual(['first', 'second']);
  });

  it('drainForTask leaves other tasks\' messages untouched', () => {
    q.enqueue('task-1', 'a');
    q.enqueue('task-2', 'b');
    q.drainForTask('task-1');
    const remaining = q.drainForTask('task-2');
    expect(remaining.map(m => m.content)).toEqual(['b']);
  });

  it('drainForTask returns [] when no messages for taskId', () => {
    q.enqueue('task-1', 'hi');
    expect(q.drainForTask('task-2')).toEqual([]);
  });

  it('drained messages are removed (second drain returns empty)', () => {
    q.enqueue('task-1', 'hi');
    q.drainForTask('task-1');
    expect(q.drainForTask('task-1')).toEqual([]);
  });

  it('pendingCount reflects un-drained messages', () => {
    expect(q.pendingCount()).toBe(0);
    q.enqueue('task-1', 'a');
    q.enqueue('task-2', 'b');
    expect(q.pendingCount()).toBe(2);
    q.drainForTask('task-1');
    expect(q.pendingCount()).toBe(1);
  });

  it('clear() wipes all messages', () => {
    q.enqueue('task-1', 'a');
    q.enqueue('task-2', 'b');
    q.clear();
    expect(q.pendingCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/task/message-queue.test.ts`
Expected: FAIL — `Cannot find module '../../src/task/message-queue.js'`

- [ ] **Step 3: Implement MessageQueue**

```typescript
// src/task/message-queue.ts
/**
 * Process-scoped FIFO message queue keyed by target taskId.
 *
 * Owned by DualLoopAgent. The outer dialogue loop enqueues user messages
 * via {@link MessageQueue.enqueue}; the inner execution loop drains them at
 * iteration boundaries via {@link MessageQueue.drainForTask}.
 *
 * This is the single architectural primitive that decouples dialogue latency
 * from task execution duration — see `docs/superpowers/plans/2026-04-13-dual-loop-architecture-design.md`
 * Pattern 1.
 *
 * @module task/message-queue
 */

import { randomUUID } from 'node:crypto';

export interface QueuedMessage {
  id: string;
  targetTaskId: string;
  content: string;
  enqueuedAt: number;
}

export class MessageQueue {
  private messages: QueuedMessage[] = [];

  /** Append a message targeting a specific task. Returns the enqueued record. */
  enqueue(targetTaskId: string, content: string): QueuedMessage {
    const msg: QueuedMessage = {
      id: randomUUID(),
      targetTaskId,
      content,
      enqueuedAt: Date.now(),
    };
    this.messages.push(msg);
    return msg;
  }

  /**
   * Remove and return all messages for a target task, in enqueue order.
   * Idempotent on empty state: returns [].
   */
  drainForTask(targetTaskId: string): QueuedMessage[] {
    const drained: QueuedMessage[] = [];
    const remaining: QueuedMessage[] = [];
    for (const m of this.messages) {
      if (m.targetTaskId === targetTaskId) drained.push(m);
      else remaining.push(m);
    }
    this.messages = remaining;
    return drained;
  }

  /** Total un-drained messages across all targets. */
  pendingCount(): number {
    return this.messages.length;
  }

  /** Wipe all messages. For tests and teardown. */
  clear(): void {
    this.messages = [];
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/task/message-queue.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/task/message-queue.ts tests/task/message-queue.test.ts
git commit -m "feat(A1): add MessageQueue for dialogue-execution decoupling"
```

---

### Task A2: TaskStore — `getActiveForSession` + `progress` field + `updateProgress`

**Files:**
- Modify: `src/task/types.ts`
- Modify: `src/task/store.ts`
- Modify: `tests/task/store.test.ts` (or create if missing)

Add per-session active-task lookup (needed by A3) and a mutable `progress` field (needed by A4).

- [ ] **Step 1: Check for existing test file**

Run: `ls tests/task/store.test.ts`
If present, open it to see the existing test style. If absent, create it in the pattern of sibling tests.

- [ ] **Step 2: Write failing tests**

Append these to `tests/task/store.test.ts` (or create the file with the import + describe scaffold if it does not exist):

```typescript
// add to tests/task/store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTaskStore } from '../../src/task/store.js';

describe('InMemoryTaskStore — Phase A additions', () => {
  let store: InMemoryTaskStore;
  beforeEach(() => { store = new InMemoryTaskStore(); });

  describe('getActiveForSession', () => {
    it('returns the executing task for a given sessionId', () => {
      const t = store.create({
        id: 't1', sessionId: 'sess-A', instruction: 'x',
        artifactIds: [], status: 'executing',
      });
      expect(store.getActiveForSession('sess-A')).toEqual(t);
    });

    it('ignores tasks in other sessions', () => {
      store.create({
        id: 't1', sessionId: 'sess-A', instruction: 'x',
        artifactIds: [], status: 'executing',
      });
      expect(store.getActiveForSession('sess-B')).toBeUndefined();
    });

    it('ignores completed / failed tasks', () => {
      store.create({
        id: 't1', sessionId: 'sess-A', instruction: 'x',
        artifactIds: [], status: 'completed',
      });
      store.create({
        id: 't2', sessionId: 'sess-A', instruction: 'y',
        artifactIds: [], status: 'failed',
      });
      expect(store.getActiveForSession('sess-A')).toBeUndefined();
    });

    it('treats paused as active', () => {
      const t = store.create({
        id: 't1', sessionId: 'sess-A', instruction: 'x',
        artifactIds: [], status: 'paused',
      });
      expect(store.getActiveForSession('sess-A')).toEqual(t);
    });
  });

  describe('updateProgress', () => {
    it('sets progress on a task', () => {
      store.create({
        id: 't1', sessionId: 'sess', instruction: 'x',
        artifactIds: [], status: 'executing',
      });
      const updated = store.updateProgress('t1', {
        iterations: 3,
        toolsUsed: ['bash', 'read_file'],
        lastActivity: 1234567890,
      });
      expect(updated?.progress).toEqual({
        iterations: 3,
        toolsUsed: ['bash', 'read_file'],
        lastActivity: 1234567890,
      });
    });

    it('merges partial progress updates', () => {
      store.create({
        id: 't1', sessionId: 'sess', instruction: 'x',
        artifactIds: [], status: 'executing',
      });
      store.updateProgress('t1', { iterations: 1, toolsUsed: [], lastActivity: 100 });
      const updated = store.updateProgress('t1', { iterations: 2, lastActivity: 200 });
      expect(updated?.progress).toEqual({
        iterations: 2, toolsUsed: [], lastActivity: 200,
      });
    });

    it('returns undefined for unknown taskId', () => {
      expect(store.updateProgress('nope', { iterations: 1, toolsUsed: [], lastActivity: 0 })).toBeUndefined();
    });
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run tests/task/store.test.ts`
Expected: FAIL — either `getActiveForSession is not a function` or `updateProgress is not a function`.

- [ ] **Step 4: Extend Task type**

In `src/task/types.ts`, add a `TaskProgress` interface and `progress?` field. Modify the file to match:

```typescript
// src/task/types.ts — add after Checkpoint section, before Task interface

export interface TaskProgress {
  /** Number of agent-loop iterations completed so far. */
  iterations: number;
  /** Unique tool names invoked so far, in first-use order. */
  toolsUsed: string[];
  /** Epoch-ms of last activity (LLM turn end or tool return). */
  lastActivity: number;
}
```

Then add `progress?: TaskProgress;` as a new field on the `Task` interface (after the `error?: string` line). And update the `TaskStore` interface at the bottom with two new method signatures:

```typescript
// Append inside TaskStore interface after existing methods, before closing brace
getActiveForSession(sessionId: string): Task | undefined;
updateProgress(id: string, progress: TaskProgress): Task | undefined;
```

- [ ] **Step 5: Implement in store.ts**

Add these two methods to `InMemoryTaskStore` in `src/task/store.ts` (before the closing `}` of the class):

```typescript
  getActiveForSession(sessionId: string): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId &&
          (task.status === 'executing' || task.status === 'paused')) {
        return task;
      }
    }
    return undefined;
  }

  updateProgress(id: string, progress: import('./types.js').TaskProgress): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.progress = { ...(task.progress ?? { iterations: 0, toolsUsed: [], lastActivity: 0 }), ...progress };
    task.updatedAt = Date.now();
    return task;
  }
```

Also update the top-of-file import line to include TaskProgress:

```typescript
import type { Task, Checkpoint, TaskStore, TaskProgress } from './types.js';
```

And change the `updateProgress` signature accordingly:

```typescript
updateProgress(id: string, progress: TaskProgress): Task | undefined {
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run tests/task/store.test.ts`
Expected: PASS — all 7 new tests.

Run full suite to make sure nothing broke:

Run: `npx vitest run tests/task/`
Expected: all existing + new tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/task/types.ts src/task/store.ts tests/task/store.test.ts
git commit -m "feat(A2): TaskStore.getActiveForSession + updateProgress + TaskProgress type"
```

---

### Task A3: Route new message to active task when one exists

**Files:**
- Modify: `src/loop/dual.ts`
- Modify: `tests/dual-loop-integration.test.ts` (or create a new `tests/loop/dual-routing.test.ts`)

When `DualLoopAgent.processMessage` is called and the session already has an executing task, enqueue the message to that task instead of creating a new one. Return immediately with `queued: true` and the existing `taskId`.

- [ ] **Step 1: Write failing tests**

Create `tests/loop/dual-routing.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus } from '../../src/sse.js';

describe('DualLoopAgent — active-task routing', () => {
  let agent: DualLoopAgent;
  beforeEach(() => { agent = new DualLoopAgent(); });

  it('creates a new task on first message to a fresh session', async () => {
    // Stub out runInnerLoop to avoid hitting a real LLM. We rely on the
    // fact that runInnerLoop is a method on the agent instance — override it.
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const bus = new EventBus();
    const r = await agent.processMessage(
      { content: 'hello', sessionId: 'sess-fresh' },
      { bus },
    );
    expect(r.taskId).toBeTruthy();
    expect(r.text).toContain('created and executing');
    // Non-queued responses do NOT carry queued: true
    expect((r as any).queued).toBeUndefined();
  });

  it('enqueues the message to the existing active task on subsequent calls', async () => {
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const bus = new EventBus();
    const first = await agent.processMessage(
      { content: 'first', sessionId: 'sess-R' }, { bus },
    );

    // Force the task into executing state (stub bypasses the real lifecycle)
    agent.tasks.update(first.taskId!, { status: 'executing' });

    const second = await agent.processMessage(
      { content: 'second', sessionId: 'sess-R' }, { bus },
    );
    expect(second.taskId).toBe(first.taskId);   // same task
    expect((second as any).queued).toBe(true);  // marked as queued
    expect(second.text).toContain('queued');

    // MessageQueue should contain the second message
    expect(agent.messageQueue.pendingCount()).toBe(1);
    const drained = agent.messageQueue.drainForTask(first.taskId!);
    expect(drained.map(m => m.content)).toEqual(['second']);
  });

  it('creates a new task when the previous task is completed', async () => {
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const bus = new EventBus();
    const first = await agent.processMessage(
      { content: 'one', sessionId: 'sess-C' }, { bus },
    );
    agent.tasks.update(first.taskId!, { status: 'completed' });

    const second = await agent.processMessage(
      { content: 'two', sessionId: 'sess-C' }, { bus },
    );
    expect(second.taskId).not.toBe(first.taskId);
    expect((second as any).queued).toBeUndefined();
  });

  it('emits task.message.enqueued event when enqueuing', async () => {
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));

    const first = await agent.processMessage(
      { content: 'x', sessionId: 'sess-E' }, { bus },
    );
    agent.tasks.update(first.taskId!, { status: 'executing' });

    await agent.processMessage(
      { content: 'y', sessionId: 'sess-E' }, { bus },
    );
    const kinds = events.map(e => e.type);
    expect(kinds).toContain('task.message.enqueued');
    const enq = events.find(e => e.type === 'task.message.enqueued');
    expect(enq.data.taskId).toBe(first.taskId);
    expect(enq.data.content).toBe('y');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/loop/dual-routing.test.ts`
Expected: FAIL — `agent.messageQueue is undefined` or `queued is undefined`.

- [ ] **Step 3: Add `task.message.enqueued` event type**

In `src/sse.ts`, find the `AgentEvent` discriminated union (search for `type:` patterns like `'task.created'`). Add this variant:

```typescript
  | { type: 'task.message.enqueued'; data: { taskId: string; messageId: string; content: string } }
```

- [ ] **Step 4: Wire MessageQueue into DualLoopAgent**

In `src/loop/dual.ts`:

1. Add import at the top:
```typescript
import { MessageQueue } from '../task/message-queue.js';
```

2. Add a public field on the class (right after `readonly sessions = new SessionStore();`):
```typescript
readonly messageQueue = new MessageQueue();
```

3. Rewrite `processMessage` to check for active task **first**. Replace the beginning of `processMessage` (lines 62–79, the block that creates `bus`, `sessionId`, calls `tasks.create`) with:

```typescript
async processMessage(input: AgentLoopInput, opts?: AgentLoopCallOpts): Promise<AgentLoopResult> {
  const bus = opts?.bus ?? new EventBus();
  this.activeBus = bus;

  const sessionId = input.sessionId ?? `dual-${Date.now()}`;

  // A3: If an active task exists for this session, enqueue and return early.
  const existing = this.tasks.getActiveForSession(sessionId);
  if (existing) {
    const queued = this.messageQueue.enqueue(existing.id, input.content);
    bus.publish({
      type: 'task.message.enqueued',
      data: { taskId: existing.id, messageId: queued.id, content: input.content.slice(0, 500) },
    });
    return {
      text: `Message queued for task ${existing.id}.`,
      directives: [],
      toolsUsed: [],
      iterations: 0,
      sessionId,
      taskId: existing.id,
      queued: true,
    };
  }

  // No active task — create one as before.
  this.abortController = new AbortController();
  const session = this.sessions.getOrCreate(sessionId);
  const taskId = randomUUID();

  const task = this.tasks.create({
    id: taskId, sessionId,
    instruction: input.content,
    artifactIds: this.artifacts.getUnassigned().map(a => a.id),
    status: 'pending',
  });
  // ... (rest of the existing body continues unchanged starting from the artifact assignment loop)
```

Be careful: the existing code extracts `taskId` from `randomUUID()` and uses it throughout. Preserve the variable-declaration order.

4. Add `queued?: boolean;` to `AgentLoopResult` in `src/loop/types.ts` if not already present:

```typescript
// src/loop/types.ts — add to AgentLoopResult
queued?: boolean;
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/loop/dual-routing.test.ts`
Expected: PASS — 4 tests.

Run the full dual-loop integration test to catch regressions:
Run: `npx vitest run tests/dual-loop-integration.test.ts`
Expected: PASS (may require `OPENAI_API_KEY`; if unset, tests are skipped).

Run the full test suite (non-LLM) to catch cross-module regressions:
Run: `npx vitest run --exclude 'tests/llm-integration.test.ts' --exclude 'tests/loop-integration.test.ts'`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/loop/dual.ts src/loop/types.ts src/sse.ts tests/loop/dual-routing.test.ts
git commit -m "feat(A3): route subsequent messages to active task via MessageQueue"
```

---

### Task A4: Plumb queue-drain into PrismerAgent iteration loop

**Files:**
- Modify: `src/agent.ts` (add `onIterationStart` to `AgentOptions`, call it at top of iteration loop)
- Modify: `tests/agent.test.ts` — add test for `onIterationStart`

Add an optional `onIterationStart` callback to `AgentOptions`. It fires once at the start of each iteration, right after the abort-signal check and before `microcompact`. DualLoopAgent will pass a callback that drains its `MessageQueue` (wired in A5).

- [ ] **Step 1: Write the failing test**

Add to `tests/agent.test.ts` (find an existing `describe('PrismerAgent', ...)` block and append inside it, or create a new block):

```typescript
describe('onIterationStart callback', () => {
  it('is invoked before each LLM call with (iteration, session)', async () => {
    // Provider returns a single response with no tool calls — loop runs one iteration.
    const provider = {
      chat: vi.fn().mockResolvedValue({
        text: 'done', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 },
      }),
      chatStream: undefined,
    };
    const calls: Array<{ iteration: number; sessionId: string }> = [];
    const agent = new PrismerAgent({
      provider: provider as any,
      tools: new ToolRegistry(),
      observer: new ConsoleObserver(),
      agents: new AgentRegistry(),
      systemPrompt: 'sys',
      maxIterations: 3,
      onIterationStart: async (iteration, session) => {
        calls.push({ iteration, sessionId: session.id });
      },
    });
    const session = new Session('sess-x');
    await agent.processMessage('hi', session);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ iteration: 1, sessionId: 'sess-x' });
  });

  it('fires once per iteration when the model requests tool calls', async () => {
    // First call: tool call; second call: final text.
    const provider = {
      chat: vi.fn()
        .mockResolvedValueOnce({
          text: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }],
          usage: { promptTokens: 1, completionTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: 'done', toolCalls: [],
          usage: { promptTokens: 2, completionTokens: 1 },
        }),
    };
    const tools = new ToolRegistry();
    tools.register(createTool(
      'bash', 'run',
      { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      async () => 'ok',
    ));
    const calls: number[] = [];
    const agent = new PrismerAgent({
      provider: provider as any,
      tools, observer: new ConsoleObserver(), agents: new AgentRegistry(),
      systemPrompt: 'sys', maxIterations: 5,
      onIterationStart: async (iteration) => { calls.push(iteration); },
    });
    await agent.processMessage('hi', new Session('s'));
    expect(calls).toEqual([1, 2]);
  });

  it('works when callback is omitted (backwards compat)', async () => {
    const provider = {
      chat: vi.fn().mockResolvedValue({
        text: 'ok', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 },
      }),
    };
    const agent = new PrismerAgent({
      provider: provider as any,
      tools: new ToolRegistry(), observer: new ConsoleObserver(),
      agents: new AgentRegistry(), systemPrompt: 'sys', maxIterations: 2,
    });
    const r = await agent.processMessage('hi', new Session('s'));
    expect(r.text).toBe('ok');
  });
});
```

Make sure the imports at the top of `tests/agent.test.ts` include `createTool` from `../src/tools/index.js` if not already present.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/agent.test.ts -t "onIterationStart"`
Expected: FAIL — either `Invalid option onIterationStart` or `expected 1 to be 0`.

- [ ] **Step 3: Extend AgentOptions**

In `src/agent.ts`, in the `AgentOptions` interface (around line 57), add:

```typescript
  /**
   * Fires at the start of each iteration, before the LLM call.
   * DualLoopAgent uses this to drain its MessageQueue and inject queued
   * user messages into the session history. Errors are caught and logged;
   * they do not halt the iteration.
   */
  onIterationStart?: (iteration: number, session: Session) => Promise<void>;
```

And add `private readonly onIterationStart?: ...` to the class fields, initialize from options in the constructor.

Find the constructor (around line 195). Add:

```typescript
this.onIterationStart = options.onIterationStart;
```

Find the iteration loop (around line 360):

```typescript
while (state.iteration++ < this.maxIterations) {
  if (this.abortSignal?.aborted) { state.lastText = '[Aborted by user]'; break; }

  microcompact(state.messages, 5);
  // ...
}
```

Insert the callback invocation between the abort check and `microcompact`:

```typescript
while (state.iteration++ < this.maxIterations) {
  if (this.abortSignal?.aborted) { state.lastText = '[Aborted by user]'; break; }

  // A4: fire onIterationStart callback (DualLoopAgent uses this to drain MessageQueue)
  if (this.onIterationStart) {
    try { await this.onIterationStart(state.iteration, session); }
    catch (err) { log.warn('onIterationStart threw', { error: err instanceof Error ? err.message : String(err) }); }
  }

  microcompact(state.messages, 5);
  // ...
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/agent.test.ts -t "onIterationStart"`
Expected: PASS — 3 tests.

Regression check:
Run: `npx vitest run tests/agent.test.ts`
Expected: all PASS (no existing tests broken).

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts tests/agent.test.ts
git commit -m "feat(A4): add onIterationStart callback to PrismerAgent for queue polling"
```

---

### Task A5: Inner loop drains queue + emits task.progress

**Files:**
- Modify: `src/loop/dual.ts` (inside `runInnerLoop`)
- Modify: `src/sse.ts` (add `task.progress` event type)
- Modify: `tests/loop/dual-routing.test.ts` (extend with steering test — may need OPENAI_API_KEY)

Wire the queue-drain callback into the agent created inside `runInnerLoop`. Emit `task.progress` events per iteration with current progress.

- [ ] **Step 1: Add task.progress event type**

In `src/sse.ts`, extend `AgentEvent` union:

```typescript
  | { type: 'task.progress'; data: { taskId: string; iteration: number; toolsUsed: string[]; lastActivity: number } }
```

- [ ] **Step 2: Write failing test (unit-level, no LLM)**

This verifies that the callback passed to PrismerAgent does the right thing. Create or extend `tests/loop/dual-steering.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MessageQueue } from '../../src/task/message-queue.js';
import { Session } from '../../src/session.js';
import { InMemoryTaskStore } from '../../src/task/store.js';
import { EventBus } from '../../src/sse.js';

// Import the helper from dual.ts once we extract it; until then, test the
// callback behavior directly by reconstructing it inline.

describe('queue-drain callback (inner loop contract)', () => {
  it('drained messages are appended to the session as user messages', async () => {
    const queue = new MessageQueue();
    const store = new InMemoryTaskStore();
    const bus = new EventBus();
    const taskId = 'task-X';
    store.create({
      id: taskId, sessionId: 's', instruction: 'x',
      artifactIds: [], status: 'executing',
    });
    queue.enqueue(taskId, 'please skip node_modules');

    const session = new Session('s');
    // Build the callback the way runInnerLoop will — inlined for unit testing
    const drain = async (iteration: number) => {
      const drained = queue.drainForTask(taskId);
      for (const m of drained) {
        session.addMessage({ role: 'user', content: m.content });
        bus.publish({
          type: 'task.progress',
          data: { taskId, iteration, toolsUsed: [], lastActivity: Date.now() },
        });
      }
    };

    const events: any[] = [];
    bus.subscribe(e => events.push(e));

    await drain(1);

    const userMsgs = session.messages.filter(m => m.role === 'user');
    expect(userMsgs.map(m => m.content)).toContain('please skip node_modules');
    expect(events.some(e => e.type === 'task.progress')).toBe(true);
  });

  it('emits task.progress every iteration even when queue is empty', async () => {
    const bus = new EventBus();
    const store = new InMemoryTaskStore();
    const taskId = 't';
    store.create({
      id: taskId, sessionId: 's', instruction: 'x',
      artifactIds: [], status: 'executing',
    });

    const events: any[] = [];
    bus.subscribe(e => events.push(e));

    // Same pattern as the real callback — always publish progress.
    const tick = async (iteration: number) => {
      const task = store.get(taskId)!;
      const p = task.progress ?? { iterations: 0, toolsUsed: [], lastActivity: 0 };
      store.updateProgress(taskId, {
        iterations: iteration,
        toolsUsed: p.toolsUsed,
        lastActivity: Date.now(),
      });
      bus.publish({
        type: 'task.progress',
        data: { taskId, iteration, toolsUsed: p.toolsUsed, lastActivity: Date.now() },
      });
    };

    await tick(1);
    await tick(2);
    const progressEvents = events.filter(e => e.type === 'task.progress');
    expect(progressEvents.length).toBe(2);
    expect(progressEvents[0].data.iteration).toBe(1);
    expect(progressEvents[1].data.iteration).toBe(2);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run tests/loop/dual-steering.test.ts`
Expected: FAIL (on the task.progress assertion — the event type doesn't exist yet until Step 1 landed, but Step 1 added it, so this may actually PASS immediately. If it does, go to Step 4.)

- [ ] **Step 4: Wire the drain callback in runInnerLoop**

In `src/loop/dual.ts`, inside `runInnerLoop`, find where the `PrismerAgent` is constructed. Add the callback to its options. Look for the options object passed to `new PrismerAgent({ ... })`. Add:

```typescript
onIterationStart: async (iteration, sessionArg) => {
  // Drain queued messages targeting this task and push them into session history.
  const drained = this.messageQueue.drainForTask(task.id);
  for (const m of drained) {
    sessionArg.addMessage({ role: 'user', content: m.content });
  }
  // Update task.progress and emit task.progress event.
  const current = this.tasks.get(task.id);
  const prev = current?.progress ?? { iterations: 0, toolsUsed: [], lastActivity: 0 };
  const lastActivity = Date.now();
  this.tasks.updateProgress(task.id, {
    iterations: iteration,
    toolsUsed: prev.toolsUsed,
    lastActivity,
  });
  outerBus.publish({
    type: 'task.progress',
    data: { taskId: task.id, iteration, toolsUsed: prev.toolsUsed, lastActivity },
  });
},
```

Note: `toolsUsed` is tracked downstream after the agent loop completes (`result.toolsUsed`). For per-iteration emission we carry forward the previous value; it updates on task completion. (A fuller per-iteration tool tracking is Phase C scope.)

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/loop/dual-steering.test.ts`
Expected: PASS — 2 tests.

Full regression:
Run: `npx vitest run tests/loop/ tests/task/`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/loop/dual.ts src/sse.ts tests/loop/dual-steering.test.ts
git commit -m "feat(A5): drain MessageQueue + emit task.progress per iteration"
```

---

### Task A6: Extend GET /v1/tasks/:id response with progress

**Files:**
- Inspect: `src/server.ts:578-580` (where `handleGetTask` is called)
- Modify: `src/server.ts` — locate `handleGetTask` definition, confirm it just returns the raw task object (which now includes `progress` after A2)
- Modify: `tests/server.test.ts` — assert `progress` appears

A4 is already implemented (as discovered by baseline). After A2 added a `progress` field to the Task type, the existing `handleGetTask` automatically exposes it through its JSON serialization.

- [ ] **Step 1: Inspect current handleGetTask**

Run: `grep -n "handleGetTask" src/server.ts`

Open `src/server.ts` and read the function. It should return `json(res, 200, task)` or similar — passing the Task object through. If it explicitly picks fields, we need to add `progress` to the whitelist.

- [ ] **Step 2: Write failing test**

Add to `tests/server.test.ts`:

```typescript
describe('GET /v1/tasks/:id — progress field', () => {
  it('includes progress when the task has it', async () => {
    // Use the shared loop instance. The exact import pattern depends on how
    // tests bootstrap the server — follow the existing tests/server.test.ts
    // harness.  If the harness is not present, a minimal invocation:

    // This is the conceptual shape. The actual test form depends on whether
    // server.test.ts tests the HTTP layer end-to-end or the handler directly.
    // Use whatever pattern matches existing tests in that file.
    const { getLoop } = await import('../src/server.js' as string); // if exported
    const loop = getLoop() as any;
    if (loop.mode !== 'dual') return;  // skip if not dual-loop harness

    // Create a task with progress
    loop.tasks.create({
      id: 'test-progress-task',
      sessionId: 'sess',
      instruction: 'x',
      artifactIds: [],
      status: 'executing',
    });
    loop.tasks.updateProgress('test-progress-task', {
      iterations: 2,
      toolsUsed: ['bash', 'read_file'],
      lastActivity: 1234567890,
    });
    const task = loop.tasks.get('test-progress-task');
    expect(task.progress).toEqual({
      iterations: 2,
      toolsUsed: ['bash', 'read_file'],
      lastActivity: 1234567890,
    });
  });
});
```

**NOTE to the implementer:** `server.ts` may not export `getLoop`. If so, restructure this test to either (a) test `handleGetTask` directly by importing and calling it with a mock req/res, or (b) skip the HTTP-layer test and rely on the A2 store test (which already covers the underlying data path). Prefer (a) if `handleGetTask` is testable, (b) otherwise. Document the choice in the commit message.

- [ ] **Step 3: Verify pass-through**

Read `handleGetTask` in `src/server.ts`. If it does `json(res, 200, task)` — `progress` automatically appears. If it does `json(res, 200, { id: task.id, status: task.status, ... })` — add `progress: task.progress` to that object.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS — the progress field appears. If the HTTP harness is not present, the store test from A2 is the effective coverage.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(A6): surface TaskProgress in GET /v1/tasks/:id response"
```

---

### Task A7: Capability test — C1 re-run with expected pass

**Files:**
- Create: `docs/superpowers/plans/2026-04-13-c1-after-phase-a.md` (measurement report, same shape as baseline)

Re-run the exact measurement script from `2026-04-13-c1-baseline.md` §1 against the post-Phase-A server. Confirm: second POST to the same live session now returns `{ queued: true, taskId: <existing> }`; the running task sees the steering message; `task.progress` events appear in the event stream.

This task produces a measurement report, not code. It is required before Phase A is considered DONE.

- [ ] **Step 1: Prepare environment**

```bash
cd /Users/prismer/workspace/luminclaw
npx tsc  # build with Phase A changes
export $(grep -v '^#' .env.test | xargs)
export LUMIN_LOOP_MODE=dual
node dist/cli.js serve --port 3001 &
SERVER_PID=$!
sleep 2
curl -s http://localhost:3001/health
```

Expected: server reports `ok` or `degraded` (degraded is fine — workspace plugin optional).

- [ ] **Step 2: Reproduce C1 scenario**

```bash
SID="c1-after-$(date +%s)"
# POST 1: long task
time curl -s -X POST http://localhost:3001/v1/chat \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"Run: bash -c 'for i in \$(seq 30); do echo step \$i; sleep 1; done'\", \"sessionId\": \"$SID\"}" \
  | tee /tmp/post1.json

TASK1=$(python3 -c "import json; print(json.load(open('/tmp/post1.json'))['taskId'])")
echo "Task 1: $TASK1"

sleep 5

# POST 2: steering message — SAME sessionId
time curl -s -X POST http://localhost:3001/v1/chat \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"Actually, please tell me what you're doing right now\", \"sessionId\": \"$SID\"}" \
  | tee /tmp/post2.json

# Verify queued routing
python3 -c "import json; p = json.load(open('/tmp/post2.json')); assert p.get('taskId') == '$TASK1', f'expected same taskId, got {p.get(\"taskId\")}'; assert p.get('queued') is True, f'expected queued=True, got {p}'; print('A3 routing PASS')"
```

- [ ] **Step 3: Verify progress events via polling**

```bash
# Poll the task at intervals — confirm task.progress events accumulated as iterations
sleep 3
curl -s http://localhost:3001/v1/tasks/$TASK1 | python3 -m json.tool | tee /tmp/task.json
python3 -c "
import json; t = json.load(open('/tmp/task.json'))
p = t.get('progress')
assert p is not None, 'expected progress field'
assert p.get('iterations', 0) >= 1, f'expected iterations >= 1, got {p}'
print(f'A5 progress field PASS — iterations={p[\"iterations\"]}')
"
```

- [ ] **Step 4: Let task complete, verify steering took effect**

```bash
# Wait for task completion
for i in $(seq 1 60); do
  STATUS=$(curl -s http://localhost:3001/v1/tasks/$TASK1 | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  echo "t=${i}s status=$STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then break; fi
  sleep 1
done

# Inspect final result — should reference the steering message
curl -s http://localhost:3001/v1/tasks/$TASK1 | python3 -c "
import sys,json; t = json.load(sys.stdin)
result = t.get('result','')
print('=== Final task result ===')
print(result[:500])
# Heuristic: the model should mention the question from the steering message,
# not just the original sleep-loop instruction.
assert 'what' in result.lower() or 'doing' in result.lower() or 'right now' in result.lower(), \
  f'steering message appears not to have influenced result: {result[:200]}'
print('A-steering behavioural PASS (heuristic)')
"

kill $SERVER_PID
```

- [ ] **Step 5: Write measurement report**

Write `docs/superpowers/plans/2026-04-13-c1-after-phase-a.md` following the exact structure of `2026-04-13-c1-baseline.md`, including:

- Frontmatter (same fields as baseline)
- §1 Test C1 — with measured numbers, POST 1/POST 2 response bodies, verdict
- §2 Test C3 — polling endpoint progress field confirmation
- §3 Test C6 — (re-use baseline unchanged; mark as "not re-measured in Phase A — stable from baseline")
- §4 Summary — audit-claim verification table with PASS markers
- §5 Machine-readable metric table — same YAML shape as baseline
- §6 Delta-from-baseline section: side-by-side numbers, bold the three key deltas (`same_task_id`, `second_task_aware_of_first`, `iterations_per_task_progress_event`)

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-04-13-c1-after-phase-a.md
git commit -m "test(A7): C1 post-Phase-A measurement — message queue verified with real LLM"
```

---

## Cross-Task Summary

| Task | What | New Tests | Est. Lines |
|------|------|-----------|-----------|
| A1 | MessageQueue class | 7 | ~60 |
| A2 | TaskStore.getActiveForSession + updateProgress + TaskProgress | 7 | ~40 |
| A3 | Active-task routing in processMessage | 4 | ~40 |
| A4 | onIterationStart callback in PrismerAgent | 3 | ~20 |
| A5 | Queue drain + task.progress emission in runInnerLoop | 2 | ~30 |
| A6 | Progress field in GET /v1/tasks/:id | 1 | ~5 |
| A7 | C1 post-Phase-A measurement | 0 (behavioral) | report only |
| **Total** | | **24** | **~195** |

---

## Self-Review

**Spec coverage — companion audit doc §3 Phase A:**
- A1 (messageQueue.ts) → **Task A1** ✓
- A2 (inner loop polls queue) → **Task A4** (adds callback) + **Task A5** (wires it) ✓
- A3 (handler routes to active task) → **Task A3** ✓
- A4 (GET /v1/tasks/:id) → **Task A6** (only missing `progress` field, endpoint already exists per baseline) ✓
- A5 (task_progress event) → **Task A5** ✓
- C1 regression test → **Task A7** ✓

**Placeholder scan:** clear — every step has concrete code blocks or commands.

**Type consistency:**
- `TaskProgress` defined in A2, used in A2 store method, A5 event payload, A6 handler — consistent.
- `MessageQueue` class API: `enqueue`, `drainForTask`, `pendingCount`, `clear` — used consistently in A3 (enqueue) and A5 (drainForTask).
- `onIterationStart: (iteration: number, session: Session) => Promise<void>` — consistent in A4 definition and A5 call site.
- `AgentLoopResult.queued?: boolean` — added in A3, asserted in A3 tests and A7 script.
- `AgentEvent` variants `task.message.enqueued` (A3) and `task.progress` (A5) — both added.

**Known manual choice point:** Task A6 Step 2 has an if/else for how to test the HTTP layer depending on whether `server.ts` exports a test harness. This is deliberate — the implementer picks the approach that matches existing patterns, and documents the choice in the commit message. Not a placeholder; it's an explicit design affordance.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-13-phase-a-message-queue-impl.md`.**

Execution will follow via `superpowers:subagent-driven-development` skill — one subagent per task, with spec compliance + code quality review between tasks.
