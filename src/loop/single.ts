/**
 * SingleLoopAgent — IAgentLoop adapter for the existing single-loop runtime.
 *
 * Delegates every call to {@link runAgent} from `index.ts`. Zero behavior
 * change: this is a thin wrapper that makes the single-loop runtime
 * addressable via the {@link IAgentLoop} interface.
 *
 * `addArtifact`, `resume`, and `cancel` are documented no-ops because the
 * single-loop model has no ArtifactStore or pause/resume machinery.
 * They become real implementations in {@link DualLoopAgent} (Phase 4).
 *
 * @module loop/single
 */

import { runAgent } from '../index.js';
import { EventBus } from '../sse.js';
import { InMemoryArtifactStore } from '../artifacts/memory.js';
import type {
  IAgentLoop,
  LoopMode,
  AgentLoopInput,
  AgentLoopResult,
  AgentLoopCallOpts,
  Artifact,
  ArtifactStore,
  DirectiveRecord,
} from './types.js';

export class SingleLoopAgent implements IAgentLoop {
  readonly mode: LoopMode = 'single';
  /** Artifact store — stores artifacts but single-loop does not consume them. */
  readonly artifacts: ArtifactStore = new InMemoryArtifactStore();

  /**
   * Process one user message through the existing single-loop agent runtime.
   *
   * Resolves when the agent finishes (identical semantics to the current
   * `runAgent()` call). The returned `AgentLoopResult` carries the full
   * response, directives, tool usage, and resolved session ID.
   */
  processMessage(input: AgentLoopInput, opts?: AgentLoopCallOpts): Promise<AgentLoopResult> {
    const bus = opts?.bus ?? new EventBus();

    return new Promise<AgentLoopResult>((resolve, reject) => {
      runAgent(
        {
          type: 'message',
          content: input.content,
          sessionId: input.sessionId,
          images: input.images,
          config: input.config,
        },
        {
          bus,
          onResult: (result, sessionId) => {
            resolve({
              text: result.text ?? '',
              thinking: result.thinking,
              directives: (result.directives ?? []) as DirectiveRecord[],
              toolsUsed: result.toolsUsed ?? [],
              usage: result.usage,
              iterations: result.iterations ?? 0,
              sessionId,
            });
          },
        },
      ).catch(reject);
    });
  }

  /**
   * Store an artifact. In single-loop mode artifacts are stored but not
   * consumed by the agent loop. In dual-loop mode (Phase 4) the HIL
   * attaches them to tasks for inner-loop access.
   */
  addArtifact(artifact: Artifact): void {
    this.artifacts.add({
      url: artifact.url,
      mimeType: artifact.mimeType,
      type: artifact.type,
      addedBy: artifact.addedBy,
      taskId: artifact.taskId,
    });
  }

  /**
   * No-op in single-loop mode.
   * Pause/resume is only meaningful in dual-loop mode (Phase 4).
   */
  resume(_clarification: string): void {}

  /**
   * No-op in single-loop mode.
   * Task cancellation is only meaningful in dual-loop mode (Phase 4).
   */
  cancel(): void {}

  async shutdown(): Promise<void> {}
}
