/**
 * In-memory task store.
 *
 * @module task/store
 */

import type { Task, Checkpoint, TaskStore, TaskProgress } from './types.js';

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

  getActiveForSession(sessionId: string): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId &&
          (task.status === 'executing' || task.status === 'paused')) {
        return task;
      }
    }
    return undefined;
  }

  updateProgress(id: string, progress: Partial<TaskProgress>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.progress = {
      ...(task.progress ?? { iterations: 0, toolsUsed: [], lastActivity: 0 }),
      ...progress,
    };
    task.updatedAt = Date.now();
    return task;
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  clear(): void {
    this.tasks.clear();
  }

  /** Evict completed/failed tasks older than maxAgeMs. Returns count evicted. */
  evictCompleted(maxAgeMs: number): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, task] of this.tasks) {
      if ((task.status === 'completed' || task.status === 'failed') &&
          (now - task.updatedAt) > maxAgeMs) {
        this.tasks.delete(id);
        evicted++;
      }
    }
    return evicted;
  }
}
