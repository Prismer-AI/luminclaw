import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { MemoryStore } from '../../src/memory.js';
import { EventBus } from '../../src/sse.js';
import { resetConfig } from '../../src/config.js';

describe('Phase E — knowledge persistence', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-knowledge-'));
    process.env.WORKSPACE_DIR = tmpWorkspace;
    resetConfig();
  });

  afterEach(async () => {
    delete process.env.WORKSPACE_DIR;
    resetConfig();
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('writes worldModel.knowledgeBase to MemoryStore on completion', async () => {
    const agent = new DualLoopAgent();
    const taskId = 'test-task';
    agent.tasks.create({
      id: taskId,
      sessionId: 's',
      instruction: 'go',
      artifactIds: [],
      status: 'executing',
    });

    // Seed worldModel with facts (private field — use `as any`).
    (agent as any).worldModel = {
      taskId,
      goal: 'go',
      completedWork: [],
      workspaceState: {
        activeComponent: '',
        openFiles: [],
        recentArtifacts: [],
        componentSummaries: new Map<string, string>(),
      },
      knowledgeBase: [
        { key: 'config.path', value: '/etc/foo', sourceAgentId: 'a1', confidence: 'high' },
        { key: 'budget', value: '$100', sourceAgentId: 'a1', confidence: 'medium' },
      ],
      agentHandoffNotes: new Map<string, string>(),
    };

    await (agent as any).persistKnowledgeBase(taskId);

    // Fresh MemoryStore pointed at the same workspace confirms durability.
    const memStore = new MemoryStore(tmpWorkspace);
    const recalled = await memStore.recall('config.path', 4000);
    expect(recalled).toContain('config.path');
    expect(recalled).toContain('/etc/foo');

    await agent.shutdown();
  });

  it('recall on new task includes facts from previous task', async () => {
    // Pre-populate MemoryStore with a fact from a "prior" task.
    const memStore = new MemoryStore(tmpWorkspace);
    await memStore.store('database.host: db.example.com', ['world-model']);

    const agent = new DualLoopAgent();
    // Skip the actual inner loop — we only care about task-creation recall.
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const result = await agent.processMessage(
      { content: 'connect to database', sessionId: 's2' },
      { bus: new EventBus() },
    );
    expect(result.taskId).toBeTruthy();

    // Allow any microtasks to settle (processMessage awaits the recall inline,
    // but we guard against timing flakes in the test harness).
    await new Promise(r => setTimeout(r, 50));

    const wm = (agent as any).worldModel;
    expect(wm).toBeTruthy();
    const keys = wm.knowledgeBase.map((f: any) => f.key);
    expect(keys).toContain('database.host');

    await agent.shutdown();
  });
});
