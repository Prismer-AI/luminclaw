/**
 * Observer — observability interface for agent lifecycle events and metrics.
 *
 * The {@link Observer} interface is the pluggable sink for all agent
 * lifecycle events (start, end, tool calls, errors, doom-loop) and
 * numeric metrics (LLM latency, tool count).
 *
 * {@link ConsoleObserver} writes structured JSON to stderr.
 * {@link MultiObserver} fans out to multiple backends.
 *
 * @module observer
 */

// ── Types ────────────────────────────────────────────────

export type EventType =
  | 'agent_start'
  | 'agent_end'
  | 'subagent_start'
  | 'subagent_end'
  | 'llm_request'
  | 'llm_response'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'directive_emit'
  | 'doom_loop'
  | 'compaction'
  | 'error';

export interface ObserverEvent {
  type: EventType;
  timestamp: number;
  data: Record<string, unknown>;
}

// ── Interface ────────────────────────────────────────────

export interface Observer {
  recordEvent(event: ObserverEvent): void;
  recordMetric(name: string, value: number): void;
  flush(): Promise<void>;
}

// ── Console Observer (default) ───────────────────────────

export class ConsoleObserver implements Observer {
  private events: ObserverEvent[] = [];
  private metrics = new Map<string, number[]>();

  recordEvent(event: ObserverEvent): void {
    this.events.push(event);

    const level = event.type === 'error' || event.type === 'doom_loop' ? 'error' : 'info';
    const prefix = `[${event.type}]`;

    if (level === 'error') {
      process.stderr.write(`${prefix} ${JSON.stringify(event.data)}\n`);
    }
    // Structured events go to stderr (stdout reserved for IPC)
    process.stderr.write(`${prefix} ${JSON.stringify(event.data)}\n`);
  }

  recordMetric(name: string, value: number): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)!.push(value);
  }

  async flush(): Promise<void> {
    // Dump summary to stderr
    if (this.events.length > 0) {
      const summary = {
        totalEvents: this.events.length,
        byType: {} as Record<string, number>,
        metrics: {} as Record<string, { count: number; avg: number; max: number }>,
      };

      for (const e of this.events) {
        summary.byType[e.type] = (summary.byType[e.type] ?? 0) + 1;
      }

      for (const [name, values] of this.metrics) {
        summary.metrics[name] = {
          count: values.length,
          avg: values.reduce((a, b) => a + b, 0) / values.length,
          max: Math.max(...values),
        };
      }

      process.stderr.write(`[observer_flush] ${JSON.stringify(summary)}\n`);
    }

    this.events = [];
    this.metrics.clear();
  }

  getEvents(): ObserverEvent[] {
    return [...this.events];
  }
}

// ── Multi Observer (fan-out) ─────────────────────────────

export class MultiObserver implements Observer {
  constructor(private observers: Observer[]) {}

  recordEvent(event: ObserverEvent): void {
    for (const o of this.observers) {
      o.recordEvent(event);
    }
  }

  recordMetric(name: string, value: number): void {
    for (const o of this.observers) {
      o.recordMetric(name, value);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.observers.map(o => o.flush()));
  }
}
