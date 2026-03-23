/**
 * SSE EventBus — schema-driven event publishing with backpressure.
 *
 * The {@link EventBus} is the central pub-sub hub for all real-time
 * events (agent lifecycle, text deltas, tool execution, directives,
 * approvals). Events are Zod-validated via {@link AgentEventSchema}.
 *
 * {@link StdoutSSEWriter} bridges the bus to stdout in SSE format
 * for IPC streaming in subprocess mode.
 *
 * @module sse
 */

import { z } from 'zod';

// ── Event Schemas ────────────────────────────────────────

/** Zod discriminated union of all agent event types. */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent.start'),
    data: z.object({ sessionId: z.string(), agentId: z.string() }),
  }),
  z.object({
    type: z.literal('agent.end'),
    data: z.object({ sessionId: z.string(), toolsUsed: z.array(z.string()) }),
  }),
  z.object({
    type: z.literal('text.delta'),
    data: z.object({ sessionId: z.string(), delta: z.string() }),
  }),
  z.object({
    type: z.literal('tool.start'),
    data: z.object({ sessionId: z.string(), tool: z.string(), toolId: z.string().optional(), args: z.record(z.unknown()).optional() }),
  }),
  z.object({
    type: z.literal('tool.end'),
    data: z.object({
      sessionId: z.string(),
      tool: z.string(),
      toolId: z.string().optional(),
      result: z.string(),
    }),
  }),
  z.object({
    type: z.literal('directive'),
    data: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal('subagent.start'),
    data: z.object({ parentAgent: z.string(), subAgent: z.string() }),
  }),
  z.object({
    type: z.literal('subagent.end'),
    data: z.object({ parentAgent: z.string(), subAgent: z.string() }),
  }),
  z.object({
    type: z.literal('compaction'),
    data: z.object({ summary: z.string(), droppedCount: z.number() }),
  }),
  z.object({
    type: z.literal('error'),
    data: z.object({ message: z.string() }),
  }),
  z.object({
    type: z.literal('heartbeat'),
    data: z.object({ timestamp: z.number() }),
  }),
  z.object({
    type: z.literal('tool.approval_required'),
    data: z.object({
      sessionId: z.string(),
      tool: z.string(),
      toolId: z.string(),
      args: z.record(z.unknown()),
      reason: z.string(),
    }),
  }),
  z.object({
    type: z.literal('tool.approval_response'),
    data: z.object({
      toolId: z.string(),
      approved: z.boolean(),
      reason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('chat.cancelled'),
    data: z.object({
      sessionId: z.string(),
    }),
  }),
  z.object({
    type: z.literal('chat.final'),
    data: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal('task.completed'),
    data: z.record(z.unknown()),
  }),
]);

/** A single agent event (inferred from {@link AgentEventSchema}). */
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// ── EventBus ─────────────────────────────────────────────

/** Callback invoked for each published event. */
export type EventHandler = (event: AgentEvent) => void;

/**
 * In-memory pub-sub event bus with bounded buffer and backpressure.
 *
 * When the buffer exceeds `maxBuffer`, oldest events are dropped
 * and {@link getStats} reports the `droppedCount`.
 */
export class EventBus {
  private handlers = new Set<EventHandler>();
  private buffer: AgentEvent[] = [];
  private maxBuffer: number;
  private highWaterMark: number;
  private _droppedCount = 0;
  private _highWaterReached = false;

  constructor(maxBuffer: number = 1000) {
    this.maxBuffer = maxBuffer;
    this.highWaterMark = Math.floor(maxBuffer * 0.8);
  }

  /** Subscribe to events */
  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Publish an event to all subscribers */
  publish(event: AgentEvent): void {
    // Buffer for late subscribers or replay
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
      this._droppedCount++;
    }

    // High-water mark warning (once per overflow cycle)
    if (!this._highWaterReached && this.buffer.length >= this.highWaterMark) {
      this._highWaterReached = true;
      // Notify handlers directly (don't recurse into buffer)
      const warning: AgentEvent = {
        type: 'error',
        data: { message: `[backpressure] Event buffer at ${this.buffer.length}/${this.maxBuffer}` },
      };
      for (const handler of this.handlers) {
        try { handler(warning); } catch { /* */ }
      }
    }
    if (this.buffer.length < this.highWaterMark) {
      this._highWaterReached = false;
    }

    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Don't let subscriber errors break the bus
      }
    }
  }

  /** Get buffered events (for late-joining clients) */
  getBuffer(): AgentEvent[] {
    return [...this.buffer];
  }

  /** Clear buffer */
  clearBuffer(): void {
    this.buffer = [];
    this._highWaterReached = false;
  }

  /** Number of active subscribers */
  get subscriberCount(): number {
    return this.handlers.size;
  }

  /** Backpressure stats */
  getStats(): { bufferSize: number; maxBuffer: number; droppedCount: number; highWaterMark: number } {
    return {
      bufferSize: this.buffer.length,
      maxBuffer: this.maxBuffer,
      droppedCount: this._droppedCount,
      highWaterMark: this.highWaterMark,
    };
  }
}

// ── Stdout SSE Writer ────────────────────────────────────

/**
 * Writes events to stdout in SSE format for IPC streaming.
 * Used when the agent runs as a subprocess and the host reads stdout.
 */
export class StdoutSSEWriter {
  private bus: EventBus;
  private unsubscribe: (() => void) | null = null;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  start(): void {
    this.unsubscribe = this.bus.subscribe((event) => {
      // Write SSE-formatted event to stdout
      const line = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      process.stdout.write(line);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
