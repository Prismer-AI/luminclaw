/**
 * PrismerAgent abort handling — synthetic [Aborted: <reason>] tool_results
 * for in-flight tools. Phase C Task C4.
 *
 * Rewritten per `no_mock_for_agent_infra`. Uses a real provider + real
 * ToolRegistry with a genuinely-blocking test tool (`slow`) that waits on
 * the abort signal and rejects. The agent loop must then emit a synthetic
 * `[Aborted: ...]` tool_result for that in-flight call.
 *
 * To keep the test deterministic without relying on LLM latency alone, the
 * `slow` tool blocks indefinitely until aborted — so the abort fires while
 * the tool is guaranteed to be in-flight.
 */

import { it, expect, describe } from 'vitest';
import { PrismerAgent } from '../src/agent.js';
import { ToolRegistry, createTool } from '../src/tools.js';
import { AgentRegistry } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { Session } from '../src/session.js';
import { AbortReason, createAbortError } from '../src/abort.js';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { loadConfig, resetConfig } from '../src/config.js';
import { HAS_REAL_LLM, loadEnvTest } from './helpers/real-llm.js';

async function drainGenerator<T>(gen: AsyncGenerator<unknown, T>): Promise<T | undefined> {
  try {
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    return r.value;
  } catch {
    return undefined;
  }
}

const describeReal = HAS_REAL_LLM ? describe : describe.skip;

describeReal('PrismerAgent — abort synthetic results (real LLM)', () => {
  it('emits synthetic [Aborted: <reason>] for in-flight tools on abort', async () => {
    loadEnvTest();
    resetConfig();
    const cfg = loadConfig();

    const ctrl = new AbortController();

    const tools = new ToolRegistry();
    tools.register(createTool(
      'slow',
      'A slow tool. Call this tool with no arguments; it waits until aborted.',
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        return new Promise<string>((_resolve, reject) => {
          ctx.abortSignal?.addEventListener('abort', () => {
            reject(createAbortError(AbortReason.UserExplicitCancel));
          });
        });
      },
    ));

    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.llm.baseUrl,
      apiKey: cfg.llm.apiKey,
      defaultModel: cfg.llm.model,
    });

    const agent = new PrismerAgent({
      provider,
      tools,
      observer: new ConsoleObserver(),
      agents: new AgentRegistry(),
      systemPrompt:
        'You are a test assistant. When the user asks, invoke the `slow` tool with an empty object argument {} — do not reply with text.',
      maxIterations: 3,
      abortSignal: ctrl.signal,
    });

    // Abort 6 seconds after start — gives the LLM time to request the tool
    // call (first iteration ~ 3-5s) so the `slow` tool is genuinely in-flight
    // when abort fires. `slow` blocks indefinitely until aborted, so we're
    // guaranteed to abort during tool execution rather than during the LLM
    // call itself.
    setTimeout(() => ctrl.abort(createAbortError(AbortReason.UserExplicitCancel)), 6_000);

    const session = new Session('s');
    await drainGenerator(agent.processMessage(
      'Please invoke the slow tool now by calling it with arguments {}.',
      session,
    ));

    const toolResults = session.messages.filter(m => m.role === 'tool');
    const aborted = toolResults.find(
      m => typeof m.content === 'string' && m.content.includes('[Aborted'),
    );
    expect(aborted, `expected a synthetic [Aborted ...] tool_result — tool messages: ${JSON.stringify(toolResults)}`).toBeDefined();
    expect(aborted!.content).toContain('user_explicit_cancel');
    expect((aborted as { toolCallId?: string }).toolCallId).toBeTruthy();
  }, 30_000);
});
