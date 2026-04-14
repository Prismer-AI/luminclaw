/**
 * Tool Registry — registration, dispatch, and spec generation.
 *
 * The {@link ToolRegistry} holds all available tools and converts them
 * to OpenAI-compatible {@link ToolSpec} arrays for the LLM. Execution
 * is dispatched through {@link ToolRegistry.execute}.
 *
 * @module tools
 */

import type { ToolSpec } from './provider.js';
import type { ToolPermissionContext, PermissionResult } from './permissions.js';
import type { Session } from './session.js';

// ── Interfaces ───────────────────────────────────────────

/** Runtime context passed to every tool execution. */
export interface ToolContext {
  workspaceDir: string;
  sessionId: string;
  agentId: string;
  emit?: (event: ToolEvent) => void;
  /** Abort signal propagated from the agent loop. Long-running tools should honor it. */
  abortSignal?: AbortSignal;
  /**
   * The owning session, when a tool is invoked through the agent loop.
   * Tools that need to mutate session state (e.g., EnterPlanMode /
   * ExitPlanMode flipping `permissionContext`) read this field.
   */
  session?: Session;
}

/** Event emitted by a tool during execution via {@link ToolContext.emit}. */
export interface ToolEvent {
  type: 'directive' | 'progress' | 'output';
  data: Record<string, unknown>;
}

/**
 * A single tool that can be executed by the agent.
 * Implementations must provide a JSON Schema `parameters` object
 * and an async `execute` function.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /**
   * Return `true` if this tool is safe to run concurrently with other
   * concurrent-safe tools (i.e., read-only / no side effects for the
   * given arguments). Defaults to `false` (serial) when not provided.
   */
  isConcurrencySafe?(args: Record<string, unknown>): boolean;

  /**
   * If true, this tool needs a human user present (e.g., to approve a dialog).
   * In headless / dual-loop / channel contexts where no human can respond,
   * the tool should be auto-denied.  Default: false.
   */
  requiresUserInteraction?(): boolean;

  /**
   * Called before tool execution. Returns whether to allow, ask the user,
   * or deny.  If omitted, default policy applies (allow in non-default
   * modes, ask if requiresUserInteraction in default mode).
   */
  checkPermissions?(input: unknown, ctx: ToolPermissionContext): Promise<PermissionResult>;
}

// ── Tool Registry ────────────────────────────────────────

/**
 * Registry of available tools. Supports registration, lookup,
 * spec generation for the LLM, and dispatched execution.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Generate OpenAI-compatible tool specs for LLM */
  getSpecs(allowedTools?: string[]): ToolSpec[] {
    const tools = allowedTools
      ? this.list().filter(t => allowedTools.includes(t.name))
      : this.list();

    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /** Execute a tool by name */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ output: string; error?: string }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: '', error: `Unknown tool: ${name}` };
    }

    try {
      const output = await tool.execute(args, ctx);
      return { output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: '', error: message };
    }
  }

  /**
   * Create a filtered view of this registry. The returned registry
   * shares the same tool implementations but only exposes tools
   * that pass the predicate.
   */
  withFilter(predicate: (name: string) => boolean): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (predicate(name)) {
        filtered.register(tool);
      }
    }
    return filtered;
  }

  /** Number of registered tools */
  get size(): number {
    return this.tools.size;
  }
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Create a tool from a simple definition (for built-in tools like bash).
 */
export function createTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>,
): Tool {
  return { name, description, parameters, execute };
}
