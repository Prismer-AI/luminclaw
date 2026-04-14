/**
 * Permission modes + ToolPermissionContext for tool-execution gating.
 *
 * **Transitional implementation.** Per
 * `prismer-cloud-next/docs/ReleasePlan-1.9.0.md` D12, the canonical types
 * for PermissionMode / PermissionRule / ToolPermissionContext live in
 * `@prismer/sandbox-runtime` (not yet published). Once that package
 * publishes, this module should be replaced by re-exports from it. CI lint
 * will enforce the single-source-of-truth invariant at that point.
 *
 * @module permissions
 */

export const PermissionMode = {
  Default: 'default',   // ask user before sensitive ops
  Plan: 'plan',         // exploration only, no writes
  Auto: 'auto',         // headless / dual-loop, classifier-based
  Bypass: 'bypass',     // dangerous: no checks, all tools allowed
} as const;

export type PermissionModeValue = typeof PermissionMode[keyof typeof PermissionMode];

export interface ToolPermissionContext {
  mode: PermissionModeValue;
  prePlanMode?: PermissionModeValue;
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'ask'; message: string; suggestions?: string[] }
  | { behavior: 'deny'; message: string; reason: string };

export function defaultPermissionContext(): ToolPermissionContext {
  return { mode: 'default' };
}

export function enterPlanMode(ctx: ToolPermissionContext): ToolPermissionContext {
  return { mode: 'plan', prePlanMode: ctx.mode };
}

export function exitPlanMode(ctx: ToolPermissionContext): ToolPermissionContext {
  return { mode: ctx.prePlanMode ?? 'default' };
}

export function isHeadless(ctx: ToolPermissionContext): boolean {
  return ctx.mode === 'auto' || ctx.mode === 'bypass';
}
