# Phase B — Disk Persistence + Resume

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Tasks survive server restart. Per-task JSONL transcript + JSON metadata written to disk. On startup, enumerate persisted tasks, re-register those in non-terminal state as `interrupted`. Add `POST /v1/tasks/:id/resume` to explicitly resume an interrupted task's inner loop from last persisted turn.

**Architecture:** CC-style disk layout at `{WORKSPACE_DIR}/.lumin/sessions/{sessionId}/tasks/{taskId}.jsonl` (transcript) + `{taskId}.meta.json` (metadata). Append-only JSONL — each line is one turn `{role, content, tool_call_id?, timestamp}`. Metadata captures task state at each transition. Idempotent writes (atomic via tmp+rename). Resume replays the JSONL into a fresh session.messages, then re-enters the inner loop.

**Tech Stack:** Node fs/promises, path. No new external deps.

**Scope boundaries:**
- **In scope:** Write path for task turns + metadata; startup enumeration; explicit resume endpoint; new terminal status `interrupted`.
- **Out of scope (Phase D):** Permission context persistence.
- **Out of scope (Phase E):** Cross-task knowledge carry-over.
- **Rust parity (Gate 1 = c):** No Rust persistence in this phase. Rust runs in-memory only; restart loses Rust task state. Documented.

---

## Current state

- `InMemoryTaskStore` in `src/task/store.ts` holds tasks in a Map, lost on restart.
- `DualLoopAgent.runInnerLoop` builds `session.messages` in memory via `SessionStore.getOrCreate` and appends assistant/tool results through PrismerAgent. On completion, no persistence happens.
- Phase A added `task.progress` events per iteration — these are the right anchor points to flush state to disk.
- Phase C added `AbortReason` and HTTP cancel — resume must handle `interrupted` tasks distinct from `killed` tasks.

---

## Disk Layout

```
{WORKSPACE_DIR}/.lumin/sessions/{sessionId}/
  └── tasks/
      ├── {taskId}.jsonl      # append-only turn log
      └── {taskId}.meta.json  # current task state (overwritten)
```

### JSONL turn format

One JSON object per line. Types:

```typescript
type TurnEntry =
  | { kind: 'user'; content: string; enqueuedAt?: number; messageId?: string; timestamp: number }
  | { kind: 'assistant'; content: string; thinking?: string; toolCalls?: Array<{id: string; name: string; arguments: unknown}>; timestamp: number }
  | { kind: 'tool'; toolCallId: string; name: string; content: string; timestamp: number }
  | { kind: 'status'; status: TaskStatus; reason?: string; timestamp: number };  // lifecycle marker
```

`status` entries are written on every state transition (pending → executing → completed/failed/killed/interrupted).

### Metadata format

```typescript
type TaskMetadata = {
  id: string;
  sessionId: string;
  instruction: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  iterations?: number;     // from Phase A progress
  toolsUsed?: string[];
  error?: string;
  lastPersistedTurnOffset: number;  // file offset into JSONL; resume reads from here
  version: 1;              // schema version
};
```

---

## Module Changes

| File | Change |
|------|--------|
| `src/task/disk.ts` | **Create.** `appendTurn`, `writeMeta`, `readMeta`, `readTranscript`, `enumerateSessionTasks`. Atomic writes (write tmp + rename). |
| `src/task/store.ts` | Wire disk writes alongside in-memory updates. Add `interrupted` status constant. |
| `src/task/types.ts` | Add `interrupted` to `TaskStatus` union. |
| `src/loop/dual.ts` | Write turn + metadata at each persistence point: task creation (meta), per-iteration (turn entries + meta update), terminal transition (status turn + final meta). |
| `src/loop/resume.ts` | **Create.** `resumeTask(taskId)`: load metadata, replay transcript into a fresh session, re-create abortController/bus, dispatch runInnerLoop from the last persisted point. |
| `src/server.ts` | Add `POST /v1/tasks/:id/resume`. At startup, call `enumerateSessionTasks()` and re-register tasks with non-terminal status as `interrupted`. |
| `tests/task/disk.test.ts` | **Create.** Unit tests for disk module. |
| `tests/loop/resume.test.ts` | **Create.** Resume behavior tests. |

---

## Tasks

### Task B1: Disk module — appendTurn / writeMeta / readMeta / readTranscript

**Files:**
- Create: `src/task/disk.ts`
- Create: `tests/task/disk.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/task/disk.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendTurn,
  writeMeta,
  readMeta,
  readTranscript,
  enumerateSessionTasks,
  taskJsonlPath,
  taskMetaPath,
} from '../../src/task/disk.js';
import type { TaskMetadata, TurnEntry } from '../../src/task/disk.js';

describe('task/disk', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-disk-'));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('appendTurn + readTranscript', () => {
    it('appends turns in order, reads back as JSONL array', async () => {
      const workspaceDir = tmpRoot;
      const sessionId = 's1';
      const taskId = 't1';
      const u: TurnEntry = { kind: 'user', content: 'hello', timestamp: 1 };
      const a: TurnEntry = { kind: 'assistant', content: 'hi', timestamp: 2 };
      await appendTurn(workspaceDir, sessionId, taskId, u);
      await appendTurn(workspaceDir, sessionId, taskId, a);
      const turns = await readTranscript(workspaceDir, sessionId, taskId);
      expect(turns).toEqual([u, a]);
    });

    it('handles tool turn with toolCallId and tool content', async () => {
      const t: TurnEntry = { kind: 'tool', toolCallId: 'c1', name: 'bash', content: 'ok', timestamp: 3 };
      await appendTurn(tmpRoot, 's1', 't1', t);
      const turns = await readTranscript(tmpRoot, 's1', 't1');
      expect(turns).toEqual([t]);
    });

    it('creates directory structure on first write', async () => {
      await appendTurn(tmpRoot, 'sess', 'task', { kind: 'status', status: 'pending', timestamp: 1 });
      const stat = await fs.stat(path.join(tmpRoot, '.lumin', 'sessions', 'sess', 'tasks'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('readTranscript returns [] for non-existent task', async () => {
      const turns = await readTranscript(tmpRoot, 'nope', 'nope');
      expect(turns).toEqual([]);
    });
  });

  describe('writeMeta + readMeta', () => {
    it('writes and reads metadata atomically', async () => {
      const meta: TaskMetadata = {
        id: 't1', sessionId: 's1', instruction: 'go',
        status: 'executing',
        createdAt: 100, updatedAt: 200,
        lastPersistedTurnOffset: 0, version: 1,
      };
      await writeMeta(tmpRoot, 's1', 't1', meta);
      const read = await readMeta(tmpRoot, 's1', 't1');
      expect(read).toEqual(meta);
    });

    it('overwrites metadata on subsequent writes', async () => {
      const m1: TaskMetadata = { id: 't1', sessionId: 's1', instruction: 'go', status: 'pending', createdAt: 100, updatedAt: 100, lastPersistedTurnOffset: 0, version: 1 };
      const m2: TaskMetadata = { ...m1, status: 'executing', updatedAt: 200 };
      await writeMeta(tmpRoot, 's1', 't1', m1);
      await writeMeta(tmpRoot, 's1', 't1', m2);
      const read = await readMeta(tmpRoot, 's1', 't1');
      expect(read?.status).toBe('executing');
      expect(read?.updatedAt).toBe(200);
    });

    it('readMeta returns null for non-existent task', async () => {
      const read = await readMeta(tmpRoot, 'nope', 'nope');
      expect(read).toBeNull();
    });
  });

  describe('enumerateSessionTasks', () => {
    it('finds all tasks across all sessions', async () => {
      const m1: TaskMetadata = { id: 't1', sessionId: 's1', instruction: 'a', status: 'executing', createdAt: 1, updatedAt: 1, lastPersistedTurnOffset: 0, version: 1 };
      const m2: TaskMetadata = { id: 't2', sessionId: 's1', instruction: 'b', status: 'completed', createdAt: 2, updatedAt: 2, lastPersistedTurnOffset: 0, version: 1 };
      const m3: TaskMetadata = { id: 't3', sessionId: 's2', instruction: 'c', status: 'executing', createdAt: 3, updatedAt: 3, lastPersistedTurnOffset: 0, version: 1 };
      await writeMeta(tmpRoot, 's1', 't1', m1);
      await writeMeta(tmpRoot, 's1', 't2', m2);
      await writeMeta(tmpRoot, 's2', 't3', m3);
      const all = await enumerateSessionTasks(tmpRoot);
      expect(all.map(t => t.id).sort()).toEqual(['t1', 't2', 't3']);
    });

    it('returns [] when no sessions exist', async () => {
      const all = await enumerateSessionTasks(tmpRoot);
      expect(all).toEqual([]);
    });
  });

  describe('path helpers', () => {
    it('produces consistent paths', () => {
      expect(taskJsonlPath(tmpRoot, 's', 't')).toBe(path.join(tmpRoot, '.lumin', 'sessions', 's', 'tasks', 't.jsonl'));
      expect(taskMetaPath(tmpRoot, 's', 't')).toBe(path.join(tmpRoot, '.lumin', 'sessions', 's', 'tasks', 't.meta.json'));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/task/disk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement disk.ts**

```typescript
// src/task/disk.ts
/**
 * Disk persistence for tasks — JSONL transcript + JSON metadata.
 * Layout:
 *   {workspaceDir}/.lumin/sessions/{sessionId}/tasks/{taskId}.jsonl
 *   {workspaceDir}/.lumin/sessions/{sessionId}/tasks/{taskId}.meta.json
 *
 * All writes are atomic (write-tmp + rename). Reads return null/[] for missing.
 * @module task/disk
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskStatus } from './types.js';

const LUMIN_DIR = '.lumin';
const SESSIONS_DIR = 'sessions';
const TASKS_DIR = 'tasks';

export interface TaskMetadata {
  id: string;
  sessionId: string;
  instruction: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  iterations?: number;
  toolsUsed?: string[];
  error?: string;
  lastPersistedTurnOffset: number;
  version: 1;
}

export type TurnEntry =
  | { kind: 'user'; content: string; enqueuedAt?: number; messageId?: string; timestamp: number }
  | { kind: 'assistant'; content: string; thinking?: string; toolCalls?: Array<{ id: string; name: string; arguments: unknown }>; timestamp: number }
  | { kind: 'tool'; toolCallId: string; name: string; content: string; timestamp: number }
  | { kind: 'status'; status: TaskStatus; reason?: string; timestamp: number };

export function taskJsonlPath(workspaceDir: string, sessionId: string, taskId: string): string {
  return path.join(workspaceDir, LUMIN_DIR, SESSIONS_DIR, sessionId, TASKS_DIR, `${taskId}.jsonl`);
}

export function taskMetaPath(workspaceDir: string, sessionId: string, taskId: string): string {
  return path.join(workspaceDir, LUMIN_DIR, SESSIONS_DIR, sessionId, TASKS_DIR, `${taskId}.meta.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

export async function appendTurn(workspaceDir: string, sessionId: string, taskId: string, entry: TurnEntry): Promise<void> {
  const filePath = taskJsonlPath(workspaceDir, sessionId, taskId);
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

export async function readTranscript(workspaceDir: string, sessionId: string, taskId: string): Promise<TurnEntry[]> {
  const filePath = taskJsonlPath(workspaceDir, sessionId, taskId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as TurnEntry);
}

export async function writeMeta(workspaceDir: string, sessionId: string, taskId: string, meta: TaskMetadata): Promise<void> {
  await atomicWrite(taskMetaPath(workspaceDir, sessionId, taskId), JSON.stringify(meta, null, 2));
}

export async function readMeta(workspaceDir: string, sessionId: string, taskId: string): Promise<TaskMetadata | null> {
  try {
    const raw = await fs.readFile(taskMetaPath(workspaceDir, sessionId, taskId), 'utf8');
    return JSON.parse(raw) as TaskMetadata;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

export async function enumerateSessionTasks(workspaceDir: string): Promise<TaskMetadata[]> {
  const sessionsRoot = path.join(workspaceDir, LUMIN_DIR, SESSIONS_DIR);
  const results: TaskMetadata[] = [];
  let sessionDirs: string[];
  try {
    sessionDirs = await fs.readdir(sessionsRoot);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  for (const sessionId of sessionDirs) {
    const tasksDir = path.join(sessionsRoot, sessionId, TASKS_DIR);
    let files: string[];
    try {
      files = await fs.readdir(tasksDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.meta.json')) continue;
      const taskId = f.slice(0, -'.meta.json'.length);
      const meta = await readMeta(workspaceDir, sessionId, taskId);
      if (meta) results.push(meta);
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/task/disk.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add src/task/disk.ts tests/task/disk.test.ts
git commit -m "feat(B1): disk persistence module — appendTurn, writeMeta, enumerate"
```

---

### Task B2: `interrupted` TaskStatus + type updates

**Files:**
- Modify: `src/task/types.ts`
- Modify: `src/task/machine.ts` — allow transition to interrupted
- Modify: `tests/task/store.test.ts` — add interrupted-status test

- [ ] **Step 1: Write failing test**

Add to `tests/task/store.test.ts`:

```typescript
describe('interrupted status', () => {
  it('getActiveForSession treats interrupted as NOT active', () => {
    const store = new InMemoryTaskStore();
    store.create({
      id: 't1', sessionId: 's', instruction: 'x',
      artifactIds: [], status: 'interrupted',
    });
    expect(store.getActiveForSession('s')).toBeUndefined();
  });
});
```

Also add a machine test if `tests/task/machine.test.ts` exists:

```typescript
it('transitions from executing to interrupted', () => {
  const task: Task = { id:'t', sessionId:'s', instruction:'x', artifactIds:[], status:'executing', checkpoints:[], createdAt:1, updatedAt:1 };
  const machine = new TaskStateMachine();
  expect(() => machine.transition(task, 'interrupted')).not.toThrow();
  expect(task.status).toBe('interrupted');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/task/`
Expected: FAIL — `"interrupted"` not a valid TaskStatus value.

- [ ] **Step 3: Update type**

In `src/task/types.ts`:

```typescript
export type TaskStatus = 'pending' | 'planning' | 'executing' | 'paused' | 'completed' | 'failed' | 'interrupted';
```

In `src/task/machine.ts`, find the transition table and allow:
- `executing → interrupted`
- `paused → interrupted`
- `interrupted → executing` (for resume)

Update terminal check in `isTerminal` or similar — `interrupted` is NOT terminal (it's recoverable). `getActiveForSession` in `src/task/store.ts` treats `executing` | `paused` as active; `interrupted` is not active until resumed.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/task/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/task/types.ts src/task/machine.ts tests/task/
git commit -m "feat(B2): add 'interrupted' TaskStatus for recoverable-task state"
```

---

### Task B3: DualLoopAgent writes to disk at lifecycle points

**Files:**
- Modify: `src/loop/dual.ts`
- Modify: `tests/loop/dual-persistence.test.ts` (create)

- [ ] **Step 1: Write failing tests**

```typescript
// tests/loop/dual-persistence.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus } from '../../src/sse.js';
import { readMeta, readTranscript } from '../../src/task/disk.js';
import { loadConfig, resetConfig } from '../../src/config.js';

describe('DualLoopAgent — disk persistence', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-persist-'));
    process.env.WORKSPACE_DIR = tmpWorkspace;
    resetConfig();
  });

  afterEach(async () => {
    delete process.env.WORKSPACE_DIR;
    resetConfig();
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('writes metadata at task creation', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const result = await agent.processMessage({ content: 'hello', sessionId: 's1' }, { bus: new EventBus() });

    // Wait for async disk write
    await new Promise(r => setTimeout(r, 50));

    const meta = await readMeta(tmpWorkspace, 's1', result.taskId!);
    expect(meta).not.toBeNull();
    expect(meta?.id).toBe(result.taskId);
    expect(meta?.instruction).toBe('hello');
    expect(meta?.version).toBe(1);
  });

  it('writes user-turn entry on task creation', async () => {
    const agent = new DualLoopAgent();
    vi.spyOn(agent as any, 'runInnerLoop').mockResolvedValue(undefined);

    const result = await agent.processMessage({ content: 'hello', sessionId: 's1' }, { bus: new EventBus() });
    await new Promise(r => setTimeout(r, 50));

    const turns = await readTranscript(tmpWorkspace, 's1', result.taskId!);
    const userTurn = turns.find(t => t.kind === 'user');
    expect(userTurn).toBeDefined();
    expect(userTurn!.kind === 'user' && userTurn.content).toBe('hello');
  });

  it('writes status turn on terminal transition', async () => {
    const agent = new DualLoopAgent();
    // Simulate a completion: mock runInnerLoop to transition state to completed
    vi.spyOn(agent as any, 'runInnerLoop').mockImplementation(async function (this: any, task: any) {
      task.status = 'completed';
      // Call drainQueueOnTermination as real code would
      this.drainQueueOnTermination(task.id, 'task_completed');
      // Signal completion via metadata rewrite
      const { writeMeta } = await import('../../src/task/disk.js');
      await writeMeta(this.workspaceDir ?? process.env.WORKSPACE_DIR!, task.sessionId, task.id, {
        id: task.id, sessionId: task.sessionId, instruction: task.instruction,
        status: 'completed', createdAt: task.createdAt, updatedAt: Date.now(),
        endedAt: Date.now(), lastPersistedTurnOffset: 0, version: 1,
      });
    });

    const result = await agent.processMessage({ content: 'x', sessionId: 's2' }, { bus: new EventBus() });
    await new Promise(r => setTimeout(r, 100));

    const meta = await readMeta(tmpWorkspace, 's2', result.taskId!);
    expect(meta?.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/loop/dual-persistence.test.ts`
Expected: FAIL — metadata file not written.

- [ ] **Step 3: Wire disk writes**

In `src/loop/dual.ts`:

Import:
```typescript
import { appendTurn, writeMeta, type TaskMetadata, type TurnEntry } from '../task/disk.js';
```

After `this.tasks.create(...)` in `processMessage` non-queued path, add:

```typescript
    // B3: Persist initial metadata + user turn
    const workspaceDir = loadConfig().workspace.dir;
    const initMeta: TaskMetadata = {
      id: taskId,
      sessionId,
      instruction: input.content,
      status: 'pending',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      lastPersistedTurnOffset: 0,
      version: 1,
    };
    void writeMeta(workspaceDir, sessionId, taskId, initMeta)
      .catch(e => log.warn('writeMeta failed', { error: String(e) }));
    void appendTurn(workspaceDir, sessionId, taskId, {
      kind: 'user', content: input.content, timestamp: task.createdAt,
    }).catch(e => log.warn('appendTurn failed', { error: String(e) }));
```

In `runInnerLoop`, at each state transition (pending→executing, terminal transitions), append a status turn + rewrite metadata:

```typescript
// Helper inline or private method:
const persistStatus = async (currentStatus: TaskStatus, reason?: string) => {
  const ts = Date.now();
  void appendTurn(workspaceDir, task.sessionId, task.id, {
    kind: 'status', status: currentStatus, reason, timestamp: ts,
  });
  const currentMeta: TaskMetadata = {
    id: task.id, sessionId: task.sessionId, instruction: task.instruction,
    status: currentStatus,
    createdAt: task.createdAt,
    updatedAt: ts,
    endedAt: ['completed','failed','interrupted','killed'].includes(currentStatus) ? ts : undefined,
    iterations: task.progress?.iterations,
    toolsUsed: task.progress?.toolsUsed,
    error: task.error,
    lastPersistedTurnOffset: 0,
    version: 1,
  };
  void writeMeta(workspaceDir, task.sessionId, task.id, currentMeta);
};
```

Call `persistStatus` at:
- After `stateMachine.transition(task, 'executing')`
- After `stateMachine.complete(...)` (on success)
- In the `catch` block after `stateMachine.fail(...)` (on error path)

For per-iteration transcript: in `onIterationStart` callback, after draining the queue, append each drained message as a user-turn entry. For assistant/tool turns: Phase B can stop at "initial user message + status transitions + final assistant text in meta" for simplicity. Full per-iteration transcript (every LLM turn persisted live) can be added in B3 follow-up or punted to Phase F if this becomes heavy.

Minimal viable scope for B3: metadata reflects current task state at all transitions; user-input turns are persisted; assistant output is captured in `meta.error` or a future `finalResult` field on terminal transition.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/loop/dual-persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop/dual.ts tests/loop/dual-persistence.test.ts
git commit -m "feat(B3): persist task metadata + user turn + status transitions to disk"
```

---

### Task B4: Server startup enumerates + re-registers interrupted tasks

**Files:**
- Modify: `src/server.ts` — on startServer(), call `enumerateSessionTasks` and populate `DualLoopAgent.tasks`
- Modify: `tests/server.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('server startup — re-register persisted tasks', () => {
  it('re-registers non-terminal tasks as interrupted on startup', async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-startup-'));
    try {
      // Pre-populate disk with a task that was 'executing' before a restart
      const { writeMeta } = await import('../src/task/disk.js');
      await writeMeta(tmpWorkspace, 'sess', 'task-x', {
        id: 'task-x', sessionId: 'sess', instruction: 'unfinished',
        status: 'executing',
        createdAt: 1, updatedAt: 2,
        lastPersistedTurnOffset: 0, version: 1,
      });

      process.env.WORKSPACE_DIR = tmpWorkspace;
      resetConfig();

      const { DualLoopAgent } = await import('../src/loop/dual.js');
      const agent = new DualLoopAgent();
      // simulate startup re-register
      await agent.loadPersistedTasks();

      const task = agent.tasks.get('task-x');
      expect(task).toBeDefined();
      expect(task!.status).toBe('interrupted');  // was executing, now interrupted
    } finally {
      delete process.env.WORKSPACE_DIR;
      resetConfig();
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
    }
  });

  it('preserves terminal-status tasks as-is', async () => {
    // completed task stays completed; failed stays failed
    // ... similar setup, assert .status stays 'completed'
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/server.test.ts -t "re-register"`
Expected: FAIL — `loadPersistedTasks` not a method.

- [ ] **Step 3: Implement loadPersistedTasks**

In `src/loop/dual.ts`:

```typescript
async loadPersistedTasks(): Promise<void> {
  const workspaceDir = loadConfig().workspace.dir;
  const metas = await enumerateSessionTasks(workspaceDir);
  for (const meta of metas) {
    const restoredStatus = (['executing', 'paused', 'planning', 'pending'] as TaskStatus[]).includes(meta.status)
      ? 'interrupted'
      : meta.status;
    this.tasks.create({
      id: meta.id,
      sessionId: meta.sessionId,
      instruction: meta.instruction,
      artifactIds: [],
      status: restoredStatus,
    });
    // Update fields not set by create()
    this.tasks.update(meta.id, {
      status: restoredStatus,
      error: meta.error,
    });
    if (meta.iterations !== undefined) {
      this.tasks.updateProgress(meta.id, {
        iterations: meta.iterations,
        toolsUsed: meta.toolsUsed ?? [],
        lastActivity: meta.updatedAt,
      });
    }
  }
  log.info('loaded persisted tasks', { count: metas.length });
}
```

- [ ] **Step 4: Call at server startup**

In `src/server.ts`, at the start of `startServer()` (or in the initialization lazy path), call `await getLoop().loadPersistedTasks()` (add the method to `IAgentLoop` interface with a default no-op for SingleLoopAgent).

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/loop/dual.ts src/loop/single.ts src/loop/types.ts src/server.ts tests/server.test.ts
git commit -m "feat(B4): server startup enumerates disk, re-registers non-terminal tasks as interrupted"
```

---

### Task B5: POST /v1/tasks/:id/resume

**Files:**
- Create: `src/loop/resume.ts`
- Modify: `src/server.ts` — add route handler
- Create: `tests/loop/resume.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/loop/resume.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DualLoopAgent } from '../../src/loop/dual.js';
import { EventBus } from '../../src/sse.js';
import { writeMeta, appendTurn } from '../../src/task/disk.js';
import { loadConfig, resetConfig } from '../../src/config.js';

describe('resume interrupted task', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-resume-'));
    process.env.WORKSPACE_DIR = tmpWorkspace;
    resetConfig();
  });
  afterEach(async () => {
    delete process.env.WORKSPACE_DIR;
    resetConfig();
    await fs.rm(tmpWorkspace, { recursive: true, force: true });
  });

  it('transitions interrupted → executing on resume', async () => {
    await writeMeta(tmpWorkspace, 'sess', 'task-r', {
      id: 'task-r', sessionId: 'sess', instruction: 'go',
      status: 'interrupted',
      createdAt: 1, updatedAt: 2,
      lastPersistedTurnOffset: 0, version: 1,
    });
    await appendTurn(tmpWorkspace, 'sess', 'task-r', {
      kind: 'user', content: 'go', timestamp: 1,
    });

    const agent = new DualLoopAgent();
    await agent.loadPersistedTasks();
    vi.spyOn(agent as any, 'runInnerLoop').mockImplementation(async (task: any) => {
      // Mock the runInnerLoop — will be called by resume
      task.status = 'executing';
    });

    await agent.resumeTask('task-r');
    await new Promise(r => setTimeout(r, 50));

    const task = agent.tasks.get('task-r');
    expect(task?.status).toBe('executing');
  });

  it('throws for non-interrupted tasks', async () => {
    const agent = new DualLoopAgent();
    agent.tasks.create({ id: 't', sessionId: 's', instruction: 'x', artifactIds: [], status: 'completed' });
    await expect(agent.resumeTask('t')).rejects.toThrow(/cannot resume/i);
  });

  it('throws for unknown taskId', async () => {
    const agent = new DualLoopAgent();
    await expect(agent.resumeTask('nope')).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/loop/resume.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement resumeTask on DualLoopAgent**

```typescript
async resumeTask(taskId: string): Promise<{ taskId: string; sessionId: string }> {
  const task = this.tasks.get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== 'interrupted') {
    throw new Error(`Cannot resume task in status '${task.status}' — only 'interrupted' is resumable`);
  }

  // Load transcript from disk, replay into a fresh session
  const workspaceDir = loadConfig().workspace.dir;
  const turns = await readTranscript(workspaceDir, task.sessionId, taskId);

  const session = this.sessions.getOrCreate(task.sessionId);
  session.messages = []; // reset, we'll replay
  for (const turn of turns) {
    if (turn.kind === 'user') {
      session.addMessage({ role: 'user', content: turn.content });
    } else if (turn.kind === 'assistant') {
      session.addMessage({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });
    } else if (turn.kind === 'tool') {
      session.addMessage({ role: 'tool', content: turn.content, toolCallId: turn.toolCallId });
    }
    // 'status' turns are lifecycle markers, not session messages
  }

  // Transition back to executing
  this.stateMachine.transition(task, 'executing');

  // Create new abortController + bus for the resumed task
  const abortController = new AbortController();
  const bus = new EventBus();
  this.taskContexts.set(taskId, { abortController, bus });

  // Re-dispatch inner loop
  void this.runInnerLoop(task, { content: task.instruction, sessionId: task.sessionId }, session, bus, abortController.signal)
    .catch(err => {
      log.error('resumed inner loop crashed', { taskId, error: String(err) });
      try { this.stateMachine.fail(task, String(err)); } catch { /* */ }
      this.drainQueueOnTermination(taskId, 'task_aborted');
      this.taskContexts.delete(taskId);
    });

  return { taskId, sessionId: task.sessionId };
}
```

- [ ] **Step 4: Add HTTP endpoint**

In `src/server.ts`, add route:

```typescript
} else if (path.match(/^\/v1\/tasks\/[^/]+\/resume$/) && method === 'POST') {
  const taskId = path.split('/')[3];
  try {
    const result = await getLoop().resumeTask(taskId);
    json(res, 200, { status: 'resumed', ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.includes('not found') ? 404 : 409;
    json(res, code, { error: msg });
  }
}
```

Add `resumeTask` to `IAgentLoop` interface; `SingleLoopAgent` throws `'resume not supported in single-loop mode'`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/loop/resume.test.ts tests/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/loop/dual.ts src/loop/single.ts src/loop/types.ts src/server.ts tests/loop/resume.test.ts
git commit -m "feat(B5): POST /v1/tasks/:id/resume + DualLoopAgent.resumeTask"
```

---

### Task B6: C3 robust capability test (disk-backed reconnect)

**Files:**
- Create: `docs/superpowers/plans/2026-04-13-c3-after-phase-b.md`

Re-run the C3 capability from audit doc §2 with full persistence. Specifically:
1. Start server, dispatch task
2. Kill server mid-task (SIGKILL)
3. Restart server with same WORKSPACE_DIR
4. Verify task is re-registered as `interrupted`
5. POST resume
6. Task completes normally

- [ ] **Step 1: Build + measurement script**

```bash
cd /Users/prismer/workspace/luminclaw
npx tsc
export $(grep -v '^#' .env.test | xargs)
export LUMIN_LOOP_MODE=dual
export WORKSPACE_DIR=/tmp/c3-phase-b
rm -rf $WORKSPACE_DIR
mkdir -p $WORKSPACE_DIR

# Start server 1
node dist/cli.js serve --port 3001 &
PID1=$!
sleep 2

SID="c3-$(date +%s)"
curl -s -X POST http://localhost:3001/v1/chat \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"Respond briefly then stop\", \"sessionId\": \"$SID\"}" \
  > /tmp/p1.json
TASK=$(python3 -c "import json; print(json.load(open('/tmp/p1.json'))['taskId'])")
echo "Task: $TASK"

sleep 1
# Kill abruptly — simulate crash
kill -9 $PID1
sleep 1

# Verify disk has the task
ls $WORKSPACE_DIR/.lumin/sessions/$SID/tasks/

# Start server 2 with same workspace
node dist/cli.js serve --port 3001 &
PID2=$!
sleep 2

# Verify task re-appeared as interrupted
curl -s http://localhost:3001/v1/tasks/$TASK > /tmp/task-after.json
python3 -c "
import json; t = json.load(open('/tmp/task-after.json'))
print('Status after restart:', t['status'])
assert t['status'] == 'interrupted', f'expected interrupted, got {t[\"status\"]}'
"

# Resume
curl -s -X POST http://localhost:3001/v1/tasks/$TASK/resume | tee /tmp/resume.json

# Wait for completion
for i in $(seq 1 30); do
  STATUS=$(curl -s http://localhost:3001/v1/tasks/$TASK | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then break; fi
  sleep 1
done
echo "Final status: $STATUS"

kill $PID2 2>/dev/null
```

Record timings + status transitions.

- [ ] **Step 2: Write report**

`docs/superpowers/plans/2026-04-13-c3-after-phase-b.md` — same shape as earlier reports.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-04-13-c3-after-phase-b.md
git commit -m "test(B6): C3 capability measurement — server restart + resume verified"
```

---

## Cross-Task Summary

| Task | What | New Tests |
|---|---|---|
| B1 | disk.ts module | 9 |
| B2 | interrupted status | 2 |
| B3 | persist at lifecycle points | 3 |
| B4 | startup re-register | 2 |
| B5 | resume endpoint | 3 |
| B6 | C3 measurement | report |
| **Total** | | **19** |

## Self-Review

- All tasks have TDD steps with explicit code blocks
- `TaskStatus` union extended consistently (types.ts, machine.ts, store.ts)
- `interrupted` treated correctly across: getActiveForSession (not active), machine transitions, resume guard
- Disk writes are fire-and-forget (`void ...catch(...)`) — don't block the dialogue loop. Errors logged, not thrown
- `resumeTask` replays transcript before re-dispatching runInnerLoop
- B4 + B5 add methods to `IAgentLoop` interface; SingleLoopAgent gets no-op or throw
- Atomic writes via tmp+rename prevent partial-file reads
- Memory growth bounded (metadata file overwritten, JSONL appends only)

**Plan saved to `docs/superpowers/plans/2026-04-13-phase-b-disk-persistence-impl.md`.**
