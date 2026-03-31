/**
 * Tests for Phase 2 — Task Model + State Machine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTaskStore } from '../src/task/store.js';
import { TaskStateMachine, InvalidTransitionError } from '../src/task/machine.js';
import type { Task, TaskStatus } from '../src/task/types.js';

// ── InMemoryTaskStore ────────────────────────────────────

describe('InMemoryTaskStore', () => {
  let store: InMemoryTaskStore;

  beforeEach(() => {
    store = new InMemoryTaskStore();
  });

  it('create + get round-trip', () => {
    const task = store.create({
      id: 'task-1',
      sessionId: 'sess-1',
      instruction: 'Write a paper',
      artifactIds: [],
      status: 'pending',
    });
    expect(task.id).toBe('task-1');
    expect(task.checkpoints).toEqual([]);
    expect(task.createdAt).toBeGreaterThan(0);
    expect(store.get('task-1')).toBe(task);
  });

  it('get returns undefined for missing id', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  it('update modifies fields', () => {
    store.create({ id: 't1', sessionId: 's1', instruction: 'x', artifactIds: [], status: 'pending' });
    const updated = store.update('t1', { status: 'executing' });
    expect(updated!.status).toBe('executing');
    expect(updated!.updatedAt).toBeGreaterThan(0);
  });

  it('update returns undefined for missing task', () => {
    expect(store.update('nope', { status: 'failed' })).toBeUndefined();
  });

  it('addCheckpoint appends to task', () => {
    store.create({ id: 't1', sessionId: 's1', instruction: 'x', artifactIds: [], status: 'executing' });
    const cp = store.addCheckpoint('t1', {
      id: 'cp-1',
      type: 'progress',
      message: 'Working...',
      requiresUserAction: false,
      emittedAt: Date.now(),
    });
    expect(cp!.taskId).toBe('t1');
    expect(store.get('t1')!.checkpoints).toHaveLength(1);
  });

  it('addCheckpoint returns undefined for missing task', () => {
    expect(store.addCheckpoint('nope', {
      id: 'cp-1', type: 'progress', message: 'x', requiresUserAction: false, emittedAt: Date.now(),
    })).toBeUndefined();
  });

  it('getActive returns executing or paused task', () => {
    store.create({ id: 't1', sessionId: 's1', instruction: 'x', artifactIds: [], status: 'pending' });
    store.create({ id: 't2', sessionId: 's2', instruction: 'y', artifactIds: [], status: 'executing' });
    expect(store.getActive()!.id).toBe('t2');
  });

  it('getActive returns paused task', () => {
    store.create({ id: 't1', sessionId: 's1', instruction: 'x', artifactIds: [], status: 'paused' });
    expect(store.getActive()!.id).toBe('t1');
  });

  it('getActive returns undefined when no active task', () => {
    store.create({ id: 't1', sessionId: 's1', instruction: 'x', artifactIds: [], status: 'completed' });
    expect(store.getActive()).toBeUndefined();
  });

  it('list returns all tasks', () => {
    store.create({ id: 't1', sessionId: 's1', instruction: 'a', artifactIds: [], status: 'pending' });
    store.create({ id: 't2', sessionId: 's2', instruction: 'b', artifactIds: [], status: 'completed' });
    expect(store.list()).toHaveLength(2);
  });

  it('clear removes everything', () => {
    store.create({ id: 't1', sessionId: 's1', instruction: 'a', artifactIds: [], status: 'pending' });
    store.clear();
    expect(store.list()).toHaveLength(0);
  });
});

// ── TaskStateMachine ─────────────────────────────────────

describe('TaskStateMachine', () => {
  let machine: TaskStateMachine;

  function makeTask(status: TaskStatus): Task {
    return {
      id: 'task-1',
      sessionId: 's1',
      instruction: 'test',
      artifactIds: [],
      status,
      checkpoints: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  beforeEach(() => {
    machine = new TaskStateMachine();
  });

  // Valid transitions
  const validTransitions: [TaskStatus, TaskStatus][] = [
    ['pending', 'planning'],
    ['pending', 'executing'],
    ['pending', 'failed'],
    ['planning', 'executing'],
    ['planning', 'failed'],
    ['executing', 'paused'],
    ['executing', 'completed'],
    ['executing', 'failed'],
    ['paused', 'executing'],
    ['paused', 'failed'],
  ];

  for (const [from, to] of validTransitions) {
    it(`allows ${from} → ${to}`, () => {
      const task = makeTask(from);
      const result = machine.transition(task, to);
      expect(result.status).toBe(to);
    });
  }

  // Invalid transitions
  const invalidTransitions: [TaskStatus, TaskStatus][] = [
    ['pending', 'paused'],
    ['pending', 'completed'],
    ['planning', 'paused'],
    ['planning', 'completed'],
    ['executing', 'pending'],
    ['executing', 'planning'],
    ['paused', 'pending'],
    ['paused', 'completed'],
    ['completed', 'executing'],
    ['completed', 'failed'],
    ['completed', 'pending'],
    ['failed', 'executing'],
    ['failed', 'completed'],
    ['failed', 'pending'],
  ];

  for (const [from, to] of invalidTransitions) {
    it(`rejects ${from} → ${to}`, () => {
      const task = makeTask(from);
      expect(() => machine.transition(task, to)).toThrow(InvalidTransitionError);
    });
  }

  it('canTransition returns boolean without side effects', () => {
    expect(machine.canTransition('pending', 'executing')).toBe(true);
    expect(machine.canTransition('completed', 'executing')).toBe(false);
  });

  it('addCheckpoint appends to task', () => {
    const task = makeTask('executing');
    const cp = machine.addCheckpoint(task, {
      id: 'cp-1',
      type: 'progress',
      message: 'Step 1 done',
      requiresUserAction: false,
      emittedAt: Date.now(),
    });
    expect(cp.taskId).toBe('task-1');
    expect(task.checkpoints).toHaveLength(1);
  });

  it('complete transitions and sets result', () => {
    const task = makeTask('executing');
    machine.complete(task, 'Done!');
    expect(task.status).toBe('completed');
    expect(task.result).toBe('Done!');
  });

  it('fail transitions and sets error', () => {
    const task = makeTask('executing');
    machine.fail(task, 'Something broke');
    expect(task.status).toBe('failed');
    expect(task.error).toBe('Something broke');
  });

  it('complete from non-executing throws', () => {
    const task = makeTask('pending');
    expect(() => machine.complete(task, 'x')).toThrow(InvalidTransitionError);
  });
});
