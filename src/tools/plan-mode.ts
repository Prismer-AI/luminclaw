/**
 * Plan-mode tools — zero node:* dependencies.
 *
 * Extracted from builtins.ts so the embedded bundle (dist/luminclaw-core.js)
 * can import only these two tools without pulling in node:fs / node:path.
 *
 * @module tools/plan-mode
 */

import { type Tool } from '../tools.js';
import { enterPlanMode, exitPlanMode } from '../permissions.js';

/**
 * Enter plan mode — exploration & planning only. Flips
 * `session.permissionContext` to `plan`, denying any tool whose
 * `requiresUserInteraction()` returns true until ExitPlanMode runs.
 */
export function createEnterPlanModeTool(): Tool {
  return {
    name: 'enter_plan_mode',
    description: 'Enter plan mode — exploration and planning only, no file writes or destructive ops.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      const session = ctx.session;
      if (!session) return 'Error: session not available';
      session.permissionContext = enterPlanMode(session.permissionContext ?? { mode: 'default' });
      return 'Plan mode entered. Read-only tools available; writes will be denied until ExitPlanMode.';
    },
    requiresUserInteraction: () => false,
  };
}

/**
 * Exit plan mode. Restores `permissionContext` to the `prePlanMode` that
 * was recorded on entry (falling back to `default`).
 */
export function createExitPlanModeTool(): Tool {
  return {
    name: 'exit_plan_mode',
    description: 'Exit plan mode and restore prior tool permissions.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      const session = ctx.session;
      if (!session) return 'Error: session not available';
      session.permissionContext = exitPlanMode(session.permissionContext ?? { mode: 'plan' });
      return `Plan mode exited. Now in mode: ${session.permissionContext.mode}.`;
    },
    requiresUserInteraction: () => false,
  };
}
