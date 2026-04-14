/**
 * E4 regression — the dual-loop inner executor must register the full memory +
 * plan-mode tool surface (memory_store, memory_recall, enter_plan_mode,
 * exit_plan_mode) so its capabilities match `runAgent()`.
 *
 * Rewritten per `no_mock_for_agent_infra`: the tool-registry builder is now
 * exported as `buildInnerLoopToolRegistry` from `src/loop/dual.ts`. This test
 * exercises that pure function directly — no PrismerAgent, no LLM, no mocks.
 *
 * End-to-end coverage (the tools actually being invoked by the inner loop) is
 * provided by capability test C7 (cross-task knowledge).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildInnerLoopToolRegistry } from '../../src/loop/dual.js';
import { MemoryStore } from '../../src/memory.js';

describe('buildInnerLoopToolRegistry — inner executor tool surface', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-tool-reg-'));
  });

  afterEach(async () => {
    await fs.rm(tmpWorkspace, { recursive: true, force: true, maxRetries: 3 });
  });

  it('registers memory_store, memory_recall, enter_plan_mode, exit_plan_mode, and bash', async () => {
    const memStore = new MemoryStore(tmpWorkspace);
    const tools = await buildInnerLoopToolRegistry(tmpWorkspace, memStore);
    const names = tools.list().map(t => t.name);

    for (const required of ['memory_store', 'memory_recall', 'enter_plan_mode', 'exit_plan_mode', 'bash']) {
      expect(names, `missing ${required} — registered: ${names.join(', ')}`).toContain(required);
    }
  });

  it('memory_store tool writes durably to the given MemoryStore', async () => {
    const memStore = new MemoryStore(tmpWorkspace);
    const tools = await buildInnerLoopToolRegistry(tmpWorkspace, memStore);
    const storeTool = tools.list().find(t => t.name === 'memory_store');
    expect(storeTool).toBeDefined();

    const result = await storeTool!.execute({ content: 'fact-A', tags: ['t1'] }, {} as never);
    expect(result).toMatch(/stored/i);

    // Fresh MemoryStore over same dir: recall picks up the write.
    const fresh = new MemoryStore(tmpWorkspace);
    const recalled = await fresh.recall('fact-A', 4000);
    expect(recalled).toContain('fact-A');
  });
});
