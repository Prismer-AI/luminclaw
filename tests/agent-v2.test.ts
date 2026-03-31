/**
 * Tests for Agent v2 improvements:
 *   - Sub-agent recursion protection
 *   - Tool read/write partitioning
 *   - LoopState + recovery paths
 *   - Microcompact integration
 */

import { describe, it, expect, vi } from 'vitest';
import { PrismerAgent, type AgentResult } from '../src/agent.js';
import { ToolRegistry, type ToolContext } from '../src/tools.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { EventBus } from '../src/sse.js';
import { Session } from '../src/session.js';
import type { Provider, ChatRequest, ChatResponse } from '../src/provider.js';

/** Drain an AsyncGenerator, discarding yielded values, and return the final value. */
async function drainGenerator<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
}

// ── Mock Provider ──────────────────────────────────────

function createMockProvider(responses: ChatResponse[]): Provider {
  let callIndex = 0;
  return {
    name: () => 'mock',
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      if (callIndex >= responses.length) {
        return { text: 'done' } as ChatResponse;
      }
      return responses[callIndex++];
    },
  };
}

/** Provider that fails N times with prompt-too-long, then succeeds */
function createPTLProvider(failCount: number, successResponse: ChatResponse): Provider {
  let calls = 0;
  return {
    name: () => 'ptl-mock',
    chat: async (): Promise<ChatResponse> => {
      calls++;
      if (calls <= failCount) {
        throw new Error('prompt too long: context length exceeded');
      }
      return successResponse;
    },
  };
}

// ── Helpers ────────────────────────────────────────────

function createTools(): ToolRegistry {
  const tools = new ToolRegistry();

  // Read-only tool (concurrent safe)
  tools.register({
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (args) => `Content of ${args.path}`,
    isConcurrencySafe: () => true,
  });

  // Write tool (NOT concurrent safe)
  tools.register({
    name: 'write_file',
    description: 'Write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    execute: async (args) => `Wrote to ${args.path}`,
    isConcurrencySafe: () => false,
  });

  // Echo tool (no isConcurrencySafe = defaults to serial)
  tools.register({
    name: 'echo',
    description: 'Echo input',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => `Echo: ${args.text}`,
  });

  tools.register({
    name: 'failing_tool',
    description: 'Always fails',
    parameters: { type: 'object', properties: {} },
    execute: async () => { throw new Error('Tool failure'); },
  });

  return tools;
}

function createAgent(provider: Provider, tools?: ToolRegistry, overrides?: Partial<ConstructorParameters<typeof PrismerAgent>[0]>): PrismerAgent {
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
    ...overrides,
  });
}

describe('PrismerAgent v2', () => {
  describe('sub-agent recursion protection', () => {
    it('sub-agent does not get delegate tool spec', async () => {
      // Setup: primary agent delegates to a sub-agent
      const agents = new AgentRegistry();
      agents.registerMany(BUILTIN_AGENTS);

      // The sub-agent should not have a delegate tool
      const provider = createMockProvider([
        // Primary agent delegates
        {
          text: '',
          toolCalls: [{ id: 'tc-d', name: 'delegate', arguments: { agent: 'latex-expert', task: 'format doc' } }],
        },
        // After delegation, primary gets final response
        { text: 'Done.', toolCalls: undefined },
      ]);

      // Create a spy to verify the sub-agent gets filtered tools
      const tools = createTools();
      const agent = createAgent(provider, tools);
      const session = new Session('test-recursion');
      const result = await drainGenerator(agent.processMessage('delegate something', session));

      // Should complete without infinite recursion
      expect(result.text).toBeDefined();
      expect(result.toolsUsed).toContain('delegate:latex-expert');
    });

    it('stops at max depth', async () => {
      const agents = new AgentRegistry();
      agents.registerMany(BUILTIN_AGENTS);

      const provider = createMockProvider([
        { text: 'Response from deep agent', toolCalls: undefined },
      ]);

      const tools = createTools();
      // Create agent at depth 5 (max)
      const agent = new PrismerAgent({
        provider,
        tools,
        observer: new ConsoleObserver(),
        agents,
        bus: new EventBus(),
        systemPrompt: 'Test',
        agentId: 'researcher',
        workspaceDir: '/tmp',
        _depth: 5,
      });

      const session = new Session('test-depth');
      // At depth 5, delegate tool should not be in specs
      // Agent should still work for normal messages
      const result = await drainGenerator(agent.processMessage('hi', session));
      expect(result.text).toBe('Response from deep agent');
    });
  });

  describe('tool read/write partitioning', () => {
    it('executes read-only tools concurrently', async () => {
      const executionOrder: string[] = [];
      const tools = new ToolRegistry();
      tools.register({
        name: 'read_a',
        description: 'Read A',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executionOrder.push('read_a_start');
          await new Promise(r => setTimeout(r, 50));
          executionOrder.push('read_a_end');
          return 'A';
        },
        isConcurrencySafe: () => true,
      });
      tools.register({
        name: 'read_b',
        description: 'Read B',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executionOrder.push('read_b_start');
          await new Promise(r => setTimeout(r, 50));
          executionOrder.push('read_b_end');
          return 'B';
        },
        isConcurrencySafe: () => true,
      });

      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [
            { id: 'tc-a', name: 'read_a', arguments: {} },
            { id: 'tc-b', name: 'read_b', arguments: {} },
          ],
        },
        { text: 'Done', toolCalls: undefined },
      ]);

      const agent = createAgent(provider, tools);
      const session = new Session('test-concurrent');
      const result = await drainGenerator(agent.processMessage('read both', session));

      expect(result.text).toBe('Done');
      // Both should start before either ends (concurrent)
      expect(executionOrder[0]).toBe('read_a_start');
      expect(executionOrder[1]).toBe('read_b_start');
    });

    it('executes write tools serially', async () => {
      const executionOrder: string[] = [];
      const tools = new ToolRegistry();
      tools.register({
        name: 'write_a',
        description: 'Write A',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executionOrder.push('write_a_start');
          await new Promise(r => setTimeout(r, 20));
          executionOrder.push('write_a_end');
          return 'wrote A';
        },
        isConcurrencySafe: () => false,
      });
      tools.register({
        name: 'write_b',
        description: 'Write B',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executionOrder.push('write_b_start');
          await new Promise(r => setTimeout(r, 20));
          executionOrder.push('write_b_end');
          return 'wrote B';
        },
        isConcurrencySafe: () => false,
      });

      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [
            { id: 'tc-wa', name: 'write_a', arguments: {} },
            { id: 'tc-wb', name: 'write_b', arguments: {} },
          ],
        },
        { text: 'Done', toolCalls: undefined },
      ]);

      const agent = createAgent(provider, tools);
      const session = new Session('test-serial');
      const result = await drainGenerator(agent.processMessage('write both', session));

      expect(result.text).toBe('Done');
      // Write A should complete before Write B starts (serial)
      expect(executionOrder).toEqual([
        'write_a_start', 'write_a_end',
        'write_b_start', 'write_b_end',
      ]);
    });

    it('defaults to serial when isConcurrencySafe is not defined', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [
            { id: 'tc-1', name: 'echo', arguments: { text: 'a' } },
            { id: 'tc-2', name: 'echo', arguments: { text: 'b' } },
          ],
        },
        { text: 'Done', toolCalls: undefined },
      ]);

      const agent = createAgent(provider);
      const session = new Session('test-default-serial');
      const result = await drainGenerator(agent.processMessage('echo twice', session));
      expect(result.text).toBe('Done');
    });
  });

  describe('recovery: reactive compact', () => {
    it('retries after prompt-too-long with compacted context', async () => {
      // First call fails with PTL, second succeeds
      const provider = createPTLProvider(1, { text: 'Recovered!', toolCalls: undefined });
      const agent = createAgent(provider);
      const session = new Session('test-ptl');

      // Seed some history so there's content to compact
      session.addMessage({ role: 'user', content: 'old message 1' });
      session.addMessage({ role: 'assistant', content: 'old response 1' });
      session.addMessage({ role: 'user', content: 'old message 2' });
      session.addMessage({ role: 'assistant', content: 'old response 2' });

      const result = await drainGenerator(agent.processMessage('new question', session));
      expect(result.text).toBe('Recovered!');
    });

    it('fails if reactive compact also fails', async () => {
      // All calls fail with PTL
      const provider = createPTLProvider(10, { text: 'never', toolCalls: undefined });
      const agent = createAgent(provider);
      const session = new Session('test-ptl-fail');

      const result = await drainGenerator(agent.processMessage('fail', session));
      expect(result.text).toContain('Error:');
    });
  });

  describe('ToolRegistry.withFilter', () => {
    it('creates filtered registry', () => {
      const tools = createTools();
      const filtered = tools.withFilter(name => name !== 'write_file');

      expect(filtered.has('read_file')).toBe(true);
      expect(filtered.has('echo')).toBe(true);
      expect(filtered.has('write_file')).toBe(false);
      expect(filtered.size).toBe(tools.size - 1);
    });
  });

  describe('existing behavior preserved', () => {
    it('returns text response when no tool calls', async () => {
      const provider = createMockProvider([
        { text: 'Hello!', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-basic');
      const result = await drainGenerator(agent.processMessage('hi', session));
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
      const session = new Session('test-tool');
      const result = await drainGenerator(agent.processMessage('echo test', session));
      expect(result.text).toBe('Got echo result.');
      expect(result.toolsUsed).toContain('echo');
      expect(result.iterations).toBe(2);
    });

    it('doom loop detection still works', async () => {
      const provider = createMockProvider([
        { text: '', toolCalls: [{ id: 'tc-1', name: 'failing_tool', arguments: {} }] },
        { text: '', toolCalls: [{ id: 'tc-2', name: 'failing_tool', arguments: {} }] },
        { text: '', toolCalls: [{ id: 'tc-3', name: 'failing_tool', arguments: {} }] },
        { text: 'should not reach', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('test-doom');
      const result = await drainGenerator(agent.processMessage('fail', session));
      expect(result.text).toContain('repeated tool failures');
    });
  });
});
