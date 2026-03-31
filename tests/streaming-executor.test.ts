/**
 * Tests for StreamingToolExecutor — state machine, concurrency, ordering.
 */

import { describe, it, expect, vi } from 'vitest';
import { StreamingToolExecutor, type ToolCallInfo, type ToolResult } from '../src/streaming-executor.js';

/** Helper: create a tool call with the given id and name */
function makeCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCallInfo {
  return { id, name, arguments: args };
}

/** Helper: create a delayed executor that resolves after `ms` milliseconds */
function delayedExecutor(ms: number, resultFn?: (call: ToolCallInfo) => string) {
  return async (call: ToolCallInfo): Promise<ToolResult> => {
    await new Promise(r => setTimeout(r, ms));
    return {
      id: call.id,
      output: resultFn ? resultFn(call) : `result-${call.id}`,
      error: false,
    };
  };
}

/** Helper: collect all results from drain */
async function collectDrain(executor: StreamingToolExecutor): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for await (const r of executor.drain()) {
    results.push(r);
  }
  return results;
}

describe('StreamingToolExecutor', () => {
  it('addTool + drain returns results in order', async () => {
    const executor = new StreamingToolExecutor(async (call) => ({
      id: call.id,
      output: `done-${call.name}`,
      error: false,
    }));

    executor.addTool(makeCall('t1', 'read_file'), true);
    executor.addTool(makeCall('t2', 'search'), true);
    executor.addTool(makeCall('t3', 'list_dir'), true);

    const results = await collectDrain(executor);

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe('t1');
    expect(results[1].id).toBe('t2');
    expect(results[2].id).toBe('t3');
    expect(results[0].output).toBe('done-read_file');
  });

  it('concurrent-safe tools execute in parallel', async () => {
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    const executor = new StreamingToolExecutor(async (call) => {
      startTimes[call.id] = Date.now();
      await new Promise(r => setTimeout(r, 50));
      endTimes[call.id] = Date.now();
      return { id: call.id, output: 'ok', error: false };
    });

    executor.addTool(makeCall('a', 'read'), true);
    executor.addTool(makeCall('b', 'read'), true);
    executor.addTool(makeCall('c', 'read'), true);

    await collectDrain(executor);

    // All three should have started before any finished (parallel)
    // Allow 30ms overlap tolerance
    const maxStart = Math.max(startTimes['a'], startTimes['b'], startTimes['c']);
    const minEnd = Math.min(endTimes['a'], endTimes['b'], endTimes['c']);
    expect(maxStart).toBeLessThan(minEnd + 10); // Started while others still running
  });

  it('non-safe (write) tools execute serially', async () => {
    const executionOrder: string[] = [];

    const executor = new StreamingToolExecutor(async (call) => {
      executionOrder.push(`start-${call.id}`);
      await new Promise(r => setTimeout(r, 20));
      executionOrder.push(`end-${call.id}`);
      return { id: call.id, output: 'ok', error: false };
    });

    executor.addTool(makeCall('w1', 'write_file'), false);
    executor.addTool(makeCall('w2', 'write_file'), false);

    await collectDrain(executor);

    // w1 must fully complete before w2 starts
    expect(executionOrder).toEqual([
      'start-w1', 'end-w1',
      'start-w2', 'end-w2',
    ]);
  });

  it('mixed read/write batching: reads run in parallel, then write blocks', async () => {
    const executionOrder: string[] = [];

    const executor = new StreamingToolExecutor(async (call) => {
      executionOrder.push(`start-${call.id}`);
      await new Promise(r => setTimeout(r, 30));
      executionOrder.push(`end-${call.id}`);
      return { id: call.id, output: 'ok', error: false };
    });

    // Two reads, then a write, then a read
    executor.addTool(makeCall('r1', 'read'), true);
    executor.addTool(makeCall('r2', 'read'), true);
    executor.addTool(makeCall('w1', 'write'), false);
    executor.addTool(makeCall('r3', 'read'), true);

    await collectDrain(executor);

    // r1 and r2 should start before either ends (parallel)
    const r1Start = executionOrder.indexOf('start-r1');
    const r2Start = executionOrder.indexOf('start-r2');
    const r1End = executionOrder.indexOf('end-r1');
    const r2End = executionOrder.indexOf('end-r2');
    const w1Start = executionOrder.indexOf('start-w1');
    const r3Start = executionOrder.indexOf('start-r3');

    expect(r1Start).toBeLessThan(r1End);
    expect(r2Start).toBeLessThan(r2End);
    // Both reads start before either ends (parallel)
    expect(r2Start).toBeLessThan(r1End);
    // Write starts after both reads are done
    expect(w1Start).toBeGreaterThan(r1End);
    expect(w1Start).toBeGreaterThan(r2End);
    // r3 starts after write is done
    expect(r3Start).toBeGreaterThan(executionOrder.indexOf('end-w1'));
  });

  it('getCompletedResults preserves order even when later tool finishes first', async () => {
    let resolveFirst: () => void;
    const firstBlock = new Promise<void>(r => { resolveFirst = r; });

    const executor = new StreamingToolExecutor(async (call) => {
      if (call.id === 't1') {
        await firstBlock; // t1 blocks until we manually resolve
      }
      // t2 completes immediately
      return { id: call.id, output: `done-${call.id}`, error: false };
    });

    executor.addTool(makeCall('t1', 'slow_read'), true);
    executor.addTool(makeCall('t2', 'fast_read'), true);

    // Wait a tick for t2 to complete
    await new Promise(r => setTimeout(r, 20));

    // t2 is done but t1 is not — getCompletedResults should return nothing
    const early = executor.getCompletedResults();
    expect(early).toHaveLength(0);

    // Now unblock t1
    resolveFirst!();

    const results = await collectDrain(executor);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('t1');
    expect(results[1].id).toBe('t2');
  });

  it('empty executor drain completes immediately', async () => {
    const executor = new StreamingToolExecutor(async (call) => ({
      id: call.id, output: '', error: false,
    }));

    const results = await collectDrain(executor);
    expect(results).toHaveLength(0);
    expect(executor.hasPendingTools).toBe(false);
  });

  it('hasPendingTools reflects correct state', async () => {
    const executor = new StreamingToolExecutor(async (call) => ({
      id: call.id, output: 'ok', error: false,
    }));

    expect(executor.hasPendingTools).toBe(false);

    executor.addTool(makeCall('t1', 'read'), true);
    expect(executor.hasPendingTools).toBe(true);

    await collectDrain(executor);
    expect(executor.hasPendingTools).toBe(false);
  });

  it('totalTools tracks added tools', () => {
    const executor = new StreamingToolExecutor(async (call) => ({
      id: call.id, output: '', error: false,
    }));

    expect(executor.totalTools).toBe(0);
    executor.addTool(makeCall('t1', 'a'), true);
    executor.addTool(makeCall('t2', 'b'), false);
    expect(executor.totalTools).toBe(2);
  });

  it('handles tool execution errors gracefully', async () => {
    const executor = new StreamingToolExecutor(async (call) => {
      if (call.name === 'fail') {
        return { id: call.id, output: 'Something went wrong', error: true };
      }
      return { id: call.id, output: 'ok', error: false };
    });

    executor.addTool(makeCall('t1', 'ok_tool'), true);
    executor.addTool(makeCall('t2', 'fail'), true);
    executor.addTool(makeCall('t3', 'ok_tool'), true);

    const results = await collectDrain(executor);
    expect(results).toHaveLength(3);
    expect(results[1].error).toBe(true);
    expect(results[1].output).toBe('Something went wrong');
    expect(results[0].error).toBe(false);
    expect(results[2].error).toBe(false);
  });

  it('snapshot returns current tool statuses', async () => {
    let resolve: () => void;
    const block = new Promise<void>(r => { resolve = r; });

    const executor = new StreamingToolExecutor(async (call) => {
      if (call.id === 't1') await block;
      return { id: call.id, output: 'ok', error: false };
    });

    executor.addTool(makeCall('t1', 'slow'), true);
    executor.addTool(makeCall('t2', 'fast'), true);

    // Wait for t2 to complete
    await new Promise(r => setTimeout(r, 10));

    const snap = executor.snapshot;
    expect(snap).toHaveLength(2);
    expect(snap[0].status).toBe('executing');
    expect(snap[1].status).toBe('completed');

    resolve!();
    await collectDrain(executor);
  });

  it('write tool followed by safe tools: safe tools wait for write', async () => {
    const executionOrder: string[] = [];

    const executor = new StreamingToolExecutor(async (call) => {
      executionOrder.push(`start-${call.id}`);
      await new Promise(r => setTimeout(r, 20));
      executionOrder.push(`end-${call.id}`);
      return { id: call.id, output: 'ok', error: false };
    });

    executor.addTool(makeCall('w1', 'write'), false);
    executor.addTool(makeCall('r1', 'read'), true);
    executor.addTool(makeCall('r2', 'read'), true);

    await collectDrain(executor);

    // write must finish before reads start
    const w1End = executionOrder.indexOf('end-w1');
    const r1Start = executionOrder.indexOf('start-r1');
    const r2Start = executionOrder.indexOf('start-r2');
    expect(r1Start).toBeGreaterThan(w1End);
    expect(r2Start).toBeGreaterThan(w1End);
  });
});
