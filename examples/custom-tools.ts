/**
 * Custom tools — register your own tools alongside builtins.
 *
 * Prerequisites:
 *   export OPENAI_API_KEY=sk-...
 *
 * Run:
 *   npx tsx examples/custom-tools.ts
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
import { ConsoleObserver } from '@prismer/agent-core/sse';

// 1. Create provider
const cfg = loadConfig();
const provider = new OpenAICompatibleProvider({
  baseUrl: cfg.llm.baseUrl,
  apiKey: cfg.llm.apiKey,
  defaultModel: cfg.llm.model,
});

// 2. Create tool registry with builtins + custom tool
const tools = new ToolRegistry();
tools.registerMany(BUILTIN_TOOLS);

// Add a custom tool
tools.register({
  name: 'current_time',
  description: 'Returns the current date and time.',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return new Date().toISOString();
  },
});

// 3. Create and run agent
const bus = new EventBus();
const sessions = new SessionStore();
const session = sessions.getOrCreate('example');

const agent = new PrismerAgent({
  provider,
  tools,
  bus,
  systemPrompt: 'You are a helpful assistant with access to file tools and a clock.',
  model: cfg.llm.model,
  workspaceDir: cfg.workspace.dir,
});

const result = await agent.processMessage(
  'What time is it? Also, create a file called hello.txt with a greeting.',
  session,
);

console.log('Agent response:', result.text);
console.log('Tools used:', result.toolsUsed);
