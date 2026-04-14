/**
 * Config — unified, Zod-validated configuration for the Lumin runtime.
 *
 * All runtime settings are defined in a single {@link LuminConfigSchema}.
 * {@link loadConfig} reads environment variables (backward-compatible with
 * existing env vars), applies overrides, validates via Zod, and returns a
 * frozen config object.
 *
 * @example
 * ```typescript
 * import { loadConfig } from './config.js';
 *
 * // Load from environment (zero-arg is the common case)
 * const cfg = loadConfig();
 * console.log(cfg.llm.model);       // 'gpt-4o'
 * console.log(cfg.agent.maxIterations); // 40
 *
 * // Override specific values
 * const cfg2 = loadConfig({ port: 8080, llm: { model: 'gpt-4o' } });
 * ```
 *
 * @module config
 */

import { z } from 'zod';

// ── Schema ───────────────────────────────────────────────

/** Zod schema for the complete Lumin runtime configuration. */
export const LuminConfigSchema = z.object({
  /** HTTP/WebSocket server port. Env: `LUMIN_PORT`. */
  port: z.number().default(3001),
  /** Server bind address. */
  host: z.string().default('0.0.0.0'),

  /** LLM provider settings. */
  llm: z.object({
    /** OpenAI-compatible API base URL. Env: `OPENAI_API_BASE_URL`. */
    baseUrl: z.string().default('https://api.openai.com/v1'),
    /** API key for the LLM provider. Env: `OPENAI_API_KEY`. */
    apiKey: z.string().default(''),
    /** Default model identifier. Env: `AGENT_DEFAULT_MODEL`. */
    model: z.string().default('gpt-4o'),
    /** Fallback model chain (tried in order). Env: `MODEL_FALLBACK_CHAIN` (comma-separated). */
    fallbackModels: z.array(z.string()).default([]),
    /** Default max completion tokens. */
    maxTokens: z.number().default(8192),
    /** HTTP request timeout in ms. */
    requestTimeout: z.number().default(300_000),
  }).default({}),

  /** Agent loop settings. */
  agent: z.object({
    /** Maximum tool-calling iterations per request. */
    maxIterations: z.number().default(40),
    /** Context window budget in characters (~4 chars/token). Env: `MAX_CONTEXT_CHARS`. */
    maxContextChars: z.number().default(600_000),
    /** Maximum characters kept from a single tool result. */
    maxToolResultChars: z.number().default(150_000),
    /** Consecutive all-error rounds before doom-loop abort. */
    doomLoopThreshold: z.number().default(3),
    /** Identical tool-call signatures before repetition abort. */
    repetitionThreshold: z.number().default(5),
    /** Maximum chars from tool result sent in tool.end SSE event. Env: `TOOL_END_SUMMARY_CHARS`. */
    toolEndSummaryChars: z.number().default(1000),
    /** Agent template (`lite` loads fewer tools). Env: `AGENT_TEMPLATE`. */
    template: z.string().default('lite'),
    /**
     * Execution architecture. Env: `LUMIN_LOOP_MODE`.
     * - `single`: synchronous single-loop (default, production-stable)
     * - `dual`:   async dual-loop / HIL+EL (experimental, Phase 4)
     *
     * Per-container DB field overrides this value at request time via
     * `resolveLoopMode()`. This config value is the server-wide default.
     */
    loopMode: z.enum(['single', 'dual']).default('single'),
  }).default({}),

  /** Approval gate for sensitive tools. */
  approval: z.object({
    /** Timeout (ms) before auto-rejecting an approval request. Env: `APPROVAL_TIMEOUT_MS`. */
    timeoutMs: z.number().default(30_000),
    /** Tool names that require approval. Env: `SENSITIVE_TOOLS` (comma-separated). */
    sensitiveTools: z.array(z.string()).default(['bash']),
    /** Regex patterns matching destructive bash commands. */
    bashPatterns: z.array(z.string()).default([
      '\\brm\\s', '\\brmdir\\b', '\\bmv\\s', '\\bchmod\\b', '\\bchown\\b', '\\bkill\\b',
    ]),
  }).default({}),

  /** Workspace filesystem settings. */
  workspace: z.object({
    /** Root working directory. Env: `WORKSPACE_DIR`. */
    dir: z.string().default('./workspace'),
    /** Path to the workspace plugin entry. Env: `PRISMER_PLUGIN_PATH`. */
    pluginPath: z.string().default(''),
  }).default({}),

  /** Session management. */
  session: z.object({
    /** Idle time (ms) before a session is garbage-collected. */
    maxIdleMs: z.number().default(30 * 60_000),
    /** Interval (ms) between cleanup sweeps. */
    cleanupIntervalMs: z.number().default(60_000),
  }).default({}),

  /** Server internals. */
  server: z.object({
    /** HTTP request body read timeout (ms). */
    bodyTimeoutMs: z.number().default(30_000),
    /** WebSocket heartbeat ping interval (ms). */
    wsHeartbeatMs: z.number().default(30_000),
    /** Max wait (ms) before forced shutdown. */
    shutdownTimeoutMs: z.number().default(5_000),
    /** CORS Access-Control-Max-Age (seconds). */
    corsMaxAge: z.number().default(86_400),
  }).default({}),

  /** EventBus backpressure settings. */
  eventBus: z.object({
    /** Maximum buffered events before drop-oldest. */
    maxBuffer: z.number().default(1000),
  }).default({}),

  /** Logging settings. */
  log: z.object({
    /** Minimum log level. Env: `LOG_LEVEL`. */
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** Debug namespace filter (e.g., `lumin:*`). Env: `DEBUG`. */
    debug: z.string().default(''),
  }).default({}),

  /** Memory backend settings. */
  memory: z.object({
    /** Backend type. Env: `MEMORY_BACKEND`. */
    backend: z.enum(['file', 'cloud', 'vector']).default('file'),
    /** Max chars for recent context in system prompt. */
    recentContextMaxChars: z.number().default(3000),
  }).default({}),

  /** Tool module gating. */
  modules: z.object({
    /** Enabled tool module names. Env: `PRISMER_ENABLED_MODULES` (comma-separated). Empty = load all. */
    enabled: z.array(z.string()).default([]),
  }).default({}),

  /** Prismer platform integration. */
  prismer: z.object({
    /** Workspace API base URL. Env: `PRISMER_API_BASE_URL`. */
    apiBaseUrl: z.string().default('http://host.docker.internal:3000'),
    /** Agent identity. Env: `AGENT_ID`. */
    agentId: z.string().default('default'),
    /** Workspace identifier. Env: `WORKSPACE_ID`. */
    workspaceId: z.string().optional(),
    /** Cloud IM service URL. Env: `PRISMER_IM_BASE_URL`. */
    imBaseUrl: z.string().optional(),
    /** Cloud IM conversation. Env: `PRISMER_IM_CONVERSATION_ID`. */
    imConversationId: z.string().optional(),
    /** Cloud IM auth token. Env: `PRISMER_IM_TOKEN`. */
    imToken: z.string().optional(),
  }).default({}),
});

/** The complete Lumin runtime configuration type. */
export type LuminConfig = z.infer<typeof LuminConfigSchema>;

// ── Env Var Mapping ──────────────────────────────────────

/**
 * Build a raw config object from environment variables.
 * This provides backward compatibility with all existing env vars.
 */
function fromEnv(): Record<string, unknown> {
  const env = process.env;
  const raw: Record<string, unknown> = {};

  if (env.LUMIN_PORT) raw.port = parseInt(env.LUMIN_PORT, 10);

  // LLM
  const llm: Record<string, unknown> = {};
  if (env.OPENAI_API_BASE_URL) llm.baseUrl = env.OPENAI_API_BASE_URL;
  if (env.OPENAI_API_KEY) llm.apiKey = env.OPENAI_API_KEY;
  if (env.AGENT_DEFAULT_MODEL) {
    const m = env.AGENT_DEFAULT_MODEL;
    llm.model = m.startsWith('prismer-gateway/') ? m.slice('prismer-gateway/'.length) : m;
  }
  if (env.MODEL_FALLBACK_CHAIN) llm.fallbackModels = env.MODEL_FALLBACK_CHAIN.split(',').filter(Boolean);
  if (Object.keys(llm).length) raw.llm = llm;

  // Agent
  const agent: Record<string, unknown> = {};
  if (env.MAX_CONTEXT_CHARS) agent.maxContextChars = parseInt(env.MAX_CONTEXT_CHARS, 10);
  if (env.AGENT_TEMPLATE) agent.template = env.AGENT_TEMPLATE;
  if (env.TOOL_END_SUMMARY_CHARS) agent.toolEndSummaryChars = parseInt(env.TOOL_END_SUMMARY_CHARS, 10);
  if (env.LUMIN_LOOP_MODE === 'single' || env.LUMIN_LOOP_MODE === 'dual') agent.loopMode = env.LUMIN_LOOP_MODE;
  if (Object.keys(agent).length) raw.agent = agent;

  // Approval
  const approval: Record<string, unknown> = {};
  if (env.APPROVAL_TIMEOUT_MS) approval.timeoutMs = parseInt(env.APPROVAL_TIMEOUT_MS, 10);
  if (env.SENSITIVE_TOOLS) approval.sensitiveTools = env.SENSITIVE_TOOLS.split(',').filter(Boolean);
  if (Object.keys(approval).length) raw.approval = approval;

  // Workspace
  const workspace: Record<string, unknown> = {};
  if (env.WORKSPACE_DIR) workspace.dir = env.WORKSPACE_DIR;
  if (env.PRISMER_PLUGIN_PATH) workspace.pluginPath = env.PRISMER_PLUGIN_PATH;
  if (Object.keys(workspace).length) raw.workspace = workspace;

  // Logging
  const log: Record<string, unknown> = {};
  if (env.LOG_LEVEL) log.level = env.LOG_LEVEL.toLowerCase();
  if (env.DEBUG) log.debug = env.DEBUG;
  if (Object.keys(log).length) raw.log = log;

  // Memory
  const memory: Record<string, unknown> = {};
  if (env.MEMORY_BACKEND) memory.backend = env.MEMORY_BACKEND;
  if (Object.keys(memory).length) raw.memory = memory;

  // Modules
  const modules: Record<string, unknown> = {};
  if (env.PRISMER_ENABLED_MODULES) modules.enabled = env.PRISMER_ENABLED_MODULES.split(',').filter(Boolean);
  if (Object.keys(modules).length) raw.modules = modules;

  // Prismer
  const prismer: Record<string, unknown> = {};
  if (env.PRISMER_API_BASE_URL) prismer.apiBaseUrl = env.PRISMER_API_BASE_URL;
  if (env.AGENT_ID) prismer.agentId = env.AGENT_ID;
  if (env.WORKSPACE_ID) prismer.workspaceId = env.WORKSPACE_ID;
  if (env.PRISMER_IM_BASE_URL) prismer.imBaseUrl = env.PRISMER_IM_BASE_URL;
  if (env.PRISMER_IM_CONVERSATION_ID) prismer.imConversationId = env.PRISMER_IM_CONVERSATION_ID;
  if (env.PRISMER_IM_TOKEN) prismer.imToken = env.PRISMER_IM_TOKEN;
  if (Object.keys(prismer).length) raw.prismer = prismer;

  return raw;
}

// ── Deep Merge ───────────────────────────────────────────

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== undefined &&
      typeof source[key] === 'object' &&
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

// ── Public API ───────────────────────────────────────────

/** Singleton cache. */
let cached: LuminConfig | null = null;

/**
 * Load and validate the Lumin configuration.
 *
 * Resolution order (later wins):
 *   1. Schema defaults
 *   2. Environment variables
 *   3. Explicit overrides
 *
 * The result is frozen and cached. Call {@link resetConfig} to clear.
 *
 * @param overrides - Partial config object to merge on top of env values.
 * @returns A validated, frozen {@link LuminConfig}.
 * @throws {z.ZodError} If the merged config fails validation.
 */
export function loadConfig(overrides?: Record<string, unknown>): LuminConfig {
  if (cached && !overrides) return cached;

  const envValues = fromEnv();
  const merged = overrides ? deepMerge(envValues, overrides) : envValues;

  // Zod v4 fix: `.default({})` on sub-objects sets the raw `{}` without
  // re-parsing through the inner schema, so inner field defaults don't apply.
  // Explicitly inserting `{}` for missing sub-objects makes Zod parse them
  // through z.object({...}) which correctly applies inner field defaults.
  const SUB_KEYS = ['llm', 'agent', 'approval', 'workspace', 'session', 'server', 'eventBus', 'log', 'prismer'];
  for (const key of SUB_KEYS) {
    if (!(key in merged)) merged[key] = {};
  }

  const config = LuminConfigSchema.parse(merged);

  if (!overrides) {
    cached = config;
  }
  return config;
}

/**
 * Clear the cached config (for testing or dynamic reload).
 * @internal
 */
export function resetConfig(): void {
  cached = null;
}

/**
 * Pure config factory — Zod-parses an override object without reading
 * process.env. Used by embedded runtimes (iOS, Android, Electron) that
 * supply config explicitly.
 *
 * @example
 * const cfg = createConfig({
 *   llm: { baseUrl: 'http://example.com/v1', apiKey: 'k', model: 'm' },
 *   workspace: { dir: '/tmp/foo', pluginPath: '' },
 * });
 */
export function createConfig(overrides: Record<string, unknown> = {}): LuminConfig {
  return LuminConfigSchema.parse(overrides);
}
