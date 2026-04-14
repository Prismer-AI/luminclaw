/**
 * Embedded runtime entry — single-loop agent that runs in JavaScriptCore (iOS),
 * Hermes/V8 (Android), and Electron without any node:* dependencies.
 *
 * Bundle target: `dist/luminclaw-core.js` via `esbuild.embedded.mjs`.
 *
 * Differences from `runAgent` in src/index.ts:
 * - No filesystem reads (no SOUL.md / AGENTS.md / TOOLS.md scanning)
 * - No workspace plugin loading
 * - No bash tool — embed contexts inject their own platform-appropriate tools
 * - Memory backend must be supplied (no auto FileMemoryBackend)
 * - DirectiveScanner not wired (embed contexts inject one if needed)
 *
 * Plan-mode tools (enter_plan_mode, exit_plan_mode) ARE auto-registered.
 * memory_store / memory_recall ARE auto-registered if memoryBackend supplied.
 *
 * @module embedded
 */

import { PrismerAgent, type AgentOptions, type AgentResult } from './agent.js';
import { OpenAICompatibleProvider, FallbackProvider, type Provider } from './provider.js';
import { ToolRegistry, type Tool, createTool } from './tools.js';
import { Session, SessionStore } from './session.js';
import { EventBus, type AgentEvent } from './sse.js';
import { ConsoleObserver } from './observer.js';
import { AgentRegistry, BUILTIN_AGENTS, type AgentConfig } from './agents.js';
import { MemoryStore, type MemoryBackend } from './memory.js';
import { createConfig } from './config.js';
import type { LuminConfig } from './config.js';
import { createEnterPlanModeTool, createExitPlanModeTool } from './tools/plan-mode.js';
import { createLogger } from './log.js';

const log = createLogger('embedded');

// ── Re-exports for embed consumers ─────────────────────────

export { PrismerAgent } from './agent.js';
export { OpenAICompatibleProvider, FallbackProvider } from './provider.js';
export type { Provider, ChatRequest, ChatResponse, Message, ToolSpec, ToolCall } from './provider.js';
export { ToolRegistry, createTool } from './tools.js';
export type { Tool, ToolContext } from './tools.js';
export { Session, SessionStore } from './session.js';
export type { Directive } from './session.js';
export { EventBus } from './sse.js';
export type { AgentEvent } from './sse.js';
export { MemoryStore } from './memory.js';
export type { MemoryBackend, MemorySearchResult, MemoryCapabilities } from './memory.js';
export { AgentRegistry, BUILTIN_AGENTS } from './agents.js';
export type { AgentConfig } from './agents.js';
export { createConfig } from './config.js';
export type { LuminConfig } from './config.js';
export { VERSION } from './version.js';
export { AbortReason, createAbortError, isAbortError, getAbortReason } from './abort.js';
export { PermissionMode, defaultPermissionContext, enterPlanMode, exitPlanMode } from './permissions.js';
export type { ToolPermissionContext, PermissionResult, PermissionModeValue } from './permissions.js';

// ── Runtime factory ────────────────────────────────────────

export interface CreateAgentRuntimeDeps {
  /** Pre-constructed Provider — usually OpenAICompatibleProvider with a base URL + key. */
  provider: Provider;
  /** Tools to register. Embed contexts supply platform-native tools (e.g. iOS Photos search). */
  tools?: Tool[];
  /** Sub-agent definitions. Defaults to BUILTIN_AGENTS. */
  agents?: AgentConfig[];
  /** System prompt. Embed contexts assemble this from their own templates. */
  systemPrompt: string;
  /** Memory backend — when supplied, memory_store + memory_recall tools are auto-registered. */
  memoryBackend?: MemoryBackend;
  /** Config overrides. process.env is NOT read. */
  config?: Record<string, unknown>;
  /** Iteration cap. Default: 40. */
  maxIterations?: number;
  /** Default agent id. Default: 'researcher'. */
  agentId?: string;
}

export interface AgentRuntime {
  /** Process a user message — returns AsyncGenerator of events + final result. */
  processMessage(content: string, sessionId?: string): AsyncGenerator<AgentEvent, AgentResult>;
  /** Get or create a session. */
  getSession(id: string): Session;
  /** EventBus for global subscription (independent of per-message generators). */
  bus: EventBus;
  /** Cleanup. Currently a no-op; provided for forward compat. */
  shutdown(): Promise<void>;
}

/**
 * Build an AgentRuntime ready to run in any embed context.
 *
 * @example
 * ```js
 * const runtime = LuminClaw.createAgentRuntime({
 *   provider: new LuminClaw.OpenAICompatibleProvider({
 *     baseUrl: 'http://api.example.com/v1', apiKey: 'k', defaultModel: 'us-kimi-k2.5',
 *   }),
 *   tools: [photoSearchTool, noteReadTool],   // platform-native, injected
 *   memoryBackend: nativeMemoryBackend,       // optional Swift/Kotlin impl
 *   systemPrompt: 'You are a helpful assistant.',
 * });
 *
 * for await (const event of runtime.processMessage('Find my notes from last week')) {
 *   console.log(event.type);
 * }
 * ```
 */
export function createAgentRuntime(deps: CreateAgentRuntimeDeps): AgentRuntime {
  const cfg: LuminConfig = createConfig(deps.config ?? {});
  const tools = new ToolRegistry();

  for (const t of deps.tools ?? []) {
    tools.register(t);
  }

  // Plan mode tools — always available
  tools.register(createEnterPlanModeTool());
  tools.register(createExitPlanModeTool());

  // Memory tools — only if backend supplied
  if (deps.memoryBackend) {
    const memStore = new MemoryStore(deps.memoryBackend);
    tools.register(createTool(
      'memory_store',
      'Store a memory entry for later recall.',
      {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Memory content' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        },
        required: ['content'],
      },
      async (args, _ctx) => {
        await memStore.store(args.content as string, (args.tags as string[] | undefined) ?? []);
        return 'Memory stored.';
      },
    ));
    tools.register(createTool(
      'memory_recall',
      'Search stored memories by keywords.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxChars: { type: 'number', description: 'Max chars (default 4000)' },
        },
        required: ['query'],
      },
      async (args, _ctx) => {
        const result = await memStore.recall(
          args.query as string,
          (args.maxChars as number | undefined) ?? 4000,
        );
        return result || 'No matching memories found.';
      },
    ));
  }

  const agents = new AgentRegistry();
  agents.registerMany(deps.agents ?? BUILTIN_AGENTS);
  const sessions = new SessionStore();
  const bus = new EventBus();
  const observer = new ConsoleObserver();

  const baseAgentOptions: AgentOptions = {
    provider: deps.provider,
    tools,
    observer,
    agents,
    bus,
    systemPrompt: deps.systemPrompt,
    model: cfg.llm.model,
    maxIterations: deps.maxIterations ?? cfg.agent.maxIterations,
    agentId: deps.agentId ?? cfg.agent.template ?? 'researcher',
    workspaceDir: cfg.workspace.dir,
    // No directiveScanner — embed contexts inject if needed
  };

  log.info('embedded runtime ready', {
    toolCount: tools.size,
    hasMemory: Boolean(deps.memoryBackend),
    model: cfg.llm.model,
  });

  return {
    bus,
    getSession(id: string): Session {
      return sessions.getOrCreate(id);
    },
    async *processMessage(content: string, sessionId?: string) {
      const sid = sessionId ?? `embed-${Date.now()}`;
      const session = sessions.getOrCreate(sid);
      const agent = new PrismerAgent(baseAgentOptions);
      const gen = agent.processMessage(content, session);
      let next = await gen.next();
      while (!next.done) {
        yield next.value;
        next = await gen.next();
      }
      return next.value;
    },
    async shutdown() { /* placeholder for future cleanup */ },
  };
}
