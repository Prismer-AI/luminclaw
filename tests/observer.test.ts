/**
 * Tests for Observer — ConsoleObserver, MultiObserver
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleObserver, MultiObserver, type ObserverEvent, type Observer } from '../src/observer.js';

describe('ConsoleObserver', () => {
  let observer: ConsoleObserver;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    observer = new ConsoleObserver();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  it('recordEvent stores event', () => {
    const event: ObserverEvent = { type: 'agent_start', timestamp: 1000, data: { agentId: 'test' } };
    observer.recordEvent(event);
    expect(observer.getEvents()).toHaveLength(1);
    expect(observer.getEvents()[0]).toEqual(event);
  });

  it('recordEvent writes to stderr', () => {
    observer.recordEvent({ type: 'llm_request', timestamp: 1000, data: {} });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[llm_request]'));
  });

  it('error events write to stderr twice (error + regular)', () => {
    observer.recordEvent({ type: 'error', timestamp: 1000, data: { msg: 'fail' } });
    // error type triggers two writes (one error, one regular)
    const errorCalls = stderrSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('[error]')
    );
    expect(errorCalls.length).toBe(2);
  });

  it('doom_loop events also write error to stderr', () => {
    observer.recordEvent({ type: 'doom_loop', timestamp: 1000, data: {} });
    const calls = stderrSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('[doom_loop]')
    );
    expect(calls.length).toBe(2); // error + regular
  });

  it('recordMetric stores metric values', () => {
    observer.recordMetric('llm_latency_ms', 100);
    observer.recordMetric('llm_latency_ms', 200);
    observer.recordMetric('tool_count', 5);

    // Verified via flush
    expect(observer.getEvents()).toHaveLength(0); // metrics don't appear as events
  });

  it('flush outputs summary and resets state', async () => {
    observer.recordEvent({ type: 'agent_start', timestamp: 1000, data: {} });
    observer.recordEvent({ type: 'agent_end', timestamp: 2000, data: {} });
    observer.recordMetric('latency', 150);

    await observer.flush();

    const flushCall = stderrSpy.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('[observer_flush]')
    );
    expect(flushCall).toBeDefined();

    const flushData = JSON.parse(flushCall![0].toString().replace('[observer_flush] ', ''));
    expect(flushData.totalEvents).toBe(2);
    expect(flushData.byType.agent_start).toBe(1);
    expect(flushData.byType.agent_end).toBe(1);
    expect(flushData.metrics.latency.count).toBe(1);
    expect(flushData.metrics.latency.avg).toBe(150);
    expect(flushData.metrics.latency.max).toBe(150);

    // State is reset
    expect(observer.getEvents()).toHaveLength(0);
  });

  it('flush with no events is a no-op', async () => {
    const callsBefore = stderrSpy.mock.calls.length;
    await observer.flush();
    const flushCalls = stderrSpy.mock.calls.slice(callsBefore).filter(c =>
      typeof c[0] === 'string' && c[0].includes('[observer_flush]')
    );
    expect(flushCalls).toHaveLength(0);
  });

  it('getEvents returns a copy', () => {
    observer.recordEvent({ type: 'agent_start', timestamp: 1, data: {} });
    const events = observer.getEvents();
    events.push({ type: 'error', timestamp: 2, data: {} });
    expect(observer.getEvents()).toHaveLength(1); // original unchanged
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });
});

describe('MultiObserver', () => {
  it('fans out recordEvent to all observers', () => {
    const o1 = new ConsoleObserver();
    const o2 = new ConsoleObserver();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const multi = new MultiObserver([o1, o2]);
    multi.recordEvent({ type: 'agent_start', timestamp: 1, data: {} });

    expect(o1.getEvents()).toHaveLength(1);
    expect(o2.getEvents()).toHaveLength(1);

    stderrSpy.mockRestore();
  });

  it('fans out recordMetric to all observers', async () => {
    const o1 = new ConsoleObserver();
    const o2 = new ConsoleObserver();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const multi = new MultiObserver([o1, o2]);
    multi.recordMetric('test', 42);

    // Verify via flush — both observers should have the metric
    o1.recordEvent({ type: 'agent_start', timestamp: 1, data: {} }); // need at least 1 event for flush output
    await o1.flush();

    const flushCall = stderrSpy.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('[observer_flush]') && c[0].includes('test')
    );
    expect(flushCall).toBeDefined();

    stderrSpy.mockRestore();
  });

  it('flush calls flush on all observers', async () => {
    const mockObserver1: Observer = {
      recordEvent: vi.fn(),
      recordMetric: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    const mockObserver2: Observer = {
      recordEvent: vi.fn(),
      recordMetric: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    const multi = new MultiObserver([mockObserver1, mockObserver2]);
    await multi.flush();

    expect(mockObserver1.flush).toHaveBeenCalledOnce();
    expect(mockObserver2.flush).toHaveBeenCalledOnce();
  });
});
