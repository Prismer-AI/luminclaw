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

// ── HookRegistry ────────────────────────────────────────

export class HookRegistry {
  private hooks: Hook[] = [];

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  async runBeforePrompt(ctx: HookContext, prompt: string): Promise<string> {
    let result = prompt;
    for (const h of this.hooks) {
      if (h.type === 'before_prompt') {
        result = await h.fn(ctx, result);
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
        const result = await h.fn(ctx, tool, currentArgs);
        if (!result.proceed) return { proceed: false, args: currentArgs };
        if (result.args) currentArgs = result.args;
      }
    }
    return { proceed: true, args: currentArgs };
  }

  async runAfterTool(ctx: HookContext, tool: string, result: string, error: boolean): Promise<void> {
    for (const h of this.hooks) {
      if (h.type === 'after_tool') {
        try { await h.fn(ctx, tool, result, error); } catch { /* hooks should not break the loop */ }
      }
    }
  }

  async runAgentEnd(ctx: HookContext, result: AgentResult): Promise<void> {
    for (const h of this.hooks) {
      if (h.type === 'agent_end') {
        try { await h.fn(ctx, result); } catch { /* hooks should not break the loop */ }
      }
    }
  }

  get count(): number {
    return this.hooks.length;
  }
}
