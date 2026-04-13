import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus } from '../../src/sse.js';

describe('DualLoopAgent — active-task routing', () => {
  let agent: DualLoopAgent;
  beforeEach(() => { agent = new DualLoopAgent(); });

  it('creates a new task on first message to a fresh session', async () => {
    // Stub out runInnerLoop to avoid hitting a real LLM.
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const bus = new EventBus();
    const r = await agent.processMessage(
      { content: 'hello', sessionId: 'sess-fresh' },
      { bus },
    );
    expect(r.taskId).toBeTruthy();
    expect(r.text).toContain('created and executing');
    expect((r as any).queued).toBeUndefined();
  });

  it('enqueues the message to the existing active task on subsequent calls', async () => {
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const bus = new EventBus();
    const first = await agent.processMessage(
      { content: 'first', sessionId: 'sess-R' }, { bus },
    );

    // Force the task into executing state (stub bypasses the real lifecycle).
    agent.tasks.update(first.taskId!, { status: 'executing' });

    const second = await agent.processMessage(
      { content: 'second', sessionId: 'sess-R' }, { bus },
    );
    expect(second.taskId).toBe(first.taskId);
    expect((second as any).queued).toBe(true);
    expect(second.text).toContain('queued');

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
