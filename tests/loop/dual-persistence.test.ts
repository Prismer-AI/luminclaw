/**
 * DualLoopAgent — disk persistence (real LLM).
 *
 * Rewritten per `no_mock_for_agent_infra`. The real inner loop's disk-write
 * behaviour is exercised end-to-end: metadata + user turn at creation, status
 * turn on terminal transition.
 */
import { it, expect } from 'vitest';
import { EventBus } from '../../src/sse.js';
import { readMeta, readTranscript } from '../../src/task/disk.js';
import { describeReal, useRealLLMWorkspace, waitUntil, waitUntilTerminal } from '../helpers/real-llm.js';

describeReal('DualLoopAgent — disk persistence (real LLM)', () => {
  const env = useRealLLMWorkspace();

  it('writes metadata at task creation', async () => {
    const agent = env.makeAgent();
    const result = await agent.processMessage(
      { content: 'Reply with the word ok.', sessionId: 's1' },
      { bus: new EventBus() },
    );

    // writeMeta is fire-and-forget — poll the disk until it lands.
    const ok = await waitUntil(async () => {
      const meta = await readMeta(env.dir(), 's1', result.taskId!);
      return meta !== null;
    }, 5_000, 50);
    expect(ok).toBe(true);

    const meta = await readMeta(env.dir(), 's1', result.taskId!);
    expect(meta).not.toBeNull();
    expect(meta?.id).toBe(result.taskId);
    expect(meta?.instruction).toBe('Reply with the word ok.');
    expect(meta?.version).toBe(1);
  }, 60_000);

  it('writes user-turn entry on task creation', async () => {
    const agent = env.makeAgent();
    const result = await agent.processMessage(
      { content: 'Reply with the word ok.', sessionId: 's1' },
      { bus: new EventBus() },
    );

    await waitUntil(async () => {
      const turns = await readTranscript(env.dir(), 's1', result.taskId!);
      return turns.some(t => t.kind === 'user');
    }, 5_000, 50);

    const turns = await readTranscript(env.dir(), 's1', result.taskId!);
    const userTurn = turns.find(t => t.kind === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn!.kind === 'user' && userTurn.content).toBe('Reply with the word ok.');
  }, 60_000);

  it('writes a terminal status turn when the task completes', async () => {
    const agent = env.makeAgent();
    const result = await agent.processMessage(
      { content: 'Reply with the word ok and stop.', sessionId: 's2' },
      { bus: new EventBus() },
    );
    const finalStatus = await waitUntilTerminal(agent, result.taskId!, 60_000);
    expect(['completed', 'failed', 'killed']).toContain(finalStatus);

    // Allow persistState fire-and-forget to flush.
    await waitUntil(async () => {
      const meta = await readMeta(env.dir(), 's2', result.taskId!);
      return meta !== null && ['completed', 'failed', 'killed'].includes(meta.status);
    }, 5_000, 50);

    const meta = await readMeta(env.dir(), 's2', result.taskId!);
    expect(meta).not.toBeNull();
    expect(['completed', 'failed', 'killed']).toContain(meta!.status);

    const turns = await readTranscript(env.dir(), 's2', result.taskId!);
    const statusTurn = turns.find(t => t.kind === 'status' && ['completed', 'failed', 'killed'].includes((t as { status: string }).status));
    expect(statusTurn).toBeDefined();
  }, 90_000);
});
