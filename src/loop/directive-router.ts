/**
 * DirectiveRouter — classifies and routes directives by delivery mode.
 *
 * - `realtime`: forwarded immediately to WebSocket/SSE (UI updates)
 * - `checkpoint`: buffered until the next checkpoint event (batched)
 * - `hil-only`: consumed by HIL, not forwarded to frontend
 *
 * @module loop/directive-router
 */

import type { EventBus } from '../sse.js';

// ── Types ─────────────────────────────────────────────────

export type DirectiveDelivery = 'realtime' | 'checkpoint' | 'hil-only';

export interface RoutedDirective {
  delivery: DirectiveDelivery;
  directive: ExtendedDirective;
}

/** Directive with optional dual-loop attribution fields. */
export interface ExtendedDirective {
  type: string;
  payload: Record<string, unknown>;
  timestamp?: string;
  /** Agent that emitted this directive. */
  emittedBy?: string;
  /** Associated task ID. */
  taskId?: string;
  /** Who triggered the state change. */
  source?: 'agent' | 'human';
  /** Monotonic counter for LWW conflict resolution. */
  stateVersion?: number;
}

// ── Delivery Table ────────────────────────────────────────

const DELIVERY_TABLE: Record<string, DirectiveDelivery> = {
  // Realtime — immediate WS forward
  SWITCH_COMPONENT: 'realtime',
  TIMELINE_EVENT: 'realtime',
  THINKING_UPDATE: 'realtime',
  OPERATION_STATUS: 'realtime',
  UPDATE_CONTENT: 'realtime',
  UPDATE_LATEX: 'realtime',
  UPDATE_CODE: 'realtime',
  UPDATE_DATA_GRID: 'realtime',
  UPDATE_GALLERY: 'realtime',
  JUPYTER_ADD_CELL: 'realtime',
  JUPYTER_CELL_OUTPUT: 'realtime',
  EXTENSION_UPDATE: 'realtime',
  AGENT_CURSOR: 'realtime',
  HUMAN_CURSOR: 'realtime',

  // Checkpoint — buffered with next checkpoint event
  COMPILE_COMPLETE: 'checkpoint',
  NOTIFICATION: 'checkpoint',
  COMPONENT_STATE_SYNC: 'checkpoint',

  // HIL-only — consumed by HIL, not forwarded to frontend
  TASK_UPDATE: 'hil-only',
  UPDATE_TASKS: 'hil-only',
  ACTION_REQUEST: 'hil-only',
  REQUEST_CONFIRMATION: 'hil-only',
};

// ── Router ────────────────────────────────────────────────

export class DirectiveRouter {
  private checkpointBuffer: ExtendedDirective[] = [];
  private bus: EventBus | null;

  constructor(bus?: EventBus) {
    this.bus = bus ?? null;
  }

  /** Classify and route a directive. Returns the routing decision. */
  route(directive: ExtendedDirective): RoutedDirective {
    const delivery = DELIVERY_TABLE[directive.type] ?? 'realtime';
    const routed: RoutedDirective = { delivery, directive };

    switch (delivery) {
      case 'realtime':
        if (this.bus) {
          this.bus.publish({ type: 'directive', data: directive as unknown as Record<string, unknown> });
        }
        break;

      case 'checkpoint':
        this.checkpointBuffer.push(directive);
        break;

      case 'hil-only':
        // Not forwarded — caller (HIL) handles directly
        break;
    }

    return routed;
  }

  /** Drain and return all buffered checkpoint directives. */
  drainCheckpointBuffer(): ExtendedDirective[] {
    const buf = this.checkpointBuffer;
    this.checkpointBuffer = [];
    return buf;
  }

  /** Peek at buffered checkpoint count without draining. */
  get checkpointBufferSize(): number {
    return this.checkpointBuffer.length;
  }

  /** Clear the checkpoint buffer without returning contents. */
  clearCheckpointBuffer(): void {
    this.checkpointBuffer = [];
  }
}
