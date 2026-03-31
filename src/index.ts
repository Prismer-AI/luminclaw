/**
 * Lumin — agent runtime core.
 *
 * This module wires together every subsystem (provider, tools, sessions,
 * prompt builder, skills, memory, channels) and exposes the public
 * {@link runAgent} function used by both the CLI and the gateway server.
 *
 * It is **not** the process entry point — see `cli.ts` for that.
 *
 * @module index
 */

import { PrismerAgent, type AgentResult } from './agent.js';
import { AgentRegistry, BUILTIN_AGENTS } from './agents.js';
import { OpenAICompatibleProvider, FallbackProvider, type Provider } from './provider.js';
import { ToolRegistry } from './tools.js';
import { ConsoleObserver } from './observer.js';
import { EventBus, StdoutSSEWriter } from './sse.js';
import { SessionStore } from './session.js';
import { writeOutput, type InputMessage } from './ipc.js';
import { loadWorkspaceToolsFromPlugin, createTool, createClawHubTool, getBuiltinTools, type WorkspacePluginConfig } from './tools/index.js';
import { PromptBuilder } from './prompt.js';
import { SkillLoader } from './skills.js';
import { MemoryStore } from './memory.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';

const log = createLogger('runtime');

// ── Shared state (reused across runAgent calls in server mode) ──

let sharedTools: ToolRegistry | null = null;
let sharedAgents: AgentRegistry | null = null;
const sharedSessions = new SessionStore();
let sharedGenerateWorkspaceMd: ((state: unknown) => string) | null = null;
let sharedSkillLoader: SkillLoader | null = null;
let sharedMemory: MemoryStore | null = null;

/**
 * Build workspace plugin config from the unified configuration.
 * Values originate from environment variables via {@link loadConfig}.
 */
function buildPluginConfig(): WorkspacePluginConfig {
  const cfg = loadConfig();
  return {
    apiBaseUrl: cfg.prismer.apiBaseUrl,
    agentId: cfg.prismer.agentId,
    workspaceId: cfg.prismer.workspaceId,
    imBaseUrl: cfg.prismer.imBaseUrl,
    imConversationId: cfg.prismer.imConversationId,
    imToken: cfg.prismer.imToken,
  };
}

/**
 * Initialize tools and agent registry (lazy, singleton).
 * In CLI mode this runs once; in server mode it's shared across requests.
 *
 * @param enabledModules - Optional list of tool module names to load.
 *   When omitted, the agent template from config determines the set.
 */
async function ensureInitialized(enabledModules?: string[]): Promise<{ tools: ToolRegistry; agents: AgentRegistry }> {
  if (!sharedTools) {
    const cfg = loadConfig();
    sharedTools = new ToolRegistry();

    const pluginPath = cfg.workspace.pluginPath;
    const pluginConfig = buildPluginConfig();

    // Module gating: PRISMER_ENABLED_MODULES (from server) > explicit arg > AGENT_TEMPLATE fallback
    let modules = enabledModules;
    if (!modules && cfg.modules.enabled.length > 0) {
      modules = cfg.modules.enabled;
      log.debug('module selection from env', { modules: modules.join(', ') });
    }
    if (!modules) {
      const template = cfg.agent.template;
      if (template === 'lite') {
        // Load LITE_MODULES from the plugin's modules file
        try {
          const modulesPath = pluginPath.replace('/tools.js', '/modules.js');
          const { LITE_MODULES } = await import(modulesPath);
          if (LITE_MODULES) {
            modules = LITE_MODULES;
            log.debug('template module selection', { template, modules: (modules as string[]).join(', ') });
          }
        } catch { /* module discovery failed, load all tools */ }
      }
      // 'researcher' and other templates → load all tools (no filtering)
    }

    const { tools: workspaceTools, generateWorkspaceMd } = await loadWorkspaceToolsFromPlugin(
      pluginPath, modules, pluginConfig,
    );
    sharedTools.registerMany(workspaceTools);

    // Save generateWorkspaceMd for per-request prompt building
    if (generateWorkspaceMd) {
      sharedGenerateWorkspaceMd = generateWorkspaceMd;
    }

    // Built-in tools — plugin tools with the same name take precedence
    const pluginNames = new Set(workspaceTools.map(t => t.name));
    const builtins = getBuiltinTools(pluginNames);
    sharedTools.registerMany(builtins);
    log.debug('built-in tools registered', { count: builtins.length, skipped: pluginNames.size > 0 ? [...pluginNames].filter(n => ['read_file', 'write_file', 'list_files', 'edit_file', 'grep', 'web_fetch', 'think'].includes(n)) : [] });

    // Bash — always available (sandboxed by container isolation)
    const workspaceDir = cfg.workspace.dir;
    sharedTools.register(createTool(
      'bash',
      'Execute a bash command in the container. Use for file operations, package installation, and system commands.',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
        },
        required: ['command'],
      },
      async (cmdArgs) => {
        const { execSync } = await import('node:child_process');
        const cmd = cmdArgs.command as string;
        const timeout = (cmdArgs.timeout as number) ?? 30_000;
        try {
          const output = execSync(cmd, {
            cwd: workspaceDir,
            timeout,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            env: { ...process.env, HOME: process.env.HOME || '/home/user' },
          });
          return output.slice(0, 10_000);
        } catch (err: unknown) {
          const e = err as { stderr?: string; message?: string };
          return `Error: ${e.stderr || e.message || String(err)}`.slice(0, 5_000);
        }
      },
    ));

    // Memory — file-based persistent memory
    sharedMemory = new MemoryStore(workspaceDir);
    sharedTools.register(createTool(
      'memory_store',
      'Store a memory entry for later recall. Use to save important facts, decisions, code snippets, or action items.',
      {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content to store' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        },
        required: ['content'],
      },
      async (args, ctx) => {
        const content = args.content as string;
        const tags = (args.tags as string[] | undefined) ?? [];
        await sharedMemory!.store(content, tags);
        ctx.emit({ type: 'output', data: { action: 'store', preview: content.slice(0, 100) } });
        return 'Memory stored successfully.';
      },
    ));
    sharedTools.register(createTool(
      'memory_recall',
      'Search stored memories by keywords. Returns relevant past entries sorted by relevance.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search for in memories' },
          maxChars: { type: 'number', description: 'Max characters to return (default: 4000)' },
        },
        required: ['query'],
      },
      async (args, ctx) => {
        const query = args.query as string;
        const result = await sharedMemory!.recall(query, (args.maxChars as number) ?? 4000);
        const resultCount = result ? result.split('\n\n').filter(Boolean).length : 0;
        ctx.emit({ type: 'output', data: { action: 'recall', query, resultCount } });
        return result || 'No matching memories found.';
      },
    ));

    // Skills — load SKILL.md files and register ClawHub tool
    sharedSkillLoader = new SkillLoader();
    sharedTools.register(createClawHubTool(sharedSkillLoader));

    const skillCount = sharedSkillLoader.count;
    log.info('tools loaded', { total: sharedTools.size, plugin: workspaceTools.length, skills: skillCount });
  }

  if (!sharedAgents) {
    sharedAgents = new AgentRegistry();
    sharedAgents.registerMany(BUILTIN_AGENTS);
  }

  return { tools: sharedTools, agents: sharedAgents };
}

// ── Dynamic System Prompt ────────────────────────────────

/**
 * Build the dynamic system prompt for an agent run.
 * Assembles: identity + tools ref + agent instructions + workspace context + runtime info
 */
async function buildSystemPrompt(
  agentPrompt: string,
  config: {
    model?: string;
    agentId?: string;
    workspaceDir?: string;
    toolCount?: number;
  },
): Promise<string> {
  const c = loadConfig();
  const workspaceDir = config.workspaceDir ?? c.workspace.dir;
  const builder = new PromptBuilder({ workspaceDir });

  // 1. Identity from SOUL.md (or default)
  builder.loadIdentity();

  // 2. Agent configuration from AGENTS.md
  builder.loadAgentConfig();

  // 3. Tools reference from TOOLS.md
  builder.loadToolsRef();

  // 4. Agent-specific instructions
  builder.setAgentInstructions(agentPrompt);

  // 4.5 User profile from USER.md
  builder.loadUserProfile();

  // 4. Skills (from SKILL.md files)
  if (sharedSkillLoader) {
    const skillSections = sharedSkillLoader.toPromptSections();
    if (skillSections.length > 0) {
      builder.addSkillSections(skillSections);
    }
  }

  // 5. Workspace context (from plugin, if available)
  if (sharedGenerateWorkspaceMd) {
    try {
      const workspaceMd = sharedGenerateWorkspaceMd({});
      builder.setWorkspaceContext(workspaceMd);
    } catch { /* graceful degradation */ }
  }

  // 6. Memory context (recent entries)
  if (sharedMemory) {
    try {
      const recentMemory = await sharedMemory.loadRecentContext(3000);
      if (recentMemory) {
        builder.addSection({ id: 'memory', content: `## Recent Memory\n\n${recentMemory}`, priority: 6 });
      }
    } catch { /* memory load failure is non-fatal */ }
  }

  // 7. Runtime info
  builder.addRuntimeInfo({
    agentId: config.agentId,
    model: config.model,
    workspaceId: c.prismer.workspaceId,
    toolCount: config.toolCount,
    nodeVersion: process.version,
  });

  return builder.build();
}

// ── Public API ──────────────────────────────────────────

/** Options for {@link runAgent}. */
export interface RunAgentOptions {
  /** Enable SSE streaming to stdout (CLI mode). */
  stream?: boolean;
  /** EventBus override (server mode injects its own bus for WS forwarding). */
  bus?: EventBus;
  /** Called when agent finishes (server mode sends result over WS instead of stdout). */
  onResult?: (result: AgentResult, sessionId: string) => void;
  /** AbortSignal for cancellation (chat.cancel). Checked between iterations + tool calls. */
  signal?: AbortSignal;
}

/**
 * Run the agent loop for a single message.
 *
 * In CLI mode: writes structured JSON to stdout via IPC protocol.
 * In server mode: calls `onResult` callback (no stdout writes).
 */
export async function runAgent(input: InputMessage, opts: RunAgentOptions = {}): Promise<void> {
  const observer = new ConsoleObserver();
  const bus = opts.bus ?? new EventBus();

  // SSE streaming to stdout (CLI mode only)
  const sseWriter = new StdoutSSEWriter(bus);
  if (opts.stream && !opts.onResult) {
    sseWriter.start();
  }

  const cfg = loadConfig();
  const inputCfg = input.config ?? {};
  const baseUrl = inputCfg.baseUrl || cfg.llm.baseUrl;
  const apiKey = inputCfg.apiKey || cfg.llm.apiKey;
  const rawModel = inputCfg.model || cfg.llm.model;
  // Strip only the Prismer gateway prefix (e.g. "prismer-gateway/us-kimi-k2.5" → "us-kimi-k2.5")
  // Keep other prefixes intact (e.g. "openai/gpt-oss-120b" stays as-is for external gateways)
  const model = rawModel.startsWith('prismer-gateway/') ? rawModel.slice('prismer-gateway/'.length) : rawModel;
  const workspaceDir = cfg.workspace.dir;

  const baseProvider = new OpenAICompatibleProvider({ baseUrl, apiKey, defaultModel: model });
  const fallbacks = cfg.llm.fallbackModels;
  const provider: Provider = fallbacks.length > 0
    ? new FallbackProvider(baseProvider, [model, ...fallbacks])
    : baseProvider;
  const { tools, agents } = await ensureInitialized(inputCfg.tools);

  const sessionId = input.sessionId ?? `session-${Date.now()}`;
  const session = sharedSessions.getOrCreate(sessionId);

  const agentId = inputCfg.agentId ?? 'researcher';
  const agentConfig = agents.get(agentId);
  const agentPrompt = agentConfig?.systemPrompt ?? BUILTIN_AGENTS[0].systemPrompt;

  // Build dynamic system prompt
  const systemPrompt = await buildSystemPrompt(agentPrompt, {
    model,
    agentId,
    workspaceDir,
    toolCount: tools.size,
  });

  const agent = new PrismerAgent({
    provider,
    tools,
    observer,
    agents,
    bus,
    memoryStore: sharedMemory ?? undefined,
    systemPrompt,
    model,
    maxIterations: inputCfg.maxIterations ?? cfg.agent.maxIterations,
    agentId,
    workspaceDir,
    abortSignal: opts.signal,
  });

  try {
    // Consume the AsyncGenerator — events are published to bus internally
    const gen = agent.processMessage(input.content ?? '', session);
    let iterResult = await gen.next();
    while (!iterResult.done) iterResult = await gen.next();
    const result = iterResult.value;

    if (opts.onResult) {
      opts.onResult(result, sessionId);
    } else {
      writeOutput({
        status: 'success',
        response: result.text,
        thinking: result.thinking,
        directives: result.directives,
        toolsUsed: result.toolsUsed,
        usage: result.usage,
        sessionId,
        iterations: result.iterations,
      });
    }
  } catch (err) {
    if (opts.onResult) {
      opts.onResult({
        text: '',
        directives: [],
        toolsUsed: [],
        iterations: 0,
      }, sessionId);
    } else {
      writeOutput({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        sessionId,
      });
    }
  } finally {
    sseWriter.stop();
    await observer.flush();
  }
}

// Re-exports for library consumers
export { PrismerAgent, type AgentResult } from './agent.js';
export { AgentRegistry, BUILTIN_AGENTS } from './agents.js';
export { OpenAICompatibleProvider } from './provider.js';
export { ToolRegistry } from './tools.js';
export { EventBus, StdoutSSEWriter } from './sse.js';
export { SessionStore } from './session.js';
export { type InputMessage, type OutputMessage, writeOutput, parseOutput, OUTPUT_START, OUTPUT_END } from './ipc.js';
export { loadWorkspaceToolsFromPlugin, createTool, createClawHubTool, BUILTIN_TOOLS, getBuiltinTools } from './tools/index.js';
export { PromptBuilder, type PromptSection } from './prompt.js';
export { SkillLoader, type LoadedSkill, type SkillMeta } from './skills.js';
export { MemoryStore, FileMemoryBackend } from './memory.js';
export type { MemoryBackend, MemorySearchResult, MemoryCapabilities, MemorySearchOptions } from './memory.js';
export { HookRegistry, type Hook, type HookType, type HookContext } from './hooks.js';
export { ChannelManager } from './channels/manager.js';
export type { ChannelAdapter, IncomingMessage as ChannelMessage } from './channels/types.js';
export { loadConfig, resetConfig, LuminConfigSchema, type LuminConfig } from './config.js';
export { createLogger, type Logger, type LogLevel } from './log.js';
export { VERSION } from './version.js';
export { createAgentLoop, resolveLoopMode } from './loop/factory.js';
export type { IAgentLoop, AgentLoopInput, AgentLoopResult, AgentLoopCallOpts, Artifact, ArtifactStore, LoopMode } from './loop/types.js';
export { InMemoryArtifactStore } from './artifacts/memory.js';
export { createArtifact, inferArtifactType } from './artifacts/types.js';
export type { ArtifactInput, ArtifactType } from './artifacts/types.js';
export { InMemoryTaskStore } from './task/store.js';
export { TaskStateMachine, InvalidTransitionError } from './task/machine.js';
export type { Task, TaskStatus, TaskStore, Checkpoint, CheckpointType } from './task/types.js';
export { microcompact, CLEARED_MARKER } from './microcompact.js';
export { estimateTokens, estimateMessageTokens } from './tokens.js';
export { StreamingToolExecutor, type ToolCallInfo, type ToolResult, type TrackedTool, type ToolStatus, type ExecuteFn } from './streaming-executor.js';
