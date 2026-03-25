/**
 * Tests for Agent — compaction, context guard, doom loop detection
 *
 * Since compactToolResult and truncateOldestTurns are private module functions,
 * we test them through the PrismerAgent integration (mock provider + mock tools).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismerAgent, type AgentResult } from '../src/agent.js';
import { ToolRegistry, type ToolContext } from '../src/tools.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { EventBus } from '../src/sse.js';
import { Session } from '../src/session.js';
import type { Provider, ChatRequest, ChatResponse } from '../src/provider.js';

// ── Mock Provider ──────────────────────────────────────

function createMockProvider(responses: ChatResponse[]): Provider {
  let callIndex = 0;
  return {
    name: () => 'mock',
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      if (callIndex >= responses.length) {
        return { text: 'done', iterations: 0 } as unknown as ChatResponse;
      }
      return responses[callIndex++];
    },
  };
}

// ── Helpers ────────────────────────────────────────────

function createTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    description: 'Echo input',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args: Record<string, unknown>) => `Echo: ${args.text}`,
  });
  tools.register({
    name: 'big_output',
    description: 'Returns a large output',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'X'.repeat(200_000), // 200K chars
  });
  tools.register({
    name: 'failing_tool',
    description: 'Always fails',
    parameters: { type: 'object', properties: {} },
    execute: async () => { throw new Error('Tool failure'); },
  });
  return tools;
}

function createAgent(provider: Provider, tools?: ToolRegistry): PrismerAgent {
  const agents = new AgentRegistry();
  agents.registerMany(BUILTIN_AGENTS);
  return new PrismerAgent({
    provider,
    tools: tools ?? createTools(),
    observer: new ConsoleObserver(),
    agents,
    bus: new EventBus(),
    systemPrompt: 'You are a test agent.',
    model: 'test-model',
    maxIterations: 10,
    agentId: 'researcher',
    workspaceDir: '/tmp',
  });
}

describe('PrismerAgent', () => {
  describe('basic flow', () => {
    it('returns text response when no tool calls', async () => {
      const provider = createMockProvider([
        { text: 'Hello!', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-1');
      const result = await agent.processMessage('hi', session);
      expect(result.text).toBe('Hello!');
      expect(result.toolsUsed).toEqual([]);
      expect(result.iterations).toBe(1);
    });

    it('executes tool calls and returns final text', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'world' } }],
        },
        { text: 'Got echo result.', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-2');
      const result = await agent.processMessage('echo test', session);
      expect(result.text).toBe('Got echo result.');
      expect(result.toolsUsed).toContain('echo');
      expect(result.iterations).toBe(2);
    });
  });

  describe('tool result compaction', () => {
    it('compacts tool output exceeding 150K chars', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-big', name: 'big_output', arguments: {} }],
        },
        { text: 'Processed.', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-compact');
      const result = await agent.processMessage('get big data', session);

      // The tool result message in session should be compacted
      const toolMsg = session.messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content!.length).toBeLessThan(200_000);
      expect(toolMsg!.content).toContain('chars omitted');
      expect(result.text).toBe('Processed.');
    });

    it('does not compact small tool outputs', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-small', name: 'echo', arguments: { text: 'hello' } }],
        },
        { text: 'ok', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-no-compact');
      await agent.processMessage('echo', session);

      const toolMsg = session.messages.find(m => m.role === 'tool');
      expect(toolMsg!.content).toBe('Echo: hello');
      expect(toolMsg!.content).not.toContain('omitted');
    });
  });

  describe('doom loop detection — all errors', () => {
    it('stops after 3 consecutive all-error rounds', async () => {
      // Provider returns 3 rounds of tool calls, all to failing_tool
      const provider = createMockProvider([
        { text: '', toolCalls: [{ id: 'tc-1', name: 'failing_tool', arguments: {} }] },
        { text: '', toolCalls: [{ id: 'tc-2', name: 'failing_tool', arguments: {} }] },
        { text: '', toolCalls: [{ id: 'tc-3', name: 'failing_tool', arguments: {} }] },
        { text: 'should not reach here', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-doom');
      const result = await agent.processMessage('do something', session);
      expect(result.text).toContain('repeated tool failures');
    });
  });

  describe('doom loop detection — repetition', () => {
    it('stops after 5 identical tool calls', async () => {
      // Provider returns 5 identical tool calls
      const responses: ChatResponse[] = [];
      for (let i = 0; i < 6; i++) {
        responses.push({
          text: '',
          toolCalls: [{ id: `tc-${i}`, name: 'echo', arguments: { text: 'same' } }],
        });
      }
      responses.push({ text: 'should not reach here', toolCalls: undefined });

      const provider = createMockProvider(responses);
      const agent = createAgent(provider);
      const session = new Session('test-repetition');
      const result = await agent.processMessage('repeat', session);
      expect(result.text).toContain('repetitive tool calls');
    });

    it('does not trigger for different tool calls', async () => {
      const provider = createMockProvider([
        { text: '', toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'a' } }] },
        { text: '', toolCalls: [{ id: 'tc-2', name: 'echo', arguments: { text: 'b' } }] },
        { text: '', toolCalls: [{ id: 'tc-3', name: 'echo', arguments: { text: 'c' } }] },
        { text: '', toolCalls: [{ id: 'tc-4', name: 'echo', arguments: { text: 'd' } }] },
        { text: '', toolCalls: [{ id: 'tc-5', name: 'echo', arguments: { text: 'e' } }] },
        { text: 'All done.', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-different');
      const result = await agent.processMessage('various', session);
      expect(result.text).toBe('All done.');
      expect(result.text).not.toContain('repetitive');
    });
  });

  describe('max iterations', () => {
    it('stops at max iterations', async () => {
      // Always return tool calls, never text
      const responses: ChatResponse[] = [];
      for (let i = 0; i < 15; i++) {
        responses.push({
          text: '',
          toolCalls: [{ id: `tc-${i}`, name: 'echo', arguments: { text: `iter-${i}` } }],
        });
      }

      const provider = createMockProvider(responses);
      const tools = createTools();
      const agents = new AgentRegistry();
      agents.registerMany(BUILTIN_AGENTS);
      const agent = new PrismerAgent({
        provider,
        tools,
        observer: new ConsoleObserver(),
        agents,
        bus: new EventBus(),
        systemPrompt: 'Test.',
        maxIterations: 5,
        agentId: 'researcher',
        workspaceDir: '/tmp',
      });

      const session = new Session('test-max-iter');
      const result = await agent.processMessage('loop forever', session);
      // Should stop — either via repetition detection or max iterations
      expect(result.iterations).toBeLessThanOrEqual(6);
    });
  });

  describe('thinking model support', () => {
    it('preserves thinking/reasoning in result', async () => {
      const provider = createMockProvider([
        { text: 'Answer.', thinking: 'I need to think about this...', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-thinking');
      const result = await agent.processMessage('think hard', session);
      expect(result.text).toBe('Answer.');
      expect(result.thinking).toBe('I need to think about this...');
    });

    it('stores reasoning in assistant messages for round-trip', async () => {
      const provider = createMockProvider([
        {
          text: '',
          thinking: 'Let me use a tool.',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'test' } }],
        },
        { text: 'Done.', thinking: 'Tool worked.', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-reasoning-roundtrip');
      await agent.processMessage('reason and act', session);

      // Check that the assistant message with tool call has reasoningContent
      const assistantMsgs = session.messages.filter(m => m.role === 'assistant');
      expect(assistantMsgs[0].reasoningContent).toBe('Let me use a tool.');
    });
  });

  describe('error handling', () => {
    it('returns error text on provider failure', async () => {
      const provider: Provider = {
        name: () => 'failing',
        chat: async () => { throw new Error('Network down'); },
      };
      const agent = createAgent(provider);
      const session = new Session('test-error');
      const result = await agent.processMessage('fail', session);
      expect(result.text).toContain('Error: Network down');
    });

    it('handles unknown tool gracefully', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-unknown', name: 'nonexistent_tool', arguments: {} }],
        },
        { text: 'Recovered.', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-unknown-tool');
      const result = await agent.processMessage('use unknown', session);
      // Should recover — unknown tool returns error, agent continues
      expect(result.text).toBe('Recovered.');
    });
  });

  describe('usage tracking', () => {
    it('accumulates token usage across iterations', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'a' } }],
          usage: { promptTokens: 100, completionTokens: 50 },
        },
        {
          text: 'Done.',
          toolCalls: undefined,
          usage: { promptTokens: 200, completionTokens: 80 },
        },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-usage');
      const result = await agent.processMessage('track usage', session);
      expect(result.usage).toBeDefined();
      expect(result.usage!.promptTokens).toBe(300);
      expect(result.usage!.completionTokens).toBe(130);
    });
  });

  // ── Agent Loop UX events ──

  describe('iteration.start event', () => {
    it('emits iteration.start at the beginning of each loop iteration', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'a' } }],
        },
        { text: 'Done.', toolCalls: undefined },
      ]);

      const bus = new EventBus();
      const events: import('../src/sse.js').AgentEvent[] = [];
      bus.subscribe((e) => { if (e.type === 'iteration.start') events.push(e); });

      const agents = new AgentRegistry();
      agents.registerMany(BUILTIN_AGENTS);
      const agent = new PrismerAgent({
        provider,
        tools: createTools(),
        observer: new ConsoleObserver(),
        agents,
        bus,
        systemPrompt: 'Test',
        model: 'test',
        maxIterations: 10,
        agentId: 'researcher',
        workspaceDir: '/tmp',
      });

      const session = new Session('test-iter');
      await agent.processMessage('test iterations', session);

      expect(events).toHaveLength(2); // 2 iterations
      expect((events[0].data as any).iteration).toBe(1);
      expect((events[0].data as any).maxIterations).toBe(10);
      expect((events[1].data as any).iteration).toBe(2);
    });
  });

  describe('thinking.delta event', () => {
    it('emits thinking.delta when streaming provider returns reasoning content', async () => {
      // Create a provider with chatStream that simulates thinking
      const mockStreamProvider: Provider = {
        name: () => 'mock-stream',
        chat: async () => ({ text: 'ok' }),
        chatStream: async (_req, _onDelta, onThinkingDelta) => {
          // Simulate thinking delta
          onThinkingDelta?.('I need to think...');
          onThinkingDelta?.(' about this carefully.');
          return { text: 'result', thinking: 'I need to think... about this carefully.' };
        },
      };

      const bus = new EventBus();
      const thinkingEvents: import('../src/sse.js').AgentEvent[] = [];
      bus.subscribe((e) => { if (e.type === 'thinking.delta') thinkingEvents.push(e); });

      const agents = new AgentRegistry();
      agents.registerMany(BUILTIN_AGENTS);
      const agent = new PrismerAgent({
        provider: mockStreamProvider,
        tools: createTools(),
        observer: new ConsoleObserver(),
        agents,
        bus,
        systemPrompt: 'Test',
        model: 'test',
        maxIterations: 10,
        agentId: 'researcher',
        workspaceDir: '/tmp',
      });

      const session = new Session('test-thinking');
      await agent.processMessage('think about this', session);

      expect(thinkingEvents).toHaveLength(2);
      expect((thinkingEvents[0].data as any).delta).toBe('I need to think...');
      expect((thinkingEvents[1].data as any).delta).toBe(' about this carefully.');
    });
  });

  describe('tool.progress event', () => {
    it('forwards tool progress events from emit handler', async () => {
      const tools = new ToolRegistry();
      tools.register({
        name: 'slow_tool',
        description: 'A tool that reports progress',
        parameters: { type: 'object', properties: {} },
        execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
          ctx.emit({ type: 'progress', data: { percent: 50, message: 'Halfway done' } });
          return 'completed';
        },
      });

      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'slow_tool', arguments: {} }],
        },
        { text: 'Done.', toolCalls: undefined },
      ]);

      const bus = new EventBus();
      const progressEvents: import('../src/sse.js').AgentEvent[] = [];
      bus.subscribe((e) => { if (e.type === 'tool.progress') progressEvents.push(e); });

      const agents = new AgentRegistry();
      agents.registerMany(BUILTIN_AGENTS);
      const agent = new PrismerAgent({
        provider,
        tools,
        observer: new ConsoleObserver(),
        agents,
        bus,
        systemPrompt: 'Test',
        model: 'test',
        maxIterations: 10,
        agentId: 'researcher',
        workspaceDir: '/tmp',
      });

      const session = new Session('test-progress');
      await agent.processMessage('run slow tool', session);

      expect(progressEvents).toHaveLength(1);
      expect((progressEvents[0].data as any).tool).toBe('slow_tool');
      expect((progressEvents[0].data as any).percent).toBe(50);
      expect((progressEvents[0].data as any).message).toBe('Halfway done');
    });
  });

  describe('memory.accessed event', () => {
    it('forwards output events as memory.accessed when action is store/recall', async () => {
      const tools = new ToolRegistry();
      tools.register({
        name: 'memory_store',
        description: 'Store memory',
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
        execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
          ctx.emit({ type: 'output', data: { action: 'store', preview: 'test fact' } });
          return 'stored';
        },
      });
      tools.register({
        name: 'memory_recall',
        description: 'Recall memory',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
          ctx.emit({ type: 'output', data: { action: 'recall', query: 'backtest', resultCount: 3 } });
          return 'results';
        },
      });

      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [
            { id: 'tc-1', name: 'memory_store', arguments: { content: 'test fact' } },
            { id: 'tc-2', name: 'memory_recall', arguments: { query: 'backtest' } },
          ],
        },
        { text: 'Done.', toolCalls: undefined },
      ]);

      const bus = new EventBus();
      const memEvents: import('../src/sse.js').AgentEvent[] = [];
      bus.subscribe((e) => { if (e.type === 'memory.accessed') memEvents.push(e); });

      const agents = new AgentRegistry();
      agents.registerMany(BUILTIN_AGENTS);
      const agent = new PrismerAgent({
        provider,
        tools,
        observer: new ConsoleObserver(),
        agents,
        bus,
        systemPrompt: 'Test',
        model: 'test',
        maxIterations: 10,
        agentId: 'researcher',
        workspaceDir: '/tmp',
      });

      const session = new Session('test-memory');
      await agent.processMessage('use memory', session);

      expect(memEvents).toHaveLength(2);
      expect((memEvents[0].data as any).action).toBe('store');
      expect((memEvents[0].data as any).preview).toBe('test fact');
      expect((memEvents[1].data as any).action).toBe('recall');
      expect((memEvents[1].data as any).query).toBe('backtest');
      expect((memEvents[1].data as any).resultCount).toBe(3);
    });
  });
});
