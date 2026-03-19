/**
 * In-memory task store.
 *
 * @module task/store
 */

import type { Task, Checkpoint, TaskStore } from './types.js';

export class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, Task>();

  create(input: Omit<Task, 'checkpoints' | 'createdAt' | 'updatedAt'>): Task {
    const now = Date.now();
    const task: Task = {
      ...input,
      checkpoints: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, partial: Partial<Pick<Task, 'status' | 'result' | 'error' | 'artifactIds'>>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, partial, { updatedAt: Date.now() });
    return task;
  }

  addCheckpoint(taskId: string, checkpoint: Omit<Checkpoint, 'taskId'>): Checkpoint | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const full: Checkpoint = { ...checkpoint, taskId };
    task.checkpoints.push(full);
    task.updatedAt = Date.now();
    return full;
  }

  getActive(): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.status === 'executing' || task.status === 'paused') return task;
    }
    return undefined;
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  clear(): void {
    this.tasks.clear();
  }
}
