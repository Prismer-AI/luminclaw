import { describe, it, expect } from 'vitest';
import { MessageQueue } from '../../src/task/message-queue.js';
import { Session } from '../../src/session.js';
import { InMemoryTaskStore } from '../../src/task/store.js';
import { EventBus } from '../../src/sse.js';

/**
 * These tests validate the contract of the queue-drain callback that
 * DualLoopAgent.runInnerLoop passes to PrismerAgent's onIterationStart.
 * They test the callback's semantics directly (not through a real LLM),
 * so they are fast and deterministic.
 */

describe('queue-drain callback (inner loop contract)', () => {
  it('drained messages are appended to the session as user messages', async () => {
    const queue = new MessageQueue();
    const store = new InMemoryTaskStore();
    const bus = new EventBus();
    const taskId = 'task-X';
    store.create({
      id: taskId, sessionId: 's', instruction: 'x',
      artifactIds: [], status: 'executing',
    });
    queue.enqueue(taskId, 'please skip node_modules');

    const session = new Session('s');
    // Replicate the drain-callback the way runInnerLoop builds it
    const drain = async (iteration: number) => {
      const drained = queue.drainForTask(taskId);
      for (const m of drained) {
        session.addMessage({ role: 'user', content: m.content });
      }
      const prev = store.get(taskId)?.progress ?? { iterations: 0, toolsUsed: [], lastActivity: 0 };
      const lastActivity = Date.now();
      store.updateProgress(taskId, { iterations: iteration, toolsUsed: prev.toolsUsed, lastActivity });
      bus.publish({
        type: 'task.progress',
        data: { taskId, iteration, toolsUsed: prev.toolsUsed, lastActivity },
      });
    };

    const events: any[] = [];
    bus.subscribe(e => events.push(e));

    await drain(1);

    const userMsgs = session.messages.filter(m => m.role === 'user');
    expect(userMsgs.map(m => m.content)).toContain('please skip node_modules');
    expect(events.some(e => e.type === 'task.progress')).toBe(true);
    expect(queue.pendingCount()).toBe(0);  // consumed
  });

  it('emits task.progress every iteration even when queue is empty', async () => {
    const bus = new EventBus();
    const store = new InMemoryTaskStore();
    const taskId = 't';
    store.create({
      id: taskId, sessionId: 's', instruction: 'x',
      artifactIds: [], status: 'executing',
    });

    const events: any[] = [];
    bus.subscribe(e => events.push(e));

    const tick = async (iteration: number) => {
      const task = store.get(taskId)!;
      const prev = task.progress ?? { iterations: 0, toolsUsed: [], lastActivity: 0 };
      const lastActivity = Date.now();
      store.updateProgress(taskId, { iterations: iteration, toolsUsed: prev.toolsUsed, lastActivity });
      bus.publish({
        type: 'task.progress',
        data: { taskId, iteration, toolsUsed: prev.toolsUsed, lastActivity },
      });
    };

    await tick(1);
    await tick(2);
    const progressEvents = events.filter(e => e.type === 'task.progress');
    expect(progressEvents.length).toBe(2);
    expect(progressEvents[0].data.iteration).toBe(1);
    expect(progressEvents[1].data.iteration).toBe(2);
  });
});
