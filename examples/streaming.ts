/**
 * Streaming — consume SSE events from the agent in real time.
 *
 * Prerequisites:
 *   export OPENAI_API_KEY=sk-...
 *
 * Run:
 *   npx tsx examples/streaming.ts
 */

import {
  PrismerAgent,
  OpenAICompatibleProvider,
  ToolRegistry,
  EventBus,
  SessionStore,
  BUILTIN_TOOLS,
  loadConfig,
} from '@prismer/agent-core';

const cfg = loadConfig();
const provider = new OpenAICompatibleProvider({
  baseUrl: cfg.llm.baseUrl,
  apiKey: cfg.llm.apiKey,
  defaultModel: cfg.llm.model,
});

const tools = new ToolRegistry();
tools.registerMany(BUILTIN_TOOLS);

// Subscribe to streaming events
const bus = new EventBus();
bus.on('*', (event) => {
  const { stream, data } = event as { stream?: string; data?: unknown };
  if (stream === 'assistant') {
    const d = data as { delta?: string };
    if (d.delta) process.stdout.write(d.delta);
  } else if (stream === 'tool') {
    const d = data as { event?: string; name?: string };
    if (d.event === 'start') console.log(`\n[tool] ${d.name} started`);
    if (d.event === 'end') console.log(`[tool] ${d.name} finished`);
  } else if (stream === 'lifecycle') {
    const d = data as { phase?: string };
    if (d.phase === 'start') console.log('[thinking...]');
  }
});

const sessions = new SessionStore();
const session = sessions.getOrCreate('stream-example');

const agent = new PrismerAgent({
  provider,
  tools,
  bus,
  systemPrompt: 'You are a helpful assistant.',
  model: cfg.llm.model,
  workspaceDir: cfg.workspace.dir,
});

await agent.processMessage(
  'Write a short haiku about programming, then save it to haiku.txt',
  session,
);

console.log('\n\nDone.');
