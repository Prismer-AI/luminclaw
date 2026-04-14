/**
 * DualLoopAgent — cancel + termination drain (real LLM).
 *
 * Rewritten per `no_mock_for_agent_infra`. Exercises the real cancel codepath
 * (including stateMachine.fail, drainQueueOnTermination, abortController signal)
 * against a live LLM.
 */
import { it, expect } from 'vitest';
import { EventBus, type AgentEvent } from '../../src/sse.js';
import { AbortReason, getAbortReason } from '../../src/abort.js';
import {
  describeReal,
  useRealLLMWorkspace,
  waitUntil,
} from '../helpers/real-llm.js';
import type { DualLoopAgent } from '../../src/loop/dual.js';

async function waitUntilExecuting(agent: DualLoopAgent, taskId: string, timeoutMs = 15_000): Promise<boolean> {
  return waitUntil(() => agent.tasks.get(taskId)?.status === 'executing', timeoutMs, 50);
}

type TaskCtxMap = Map<string, { abortController: AbortController; bus: EventBus }>;

describeReal('DualLoopAgent — cancel + termination drain (real LLM)', () => {
  const env = useRealLLMWorkspace();

  it('cancel(taskId, reason) propagates the reason to the per-task AbortController', async () => {
    const agent = env.makeAgent();
    const first = await agent.processMessage(
      {
        content: 'Reply with the number 1, then 2, then 3, each on its own line, separated by pauses.',
        sessionId: 's',
      },
      { bus: new EventBus() },
    );
    expect(await waitUntilExecuting(agent, first.taskId!)).toBe(true);

    // Capture the per-task controller BEFORE cancel to inspect signal.reason.
    const ctx = (agent as unknown as { taskContexts: TaskCtxMap })
      .taskContexts.get(first.taskId!);
    expect(ctx).toBeDefined();

    agent.cancel(first.taskId, AbortReason.Timeout);
    const reason = ctx!.abortController.signal.reason;
    expect(reason).toBeDefined();
    expect(getAbortReason(reason)).toBe(AbortReason.Timeout);

    // Status should reflect cancellation (stateMachine.fail called synchronously).
    const task = agent.tasks.get(first.taskId!);
    expect(task?.status).toBe('failed');
    expect(task?.error ?? '').toMatch(/timeout/i);
  }, 60_000);

  it('emits task.message.orphaned for queued messages when task is cancelled', async () => {
    const agent = env.makeAgent();
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe(e => events.push(e));

    const first = await agent.processMessage(
      {
        content: 'Reply with the number 1, then 2, then 3, each on its own line, separated by pauses.',
        sessionId: 's',
      },
      { bus },
    );
    expect(await waitUntilExecuting(agent, first.taskId!)).toBe(true);

    // Enqueue a follow-up message while the task is still running.
    const second = await agent.processMessage(
      { content: 'leftover', sessionId: 's' },
      { bus },
    );
    expect((second as { queued?: boolean }).queued).toBe(true);

    // Cancel — this drives drainQueueOnTermination internally.
    agent.cancel(first.taskId, AbortReason.UserExplicitCancel);

    // Wait for orphan event to surface (drain is synchronous inside cancel
    // but the event-loop must flush subscribers).
    await waitUntil(
      () => events.some(e => e.type === 'task.message.orphaned'),
      5_000,
      50,
    );

    const orphanEvents = events.filter(e => e.type === 'task.message.orphaned');
    expect(orphanEvents.length).toBeGreaterThanOrEqual(1);
    const ev = orphanEvents[0]! as Extract<AgentEvent, { type: 'task.message.orphaned' }>;
    expect(ev.data.taskId).toBe(first.taskId);
    expect(ev.data.content).toBe('leftover');
    expect(ev.data.reason).toBe('task_aborted');
    expect(ev.data.messageId).toBeTruthy();
  }, 60_000);
});
