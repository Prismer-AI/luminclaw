import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { writeMeta, appendTurn } from '../../src/task/disk.js';
import { resetConfig } from '../../src/config.js';

describe('resume interrupted task', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-resume-'));
    process.env.WORKSPACE_DIR = tmpWorkspace;
    resetConfig();
  });

  afterEach(async () => {
    delete process.env.WORKSPACE_DIR;
    resetConfig();
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('transitions interrupted → executing on resume', async () => {
    await writeMeta(tmpWorkspace, 'sess', 'task-r', {
      id: 'task-r',
      sessionId: 'sess',
      instruction: 'go',
      status: 'interrupted',
      createdAt: 1,
      updatedAt: 2,
      lastPersistedTurnOffset: 0,
      version: 1,
    });
    await appendTurn(tmpWorkspace, 'sess', 'task-r', {
      kind: 'user', content: 'go', timestamp: 1,
    });

    const agent = new DualLoopAgent();
    await agent.loadPersistedTasks();
    // Mock runInnerLoop — avoid real LLM. Resume already transitions to
    // 'executing' synchronously before dispatching; the mock is a no-op.
    vi.spyOn(agent as unknown as { runInnerLoop: (...a: unknown[]) => Promise<void> }, 'runInnerLoop')
      .mockImplementation(async () => { /* no-op */ });

    const result = await agent.resumeTask('task-r');
    expect(result.taskId).toBe('task-r');
    expect(result.sessionId).toBe('sess');

    const task = agent.tasks.get('task-r');
    expect(task?.status).toBe('executing');
  });

  it('throws for non-interrupted tasks', async () => {
    const agent = new DualLoopAgent();
    agent.tasks.create({
      id: 't',
      sessionId: 's',
      instruction: 'x',
      artifactIds: [],
      status: 'completed',
    });
    await expect(agent.resumeTask('t')).rejects.toThrow(/cannot resume/i);
  });

  it('throws for unknown taskId', async () => {
    const agent = new DualLoopAgent();
    await expect(agent.resumeTask('nope')).rejects.toThrow(/not found/i);
  });
});
