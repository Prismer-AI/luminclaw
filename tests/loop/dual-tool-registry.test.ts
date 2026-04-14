/**
 * E4 fix verification — runInnerLoop must register memory_store + memory_recall.
 *
 * Uses vi.mock at the module level to intercept PrismerAgent construction so
 * we can inspect the ToolRegistry that the inner executor builds without
 * making any real LLM calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resetConfig } from '../../src/config.js';
import type { ToolRegistry } from '../../src/tools.js';

// Capture the ToolRegistry that runInnerLoop passes to PrismerAgent.
let capturedTools: ToolRegistry | undefined;

// Mock PrismerAgent so runInnerLoop never makes a real LLM call.
// The factory intercepts `new PrismerAgent({ tools, ... })` and stores `tools`.
vi.mock('../../src/agent.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/agent.js')>();
  return {
    ...original,
    PrismerAgent: vi.fn().mockImplementation((opts: any) => {
      capturedTools = opts.tools;
      return {
        processMessage: async function* () {
          return { text: 'stubbed', directives: [], toolsUsed: [], iterations: 1 };
        },
      };
    }),
  };
});

describe('E4 fix — DualLoopAgent inner executor tool registry', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    capturedTools = undefined;
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-tool-reg-'));
    process.env.WORKSPACE_DIR = tmpWorkspace;
    resetConfig();
  });

  afterEach(async () => {
    delete process.env.WORKSPACE_DIR;
    resetConfig();
    await fs.rm(tmpWorkspace, { recursive: true, force: true, maxRetries: 3 });
  });

  it('registers memory_store and memory_recall in the inner executor tool registry', async () => {
    // Import DualLoopAgent *after* vi.mock so it picks up the mocked PrismerAgent.
    const { DualLoopAgent } = await import('../../src/loop/dual.js');
    const { Session } = await import('../../src/session.js');
    const { EventBus } = await import('../../src/sse.js');

    const agent = new DualLoopAgent();

    // Create a minimal task in 'executing' state to skip the planning LLM call.
    const taskId = 'tool-reg-test-task';
    agent.tasks.create({
      id: taskId,
      sessionId: 'tool-reg-session',
      instruction: 'test',
      artifactIds: [],
      status: 'executing',
    });
    const task = agent.tasks.get(taskId)!;

    const session = {
      id: 'tool-reg-session',
      messages: [],
      addMessage: () => {},
    } as any;

    const bus = new EventBus();
    const abortController = new AbortController();

    // Call runInnerLoop directly (it's private, use `as any`).
    // PrismerAgent is mocked → no LLM calls, just tool registration happens.
    await (agent as any).runInnerLoop(
      task,
      { content: 'test' },
      session,
      bus,
      abortController.signal,
    );

    await agent.shutdown();

    expect(
      capturedTools,
      'PrismerAgent mock was not called — runInnerLoop did not reach agent construction',
    ).toBeTruthy();

    const registeredNames = capturedTools!.list().map((t) => t.name);
    expect(
      registeredNames,
      `memory_store missing — registered tools: ${registeredNames.join(', ')}`,
    ).toContain('memory_store');
    expect(
      registeredNames,
      `memory_recall missing — registered tools: ${registeredNames.join(', ')}`,
    ).toContain('memory_recall');
  });
});
