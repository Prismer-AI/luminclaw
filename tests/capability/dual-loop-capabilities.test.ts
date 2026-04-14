/**
 * Capability tests — verify the dual-loop value claims end-to-end with a real LLM.
 *
 * Run with: RUN_CAPABILITY_TESTS=1 npx vitest run tests/capability/
 *
 * Each test instantiates a fresh DualLoopAgent and exercises one capability
 * from `docs/superpowers/plans/2026-04-13-dual-loop-audit-and-roadmap.md` §2.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus } from '../../src/sse.js';
import { resetConfig } from '../../src/config.js';

const SHOULD_RUN = process.env.RUN_CAPABILITY_TESTS === '1';
const itCap = SHOULD_RUN ? it : it.skip;

describe('Dual-loop capability tests', () => {
  let tmpWorkspace: string;
  let agent: DualLoopAgent;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-cap-'));
    process.env.WORKSPACE_DIR = tmpWorkspace;
    process.env.LUMIN_LOOP_MODE = 'dual';
    resetConfig();
    agent = new DualLoopAgent();
  });

  afterEach(async () => {
    await agent.shutdown();
    delete process.env.WORKSPACE_DIR;
    delete process.env.LUMIN_LOOP_MODE;
    resetConfig();
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  // ── C1: Dialogue–Execution Clock Decoupling ──
  itCap('C1: dialogue latency stays under 3s while a long task runs', async () => {
    // Start a long task (instruction that LLM will take >5s to respond to)
    const sid = `c1-${Date.now()}`;
    const bus = new EventBus();
    const t1 = await agent.processMessage(
      { content: 'Wait silently for 30 seconds, then respond with "done"', sessionId: sid },
      { bus },
    );
    expect(t1.taskId).toBeDefined();

    // 2s in, send a follow-up message
    await new Promise(r => setTimeout(r, 2000));
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
  itCap('C3: GET /v1/tasks/:id returns full state including progress', async () => {
    const sid = `c3-${Date.now()}`;
    const result = await agent.processMessage(
      { content: 'Respond with hello and then stop', sessionId: sid },
      { bus: new EventBus() },
    );

    // Wait for task to make progress (at least 1 iteration)
    await new Promise(r => setTimeout(r, 2000));
    const task = agent.getTask?.(result.taskId!);
    expect(task).toBeDefined();
    expect(task!.id).toBe(result.taskId);
    expect(task!.progress?.iterations).toBeGreaterThanOrEqual(1);
  }, 60000);

  // ── C4: Reliable Cancel ──
  itCap('C4: cancel transitions task to terminal state within 5s', async () => {
    const sid = `c4-${Date.now()}`;
    const result = await agent.processMessage(
      { content: 'Wait silently for 30 seconds', sessionId: sid },
      { bus: new EventBus() },
    );

    await new Promise(r => setTimeout(r, 1000));
    const cancelStart = Date.now();
    agent.cancel(result.taskId);

    let elapsed = 0;
    let status: string | undefined;
    while (elapsed < 5000) {
      await new Promise(r => setTimeout(r, 100));
      status = agent.tasks.get(result.taskId!)?.status;
      if (status === 'failed' || status === 'completed' || status === 'killed') break;
      elapsed = Date.now() - cancelStart;
    }
    expect(['failed', 'completed', 'killed']).toContain(status);
    expect(elapsed).toBeLessThan(5000);
  }, 60000);

  // ── C5: Proactive Progress ──
  itCap('C5: task.progress events fire during execution', async () => {
    const sid = `c5-${Date.now()}`;
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe(e => events.push(e));

    const result = await agent.processMessage(
      { content: 'Use bash to run "echo hello" then explain', sessionId: sid },
      { bus },
    );

    // Wait for completion
    let attempts = 0;
    while (attempts < 30 && !['completed', 'failed', 'killed'].includes(agent.tasks.get(result.taskId!)?.status ?? '')) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    const progressEvents = events.filter(e => e.type === 'task.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  // ── C6: Concurrent Task Isolation ──
  itCap('C6: 3 concurrent tasks complete with correct sessionId binding', async () => {
    const sids = [`c6a-${Date.now()}`, `c6b-${Date.now()}`, `c6c-${Date.now()}`];
    const results = await Promise.all(
      sids.map(sid => agent.processMessage(
        { content: 'reply with the word ready', sessionId: sid },
        { bus: new EventBus() },
      )),
    );

    expect(new Set(results.map(r => r.taskId)).size).toBe(3);

    // Wait for all completions
    await new Promise(r => setTimeout(r, 30000));
    for (let i = 0; i < 3; i++) {
      const task = agent.tasks.get(results[i].taskId!);
      expect(task?.sessionId).toBe(sids[i]);
    }
  }, 60000);

  // ── C7: Cross-Task Knowledge ──
  itCap('C7: task 2 can recall fact stored by task 1', async () => {
    // Task 1: store via memory_store
    const sid1 = `c7a-${Date.now()}`;
    const t1 = await agent.processMessage(
      { content: 'Use memory_store to remember: project-language is TypeScript', sessionId: sid1 },
      { bus: new EventBus() },
    );

    let attempts = 0;
    while (attempts < 30 && !['completed', 'failed'].includes(agent.tasks.get(t1.taskId!)?.status ?? '')) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    // Task 2: recall in a NEW session
    const sid2 = `c7b-${Date.now()}`;
    const t2 = await agent.processMessage(
      { content: 'What language is this project? Use memory_recall to find out.', sessionId: sid2 },
      { bus: new EventBus() },
    );
    attempts = 0;
    while (attempts < 30 && !['completed', 'failed'].includes(agent.tasks.get(t2.taskId!)?.status ?? '')) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    const task2 = agent.tasks.get(t2.taskId!);
    expect(task2?.result?.toLowerCase()).toMatch(/typescript|ts/);
  }, 90000);
});
