/**
 * StreamingToolExecutor — starts tool execution while the LLM stream is
 * still in progress, as soon as complete tool_use blocks are parsed.
 *
 * ## Integration with agent.ts
 *
 * To integrate with the agent loop, replace the post-stream tool execution
 * with something like:
 *
 * ```typescript
 * const executor = new StreamingToolExecutor(async (call) => {
 *   const { output, error } = await tools.execute(call.name, call.arguments, ctx);
 *   return { id: call.id, output: error ? `Error: ${error}` : output, error: !!error };
 * });
 *
 * const response = await provider.chatStream(request, onDelta, (toolCall) => {
 *   const tool = tools.get(toolCall.name);
 *   const safe = tool?.isConcurrencySafe?.(toolCall.arguments) ?? false;
 *   executor.addTool(toolCall, safe);
 * });
 *
 * // Drain remaining results in order
 * for await (const result of executor.drain()) {
 *   session.addToolResult(result);
 * }
 * ```
 *
 * This interleaves API streaming with tool execution for lower latency,
 * while preserving result ordering for the conversation history.
 *
 * @module streaming-executor
 */

import { createLogger } from './log.js';

const log = createLogger('streaming-executor');

// ── Types ───────────────────────────────────────────────

/** Lifecycle status of a tracked tool. */
export type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded';

/** A parsed tool call ready for execution. */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The result of executing a single tool. */
export interface ToolResult {
  id: string;
  output: string;
  error: boolean;
}

/** Internal tracking entry for a tool in the executor pipeline. */
export interface TrackedTool {
  id: string;
  call: ToolCallInfo;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  result?: ToolResult;
  promise?: Promise<void>;
}

/** Function signature for executing a tool call and returning a result. */
export type ExecuteFn = (call: ToolCallInfo) => Promise<ToolResult>;

// ── StreamingToolExecutor ───────────────────────────────

/**
 * State machine that manages tool execution from queued through completed.
 *
 * Tools are added as soon as their tool_use blocks are fully parsed from the
 * LLM stream. Concurrency-safe tools execute in parallel; non-safe tools
 * execute serially and block subsequent tools until complete.
 *
 * Results are always yielded in the original order, regardless of completion
 * order, to preserve conversation history correctness.
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private readonly executeFn: ExecuteFn;

  constructor(executeFn: ExecuteFn) {
    this.executeFn = executeFn;
  }

  /**
   * Add a tool as soon as its tool_use block is fully parsed.
   * Immediately attempts to schedule execution if possible.
   */
  addTool(call: ToolCallInfo, isConcurrencySafe: boolean): void {
    const tool: TrackedTool = {
      id: call.id,
      call,
      status: 'queued',
      isConcurrencySafe,
    };
    this.tools.push(tool);
    log.debug('tool added', { id: call.id, name: call.name, safe: isConcurrencySafe });
    this.processQueue();
  }

  /**
   * Non-blocking: check if any queued tools can start executing.
   * Called after addTool and after a tool completes (cascade).
   */
  private processQueue(): void {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue;
      if (this.canExecute(tool)) {
        tool.status = 'executing';
        log.debug('tool executing', { id: tool.id, name: tool.call.name });
        tool.promise = this.executeFn(tool.call).then(result => {
          tool.result = result;
          tool.status = 'completed';
          log.debug('tool completed', { id: tool.id, name: tool.call.name });
          this.processQueue(); // Cascade: check if next tool can now run
        });
      } else if (!tool.isConcurrencySafe) {
        // A non-safe queued tool blocks everything behind it
        break;
      }
    }
  }

  /**
   * Determine whether a queued tool can begin execution now.
   *
   * Rules:
   * - If nothing is executing, any tool can start.
   * - A concurrency-safe tool can start if all currently executing tools are also safe.
   * - A non-safe tool can only start if nothing is executing.
   */
  private canExecute(tool: TrackedTool): boolean {
    const executing = this.tools.filter(t => t.status === 'executing');
    if (executing.length === 0) return true;
    return tool.isConcurrencySafe && executing.every(t => t.isConcurrencySafe);
  }

  /**
   * Get completed results in order (non-blocking poll).
   *
   * Returns results from the front of the queue up to the first
   * non-completed tool. This preserves ordering: even if tool #3
   * completes before tool #2, tool #3's result won't be returned
   * until tool #2's has been yielded.
   */
  getCompletedResults(): ToolResult[] {
    const results: ToolResult[] = [];
    for (const tool of this.tools) {
      if (tool.status === 'completed' && tool.result) {
        tool.status = 'yielded';
        results.push(tool.result);
      } else if (tool.status !== 'yielded') {
        break; // Preserve order — stop at first non-completed
      }
    }
    return results;
  }

  /**
   * Async drain: wait for all tools to complete and yield results in order.
   *
   * Use this after the LLM stream has finished to collect all remaining
   * tool results. Results are yielded as soon as they are available
   * (in order), so the caller can start building the next prompt
   * incrementally.
   */
  async *drain(): AsyncGenerator<ToolResult> {
    while (this.tools.some(t => t.status !== 'yielded')) {
      // Yield any completed results at the front of the queue
      for (const r of this.getCompletedResults()) {
        yield r;
      }

      // If there are still non-yielded tools, wait for the next completion
      const executing = this.tools.filter(t => t.status === 'executing' && t.promise);
      if (executing.length > 0) {
        await Promise.race(executing.map(t => t.promise!));
      }

      // Re-trigger scheduling in case completions freed up the queue
      this.processQueue();
    }

    // Final drain: pick up anything that completed in the last iteration
    for (const r of this.getCompletedResults()) {
      yield r;
    }
  }

  /** True if any tools have not yet been yielded. */
  get hasPendingTools(): boolean {
    return this.tools.some(t => t.status !== 'yielded');
  }

  /** Number of tools currently tracked. */
  get totalTools(): number {
    return this.tools.length;
  }

  /** Snapshot of current tool statuses (for debugging / observability). */
  get snapshot(): Array<{ id: string; name: string; status: ToolStatus }> {
    return this.tools.map(t => ({ id: t.id, name: t.call.name, status: t.status }));
  }
}
