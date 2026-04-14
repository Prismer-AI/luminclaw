/**
 * Phase C review-blocker regression tests:
 * - Per-task AbortController isolation
 * - Drain queue on exception paths
 */
import { describe, it, expect, vi } from 'vitest';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus, type AgentEvent } from '../../src/sse.js';
import { AbortReason } from '../../src/abort.js';

type TaskCtxMap = Map<string, { abortController: AbortController; bus: EventBus }>;

describe('DualLoopAgent — per-task AbortController isolation', () => {
  it('cancel(taskId) cancels the specific task in a multi-task scenario', async () => {
    const agent = new DualLoopAgent();
    // Stub runInnerLoop to hold tasks executing
    vi.spyOn(agent as unknown as { runInnerLoop: () => Promise<void> }, 'runInnerLoop')
      .mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 500));
      });

    const t1 = await agent.processMessage({ content: 'a', sessionId: 's1' }, { bus: new EventBus() });
    agent.tasks.update(t1.taskId!, { status: 'executing' });
    const t2 = await agent.processMessage({ content: 'b', sessionId: 's2' }, { bus: new EventBus() });
    agent.tasks.update(t2.taskId!, { status: 'executing' });

    const contextsBefore = (agent as unknown as { taskContexts: TaskCtxMap }).taskContexts;
    expect(contextsBefore.size).toBe(2);
    const ctx1Before = contextsBefore.get(t1.taskId!);
    const ctx2Before = contextsBefore.get(t2.taskId!);
    expect(ctx1Before).toBeDefined();
    expect(ctx2Before).toBeDefined();

    // Cancel only t1
    agent.cancel(t1.taskId, AbortReason.UserExplicitCancel);

    // t1's controller aborted, t2's not
    expect(ctx1Before!.abortController.signal.aborted).toBe(true);
    expect(ctx2Before!.abortController.signal.aborted).toBe(false);
  });

  it('cancel() with no taskId when exactly one task active still works (backwards-compat)', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as unknown as { runInnerLoop: () => Promise<void> }, 'runInnerLoop')
      .mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 500));
      });

    const t1 = await agent.processMessage({ content: 'a', sessionId: 's1' }, { bus: new EventBus() });
    agent.tasks.update(t1.taskId!, { status: 'executing' });

    const contextsBefore = (agent as unknown as { taskContexts: TaskCtxMap }).taskContexts;
    const ctx = contextsBefore.get(t1.taskId!)!;

    agent.cancel(undefined, AbortReason.UserExplicitCancel);
    expect(ctx.abortController.signal.aborted).toBe(true);
  });
});

describe('DualLoopAgent — drain queue on exception paths', () => {
  it('drainQueueOnTermination fires when runInnerLoop throws (fire-and-forget .catch path)', async () => {
    const agent = new DualLoopAgent();
    // Make runInnerLoop reject AFTER a short delay so we have time to enqueue
    // a message before the fire-and-forget .catch handler fires.
    vi.spyOn(agent as unknown as { runInnerLoop: () => Promise<void> }, 'runInnerLoop')
      .mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 30));
        throw new Error('boom');
      });

    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe(e => events.push(e));

    // First message creates the task
    const first = await agent.processMessage({ content: 'x', sessionId: 's' }, { bus });
    agent.tasks.update(first.taskId!, { status: 'executing' });
    // Queue a message that should be orphaned when the inner loop crashes
    agent.messageQueue.enqueue(first.taskId!, 'leftover');

    // Wait long enough for the mocked rejection + .catch handler to fire
    await new Promise(r => setTimeout(r, 100));

    const orphaned = events.filter(e => e.type === 'task.message.orphaned');
    expect(orphaned.length).toBeGreaterThan(0);
    const ev = orphaned[0]! as Extract<AgentEvent, { type: 'task.message.orphaned' }>;
    expect(ev.data.content).toBe('leftover');
    expect(ev.data.reason).toBe('task_aborted');
  });
});
