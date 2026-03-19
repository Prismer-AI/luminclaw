/**
 * Agent loop abstraction types.
 *
 * {@link IAgentLoop} is the single interface over all execution architectures:
 * - `single` — current Lumin default (LLM → tools → response in one request)
 * - `dual`   — async Devin-style (HIL outer loop + EL inner loop, Phase 4)
 *
 * Phase 0: only types are defined here. No behavior change.
 *
 * @module loop/types
 */

import type { EventBus } from '../sse.js';
import type { Artifact as ArtifactType, ArtifactInput, ArtifactStore } from '../artifacts/types.js';

// ── Mode ─────────────────────────────────────────────────

export type LoopMode = 'single' | 'dual';

// ── Artifact ─────────────────────────────────────────────

// Re-export the full Artifact type from artifacts module (Phase 1a).
export type { ArtifactInput, ArtifactStore };
export type Artifact = ArtifactType;

// ── Input / Output ────────────────────────────────────────

export interface AgentLoopInput {
  content: string;
  sessionId?: string;
  images?: Array<{ url: string; path?: string; mimeType?: string }>;
  config?: Record<string, string | number | string[] | undefined>;
}

/** Structural directive type — avoids Zod v4 enum inference inconsistency. */
export interface DirectiveRecord {
  type: string;
  payload: Record<string, unknown>;
  timestamp?: string;
}

export interface AgentLoopResult {
  text: string;
  thinking?: string;
  directives: DirectiveRecord[];
  toolsUsed: string[];
  usage?: { promptTokens?: number; completionTokens?: number };
  iterations: number;
  /** Resolved session ID (generated if not provided in input). */
  sessionId: string;
}

export interface AgentLoopCallOpts {
  /**
   * EventBus for real-time streaming events.
   * Required when the caller needs to forward events over WebSocket or SSE.
   * If omitted, a private bus is created and discarded after the call.
   */
  bus?: EventBus;
}

// ── Interface ─────────────────────────────────────────────

/**
 * Common contract for all agent execution architectures.
 *
 * **Single-loop** (`mode === 'single'`): `processMessage` resolves when the
 * agent finishes and the full response is available. Semantically identical
 * to the existing `runAgent()` call.
 *
 * **Dual-loop** (`mode === 'dual'`): `processMessage` resolves once the task
 * is enqueued (fast, < 100 ms). The actual result arrives later via SSE
 * `task.checkpoint` / `task.completed` events. Callers must not assume the
 * Promise resolving means the task is done.
 */
export interface IAgentLoop {
  readonly mode: LoopMode;

  processMessage(input: AgentLoopInput, opts?: AgentLoopCallOpts): Promise<AgentLoopResult>;

  /**
   * Add a user-supplied artifact to the active task's ArtifactStore.
   *
   * Single-loop (Phase 0): no-op — there is no ArtifactStore yet.
   * Dual-loop (Phase 1a+): stores the artifact; it becomes available to the
   * inner loop at the next planning step without interrupting execution.
   */
  addArtifact(artifact: Artifact): void;

  /**
   * Resume the inner loop after an `ACTION_REQUEST` / clarification pause.
   * Single-loop: no-op.
   * Dual-loop: injects the clarification string as a user message and resumes.
   */
  resume(clarification: string): void;

  /**
   * Cancel the active task.
   * Single-loop: no-op.
   * Dual-loop: sets a cancellation flag checked at the next tool boundary.
   */
  cancel(): void;

  /** Graceful shutdown — wait for in-flight work to settle. */
  shutdown(): Promise<void>;
}
