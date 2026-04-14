import { describe, it, expect, vi, afterEach } from 'vitest';
import { DualLoopAgent } from '../../src/loop/dual.js';

describe('Phase E — TTL eviction', () => {
  afterEach(() => {
    // Ensure fake timers are always restored, even on test failure.
    vi.useRealTimers();
  });

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
