/**
 * Tests for plan-mode tools (D4).
 *
 * EnterPlanMode and ExitPlanMode mutate `session.permissionContext` through
 * the `ToolContext.session` field added in D3.
 */

import { describe, it, expect } from 'vitest';
import { Session } from '../../src/session.js';
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
} from '../../src/tools/builtins.js';
import type { ToolContext } from '../../src/tools.js';

function makeCtx(session: Session): ToolContext {
  return {
    workspaceDir: '/tmp',
    sessionId: session.id,
    agentId: 'researcher',
    session,
  };
}

describe('plan mode tools (D4)', () => {
  it('EnterPlanMode flips session permissionContext to plan', async () => {
    const tool = createEnterPlanModeTool();
    const session = new Session('s-enter');
    session.permissionContext = { mode: 'default' };

    const result = await tool.execute({}, makeCtx(session));

    expect(session.permissionContext.mode).toBe('plan');
    expect(session.permissionContext.prePlanMode).toBe('default');
    expect(result).toContain('Plan mode entered');
  });

  it('ExitPlanMode restores prior mode', async () => {
    const tool = createExitPlanModeTool();
    const session = new Session('s-exit');
    session.permissionContext = { mode: 'plan', prePlanMode: 'auto' };

    const result = await tool.execute({}, makeCtx(session));

    expect(session.permissionContext.mode).toBe('auto');
    expect(session.permissionContext.prePlanMode).toBeUndefined();
    expect(result).toContain('Plan mode exited');
    expect(result).toContain('auto');
  });
});
