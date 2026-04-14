/**
 * Agent permission enforcement (D3) — real LLM.
 *
 * Rewritten per `no_mock_for_agent_infra`. Verifies that the real agent loop
 * consults `Session.permissionContext` before each tool execution and
 * auto-denies tools annotated with `requiresUserInteraction: () => true` when
 * running in `auto` mode.
 *
 * The LLM is prompted to call the restricted tool; we assert that the
 * synthetic `[Permission denied ...]` tool_result appears and that the tool
 * body itself never executed.
 */

import { it, expect, describe } from 'vitest';
import { PrismerAgent } from '../src/agent.js';
import { ToolRegistry, createTool, type Tool } from '../src/tools.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../src/agents.js';
import { ConsoleObserver } from '../src/observer.js';
import { EventBus } from '../src/sse.js';
import { Session } from '../src/session.js';
import { OpenAICompatibleProvider, type Provider } from '../src/provider.js';
import { loadConfig, resetConfig } from '../src/config.js';
import { HAS_REAL_LLM, loadEnvTest } from './helpers/real-llm.js';

async function drainGenerator<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
}

function buildRealProvider(): Provider {
  const cfg = loadConfig();
  return new OpenAICompatibleProvider({
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    defaultModel: cfg.llm.model,
  });
}

function createAgent(provider: Provider, tools: ToolRegistry, systemPrompt: string): PrismerAgent {
  const agents = new AgentRegistry();
  agents.registerMany(BUILTIN_AGENTS);
  return new PrismerAgent({
    provider,
    tools,
    observer: new ConsoleObserver(),
    agents,
    bus: new EventBus(),
    systemPrompt,
    model: loadConfig().llm.model,
    maxIterations: 5,
    agentId: 'researcher',
    workspaceDir: '/tmp',
  });
}

const describeReal = HAS_REAL_LLM ? describe : describe.skip;

describeReal('Agent — permission enforcement (D3) — real LLM', () => {
  it('auto-denies a requiresUserInteraction tool in auto mode', async () => {
    loadEnvTest();
    resetConfig();

    const executed = { value: false };
    const tools = new ToolRegistry();
    const destructive: Tool = createTool(
      'destructive',
      'Destroys things. Takes no arguments.',
      { type: 'object', properties: {} },
      async () => { executed.value = true; return 'should not run'; },
    );
    destructive.requiresUserInteraction = () => true;
    tools.register(destructive);

    const agent = createAgent(
      buildRealProvider(),
      tools,
      'You are a test assistant. When the user asks, invoke the `destructive` tool with empty arguments {}. After the tool responds, reply with the single word: done.',
    );
    const session = new Session('auto-deny');
    session.permissionContext = { mode: 'auto' };

    await drainGenerator(agent.processMessage(
      'Please invoke the destructive tool now with empty arguments {}.',
      session,
    ));

    const toolMsg = session.messages.find(
      m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('Permission denied'),
    );
    expect(toolMsg, `expected a [Permission denied] tool_result; session.messages = ${JSON.stringify(session.messages)}`).toBeDefined();
    // The tool body must never have run.
    expect(executed.value).toBe(false);
    expect(toolMsg!.content).not.toContain('should not run');
  }, 60_000);

  it('allows non-interactive tools in auto mode', async () => {
    loadEnvTest();
    resetConfig();

    const tools = new ToolRegistry();
    const safe: Tool = createTool(
      'safe_tool',
      'Read-only info. Takes no arguments.',
      { type: 'object', properties: {} },
      async () => 'safe result xyz',
    );
    safe.requiresUserInteraction = () => false;
    tools.register(safe);

    const agent = createAgent(
      buildRealProvider(),
      tools,
      'You are a test assistant. When the user asks, invoke the `safe_tool` tool with empty arguments {}. After the tool responds, reply with the single word: done.',
    );
    const session = new Session('auto-allow');
    session.permissionContext = { mode: 'auto' };

    const result = await drainGenerator(agent.processMessage(
      'Please invoke the safe_tool now with empty arguments {}.',
      session,
    ));

    expect(result.toolsUsed).toContain('safe_tool');
    const toolMsg = session.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('safe result xyz');
    expect(toolMsg!.content).not.toContain('Permission denied');
  }, 60_000);
});
