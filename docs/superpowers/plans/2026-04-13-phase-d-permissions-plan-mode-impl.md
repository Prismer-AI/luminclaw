# Phase D — Permission Mode + Plan Mode

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Add `PermissionMode` enum and per-tool `requiresUserInteraction()` + `checkPermissions()` protocol. In headless contexts (dual-loop, no human present), tools that require user interaction are auto-denied. Implement `EnterPlanMode` / `ExitPlanMode` tools that flip the mode and gate which tools are usable.

**Architecture:** Local implementation (Gate 2 confirmed: `@prismer/sandbox-runtime` not yet published). All types and helpers defined in luminclaw codebase, with explicit comments noting they are a **transitional shim until `@prismer/sandbox-runtime` publishes**, at which point per `prismer-cloud-next/docs/ReleasePlan-1.9.0.md` D12 the canonical types must be imported from that package.

**Tech Stack:** TypeScript 5, vitest. No new external deps.

**Scope boundaries:**
- **In scope:** PermissionMode enum, ToolPermissionContext on session, Tool.requiresUserInteraction + Tool.checkPermissions, headless auto-deny, EnterPlanMode/ExitPlanMode tools.
- **Out of scope (Phase F):** Capability test orchestration.
- **Rust parity (Gate 1 = c):** No Rust changes.
- **Out of scope:** Full PARA L5 wire schema; sandbox enforcement at OS level. Phase D delivers the in-process gating only.

---

## Current state

- TS has partial approval gates: `src/agent.ts` `needsApproval(toolName)` checks against a hardcoded list. `bash` requires approval for destructive commands. No mode/context.
- Rust has no approval gates at all.
- No `EnterPlanMode` / `ExitPlanMode` tools.
- No `Tool.requiresUserInteraction` flag.
- No mode-based tool filtering.

---

## Module Changes

| File | Change |
|------|--------|
| `src/permissions.ts` | **Create.** `PermissionMode` enum, `ToolPermissionContext`, `PermissionResult` type, default policies. |
| `src/tools.ts` | Extend `Tool` interface with optional `requiresUserInteraction?(): boolean` and `checkPermissions?(input, ctx): Promise<PermissionResult>`. |
| `src/session.ts` | Add `permissionContext: ToolPermissionContext` field with default `{mode: 'default'}`. |
| `src/agent.ts` | Before each tool call, run `checkPermissions` and `requiresUserInteraction` checks. In headless mode (no UI subscriber), auto-deny user-interaction tools. |
| `src/tools/builtins.ts` | Implement `EnterPlanModeTool` + `ExitPlanModeTool`. Annotate destructive tools with `requiresUserInteraction: () => true`. |
| `src/loop/dual.ts` | Set `session.permissionContext.mode = 'auto'` for dual-loop tasks (headless). |
| Tests | `tests/permissions.test.ts`, `tests/tools/plan-mode.test.ts`, `tests/agent-permissions.test.ts` |

---

## Tasks

### Task D1: permissions.ts module + types

**Files:**
- Create: `src/permissions.ts`
- Create: `tests/permissions.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/permissions.test.ts
import { describe, it, expect } from 'vitest';
import {
  PermissionMode,
  type ToolPermissionContext,
  type PermissionResult,
  defaultPermissionContext,
  enterPlanMode,
  exitPlanMode,
  isHeadless,
} from '../src/permissions.js';

describe('permissions module', () => {
  describe('PermissionMode', () => {
    it('exposes the four modes', () => {
      expect(PermissionMode.Default).toBe('default');
      expect(PermissionMode.Plan).toBe('plan');
      expect(PermissionMode.Auto).toBe('auto');
      expect(PermissionMode.Bypass).toBe('bypass');
    });
  });

  describe('defaultPermissionContext', () => {
    it('starts in default mode', () => {
      const ctx = defaultPermissionContext();
      expect(ctx.mode).toBe('default');
      expect(ctx.prePlanMode).toBeUndefined();
    });
  });

  describe('enterPlanMode / exitPlanMode', () => {
    it('enterPlanMode stores prior mode and switches to plan', () => {
      const ctx: ToolPermissionContext = { mode: 'default' };
      const next = enterPlanMode(ctx);
      expect(next.mode).toBe('plan');
      expect(next.prePlanMode).toBe('default');
    });

    it('exitPlanMode restores prior mode', () => {
      const ctx: ToolPermissionContext = { mode: 'plan', prePlanMode: 'auto' };
      const next = exitPlanMode(ctx);
      expect(next.mode).toBe('auto');
      expect(next.prePlanMode).toBeUndefined();
    });

    it('exitPlanMode falls back to default if prePlanMode unset', () => {
      const ctx: ToolPermissionContext = { mode: 'plan' };
      const next = exitPlanMode(ctx);
      expect(next.mode).toBe('default');
    });
  });

  describe('isHeadless', () => {
    it('true when context indicates dual-loop or no UI subscriber', () => {
      expect(isHeadless({ mode: 'auto' })).toBe(true);
      expect(isHeadless({ mode: 'bypass' })).toBe(true);
    });
    it('false in default + plan modes', () => {
      expect(isHeadless({ mode: 'default' })).toBe(false);
      expect(isHeadless({ mode: 'plan' })).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

`npx vitest run tests/permissions.test.ts` — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/permissions.ts
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
```

- [ ] **Step 4: Pass + commit**

```bash
git add src/permissions.ts tests/permissions.test.ts
git commit -m "feat(D1): permissions module — PermissionMode, ToolPermissionContext, plan-mode helpers"
```

---

### Task D2: Tool interface extension + builtin annotations

**Files:**
- Modify: `src/tools.ts` — add optional `requiresUserInteraction` + `checkPermissions` to Tool interface
- Modify: `src/tools/builtins.ts` — annotate destructive tools (write_file, edit_file, bash) with `requiresUserInteraction: () => true`
- Create: `tests/tools-permissions.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/tools-permissions.test.ts
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools.js';

describe('Tool permissions interface', () => {
  it('Tool.requiresUserInteraction is optional', async () => {
    const { createBashTool } = await import('../src/tools/builtins.js');
    const bash = createBashTool('/tmp');
    expect(typeof bash.requiresUserInteraction === 'function').toBe(true);
    expect(bash.requiresUserInteraction!()).toBe(true);
  });

  it('Tool without requiresUserInteraction defaults to false (safe)', async () => {
    // think tool is non-destructive
    const builtins = await import('../src/tools/builtins.js');
    // depends on what's exported — check getBuiltinTools or similar
    const tools = builtins.getBuiltinTools?.() ?? [];
    const think = tools.find((t: any) => t.name === 'think');
    if (think) {
      expect(think.requiresUserInteraction?.() ?? false).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Verify FAIL**

`npx vitest run tests/tools-permissions.test.ts`

- [ ] **Step 3: Extend Tool interface**

In `src/tools.ts`:

```typescript
import type { ToolPermissionContext, PermissionResult } from './permissions.js';

export interface Tool {
  // ... existing fields ...

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
```

- [ ] **Step 4: Annotate builtins**

In `src/tools/builtins.ts`, add `requiresUserInteraction: () => true` to:
- `createBashTool` returned object
- `write_file` tool definition
- `edit_file` tool definition

For read-only tools (`read_file`, `list_files`, `grep`, `web_fetch`, `think`, `memory_*`), explicitly set `requiresUserInteraction: () => false` (or omit — default is false).

- [ ] **Step 5: Pass + commit**

```bash
git add src/tools.ts src/tools/builtins.ts tests/tools-permissions.test.ts
git commit -m "feat(D2): Tool.requiresUserInteraction + checkPermissions interface; annotate builtins"
```

---

### Task D3: Agent enforces permissions, headless auto-deny

**Files:**
- Modify: `src/agent.ts` — replace existing `needsApproval` logic with `checkPermissions` invocation
- Modify: `src/session.ts` — add `permissionContext: ToolPermissionContext` field
- Modify: `src/loop/dual.ts` — set `session.permissionContext.mode = 'auto'` for dual-loop tasks
- Create: `tests/agent-permissions.test.ts`

- [ ] **Step 1: Add permissionContext to Session**

In `src/session.ts`, add field `permissionContext: ToolPermissionContext = defaultPermissionContext()` initialized in constructor.

- [ ] **Step 2: Write failing tests**

```typescript
// tests/agent-permissions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PrismerAgent } from '../src/agent.js';
import { ToolRegistry, createTool } from '../src/tools.js';
import { ConsoleObserver } from '../src/observer.js';
import { AgentRegistry } from '../src/agents.js';
import { Session } from '../src/session.js';
import { PermissionMode } from '../src/permissions.js';

describe('Agent — permission enforcement', () => {
  it('auto-denies requiresUserInteraction tools in auto mode', async () => {
    const tools = new ToolRegistry();
    const tool = createTool(
      'destructive', 'destroys things',
      { type: 'object', properties: {} },
      async () => 'should not run',
    );
    tool.requiresUserInteraction = () => true;
    tools.register(tool);

    const provider = {
      chat: vi.fn().mockResolvedValueOnce({
        text: '', toolCalls: [{ id: 'c1', name: 'destructive', arguments: {} }],
        usage: { promptTokens: 1, completionTokens: 1 },
      }).mockResolvedValueOnce({
        text: 'done', toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    };

    const agent = new PrismerAgent({
      provider: provider as any,
      tools, observer: new ConsoleObserver(), agents: new AgentRegistry(),
      systemPrompt: 'sys', maxIterations: 3,
    });
    const session = new Session('s');
    session.permissionContext = { mode: 'auto' };

    // Drive the generator (use existing drainGenerator helper)
    // For brevity this test asserts that a tool result is in the messages
    // with content containing 'denied' / 'requires user interaction'

    // ... actual driving code per existing test patterns ...
  });

  it('allows requiresUserInteraction tools in default mode (with mock approval)', async () => {
    // Similar setup but mode: 'default' — verifies the path proceeds to ask/allow
  });
});
```

Adapt to the existing test patterns in `tests/agent.test.ts`.

- [ ] **Step 3: Implement**

In `src/agent.ts`, find the existing `needsApproval` logic. Replace with permission check:

```typescript
// Before tool execution
const ctx = session.permissionContext ?? defaultPermissionContext();

// Default policy:
// - mode 'bypass': allow everything
// - mode 'auto': deny requiresUserInteraction tools, allow rest
// - mode 'plan': deny ALL write tools (heuristic: requiresUserInteraction=true)
// - mode 'default': call tool.checkPermissions or ask user

let result: PermissionResult;
if (tool.checkPermissions) {
  result = await tool.checkPermissions(call.arguments, ctx);
} else {
  // Default policy
  if (ctx.mode === 'bypass') {
    result = { behavior: 'allow' };
  } else if (ctx.mode === 'plan') {
    result = tool.requiresUserInteraction?.()
      ? { behavior: 'deny', message: 'Plan mode: writes/destructive ops not allowed', reason: 'plan_mode' }
      : { behavior: 'allow' };
  } else if (ctx.mode === 'auto') {
    result = tool.requiresUserInteraction?.()
      ? { behavior: 'deny', message: 'Headless mode: tools requiring user interaction are not available', reason: 'headless' }
      : { behavior: 'allow' };
  } else {
    // default mode — fall back to existing approval logic
    result = { behavior: 'allow' };  // or call existing needsApproval check
  }
}

if (result.behavior === 'deny') {
  // Push synthetic tool_result with denial message
  state.messages.push({
    role: 'tool',
    content: `[Permission denied: ${result.message}]`,
    toolCallId: call.id,
  });
  continue;  // skip to next tool
}
// ... else proceed with execution ...
```

- [ ] **Step 4: Set dual-loop mode to auto**

In `src/loop/dual.ts`, after creating session in `processMessage`:

```typescript
const session = this.sessions.getOrCreate(sessionId);
session.permissionContext = { mode: 'auto' };  // dual-loop is headless
```

- [ ] **Step 5: Pass + commit**

```bash
git add src/agent.ts src/session.ts src/loop/dual.ts tests/agent-permissions.test.ts
git commit -m "feat(D3): Agent enforces ToolPermissionContext; dual-loop runs in auto mode"
```

---

### Task D4: EnterPlanMode + ExitPlanMode tools

**Files:**
- Modify: `src/tools/builtins.ts` — add `EnterPlanModeTool` + `ExitPlanModeTool`
- Modify: `src/index.ts` — register them in builtin set
- Create: `tests/tools/plan-mode.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/tools/plan-mode.test.ts
import { describe, it, expect } from 'vitest';
import { Session } from '../../src/session.js';

describe('plan mode tools', () => {
  it('EnterPlanMode flips session permissionContext to plan', async () => {
    const { createEnterPlanModeTool } = await import('../../src/tools/builtins.js');
    const tool = createEnterPlanModeTool();
    const session = new Session('s');
    session.permissionContext = { mode: 'default' };

    const result = await tool.execute({}, {
      workspaceDir: '/tmp', sessionId: 's', agentId: 'a',
      session,  // pass the session via context
    } as any);

    expect(session.permissionContext.mode).toBe('plan');
    expect(session.permissionContext.prePlanMode).toBe('default');
    expect(result).toContain('Plan mode entered');
  });

  it('ExitPlanMode restores prior mode', async () => {
    const { createExitPlanModeTool } = await import('../../src/tools/builtins.js');
    const tool = createExitPlanModeTool();
    const session = new Session('s');
    session.permissionContext = { mode: 'plan', prePlanMode: 'auto' };

    await tool.execute({}, {
      workspaceDir: '/tmp', sessionId: 's', agentId: 'a',
      session,
    } as any);

    expect(session.permissionContext.mode).toBe('auto');
    expect(session.permissionContext.prePlanMode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement tools**

In `src/tools/builtins.ts`:

```typescript
import { enterPlanMode, exitPlanMode } from '../permissions.js';

export function createEnterPlanModeTool(): Tool {
  return {
    name: 'enter_plan_mode',
    description: 'Enter plan mode — exploration and planning only, no file writes or destructive ops. Useful when designing an approach before execution.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      const session = (ctx as any).session;
      if (!session) return 'Error: session not available';
      session.permissionContext = enterPlanMode(session.permissionContext ?? { mode: 'default' });
      return 'Plan mode entered. Read-only tools available; writes will be denied until ExitPlanMode.';
    },
    requiresUserInteraction: () => false,
  };
}

export function createExitPlanModeTool(): Tool {
  return {
    name: 'exit_plan_mode',
    description: 'Exit plan mode and restore prior tool permissions. Use after planning is complete.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      const session = (ctx as any).session;
      if (!session) return 'Error: session not available';
      session.permissionContext = exitPlanMode(session.permissionContext ?? { mode: 'plan' });
      return `Plan mode exited. Now in mode: ${session.permissionContext.mode}.`;
    },
    requiresUserInteraction: () => false,
  };
}
```

Note: `ctx.session` is a new field on `ToolContext` that needs adding. Update `ToolContext` interface in `src/tools.ts`:

```typescript
export interface ToolContext {
  // ... existing fields ...
  session?: Session;  // optional, present when invoked through agent loop
}
```

In `src/agent.ts`, when constructing the ToolContext for tool execution, add `session` to the object.

- [ ] **Step 3: Register in builtin set**

In `src/index.ts` `ensureInitialized`, register both tools:

```typescript
const { createEnterPlanModeTool, createExitPlanModeTool } = await import('./tools/builtins.js');
sharedTools.register(createEnterPlanModeTool());
sharedTools.register(createExitPlanModeTool());
```

Same for `src/loop/dual.ts` runInnerLoop tool registration block (where E4 fix added memory tools).

- [ ] **Step 4: Pass + commit**

```bash
git add src/tools/builtins.ts src/tools.ts src/agent.ts src/index.ts src/loop/dual.ts tests/tools/plan-mode.test.ts
git commit -m "feat(D4): EnterPlanMode + ExitPlanMode tools, ToolContext.session"
```

---

### Task D5: Capability test — plan mode prevents destructive ops

**Files:**
- Create: `docs/superpowers/plans/2026-04-13-plan-mode-after-phase-d.md`

Real-LLM scenario:
1. Start dual-loop server
2. Task: "Use enter_plan_mode then try to write to /tmp/test.txt"
3. Verify: `enter_plan_mode` succeeds, `write_file` is denied with `[Permission denied: ...]` synthetic result
4. Task continues, eventually exits plan mode and writes successfully

Steps similar to previous capability measurements (start server, POST /v1/chat, poll task, inspect result).

Write report `docs/superpowers/plans/2026-04-13-plan-mode-after-phase-d.md`.

Commit: `test(D5): plan mode capability measurement`

---

## Cross-Task Summary

| Task | What | New Tests |
|---|---|---|
| D1 | permissions module | 8 |
| D2 | Tool interface extension + annotations | 2 |
| D3 | Agent enforces permissions | 2 |
| D4 | Plan mode tools | 2 |
| D5 | Plan-mode capability measurement | — |
| **Total** | | **14** |

## Self-Review

- D1 has clear "transitional" docstring linking to ReleasePlan-1.9.0 D12
- D2 makes both new methods optional → backwards-compatible with existing tools
- D3 dual-loop sets `mode: 'auto'` so destructive tools auto-deny in headless
- D4 plan/exit-plan tools take effect immediately on next tool call (mode is read fresh each time)
- D5 verifies the gating actually fires in production
- Plan saved to `docs/superpowers/plans/2026-04-13-phase-d-permissions-plan-mode-impl.md`
