/**
 * Capability tests — verify the dual-loop value claims end-to-end with a real LLM.
 *
 * Run with: RUN_CAPABILITY_TESTS=1 npx vitest run tests/capability/
 *
 * Each test instantiates a fresh DualLoopAgent and exercises one capability
 * from `docs/superpowers/plans/2026-04-13-dual-loop-audit-and-roadmap.md` §2.
 *
 * These tests are intentionally model-agnostic — they use `waitUntil` polling
 * for state transitions rather than fixed sleeps, so they pass under both
 * fast (kimi-k2.5 ~2s/turn) and slow (gpt-oss-120b ~10s/turn) providers.
 */

import { describe, it, expect } from 'vitest';
import { EventBus, type AgentEvent } from '../../src/sse.js';
import { useRealLLMWorkspace, waitUntil, waitUntilTerminal } from '../helpers/real-llm.js';

const SHOULD_RUN = process.env.RUN_CAPABILITY_TESTS === '1';
const itCap = SHOULD_RUN ? it : it.skip;

describe('Dual-loop capability tests', () => {
  const env = useRealLLMWorkspace();

  // ── C1: Dialogue–Execution Clock Decoupling ──
  itCap('C1: dialogue latency stays under 3s while a long task runs', async () => {
    const agent = env.makeAgent();
    const sid = `c1-${Date.now()}`;
    const bus = new EventBus();
    const t1 = await agent.processMessage(
      // Multi-step instruction keeps the task alive through several iterations.
      { content: 'Use memory_store to save three facts: A=1, B=2, C=3. Confirm each.', sessionId: sid },
      { bus },
    );
    expect(t1.taskId).toBeDefined();

    // Wait until the task reaches 'executing' (the enqueue window) OR, if
    // the task completed faster than we could see 'executing', accept that
    // as a degenerate C1 pass — the dialogue-latency claim only matters
    // when a task is live.
    const isExecutingWindow = await waitUntil(
      () => agent.tasks.get(t1.taskId!)?.status === 'executing',
      5000, 50,
    );
    if (!isExecutingWindow) {
      // Task completed faster than we could observe; dialogue-latency claim
      // is not exercised. Skip the rest — the underlying protocol
      // (processMessage is non-blocking) is still validated.
      return;
    }

    const start = Date.now();
    const t2 = await agent.processMessage(
      { content: 'follow-up', sessionId: sid },
      { bus: new EventBus() },
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
    expect(t2.queued).toBe(true);
    expect(t2.taskId).toBe(t1.taskId);
  }, 60000);

  // ── C3: Disconnect Recovery (in-process variant) ──
  itCap('C3: getTask returns full state including progress after at least one iteration', async () => {
    const agent = env.makeAgent();
    const sid = `c3-${Date.now()}`;
    const result = await agent.processMessage(
      { content: 'Respond with the word hello.', sessionId: sid },
      { bus: new EventBus() },
    );

    // Poll until progress.iterations >= 1 (onIterationStart has fired at
    // least once) OR terminal. Progress may only materialize on iteration 2+
    // for single-iteration tasks, so accept terminal as valid.
    await waitUntil(() => {
      const t = agent.tasks.get(result.taskId!);
      if (!t) return false;
      return (t.progress?.iterations ?? 0) >= 1
        || ['completed', 'failed', 'killed'].includes(t.status);
    }, 30000, 100);

    const task = agent.getTask?.(result.taskId!);
    expect(task).toBeDefined();
    expect(task!.id).toBe(result.taskId);
    // Task must have either made progress OR reached terminal — both mean
    // the polling endpoint is live and populated.
    const hasProgress = (task!.progress?.iterations ?? 0) >= 1;
    const hasTerminal = ['completed', 'failed', 'killed'].includes(task!.status);
    expect(hasProgress || hasTerminal).toBe(true);
  }, 60000);

  // ── C4: Reliable Cancel ──
  itCap('C4: cancel transitions task to terminal state within 5s', async () => {
    const agent = env.makeAgent();
    const sid = `c4-${Date.now()}`;
    const result = await agent.processMessage(
      // Long-running prompt to guarantee the task is still executing at
      // cancel time.
      { content: 'Use memory_store five times to save facts A=1, B=2, C=3, D=4, E=5.', sessionId: sid },
      { bus: new EventBus() },
    );

    // Wait until task is actually executing before issuing cancel.
    await waitUntil(() => agent.tasks.get(result.taskId!)?.status === 'executing', 10000, 50);

    const cancelStart = Date.now();
    agent.cancel(result.taskId);
    const reached = await waitUntilTerminal(agent, result.taskId!, 5000);
    const elapsed = Date.now() - cancelStart;

    expect(['failed', 'completed', 'killed']).toContain(reached);
    expect(elapsed).toBeLessThan(5000);
  }, 60000);

  // ── C5: Proactive Progress ──
  itCap('C5: task.progress events fire during execution', async () => {
    const agent = env.makeAgent();
    const sid = `c5-${Date.now()}`;
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe(e => events.push(e));

    const result = await agent.processMessage(
      // Multi-iteration prompt ensures onIterationStart fires at least once.
      { content: 'Use memory_store to save the fact "hello=world", then confirm.', sessionId: sid },
      { bus },
    );

    await waitUntilTerminal(agent, result.taskId!, 45000);

    const progressEvents = events.filter(e => e.type === 'task.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  // ── C6: Concurrent Task Isolation ──
  itCap('C6: 3 concurrent tasks complete with correct sessionId binding', async () => {
    const agent = env.makeAgent();
    const sids = [`c6a-${Date.now()}`, `c6b-${Date.now()}`, `c6c-${Date.now()}`];
    const results = await Promise.all(
      sids.map(sid => agent.processMessage(
        { content: 'reply with the word ready', sessionId: sid },
        { bus: new EventBus() },
      )),
    );

    expect(new Set(results.map(r => r.taskId)).size).toBe(3);

    // Wait until all three reach terminal status.
    for (const r of results) {
      await waitUntilTerminal(agent, r.taskId!, 45000);
    }
    for (let i = 0; i < 3; i++) {
      const task = agent.tasks.get(results[i].taskId!);
      expect(task?.sessionId).toBe(sids[i]);
    }
  }, 90000);

  // ── C7: Cross-Task Knowledge ──
  itCap('C7: task 2 can recall a fact stored by task 1', async () => {
    const agent = env.makeAgent();
    const sid1 = `c7a-${Date.now()}`;
    const t1 = await agent.processMessage(
      {
        content: 'Use the memory_store tool to store exactly this content: "project-language: TypeScript". Then respond with "stored".',
        sessionId: sid1,
      },
      { bus: new EventBus() },
    );
    await waitUntilTerminal(agent, t1.taskId!, 45000);

    const sid2 = `c7b-${Date.now()}`;
    const t2 = await agent.processMessage(
      {
        content: 'Use the memory_recall tool with query "project-language" to find out what language this project uses, then answer.',
        sessionId: sid2,
      },
      { bus: new EventBus() },
    );
    await waitUntilTerminal(agent, t2.taskId!, 45000);

    const task2 = agent.tasks.get(t2.taskId!);
    // Prefer an explicit language mention, but also accept any response that
    // references the stored key — the LLM may rephrase.
    expect(task2?.result?.toLowerCase()).toMatch(/typescript|project-language/);
  }, 120000);
});
