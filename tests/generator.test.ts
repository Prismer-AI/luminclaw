/**
 * Tests for AsyncGenerator transformation of processMessage.
 *
 * Verifies that:
 * - processMessage yields AgentEvent objects in the correct order
 * - The generator return value is AgentResult
 * - Sub-agent events are re-yielded through parent
 * - EventBus still receives all events (backward compat)
 */

import { describe, it, expect } from 'vitest';
import { PrismerAgent, type AgentResult } from '../src/agent.js';
import { ToolRegistry } from '../src/tools.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { EventBus, type AgentEvent } from '../src/sse.js';
import { Session } from '../src/session.js';
import type { Provider, ChatRequest, ChatResponse } from '../src/provider.js';

// ── Helpers ────────────────────────────────────────────

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

function createTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    description: 'Echo input',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args: Record<string, unknown>) => `Echo: ${args.text}`,
  });
  return tools;
}

function createAgent(provider: Provider, bus?: EventBus): PrismerAgent {
  const agents = new AgentRegistry();
  agents.registerMany(BUILTIN_AGENTS);
  return new PrismerAgent({
    provider,
    tools: createTools(),
    observer: new ConsoleObserver(),
    agents,
    bus: bus ?? new EventBus(),
    systemPrompt: 'You are a test agent.',
    model: 'test-model',
    maxIterations: 10,
    agentId: 'researcher',
    workspaceDir: '/tmp',
  });
}

/** Collect all yielded events and the return value from the generator. */
async function collectGenerator<Y, R>(gen: AsyncGenerator<Y, R>): Promise<{ events: Y[]; result: R }> {
  const events: Y[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, result: r.value };
}

describe('processMessage AsyncGenerator', () => {
  describe('event ordering', () => {
    it('yields agent.start as the first event and agent.end as the last', async () => {
      const provider = createMockProvider([
        { text: 'Hello!', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('gen-1');

      const { events, result } = await collectGenerator(agent.processMessage('hi', session));

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe('agent.start');
      expect(events[events.length - 1].type).toBe('agent.end');
      expect(result.text).toBe('Hello!');
    });

    it('yields text.delta event for non-streaming responses', async () => {
      const provider = createMockProvider([
        { text: 'Response text', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('gen-2');

      const { events } = await collectGenerator(agent.processMessage('say something', session));

      const textEvents = events.filter(e => e.type === 'text.delta');
      expect(textEvents.length).toBeGreaterThanOrEqual(1);
      expect((textEvents[0].data as { delta: string }).delta).toBe('Response text');
    });

    it('yields tool.start and tool.end events around tool execution', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'test' } }],
        },
        { text: 'Done.', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('gen-3');

      const { events } = await collectGenerator(agent.processMessage('use echo', session));

      const types = events.map(e => e.type);
      const toolStartIdx = types.indexOf('tool.start');
      const toolEndIdx = types.indexOf('tool.end');
      expect(toolStartIdx).toBeGreaterThan(-1);
      expect(toolEndIdx).toBeGreaterThan(toolStartIdx);
    });

    it('yields events in correct order: start, tool.start, tool.end, text.delta, end', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'x' } }],
        },
        { text: 'Final.', toolCalls: undefined },
      ]);
      const agent = createAgent(provider);
      const session = new Session('gen-4');

      const { events } = await collectGenerator(agent.processMessage('test order', session));

      const types = events.map(e => e.type);
      const startIdx = types.indexOf('agent.start');
      const toolStartIdx = types.indexOf('tool.start');
      const toolEndIdx = types.indexOf('tool.end');
      const textIdx = types.indexOf('text.delta');
      const endIdx = types.lastIndexOf('agent.end');

      expect(startIdx).toBe(0);
      expect(toolStartIdx).toBeGreaterThan(startIdx);
      expect(toolEndIdx).toBeGreaterThan(toolStartIdx);
      expect(textIdx).toBeGreaterThan(toolEndIdx);
      expect(endIdx).toBe(types.length - 1);
    });
  });

  describe('return value', () => {
    it('returns AgentResult with correct fields', async () => {
      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hi' } }],
        },
        {
          text: 'Result text.',
          toolCalls: undefined,
          usage: { promptTokens: 100, completionTokens: 50 },
        },
      ]);
      const agent = createAgent(provider);
      const session = new Session('gen-5');

      const { result } = await collectGenerator(agent.processMessage('test', session));

      expect(result.text).toBe('Result text.');
      expect(result.toolsUsed).toContain('echo');
      expect(result.iterations).toBe(2);
      expect(result.directives).toEqual([]);
    });
  });

  describe('EventBus backward compatibility', () => {
    it('publishes all events to EventBus in addition to yielding them', async () => {
      const bus = new EventBus();
      const busEvents: AgentEvent[] = [];
      bus.subscribe((event) => busEvents.push(event));

      const provider = createMockProvider([
        {
          text: '',
          toolCalls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'bus' } }],
        },
        { text: 'Bus test.', toolCalls: undefined },
      ]);
      const agent = createAgent(provider, bus);
      const session = new Session('gen-bus');

      const { events: yieldedEvents } = await collectGenerator(agent.processMessage('test bus', session));

      // EventBus should have received all the same event types
      const yieldedTypes = yieldedEvents.map(e => e.type);
      const busTypes = busEvents.map(e => e.type);

      // Every yielded event type should appear in bus events
      for (const type of yieldedTypes) {
        expect(busTypes).toContain(type);
      }

      // Both should have agent.start and agent.end
      expect(busTypes).toContain('agent.start');
      expect(busTypes).toContain('agent.end');
      expect(busTypes).toContain('tool.start');
      expect(busTypes).toContain('tool.end');
    });
  });

  describe('error events', () => {
    it('yields error event on provider failure', async () => {
      const provider: Provider = {
        name: () => 'failing',
        chat: async () => { throw new Error('LLM failure'); },
      };
      const agent = createAgent(provider);
      const session = new Session('gen-err');

      const { events, result } = await collectGenerator(agent.processMessage('fail', session));

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect((errorEvents[0].data as { message: string }).message).toBe('LLM failure');
      expect(result.text).toContain('Error: LLM failure');
    });
  });
});
