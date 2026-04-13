/**
 * Process-scoped FIFO message queue keyed by target taskId.
 *
 * Owned by DualLoopAgent. The outer dialogue loop enqueues user messages
 * via {@link MessageQueue.enqueue}; the inner execution loop drains them at
 * iteration boundaries via {@link MessageQueue.drainForTask}.
 *
 * This is the single architectural primitive that decouples dialogue latency
 * from task execution duration — see `docs/superpowers/plans/2026-04-13-dual-loop-architecture-design.md`
 * Pattern 1.
 *
 * @module task/message-queue
 */

import { randomUUID } from 'node:crypto';

export interface QueuedMessage {
  id: string;
  targetTaskId: string;
  content: string;
  enqueuedAt: number;
}

export class MessageQueue {
  private messages: QueuedMessage[] = [];

  /** Append a message targeting a specific task. Returns the enqueued record. */
  enqueue(targetTaskId: string, content: string): QueuedMessage {
    const msg: QueuedMessage = {
      id: randomUUID(),
      targetTaskId,
      content,
      enqueuedAt: Date.now(),
    };
    this.messages.push(msg);
    return msg;
  }

  /**
   * Remove and return all messages for a target task, in enqueue order.
   * Idempotent on empty state: returns [].
   */
  drainForTask(targetTaskId: string): QueuedMessage[] {
    const drained: QueuedMessage[] = [];
    const remaining: QueuedMessage[] = [];
    for (const m of this.messages) {
      if (m.targetTaskId === targetTaskId) drained.push(m);
      else remaining.push(m);
    }
    this.messages = remaining;
    return drained;
  }

  /** Total un-drained messages across all targets. */
  pendingCount(): number {
    return this.messages.length;
  }

  /** Wipe all messages. For tests and teardown. */
  clear(): void {
    this.messages = [];
  }
}
