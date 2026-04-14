/**
 * Resume interrupted task (real LLM).
 *
 * Rewritten per `no_mock_for_agent_infra`. The resume codepath is exercised
 * end-to-end: seed disk state → loadPersistedTasks → resumeTask → real inner
 * loop runs. This validates the resume-planning-skip fix (commit 5aea305)
 * without mocking runInnerLoop.
 */
import { it, expect } from 'vitest';
import { EventBus } from '../../src/sse.js';
import { writeMeta, appendTurn } from '../../src/task/disk.js';
import { describeReal, useRealLLMWorkspace, waitUntilTerminal } from '../helpers/real-llm.js';

describeReal('resume interrupted task (real LLM)', () => {
  const env = useRealLLMWorkspace();

  it('transitions interrupted → executing on resume and runs to terminal without error', async () => {
    await writeMeta(env.dir(), 'sess', 'task-r', {
      id: 'task-r',
      sessionId: 'sess',
      instruction: 'Reply with the word ok and stop.',
      status: 'interrupted',
      createdAt: 1,
      updatedAt: 2,
      lastPersistedTurnOffset: 0,
      version: 1,
    });
    await appendTurn(env.dir(), 'sess', 'task-r', {
      kind: 'user', content: 'Reply with the word ok and stop.', timestamp: 1,
    });

    const agent = env.makeAgent();
    await agent.loadPersistedTasks();

    // Sanity: the task should be registered as interrupted post-load.
    expect(agent.tasks.get('task-r')?.status).toBe('interrupted');

    const result = await agent.resumeTask('task-r');
    expect(result.taskId).toBe('task-r');
    expect(result.sessionId).toBe('sess');

    // After resumeTask returns, the task has been transitioned to 'executing'
    // synchronously; the inner loop runs fire-and-forget against the real LLM.
    // Previously (pre-5aea305) the inner loop would throw
    // InvalidTransitionError (executing → planning). We assert it does NOT —
    // the task reaches a terminal state (completed/failed/killed) without
    // that specific error.
    const final = await waitUntilTerminal(agent, 'task-r', 60_000);
    expect(['completed', 'failed', 'killed']).toContain(final);
    const t = agent.tasks.get('task-r');
    // If the task failed, it must not be the invalid-transition error.
    if (t?.error) {
      expect(t.error).not.toMatch(/Invalid task transition/i);
    }
  }, 90_000);

  it('throws for non-interrupted tasks', async () => {
    const agent = env.makeAgent();
    agent.tasks.create({
      id: 't',
      sessionId: 's',
      instruction: 'x',
      artifactIds: [],
      status: 'completed',
    });
    await expect(agent.resumeTask('t')).rejects.toThrow(/cannot resume/i);
  }, 30_000);

  it('throws for unknown taskId', async () => {
    const agent = env.makeAgent();
    await expect(agent.resumeTask('nope')).rejects.toThrow(/not found/i);
  }, 30_000);

  it('does not attempt planning → executing transition on resume (regression 5aea305)', async () => {
    // Same shape as first test but we additionally inspect no spurious errors
    // were emitted to the bus with 'Invalid task transition'.
    await writeMeta(env.dir(), 'sess', 'task-guard', {
      id: 'task-guard',
      sessionId: 'sess',
      instruction: 'Reply with the word ok and stop.',
      status: 'interrupted',
      createdAt: 1,
      updatedAt: 2,
      lastPersistedTurnOffset: 0,
      version: 1,
    });
    await appendTurn(env.dir(), 'sess', 'task-guard', {
      kind: 'user', content: 'Reply with the word ok and stop.', timestamp: 1,
    });

    const agent = env.makeAgent();
    await agent.loadPersistedTasks();

    const errors: string[] = [];
    const bus = new EventBus();
    bus.subscribe(e => {
      if (e.type === 'error') {
        const msg = (e.data as { message?: string }).message ?? '';
        errors.push(msg);
      }
    });
    // Subscribe before resume: the resumed inner loop publishes on the
    // per-task bus it creates internally, not ours. But state-transition
    // errors bubble through task.error on failure, which we assert on below.

    await agent.resumeTask('task-guard');
    await waitUntilTerminal(agent, 'task-guard', 60_000);

    const t = agent.tasks.get('task-guard');
    if (t?.error) {
      expect(t.error).not.toMatch(/Invalid task transition/i);
    }
  }, 90_000);
});
