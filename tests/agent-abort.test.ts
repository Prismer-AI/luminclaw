/**
 * Tests for PrismerAgent abort handling — synthetic [Aborted: <reason>] tool_results
 * for in-flight tools. Phase C Task C4.
 */

import { describe, it, expect, vi } from 'vitest';
import { PrismerAgent } from '../src/agent.js';
import { ToolRegistry, createTool } from '../src/tools.js';
import { AgentRegistry } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { Session } from '../src/session.js';
import { AbortReason, createAbortError } from '../src/abort.js';
import type { Provider, ChatRequest, ChatResponse } from '../src/provider.js';

async function drainGenerator<T>(gen: AsyncGenerator<unknown, T>): Promise<T | undefined> {
  try {
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    return r.value;
  } catch {
    return undefined;
  }
}

describe('PrismerAgent — abort synthetic results', () => {
  it('emits synthetic [Aborted: <reason>] for in-flight tools on abort', async () => {
    const ctrl = new AbortController();

    const tools = new ToolRegistry();
    tools.register(createTool(
      'slow',
      'slow tool that waits for abort',
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        return new Promise<string>((_resolve, reject) => {
          ctx.abortSignal?.addEventListener('abort', () => {
            reject(createAbortError(AbortReason.UserExplicitCancel));
          });
        });
      },
    ));

    const provider: Provider = {
      name: () => 'mock',
      chat: vi.fn(async (_req: ChatRequest): Promise<ChatResponse> => ({
        text: '',
        toolCalls: [{ id: 'call1', name: 'slow', arguments: {} }],
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    };

    const agent = new PrismerAgent({
      provider,
      tools,
      observer: new ConsoleObserver(),
      agents: new AgentRegistry(),
      systemPrompt: 'sys',
      maxIterations: 3,
      abortSignal: ctrl.signal,
    });

    // Abort 50ms after processMessage starts
    setTimeout(() => ctrl.abort(createAbortError(AbortReason.UserExplicitCancel)), 50);

    const session = new Session('s');
    await drainGenerator(agent.processMessage('hi', session));

    const toolResults = session.messages.filter(m => m.role === 'tool');
    const aborted = toolResults.find(
      m => typeof m.content === 'string' && m.content.includes('[Aborted'),
    );
    expect(aborted).toBeDefined();
    expect(aborted!.content).toContain('user_explicit_cancel');
    expect((aborted as { toolCallId?: string }).toolCallId).toBe('call1');
  }, 5000);
});
