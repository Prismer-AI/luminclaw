import { describe, it, expect, vi } from 'vitest';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus, type AgentEvent } from '../../src/sse.js';
import { AbortReason, getAbortReason } from '../../src/abort.js';

describe('DualLoopAgent — cancel + termination drain', () => {
  it('cancel(reason) propagates reason to the AbortController signal', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as unknown as { runInnerLoop: () => Promise<void> }, 'runInnerLoop')
      .mockImplementation(async () => {
        // Hold the task in executing state
        await new Promise(r => setTimeout(r, 100));
      });

    const first = await agent.processMessage({ content: 'x', sessionId: 's' }, { bus: new EventBus() });
    agent.tasks.update(first.taskId!, { status: 'executing' });

    // Capture reason via the private abortController BEFORE cancel nulls it out
    const controller = (agent as unknown as { abortController: AbortController | null }).abortController;
    agent.cancel(AbortReason.Timeout);
    const reason = controller?.signal?.reason;
    expect(reason).toBeDefined();
    expect(getAbortReason(reason)).toBe(AbortReason.Timeout);
  });

  it('emits task.message.orphaned for queued messages when task terminates', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as unknown as { runInnerLoop: () => Promise<void> }, 'runInnerLoop')
      .mockResolvedValue(undefined);

    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe(e => events.push(e));

    const first = await agent.processMessage({ content: 'one', sessionId: 's' }, { bus });
    agent.tasks.update(first.taskId!, { status: 'executing' });

    const second = await agent.processMessage({ content: 'two', sessionId: 's' }, { bus });
    expect((second as unknown as { queued?: boolean }).queued).toBe(true);
    expect(agent.messageQueue.pendingCount()).toBe(1);

    // Directly invoke the termination-drain helper
    (agent as unknown as { drainQueueOnTermination: (id: string, r: 'task_completed' | 'task_aborted') => void })
      .drainQueueOnTermination(first.taskId!, 'task_completed');

    const orphanEvents = events.filter(e => e.type === 'task.message.orphaned');
    expect(orphanEvents.length).toBe(1);
    const ev = orphanEvents[0]! as Extract<AgentEvent, { type: 'task.message.orphaned' }>;
    expect(ev.data.content).toBe('two');
    expect(ev.data.reason).toBe('task_completed');
    expect(ev.data.taskId).toBe(first.taskId);
    expect(ev.data.messageId).toBeTruthy();
    expect(agent.messageQueue.pendingCount()).toBe(0);
  });
});
