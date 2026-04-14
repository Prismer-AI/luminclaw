/**
 * Phase E — knowledge persistence (real LLM).
 *
 * Rewritten per `no_mock_for_agent_infra`. First test directly calls
 * `persistKnowledgeBase` after seeding the worldModel — this validates the
 * persistence mechanism without simulating an LLM run. Second test drives a
 * real LLM task start and verifies the knowledge recall wiring seeds the
 * new worldModel.knowledgeBase from the MemoryStore.
 */
import { it, expect } from 'vitest';
import { MemoryStore } from '../../src/memory.js';
import { FileMemoryBackend } from '../../src/memory-file-backend.js';
import { EventBus } from '../../src/sse.js';
import { describeReal, useRealLLMWorkspace, waitUntil } from '../helpers/real-llm.js';

describeReal('Phase E — knowledge persistence (real LLM)', () => {
  const env = useRealLLMWorkspace();

  it('persistKnowledgeBase writes worldModel.knowledgeBase to MemoryStore', async () => {
    const agent = env.makeAgent();
    const taskId = 'test-task-knowledge';
    agent.tasks.create({
      id: taskId,
      sessionId: 's',
      instruction: 'go',
      artifactIds: [],
      status: 'executing',
    });

    // Seed a worldModel directly on the private field so persistKnowledgeBase
    // has something to serialize. This inspects/sets state — it doesn't mock
    // agent behaviour.
    (agent as unknown as { worldModel: unknown }).worldModel = {
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

    await (agent as unknown as { persistKnowledgeBase: (id: string) => Promise<void> })
      .persistKnowledgeBase(taskId);

    // Fresh MemoryStore confirms the fact was persisted durably.
    const memStore = new MemoryStore(new FileMemoryBackend(env.dir()));
    const recalled = await memStore.recall('config.path', 4000);
    expect(recalled).toContain('config.path');
    expect(recalled).toContain('/etc/foo');
  }, 60_000);

  it('new task recalls prior knowledge from MemoryStore into worldModel.knowledgeBase', async () => {
    // Pre-populate the workspace's MemoryStore with a fact (as if a previous
    // task had persisted it).
    const seedStore = new MemoryStore(new FileMemoryBackend(env.dir()));
    await seedStore.store('database.host: db.example.com', ['world-model']);

    const agent = env.makeAgent();
    const result = await agent.processMessage(
      { content: 'Reply with ok.', sessionId: 's2' },
      { bus: new EventBus() },
    );
    expect(result.taskId).toBeTruthy();

    // processMessage awaits the recall inline before returning, but we poll
    // defensively in case ordering shifts.
    const recalled = await waitUntil(() => {
      const wm = (agent as unknown as { worldModel: { knowledgeBase: { key: string }[] } | null }).worldModel;
      return !!wm && wm.knowledgeBase.some(f => f.key === 'database.host');
    }, 5_000, 50);
    expect(recalled).toBe(true);

    const wm = (agent as unknown as { worldModel: { knowledgeBase: { key: string; value: string }[] } }).worldModel;
    const fact = wm.knowledgeBase.find(f => f.key === 'database.host');
    expect(fact).toBeDefined();
    expect(fact!.value).toContain('db.example.com');
  }, 60_000);
});
