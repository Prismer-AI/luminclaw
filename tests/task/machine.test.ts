import { describe, it, expect } from 'vitest';
import { TaskStateMachine } from '../../src/task/machine.js';
import type { Task } from '../../src/task/types.js';

describe('TaskStateMachine — interrupted transitions', () => {
  it('transitions from executing to interrupted', () => {
    const task: Task = { id: 't', sessionId: 's', instruction: 'x', artifactIds: [], status: 'executing', checkpoints: [], createdAt: 1, updatedAt: 1 };
    const machine = new TaskStateMachine();
    expect(() => machine.transition(task, 'interrupted')).not.toThrow();
    expect(task.status).toBe('interrupted');
  });

  it('transitions from interrupted back to executing (resume)', () => {
    const task: Task = { id: 't', sessionId: 's', instruction: 'x', artifactIds: [], status: 'interrupted', checkpoints: [], createdAt: 1, updatedAt: 1 };
    const machine = new TaskStateMachine();
    expect(() => machine.transition(task, 'executing')).not.toThrow();
    expect(task.status).toBe('executing');
  });
});
