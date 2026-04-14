/**
 * Task state machine — validates transitions and enforces lifecycle rules.
 *
 * @module task/machine
 */

import type { Task, TaskStatus, Checkpoint } from './types.js';

// ── Valid Transitions ─────────────────────────────────────

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:     ['planning', 'executing', 'failed'],
  planning:    ['executing', 'failed'],
  executing:   ['paused', 'completed', 'failed', 'interrupted'],
  paused:      ['executing', 'failed', 'interrupted'],
  completed:   [],
  failed:      [],
  interrupted: ['executing'],
};

// ── Errors ────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  constructor(public from: TaskStatus, public to: TaskStatus) {
    super(`Invalid task transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

// ── State Machine ─────────────────────────────────────────

export class TaskStateMachine {
  /** Check if a transition is valid without applying it. */
  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  /**
   * Apply a status transition. Mutates the task in place and returns it.
   * @throws {InvalidTransitionError} if the transition is illegal.
   */
  transition(task: Task, newStatus: TaskStatus): Task {
    if (!this.canTransition(task.status, newStatus)) {
      throw new InvalidTransitionError(task.status, newStatus);
    }
    task.status = newStatus;
    task.updatedAt = Date.now();
    return task;
  }

  /** Append a checkpoint to the task. */
  addCheckpoint(task: Task, checkpoint: Omit<Checkpoint, 'taskId'>): Checkpoint {
    const full: Checkpoint = { ...checkpoint, taskId: task.id };
    task.checkpoints.push(full);
    task.updatedAt = Date.now();
    return full;
  }

  /** Complete a task with a result. */
  complete(task: Task, result: string): Task {
    this.transition(task, 'completed');
    task.result = result;
    return task;
  }

  /** Fail a task with an error. */
  fail(task: Task, error: string): Task {
    this.transition(task, 'failed');
    task.error = error;
    return task;
  }
}
