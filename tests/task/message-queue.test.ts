import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from '../../src/task/message-queue.js';

describe('MessageQueue', () => {
  let q: MessageQueue;
  beforeEach(() => { q = new MessageQueue(); });

  it('enqueue returns a queued message with id + timestamp', () => {
    const m = q.enqueue('task-1', 'hello');
    expect(m.id).toMatch(/^[0-9a-f-]+$/);  // uuid-like
    expect(m.targetTaskId).toBe('task-1');
    expect(m.content).toBe('hello');
    expect(m.enqueuedAt).toBeGreaterThan(0);
  });

  it('drainForTask returns messages in FIFO order for the matching taskId', () => {
    q.enqueue('task-1', 'first');
    q.enqueue('task-2', 'unrelated');
    q.enqueue('task-1', 'second');
    const drained = q.drainForTask('task-1');
    expect(drained.map(m => m.content)).toEqual(['first', 'second']);
  });

  it('drainForTask leaves other tasks\' messages untouched', () => {
    q.enqueue('task-1', 'a');
    q.enqueue('task-2', 'b');
    q.drainForTask('task-1');
    const remaining = q.drainForTask('task-2');
    expect(remaining.map(m => m.content)).toEqual(['b']);
  });

  it('drainForTask returns [] when no messages for taskId', () => {
    q.enqueue('task-1', 'hi');
    expect(q.drainForTask('task-2')).toEqual([]);
  });

  it('drained messages are removed (second drain returns empty)', () => {
    q.enqueue('task-1', 'hi');
    q.drainForTask('task-1');
    expect(q.drainForTask('task-1')).toEqual([]);
  });

  it('pendingCount reflects un-drained messages', () => {
    expect(q.pendingCount()).toBe(0);
    q.enqueue('task-1', 'a');
    q.enqueue('task-2', 'b');
    expect(q.pendingCount()).toBe(2);
    q.drainForTask('task-1');
    expect(q.pendingCount()).toBe(1);
  });

  it('clear() wipes all messages', () => {
    q.enqueue('task-1', 'a');
    q.enqueue('task-2', 'b');
    q.clear();
    expect(q.pendingCount()).toBe(0);
  });
});
