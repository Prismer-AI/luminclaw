/**
 * Hooks — lifecycle extension points for the agent loop.
 *
 * The {@link HookRegistry} allows plugins and skills to register
 * callbacks at four points in the agent lifecycle:
 *
 * | Hook | Phase | Can modify? |
 * |------|-------|-------------|
 * | `before_prompt` | Before first LLM call | System prompt |
 * | `before_tool` | Before tool execution | Tool args, can block |
 * | `after_tool` | After tool execution | Observe only |
 * | `agent_end` | After loop completes | Observe only |
 *
 * All hook executions are protected by a configurable timeout
 * (default 30 s) to prevent hanging the agent loop.
 *
 * @module hooks
 */

import type { AgentResult } from './agent.js';

// ── Types ────────────────────────────────────────────────

export type HookType = 'before_prompt' | 'before_tool' | 'after_tool' | 'agent_end';

export interface HookContext {
  sessionId: string;
  agentId: string;
  [key: string]: unknown;
}

export interface BeforePromptHook {
  type: 'before_prompt';
  fn: (ctx: HookContext, prompt: string) => Promise<string> | string;
}

export interface BeforeToolHook {
  type: 'before_tool';
  fn: (ctx: HookContext, tool: string, args: Record<string, unknown>) => Promise<{ proceed: boolean; args?: Record<string, unknown> }>;
}

export interface AfterToolHook {
  type: 'after_tool';
  fn: (ctx: HookContext, tool: string, result: string, error: boolean) => Promise<void> | void;
}

export interface AgentEndHook {
  type: 'agent_end';
  fn: (ctx: HookContext, result: AgentResult) => Promise<void> | void;
}

export type Hook = BeforePromptHook | BeforeToolHook | AfterToolHook | AgentEndHook;

// ── Timeout helper ──────────────────────────────────────

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T> | T, ms: number, fallback: T): Promise<T> {
  if (!(promise instanceof Promise)) return Promise.resolve(promise);
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ── HookRegistry ────────────────────────────────────────

export class HookRegistry {
  private hooks: Hook[] = [];
  private timeoutMs: number;

  constructor(timeoutMs = DEFAULT_HOOK_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  async runBeforePrompt(ctx: HookContext, prompt: string): Promise<string> {
    let result = prompt;
    for (const h of this.hooks) {
      if (h.type === 'before_prompt') {
        try {
          result = await withTimeout(h.fn(ctx, result), this.timeoutMs, result);
        } catch { /* hooks should not break the loop */ }
      }
    }
    return result;
  }

  async runBeforeTool(
    ctx: HookContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ proceed: boolean; args: Record<string, unknown> }> {
    let currentArgs = args;
    for (const h of this.hooks) {
      if (h.type === 'before_tool') {
        try {
          const result = await withTimeout(
            h.fn(ctx, tool, currentArgs),
            this.timeoutMs,
            { proceed: true, args: currentArgs },
          );
          if (!result.proceed) return { proceed: false, args: currentArgs };
          if (result.args) currentArgs = result.args;
        } catch { /* hooks should not break the loop */ }
      }
    }
    return { proceed: true, args: currentArgs };
  }

  async runAfterTool(ctx: HookContext, tool: string, result: string, error: boolean): Promise<void> {
    for (const h of this.hooks) {
      if (h.type === 'after_tool') {
        try { await withTimeout(h.fn(ctx, tool, result, error), this.timeoutMs, undefined); } catch { /* hooks should not break the loop */ }
      }
    }
  }

  async runAgentEnd(ctx: HookContext, result: AgentResult): Promise<void> {
    for (const h of this.hooks) {
      if (h.type === 'agent_end') {
        try { await withTimeout(h.fn(ctx, result), this.timeoutMs, undefined); } catch { /* hooks should not break the loop */ }
      }
    }
  }

  get count(): number {
    return this.hooks.length;
  }
}
