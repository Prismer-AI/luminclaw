/**
 * Tests for Agent permission enforcement (D3).
 *
 * Verifies that the agent loop consults `Session.permissionContext` before
 * each tool execution and auto-denies tools annotated with
 * `requiresUserInteraction: () => true` when running in `auto` mode.
 */

import { describe, it, expect } from 'vitest';
import { PrismerAgent } from '../src/agent.js';
import { ToolRegistry, createTool, type Tool } from '../src/tools.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { EventBus } from '../src/sse.js';
import { Session } from '../src/session.js';
import type { Provider, ChatRequest, ChatResponse } from '../src/provider.js';

async function drainGenerator<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
}

function createMockProvider(responses: ChatResponse[]): Provider {
  let callIndex = 0;
  return {
    name: () => 'mock',
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      if (callIndex >= responses.length) {
        return { text: 'done', toolCalls: undefined } as unknown as ChatResponse;
      }
      return responses[callIndex++];
    },
  };
}

function createAgent(provider: Provider, tools: ToolRegistry): PrismerAgent {
  const agents = new AgentRegistry();
  agents.registerMany(BUILTIN_AGENTS);
  return new PrismerAgent({
    provider,
    tools,
    observer: new ConsoleObserver(),
    agents,
    bus: new EventBus(),
    systemPrompt: 'You are a test agent.',
    model: 'test-model',
    maxIterations: 5,
    agentId: 'researcher',
    workspaceDir: '/tmp',
  });
}

describe('Agent — permission enforcement (D3)', () => {
  it('auto-denies requiresUserInteraction tools in auto mode', async () => {
    const tools = new ToolRegistry();
    const destructive: Tool = createTool(
      'destructive',
      'destroys things',
      { type: 'object', properties: {} },
      async () => 'should not run',
    );
    destructive.requiresUserInteraction = () => true;
    tools.register(destructive);

    const provider = createMockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'destructive', arguments: {} }] } as ChatResponse,
      { text: 'done', toolCalls: undefined } as ChatResponse,
    ]);

    const agent = createAgent(provider, tools);
    const session = new Session('auto-deny');
    session.permissionContext = { mode: 'auto' };

    const result = await drainGenerator(agent.processMessage('run it', session));
    expect(result.text).toBe('done');

    const toolMsg = session.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('Permission denied');
    // The actual tool body should never have run (returned 'should not run')
    expect(toolMsg!.content).not.toContain('should not run');
  });

  it('allows non-destructive tools in auto mode', async () => {
    const tools = new ToolRegistry();
    const safe: Tool = createTool(
      'safe_tool',
      'read-only info',
      { type: 'object', properties: {} },
      async () => 'safe result',
    );
    safe.requiresUserInteraction = () => false;
    tools.register(safe);

    const provider = createMockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'safe_tool', arguments: {} }] } as ChatResponse,
      { text: 'ok', toolCalls: undefined } as ChatResponse,
    ]);

    const agent = createAgent(provider, tools);
    const session = new Session('auto-allow');
    session.permissionContext = { mode: 'auto' };

    const result = await drainGenerator(agent.processMessage('run it', session));
    expect(result.text).toBe('ok');
    expect(result.toolsUsed).toContain('safe_tool');

    const toolMsg = session.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('safe result');
    expect(toolMsg!.content).not.toContain('Permission denied');
  });
});
