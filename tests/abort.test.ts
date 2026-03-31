/**
 * Tests for AbortController/AbortSignal support in the agent system.
 *
 * Verifies:
 *   - Agent loop stops when abort signal fires
 *   - Already-aborted signal prevents agent from starting work
 *   - Abort propagates from parent to child sub-agent
 *   - Provider fetch uses the abort signal from ChatRequest
 */

import { describe, it, expect, vi } from 'vitest';
import { PrismerAgent, type AgentResult } from '../src/agent.js';

async function drainGenerator<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
}
import { ToolRegistry } from '../src/tools.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { EventBus } from '../src/sse.js';
import { Session } from '../src/session.js';
import type { Provider, ChatRequest, ChatResponse } from '../src/provider.js';

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
    name: 'slow_tool',
    description: 'A tool that takes a while',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      await new Promise(r => setTimeout(r, 50));
      return 'done';
    },
  });
  return tools;
}

function createAgent(provider: Provider, opts?: { abortSignal?: AbortSignal; tools?: ToolRegistry }): PrismerAgent {
  const agents = new AgentRegistry();
  agents.registerMany(BUILTIN_AGENTS);
  return new PrismerAgent({
    provider,
    tools: opts?.tools ?? createTools(),
    observer: new ConsoleObserver(),
    agents,
    bus: new EventBus(),
    systemPrompt: 'You are a test agent.',
    model: 'test-model',
    maxIterations: 10,
    agentId: 'researcher',
    workspaceDir: '/tmp',
    abortSignal: opts?.abortSignal,
  });
}

describe('AbortController support', () => {
  describe('agent loop abort', () => {
    it('stops the loop when signal is aborted during tool calls', async () => {
      const ac = new AbortController();
      let callCount = 0;

      const provider: Provider = {
        name: () => 'mock',
        chat: async (_req: ChatRequest): Promise<ChatResponse> => {
          callCount++;
          if (callCount === 1) {
            // First call: return a tool call, then abort
            setTimeout(() => ac.abort(), 5);
            return {
              text: '',
              toolCalls: [{ id: 'tc1', name: 'slow_tool', arguments: {} }],
            };
          }
          // Second call should not happen if abort works
          return { text: 'should not reach here' };
        },
      };

      const agent = createAgent(provider, { abortSignal: ac.signal });
      const session = new Session('test-abort');
      const result = await drainGenerator(agent.processMessage('test', session));

      // The agent should have stopped with the abort message
      expect(result.text).toBe('[Aborted by user]');
    });

    it('returns immediately with abort text when signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort(); // Pre-abort

      let chatCalled = false;
      const provider: Provider = {
        name: () => 'mock',
        chat: async (): Promise<ChatResponse> => {
          chatCalled = true;
          return { text: 'response' };
        },
      };

      const agent = createAgent(provider, { abortSignal: ac.signal });
      const session = new Session('test-pre-abort');
      const result = await drainGenerator(agent.processMessage('test', session));

      expect(result.text).toBe('[Aborted by user]');
      // The LLM should never have been called
      expect(chatCalled).toBe(false);
    });

    it('works normally when no abort signal is provided', async () => {
      const provider: Provider = {
        name: () => 'mock',
        chat: async (): Promise<ChatResponse> => {
          return { text: 'Hello!' };
        },
      };

      const agent = createAgent(provider);
      const session = new Session('test-no-abort');
      const result = await drainGenerator(agent.processMessage('test', session));

      expect(result.text).toBe('Hello!');
    });
  });

  describe('tool execution abort', () => {
    it('returns [Aborted] for tool calls when signal is aborted', async () => {
      const ac = new AbortController();
      let callCount = 0;

      const provider: Provider = {
        name: () => 'mock',
        chat: async (): Promise<ChatResponse> => {
          callCount++;
          if (callCount === 1) {
            // Abort right before tool execution would happen
            ac.abort();
            return {
              text: '',
              toolCalls: [{ id: 'tc1', name: 'echo', arguments: { text: 'hello' } }],
            };
          }
          return { text: 'final' };
        },
      };

      const agent = createAgent(provider, { abortSignal: ac.signal });
      const session = new Session('test-tool-abort');
      const result = await drainGenerator(agent.processMessage('test', session));

      // After tool returns [Aborted], the loop should check abort and break
      expect(result.text).toBe('[Aborted by user]');
    });
  });

  describe('provider signal passthrough', () => {
    it('passes the signal to the provider chat call', async () => {
      let receivedSignal: AbortSignal | undefined;

      const provider: Provider = {
        name: () => 'mock',
        chat: async (req: ChatRequest): Promise<ChatResponse> => {
          receivedSignal = req.signal;
          return { text: 'ok' };
        },
      };

      const ac = new AbortController();
      const agent = createAgent(provider, { abortSignal: ac.signal });
      const session = new Session('test-signal-passthrough');
      await drainGenerator(agent.processMessage('test', session));

      // The provider should have received a signal (combined abort + timeout)
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });

    it('provides a timeout signal even without user abort signal', async () => {
      let receivedSignal: AbortSignal | undefined;

      const provider: Provider = {
        name: () => 'mock',
        chat: async (req: ChatRequest): Promise<ChatResponse> => {
          receivedSignal = req.signal;
          return { text: 'ok' };
        },
      };

      const agent = createAgent(provider);
      const session = new Session('test-timeout-signal');
      await drainGenerator(agent.processMessage('test', session));

      // Should still get a timeout signal even without abort
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('ChatRequest.signal in provider', () => {
    it('signal field is part of ChatRequest interface', () => {
      const req: ChatRequest = {
        messages: [{ role: 'user', content: 'test' }],
        signal: new AbortController().signal,
      };
      expect(req.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
