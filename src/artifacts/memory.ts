/**
 * In-memory artifact store.
 *
 * Simple Map-based implementation suitable for single-process runtimes.
 * Can be replaced with a Redis or DB-backed store without changing the
 * {@link ArtifactStore} interface.
 *
 * @module artifacts/memory
 */

import type { Artifact, ArtifactInput, ArtifactStore } from './types.js';
import { createArtifact } from './types.js';

export class InMemoryArtifactStore implements ArtifactStore {
  private artifacts = new Map<string, Artifact>();

  add(input: ArtifactInput): Artifact {
    const artifact = createArtifact(input);
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  get(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  getByTask(taskId: string): Artifact[] {
    return Array.from(this.artifacts.values()).filter(a => a.taskId === taskId);
  }

  getUnassigned(): Artifact[] {
    return Array.from(this.artifacts.values()).filter(a => a.taskId === null);
  }

  assignToTask(artifactId: string, taskId: string): boolean {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return false;
    artifact.taskId = taskId;
    return true;
  }

  list(): Artifact[] {
    return Array.from(this.artifacts.values());
  }

  clear(): void {
    this.artifacts.clear();
  }
}
