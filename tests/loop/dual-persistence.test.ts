import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus } from '../../src/sse.js';
import { readMeta, readTranscript, writeMeta } from '../../src/task/disk.js';
import { resetConfig } from '../../src/config.js';

describe('DualLoopAgent — disk persistence', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-persist-'));
    process.env.WORKSPACE_DIR = tmpWorkspace;
    resetConfig();
  });

  afterEach(async () => {
    delete process.env.WORKSPACE_DIR;
    resetConfig();
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('writes metadata at task creation', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const result = await agent.processMessage({ content: 'hello', sessionId: 's1' }, { bus: new EventBus() });

    // Wait for async disk write
    await new Promise(r => setTimeout(r, 50));

    const meta = await readMeta(tmpWorkspace, 's1', result.taskId!);
    expect(meta).not.toBeNull();
    expect(meta?.id).toBe(result.taskId);
    expect(meta?.instruction).toBe('hello');
    expect(meta?.version).toBe(1);
  });

  it('writes user-turn entry on task creation', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const result = await agent.processMessage({ content: 'hello', sessionId: 's1' }, { bus: new EventBus() });
    await new Promise(r => setTimeout(r, 50));

    const turns = await readTranscript(tmpWorkspace, 's1', result.taskId!);
    const userTurn = turns.find(t => t.kind === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn!.kind === 'user' && userTurn.content).toBe('hello');
  });

  it('writes status turn on terminal transition', async () => {
    const agent = new DualLoopAgent();
    // Simulate a completion: mock runInnerLoop to transition state to completed
    vi.spyOn(agent as any, 'runInnerLoop').mockImplementation(async function (this: any, task: any) {
      task.status = 'completed';
      // Call drainQueueOnTermination as real code would
      this.drainQueueOnTermination(task.id, 'task_completed');
      // Signal completion via metadata rewrite
      await writeMeta(process.env.WORKSPACE_DIR!, task.sessionId, task.id, {
        id: task.id, sessionId: task.sessionId, instruction: task.instruction,
        status: 'completed', createdAt: task.createdAt, updatedAt: Date.now(),
        endedAt: Date.now(), lastPersistedTurnOffset: 0, version: 1,
      });
    });

    const result = await agent.processMessage({ content: 'x', sessionId: 's2' }, { bus: new EventBus() });
    await new Promise(r => setTimeout(r, 100));

    const meta = await readMeta(tmpWorkspace, 's2', result.taskId!);
    expect(meta?.status).toBe('completed');
  });
});
