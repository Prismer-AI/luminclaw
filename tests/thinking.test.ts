/**
 * Tests for Thinking Control — /think directive parsing + provider param mapping
 */

import { describe, it, expect, vi } from 'vitest';
import { PrismerAgent } from '../src/agent.js';
import { ToolRegistry } from '../src/tools.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { EventBus } from '../src/sse.js';
import { Session } from '../src/session.js';
import type { Provider, ChatRequest, ChatResponse } from '../src/provider.js';

function createSpyProvider(): { provider: Provider; getLastRequest: () => ChatRequest | null } {
  let lastRequest: ChatRequest | null = null;
  const provider: Provider = {
    name: () => 'spy',
    chat: async (req: ChatRequest): Promise<ChatResponse> => {
      lastRequest = req;
      return { text: 'ok' };
    },
  };
  return { provider, getLastRequest: () => lastRequest };
}

function createAgent(provider: Provider): PrismerAgent {
  const agents = new AgentRegistry();
  agents.registerMany(BUILTIN_AGENTS);
  return new PrismerAgent({
    provider,
    tools: new ToolRegistry(),
    observer: new ConsoleObserver(),
    agents,
    bus: new EventBus(),
    systemPrompt: 'Test agent.',
    model: 'test-model',
    maxIterations: 5,
    agentId: 'researcher',
    workspaceDir: '/tmp',
  });
}

describe('Thinking Control', () => {
  it('parses /think directive and sets thinkingLevel to high', async () => {
    const { provider, getLastRequest } = createSpyProvider();
    const agent = createAgent(provider);
    const session = new Session('think-1');

    await agent.processMessage('/think What is quantum computing?', session);

    const req = getLastRequest()!;
    expect(req.thinkingLevel).toBe('high');
    // Input should have the /think prefix stripped from the user message
    const userMsg = req.messages.find(m => m.role === 'user');
    expect(userMsg?.content).toBe('What is quantum computing?');
  });

  it('parses /t shorthand directive', async () => {
    const { provider, getLastRequest } = createSpyProvider();
    const agent = createAgent(provider);
    const session = new Session('think-2');

    await agent.processMessage('/t Explain relativity.', session);

    expect(getLastRequest()!.thinkingLevel).toBe('high');
    const userMsg = getLastRequest()!.messages.find(m => m.role === 'user');
    expect(userMsg?.content).toBe('Explain relativity.');
  });

  it('parses /nothink directive and sets thinkingLevel to off', async () => {
    const { provider, getLastRequest } = createSpyProvider();
    const agent = createAgent(provider);
    const session = new Session('think-3');

    await agent.processMessage('/nothink Just say hello.', session);

    expect(getLastRequest()!.thinkingLevel).toBe('off');
    const userMsg = getLastRequest()!.messages.find(m => m.role === 'user');
    expect(userMsg?.content).toBe('Just say hello.');
  });

  it('does not set thinkingLevel for regular messages', async () => {
    const { provider, getLastRequest } = createSpyProvider();
    const agent = createAgent(provider);
    const session = new Session('think-4');

    await agent.processMessage('Normal question', session);

    expect(getLastRequest()!.thinkingLevel).toBeUndefined();
  });

  it('thinking level persists across turns in same agent instance', async () => {
    const { provider, getLastRequest } = createSpyProvider();
    const agent = createAgent(provider);

    // First turn: set thinking to high
    await agent.processMessage('/think First question', new Session('think-5a'));
    expect(getLastRequest()!.thinkingLevel).toBe('high');

    // Second turn: should retain high
    await agent.processMessage('Second question', new Session('think-5b'));
    expect(getLastRequest()!.thinkingLevel).toBe('high');

    // Third turn: turn off
    await agent.processMessage('/nothink Third question', new Session('think-5c'));
    expect(getLastRequest()!.thinkingLevel).toBe('off');
  });
});
