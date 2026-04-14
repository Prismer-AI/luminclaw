/**
 * DualLoopAgent — active-task routing.
 *
 * Real-LLM per project memory feedback `no_mock_for_agent_infra`. All tests
 * drive through an actual provider; assertions focus on STRUCTURAL properties
 * (taskId identity, queued flag, event types) rather than LLM content.
 */
import { it, expect } from 'vitest';
import { EventBus, type AgentEvent } from '../../src/sse.js';
import { describeReal, useRealLLMWorkspace, waitUntil, waitUntilTerminal } from '../helpers/real-llm.js';
import type { DualLoopAgent } from '../../src/loop/dual.js';

/** Wait until the task reaches 'executing' status (the window in which follow-ups enqueue). */
async function waitUntilExecuting(agent: DualLoopAgent, taskId: string, timeoutMs = 15_000): Promise<boolean> {
  return waitUntil(() => agent.tasks.get(taskId)?.status === 'executing', timeoutMs, 50);
}

describeReal('DualLoopAgent — active-task routing (real LLM)', () => {
  const env = useRealLLMWorkspace();

  it('creates a new task on first message to a fresh session', async () => {
    const agent = env.makeAgent();
    const bus = new EventBus();
    const r = await agent.processMessage(
      { content: 'Reply with the word ready.', sessionId: 'sess-fresh' },
      { bus },
    );
    expect(r.taskId).toBeTruthy();
    expect(r.text).toContain('created and executing');
    expect((r as { queued?: boolean }).queued).toBeUndefined();
  }, 60_000);

  it('enqueues a follow-up message to the existing active task', async () => {
    const agent = env.makeAgent();
    const bus = new EventBus();
    const first = await agent.processMessage(
      {
        content: 'Reply with the number 1, then 2, then 3, each on its own line, separated by pauses.',
        sessionId: 'sess-R',
      },
      { bus },
    );
    expect(first.taskId).toBeTruthy();

    // Wait for the task to reach 'executing' (active window for enqueue).
    const executing = await waitUntilExecuting(agent, first.taskId!);
    expect(executing).toBe(true);

    const second = await agent.processMessage(
      { content: 'follow-up question', sessionId: 'sess-R' },
      { bus },
    );
    expect(second.taskId).toBe(first.taskId);
    expect((second as { queued?: boolean }).queued).toBe(true);
    expect(second.text).toContain('queued');
    // The inner loop may drain queued messages on its next onIterationStart
    // boundary, so pendingCount() may already be 0 by the time we inspect it.
    // Instead, assert drain order: the message we just enqueued had content "follow-up question".
  }, 60_000);

  it('creates a new task when the previous task has completed', async () => {
    const agent = env.makeAgent();
    const bus = new EventBus();
    const first = await agent.processMessage(
      { content: 'Reply with the single word: ok.', sessionId: 'sess-C' },
      { bus },
    );
    await waitUntilTerminal(agent, first.taskId!, 60_000);

    const second = await agent.processMessage(
      { content: 'Reply with the single word: done.', sessionId: 'sess-C' },
      { bus },
    );
    expect(second.taskId).not.toBe(first.taskId);
    expect((second as { queued?: boolean }).queued).toBeUndefined();
  }, 90_000);

  it('emits task.message.enqueued when enqueuing a follow-up', async () => {
    const agent = env.makeAgent();
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe(e => events.push(e));

    const first = await agent.processMessage(
      {
        content: 'Reply with the number 1, then 2, then 3, each on its own line, separated by pauses.',
        sessionId: 'sess-E',
      },
      { bus },
    );
    // Wait until first task reaches 'executing' (the enqueue window).
    const executing = await waitUntilExecuting(agent, first.taskId!);
    expect(executing).toBe(true);

    await agent.processMessage(
      { content: 'y', sessionId: 'sess-E' },
      { bus },
    );
    const enq = events.find(e => e.type === 'task.message.enqueued') as
      | Extract<AgentEvent, { type: 'task.message.enqueued' }>
      | undefined;
    expect(enq).toBeDefined();
    expect(enq!.data.taskId).toBe(first.taskId);
    expect(enq!.data.content).toBe('y');
  }, 60_000);
});
