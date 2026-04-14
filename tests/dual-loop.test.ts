/**
 * Tests for Phase 4 — DualLoopAgent + WorldModel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock index.js to prevent import cascade
vi.mock('../src/index.js', () => ({
  runAgent: vi.fn(),
}));

// ── WorldModel ───────────────────────────────────────────

describe('WorldModel', () => {
  it('createWorldModel returns empty model', async () => {
    const { createWorldModel } = await import('../src/world-model/builder.js');
    const model = createWorldModel('task-1', 'Write a paper about AI');
    expect(model.taskId).toBe('task-1');
    expect(model.goal).toBe('Write a paper about AI');
    expect(model.completedWork).toEqual([]);
    expect(model.knowledgeBase).toEqual([]);
    expect(model.workspaceState.activeComponent).toBe('');
  });

  it('buildHandoffContext produces compact string', async () => {
    const { createWorldModel, buildHandoffContext, recordCompletion } = await import('../src/world-model/builder.js');
    const model = createWorldModel('t1', 'Analyze dataset');

    recordCompletion(model, {
      agentId: 'data-analyst',
      task: 'Run statistical analysis',
      resultSummary: 'Found 3 significant correlations',
      toolsUsed: ['jupyter_execute', 'bash'],
      artifactsProduced: [],
      completedAt: Date.now(),
    });

    model.knowledgeBase.push({
      key: 'correlation_count',
      value: '3',
      sourceAgentId: 'data-analyst',
      confidence: 'high',
    });

    model.workspaceState.activeComponent = 'jupyter-notebook';
    model.workspaceState.componentSummaries.set('jupyter-notebook', '5 cells, all executed');

    const context = buildHandoffContext(model, 'latex-expert');
    expect(context).toContain('Analyze dataset');
    expect(context).toContain('data-analyst');
    expect(context).toContain('3 significant correlations');
    expect(context).toContain('correlation_count');
    expect(context).toContain('jupyter-notebook');
    expect(context.length).toBeLessThanOrEqual(3000);
  });

  it('buildHandoffContext truncates to 3000 chars', async () => {
    const { createWorldModel, buildHandoffContext, recordCompletion } = await import('../src/world-model/builder.js');
    const model = createWorldModel('t1', 'A'.repeat(500));

    // Add lots of completed work
    for (let i = 0; i < 20; i++) {
      recordCompletion(model, {
        agentId: `agent-${i}`,
        task: `Task ${i}: ${'X'.repeat(100)}`,
        resultSummary: `Result ${i}: ${'Y'.repeat(100)}`,
        toolsUsed: ['bash'],
        artifactsProduced: [],
        completedAt: Date.now(),
      });
    }

    // Add lots of facts
    for (let i = 0; i < 30; i++) {
      model.knowledgeBase.push({
        key: `fact_${i}`,
        value: 'Z'.repeat(80),
        sourceAgentId: 'test',
        confidence: 'high',
      });
    }

    const context = buildHandoffContext(model, 'test-agent');
    expect(context.length).toBeLessThanOrEqual(3000);
    expect(context).toContain('[... truncated to context budget]');
  });

  it('buildHandoffContext includes agent-specific handoff notes', async () => {
    const { createWorldModel, buildHandoffContext } = await import('../src/world-model/builder.js');
    const model = createWorldModel('t1', 'Research');
    model.agentHandoffNotes.set('latex-expert', 'Use CVPR template, 2-column format');

    const context = buildHandoffContext(model, 'latex-expert');
    expect(context).toContain('CVPR template');
  });

  it('buildHandoffContext filters low-confidence facts', async () => {
    const { createWorldModel, buildHandoffContext } = await import('../src/world-model/builder.js');
    const model = createWorldModel('t1', 'Test');
    model.knowledgeBase.push(
      { key: 'high', value: 'visible', sourceAgentId: 'a', confidence: 'high' },
      { key: 'low', value: 'hidden', sourceAgentId: 'a', confidence: 'low' },
    );

    const context = buildHandoffContext(model, 'test');
    expect(context).toContain('visible');
    expect(context).not.toContain('hidden');
  });
});

// ── extractStructuredFacts ───────────────────────────────

describe('extractStructuredFacts', () => {
  it('extracts file paths', async () => {
    const { extractStructuredFacts } = await import('../src/world-model/builder.js');
    const facts = extractStructuredFacts(
      'Created file at /workspace/paper/main.tex and /workspace/data/results.csv',
      'agent-1',
    );
    const paths = facts.filter(f => f.key === 'file_path');
    expect(paths).toHaveLength(2);
    expect(paths[0].value).toBe('/workspace/paper/main.tex');
    expect(paths[0].confidence).toBe('high');
  });

  it('extracts measurements', async () => {
    const { extractStructuredFacts } = await import('../src/world-model/builder.js');
    const facts = extractStructuredFacts('Found 47 citations across 8 sections, total 3.2MB');
    const measurements = facts.filter(f => f.key === 'measurement');
    expect(measurements.length).toBeGreaterThanOrEqual(2);
  });

  it('limits to 5 per category', async () => {
    const { extractStructuredFacts } = await import('../src/world-model/builder.js');
    const paths = Array.from({ length: 10 }, (_, i) => `/workspace/file${i}.txt`).join(' ');
    const facts = extractStructuredFacts(paths);
    expect(facts.filter(f => f.key === 'file_path').length).toBeLessThanOrEqual(5);
  });

  it('returns empty for text without patterns', async () => {
    const { extractStructuredFacts } = await import('../src/world-model/builder.js');
    expect(extractStructuredFacts('Hello world')).toEqual([]);
  });
});

// ── DualLoopAgent ────────────────────────────────────────

describe('DualLoopAgent', () => {
  it('has mode = dual', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const agent = new DualLoopAgent();
    expect(agent.mode).toBe('dual');
  });

  it('addArtifact stores in artifact store', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const agent = new DualLoopAgent();
    agent.addArtifact({
      id: 'test', url: 'https://img.png', mimeType: 'image/png',
      type: 'image', addedBy: 'user', taskId: null, addedAt: Date.now(),
    });
    expect(agent.artifacts.list()).toHaveLength(1);
  });

  it('cancel fails active task', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const { EventBus } = await import('../src/sse.js');
    const agent = new DualLoopAgent();

    // Stub runInnerLoop so the task stays executing instead of actually running
    const { vi } = await import('vitest');
    vi.spyOn(agent as unknown as { runInnerLoop: () => Promise<void> }, 'runInnerLoop')
      .mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 500));
      });

    const result = await agent.processMessage({ content: 'test', sessionId: 's1' }, { bus: new EventBus() });
    const task = agent.tasks.get(result.taskId!)!;
    agent.stateMachine.transition(task, 'executing');

    agent.cancel();
    expect(task.status).toBe('failed');
    expect(task.error).toBe('cancelled: user_explicit_cancel');
  });

  it('resume transitions paused task to executing', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const agent = new DualLoopAgent();

    const task = agent.tasks.create({
      id: 'resume-test',
      sessionId: 's1',
      instruction: 'test',
      artifactIds: [],
      status: 'pending',
    });
    agent.stateMachine.transition(task, 'executing');
    agent.stateMachine.transition(task, 'paused');

    agent.resume('Continue please');
    expect(task.status).toBe('executing');
  });

  it('shutdown clears state', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const agent = new DualLoopAgent();
    agent.viewStack.push('test-agent');
    await agent.shutdown();
    expect(agent.viewStack.depth).toBe(0);
  });
});

// ── Agent Loop UX — Dual Loop Enhancements ───────────────

describe('DualLoopAgent — Agent Loop UX', () => {
  it('emits task.created event with taskId in processMessage', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const { EventBus } = await import('../src/sse.js');

    const agent = new DualLoopAgent();
    const bus = new EventBus();
    const events: any[] = [];
    bus.subscribe((e) => events.push(e));

    // processMessage returns immediately with task info
    const result = await agent.processMessage({ content: 'test task' }, { bus });

    expect(result.taskId).toBeDefined();
    expect(result.sessionId).toBeDefined();

    // task.created event should be emitted
    const taskCreated = events.find(e => e.type === 'task.created');
    expect(taskCreated).toBeDefined();
    expect(taskCreated.data.taskId).toBe(result.taskId);
    expect(taskCreated.data.instruction).toContain('test task');
  });

  it('cancel() aborts inner loop via AbortSignal', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const { EventBus } = await import('../src/sse.js');

    const agent = new DualLoopAgent();
    const bus = new EventBus();

    // Start a task (will fail because no real LLM, but cancel should still work)
    await agent.processMessage({ content: 'long task' }, { bus });

    // Cancel should abort without error
    expect(() => agent.cancel()).not.toThrow();
  });

  it('Task type supports plan field', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const agent = new DualLoopAgent();

    const task = agent.tasks.create({
      id: 'test-plan',
      sessionId: 's1',
      instruction: 'build something',
      artifactIds: [],
      status: 'pending',
    });

    // Plan field should be settable
    task.plan = ['Step 1', 'Step 2', 'Step 3'];
    expect(task.plan).toEqual(['Step 1', 'Step 2', 'Step 3']);
  });

  it('DirectiveRouter is initialized and routes correctly', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const agent = new DualLoopAgent();

    // DirectiveRouter should be initialized
    expect(agent.directiveRouter).toBeDefined();
    expect(agent.directiveRouter.checkpointBufferSize).toBe(0);
  });
});

// ── Factory Integration ──────────────────────────────────

describe('createAgentLoop with dual mode', () => {
  it('returns DualLoopAgent when mode is dual', async () => {
    const { createAgentLoop } = await import('../src/loop/factory.js');
    const loop = createAgentLoop('dual');
    expect(loop.mode).toBe('dual');
  });

  it('returns SingleLoopAgent when mode is single', async () => {
    const { createAgentLoop } = await import('../src/loop/factory.js');
    const loop = createAgentLoop('single');
    expect(loop.mode).toBe('single');
  });
});
