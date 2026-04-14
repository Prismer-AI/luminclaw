/**
 * DualLoopAgent — per-task AbortController isolation + drain-on-exception (real LLM).
 *
 * Rewritten per `no_mock_for_agent_infra`. The drain-on-exception test is
 * skipped because provoking a deterministic runInnerLoop crash requires
 * mocking internal failure points; the crash path's drain-queue behaviour is
 * covered end-to-end by the C4 capability test.
 */
import { it, expect } from 'vitest';
import { EventBus } from '../../src/sse.js';
import { AbortReason } from '../../src/abort.js';
import { describeReal, useRealLLMWorkspace, waitUntil } from '../helpers/real-llm.js';
import type { DualLoopAgent } from '../../src/loop/dual.js';

type TaskCtxMap = Map<string, { abortController: AbortController; bus: EventBus }>;

async function waitUntilExecuting(agent: DualLoopAgent, taskId: string, timeoutMs = 15_000): Promise<boolean> {
  return waitUntil(() => agent.tasks.get(taskId)?.status === 'executing', timeoutMs, 50);
}

describeReal('DualLoopAgent — per-task AbortController isolation (real LLM)', () => {
  const env = useRealLLMWorkspace();

  it('cancel(taskId) cancels only the specified task in a multi-task scenario', async () => {
    const agent = env.makeAgent();

    const slowPrompt = 'Reply with the number 1, then 2, then 3, each on its own line, separated by pauses.';
    const t1 = await agent.processMessage(
      { content: slowPrompt, sessionId: 's1' }, { bus: new EventBus() },
    );
    const t2 = await agent.processMessage(
      { content: slowPrompt, sessionId: 's2' }, { bus: new EventBus() },
    );
    expect(await waitUntilExecuting(agent, t1.taskId!)).toBe(true);
    expect(await waitUntilExecuting(agent, t2.taskId!)).toBe(true);

    const contexts = (agent as unknown as { taskContexts: TaskCtxMap }).taskContexts;
    expect(contexts.size).toBe(2);
    const ctx1 = contexts.get(t1.taskId!);
    const ctx2 = contexts.get(t2.taskId!);
    expect(ctx1).toBeDefined();
    expect(ctx2).toBeDefined();

    // Cancel only t1
    agent.cancel(t1.taskId, AbortReason.UserExplicitCancel);

    expect(ctx1!.abortController.signal.aborted).toBe(true);
    expect(ctx2!.abortController.signal.aborted).toBe(false);
  }, 60_000);

  it('cancel() with no taskId when exactly one task is active still works (backwards-compat)', async () => {
    const agent = env.makeAgent();
    const t1 = await agent.processMessage(
      {
        content: 'Reply with the number 1, then 2, then 3, each on its own line, separated by pauses.',
        sessionId: 's1',
      },
      { bus: new EventBus() },
    );
    expect(await waitUntilExecuting(agent, t1.taskId!)).toBe(true);

    const contexts = (agent as unknown as { taskContexts: TaskCtxMap }).taskContexts;
    const ctx = contexts.get(t1.taskId!)!;

    agent.cancel(undefined, AbortReason.UserExplicitCancel);
    expect(ctx.abortController.signal.aborted).toBe(true);
  }, 60_000);

  // Deterministically provoking a runInnerLoop crash requires mocking internal
  // failure points (LLM provider throwing mid-iteration, disk I/O errors, etc).
  // Per `no_mock_for_agent_infra`, we prefer not to reintroduce mocks. The
  // crash-path drain-queue behaviour is exercised end-to-end by capability
  // test C4 (cancel transitions task to terminal state) and by the
  // drainQueueOnTermination assertions in dual-cancel.test.ts.
  // TODO: if a deterministic crash path is needed (e.g. a dedicated test-only
  // tool that throws), reinstate this test here.
  it.skip('drainQueueOnTermination fires when runInnerLoop throws', () => {
    // Covered indirectly by capability test C4 and dual-cancel orphaned-event test.
  });
});
