# Phase E — Cross-Task Knowledge + Eviction

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** When a task completes, persist its `WorldModel.knowledgeBase` facts to `MemoryStore`. When a new task starts, recall related facts and inject them into the system prompt. Add TTL-based eviction to `InMemoryTaskStore` to bound memory growth.

**Architecture:** On task completion, walk `WorldModel.knowledgeBase` (already populated by `extractStructuredFacts` in builder.ts) and write each fact to `MemoryStore` with a tag derived from agentId. On task start, query `MemoryStore.recall(task.instruction, 4000)` and inject the top facts into the system prompt via `PromptBuilder` (or directly into the handoff context). Eviction: `InMemoryTaskStore.evictCompleted` already exists (per Phase A read) — wire it on a setInterval, default 1h for terminal tasks.

**Tech Stack:** TypeScript 5, vitest. No new deps.

**Scope boundaries:**
- **In scope:** Persist facts on completion, recall on task start, periodic eviction.
- **Out of scope (Phase F):** Capability test orchestration.
- **Rust parity (Gate 1 = c):** No Rust changes.

---

## Current state

- `WorldModel.knowledgeBase` is populated during `runInnerLoop` via `extractStructuredFacts` (in `src/world-model/builder.ts`)
- `MemoryStore` (`src/memory.ts`) supports `store(content, tags)` and `recall(query, maxChars)`
- `InMemoryTaskStore.evictCompleted(maxAgeMs)` already exists per Phase A reading — no eviction timer is wired
- `DualLoopAgent` already calls `recall('world-model', 4000)` at task creation (line ~88) to seed `knowledgeBase` — but the facts being recalled are written by NO ONE today

---

## Module Changes

| File | Change |
|------|--------|
| `src/loop/dual.ts` | On terminal `completed` transition, persist `worldModel.knowledgeBase` to MemoryStore. Wire `evictCompleted` on setInterval (default 1h). |
| `src/memory.ts` | (already has `store` and `recall`) — verify tag handling. |
| `src/world-model/builder.ts` | Add `serializeKnowledgeBaseForMemory(model)` returning string array suitable for `store()`. |
| `tests/loop/dual-knowledge.test.ts` | (create) tests for end-to-end knowledge round-trip |
| `tests/loop/dual-eviction.test.ts` | (create) tests for TTL eviction |

---

## Tasks

### Task E1: serializeKnowledgeBaseForMemory + tests

**Files:**
- Modify: `src/world-model/builder.ts`
- Create: `tests/world-model/builder.test.ts` (or extend existing)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { serializeKnowledgeBaseForMemory } from '../../src/world-model/builder.js';
import type { KnowledgeFact } from '../../src/world-model/types.js';

describe('serializeKnowledgeBaseForMemory', () => {
  it('serializes facts as "key: value" lines', () => {
    const facts: KnowledgeFact[] = [
      { key: 'config.path', value: '/tmp/foo', sourceAgentId: 'agent-1', confidence: 'high' },
      { key: 'budget', value: '$100', sourceAgentId: 'agent-2', confidence: 'medium' },
    ];
    const result = serializeKnowledgeBaseForMemory(facts);
    expect(result).toContain('config.path: /tmp/foo');
    expect(result).toContain('budget: $100');
  });

  it('returns empty string for empty array', () => {
    expect(serializeKnowledgeBaseForMemory([])).toBe('');
  });

  it('orders by confidence (high first)', () => {
    const facts: KnowledgeFact[] = [
      { key: 'low-fact', value: 'maybe', sourceAgentId: 'a', confidence: 'low' },
      { key: 'high-fact', value: 'definitely', sourceAgentId: 'a', confidence: 'high' },
      { key: 'medium-fact', value: 'probably', sourceAgentId: 'a', confidence: 'medium' },
    ];
    const result = serializeKnowledgeBaseForMemory(facts);
    const lines = result.split('\n').filter(Boolean);
    expect(lines[0]).toContain('high-fact');
    expect(lines[1]).toContain('medium-fact');
    expect(lines[2]).toContain('low-fact');
  });
});
```

- [ ] **Step 2: Run test**

`npx vitest run tests/world-model/builder.test.ts` — FAIL (function doesn't exist)

- [ ] **Step 3: Implement**

Append to `src/world-model/builder.ts`:

```typescript
import type { KnowledgeFact } from './types.js';

const CONFIDENCE_ORDER: Record<KnowledgeFact['confidence'], number> = {
  high: 0, medium: 1, low: 2,
};

export function serializeKnowledgeBaseForMemory(facts: KnowledgeFact[]): string {
  const sorted = [...facts].sort(
    (a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence],
  );
  return sorted.map(f => `${f.key}: ${f.value}`).join('\n');
}
```

- [ ] **Step 4: Pass + commit**

```bash
git add src/world-model/builder.ts tests/world-model/builder.test.ts
git commit -m "feat(E1): serializeKnowledgeBaseForMemory for cross-task persistence"
```

---

### Task E2: Persist knowledgeBase on completion + recall on task start

**Files:**
- Modify: `src/loop/dual.ts`
- Create: `tests/loop/dual-knowledge.test.ts`

- [ ] **Step 1: Inspect current task-creation code**

In `src/loop/dual.ts` lines ~85-105, the code already calls `this.memStore.recall('world-model', 4000)` and parses `key: value` lines into knowledgeBase entries. This recall path **works today** but writes nothing — Phase E adds the writes.

In `runInnerLoop`, at the natural completion point (after `stateMachine.complete(...)` and the existing `persistState(task)` call from B3), add knowledge-base persistence.

- [ ] **Step 2: Write failing test**

```typescript
// tests/loop/dual-knowledge.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { MemoryStore } from '../../src/memory.js';
import { resetConfig } from '../../src/config.js';

describe('Phase E — knowledge persistence', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-knowledge-'));
    process.env.WORKSPACE_DIR = tmpWorkspace;
    resetConfig();
  });
  afterEach(async () => {
    delete process.env.WORKSPACE_DIR;
    resetConfig();
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('writes worldModel.knowledgeBase to MemoryStore on completion', async () => {
    const agent = new DualLoopAgent();
    // Manually populate worldModel after a task starts
    const taskId = 'test-task';
    agent.tasks.create({
      id: taskId, sessionId: 's', instruction: 'go',
      artifactIds: [], status: 'executing',
    });
    // Simulate that the agent's worldModel for this task has facts
    (agent as any).worldModel = {
      taskId,
      goal: 'go',
      completedWork: [],
      workspaceState: { activeComponent: '', openFiles: [], recentArtifacts: [], componentSummaries: new Map() },
      knowledgeBase: [
        { key: 'config.path', value: '/etc/foo', sourceAgentId: 'a1', confidence: 'high' },
        { key: 'budget', value: '$100', sourceAgentId: 'a1', confidence: 'medium' },
      ],
      agentHandoffNotes: new Map(),
    };

    // Trigger the persistence helper (we'll add a method or reach into runInnerLoop's completion path)
    await (agent as any).persistKnowledgeBase(taskId);

    // Now create a fresh MemoryStore in the same workspace and verify recall
    const memStore = new MemoryStore(tmpWorkspace);
    const recalled = await memStore.recall('config.path', 4000);
    expect(recalled).toContain('config.path');
    expect(recalled).toContain('/etc/foo');
  });

  it('recall on new task includes facts from previous task', async () => {
    // Set up: pre-populate MemoryStore with a fact
    const memStore = new MemoryStore(tmpWorkspace);
    await memStore.store('database.host: db.example.com', ['world-model']);

    // Create a new agent — its worldModel for a fresh task should include this fact
    const agent = new DualLoopAgent();
    const result = await agent.processMessage(
      { content: 'connect to database', sessionId: 's2' },
      { bus: new (await import('../../src/sse.js')).EventBus() },
    );
    expect(result.taskId).toBeTruthy();

    // Wait for the async memory recall to populate
    await new Promise(r => setTimeout(r, 100));

    const wm = (agent as any).worldModel;
    expect(wm).toBeTruthy();
    const keys = wm.knowledgeBase.map((f: any) => f.key);
    expect(keys).toContain('database.host');
  });
});
```

- [ ] **Step 3: Run test to verify failure**

`npx vitest run tests/loop/dual-knowledge.test.ts` — FAIL (no `persistKnowledgeBase` method).

- [ ] **Step 4: Implement persistence**

In `src/loop/dual.ts`, add helper:

```typescript
import { serializeKnowledgeBaseForMemory } from '../world-model/builder.js';

private async persistKnowledgeBase(taskId: string): Promise<void> {
  const wm = this.worldModel;
  if (!wm || wm.taskId !== taskId || wm.knowledgeBase.length === 0) return;
  const serialized = serializeKnowledgeBaseForMemory(wm.knowledgeBase);
  if (!serialized) return;
  try {
    await this.memStore.store(serialized, ['world-model', `task:${taskId}`]);
    log.info('persisted knowledgeBase to memory', { taskId, factCount: wm.knowledgeBase.length });
  } catch (err) {
    log.warn('persistKnowledgeBase failed', { taskId, error: String(err) });
  }
}
```

In `runInnerLoop`, find the completion path (after `stateMachine.complete(task, result.text)` and `persistState(task)`). Add:

```typescript
void this.persistKnowledgeBase(task.id).catch(() => { /* logged in helper */ });
```

- [ ] **Step 5: Run tests**

`npx vitest run tests/loop/dual-knowledge.test.ts` — PASS.

Regression: `npx vitest run tests/loop/`

- [ ] **Step 6: Commit**

```bash
git add src/loop/dual.ts tests/loop/dual-knowledge.test.ts
git commit -m "feat(E2): persist worldModel.knowledgeBase to MemoryStore on completion"
```

---

### Task E3: TTL eviction wired on setInterval

**Files:**
- Modify: `src/loop/dual.ts` — start eviction timer in constructor; clear in shutdown
- Create: `tests/loop/dual-eviction.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DualLoopAgent } from '../../src/loop/dual.js';

describe('Phase E — TTL eviction', () => {
  it('evicts completed tasks older than maxAge on tick', async () => {
    vi.useFakeTimers();
    const agent = new DualLoopAgent({ evictionIntervalMs: 100, evictionMaxAgeMs: 50 });
    agent.tasks.create({
      id: 'old', sessionId: 's', instruction: 'x',
      artifactIds: [], status: 'completed',
    });
    // Force the task's updatedAt into the past
    (agent.tasks as any).tasks.get('old').updatedAt = Date.now() - 1000;

    expect(agent.tasks.get('old')).toBeDefined();
    vi.advanceTimersByTime(150);
    // wait for any pending microtasks
    await Promise.resolve();
    expect(agent.tasks.get('old')).toBeUndefined();

    vi.useRealTimers();
    await agent.shutdown();
  });

  it('does not evict active (executing) tasks', async () => {
    vi.useFakeTimers();
    const agent = new DualLoopAgent({ evictionIntervalMs: 100, evictionMaxAgeMs: 50 });
    agent.tasks.create({
      id: 'active', sessionId: 's', instruction: 'x',
      artifactIds: [], status: 'executing',
    });
    (agent.tasks as any).tasks.get('active').updatedAt = Date.now() - 1000;

    vi.advanceTimersByTime(150);
    await Promise.resolve();
    expect(agent.tasks.get('active')).toBeDefined();

    vi.useRealTimers();
    await agent.shutdown();
  });

  it('shutdown clears the eviction timer', async () => {
    const agent = new DualLoopAgent({ evictionIntervalMs: 100, evictionMaxAgeMs: 50 });
    expect((agent as any).evictionTimer).toBeDefined();
    await agent.shutdown();
    expect((agent as any).evictionTimer).toBeNull();
  });
});
```

- [ ] **Step 2: Run failure**

`npx vitest run tests/loop/dual-eviction.test.ts` — FAIL (constructor doesn't accept options, no timer).

- [ ] **Step 3: Implement**

In `src/loop/dual.ts`:

```typescript
interface DualLoopAgentOptions {
  evictionIntervalMs?: number;  // default: 1h = 3_600_000
  evictionMaxAgeMs?: number;    // default: 1h = 3_600_000
}

export class DualLoopAgent implements IAgentLoop {
  // ... existing fields ...
  private evictionTimer: NodeJS.Timeout | null = null;

  constructor(options: DualLoopAgentOptions = {}) {
    const cfg = loadConfig();
    this.memStore = new MemoryStore(cfg.workspace.dir);
    this.directiveRouter = new DirectiveRouter();

    const intervalMs = options.evictionIntervalMs ?? 60 * 60 * 1000;
    const maxAgeMs = options.evictionMaxAgeMs ?? 60 * 60 * 1000;
    this.evictionTimer = setInterval(() => {
      try {
        const evicted = this.tasks.evictCompleted(maxAgeMs);
        if (evicted > 0) log.info('evicted terminal tasks', { count: evicted });
      } catch (err) {
        log.warn('eviction tick failed', { error: String(err) });
      }
    }, intervalMs);
    // Allow process exit if this is the only timer
    this.evictionTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    // ... existing shutdown logic if any
  }
```

If `IAgentLoop` doesn't already define `shutdown()`, add it as optional. SingleLoopAgent gets a no-op or `Promise.resolve()`.

- [ ] **Step 4: Pass + commit**

```bash
git add src/loop/dual.ts src/loop/types.ts src/loop/single.ts tests/loop/dual-eviction.test.ts
git commit -m "feat(E3): TTL-based eviction of terminal tasks (default 1h)"
```

---

### Task E4: C7 capability measurement (cross-task knowledge)

**Files:**
- Create: `docs/superpowers/plans/2026-04-13-c7-after-phase-e.md`

Real LLM end-to-end:
1. Task 1: instruct agent to discover and remember a fact (e.g., "find the version in package.json and remember it")
2. Wait for completion
3. Task 2 (new sessionId): ask about the fact ("what's the version of this project?")
4. Verify task 2's response includes the fact

Run from `/Users/prismer/workspace/luminclaw`. Same script pattern as C3/C4 measurements.

Steps:
1. Build + start server with fresh `WORKSPACE_DIR`
2. Run task 1 with content like `"List the files in this directory and remember /tmp as our work area"`
3. Poll until completed
4. Verify MemoryStore has facts (`ls $WORKSPACE_DIR/.lumin/memory/` or similar)
5. Run task 2 with content `"Where do we work? Use memory_recall to check."`
6. Poll until completed; verify response contains the recalled info

Write report `docs/superpowers/plans/2026-04-13-c7-after-phase-e.md` with same shape as previous phase reports.

Commit: `test(E4): C7 capability measurement — cross-task knowledge verified`

If LLM endpoint is unreachable, document as `DONE_WITH_CONCERNS` and ship the unit-level verification only.

---

## Cross-Task Summary

| Task | What | New Tests |
|---|---|---|
| E1 | serializeKnowledgeBaseForMemory | 3 |
| E2 | persist on completion + recall on start | 2 |
| E3 | TTL eviction timer | 3 |
| E4 | C7 measurement report | — |
| **Total** | | **8** |

## Self-Review

- E1 + E2 close the loop: facts written on completion → recall on next task → injected into knowledgeBase
- E3 prevents unbounded growth (1h default, configurable)
- All disk writes are best-effort (fire-and-forget with logged warnings, don't block dialogue)
- shutdown() clears timer to allow clean process exit in tests
- Plan saved to `docs/superpowers/plans/2026-04-13-phase-e-knowledge-eviction-impl.md`
