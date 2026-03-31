/**
 * Artifact types — workspace-scoped file/image/URL references.
 *
 * Artifacts decouple user-supplied context (images, files) from the chat
 * message stream. In single-loop mode they are stored but not consumed;
 * in dual-loop mode the HIL attaches them to tasks so the inner loop can
 * access them without interrupting execution.
 *
 * @module artifacts/types
 */

import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────

export type ArtifactType = 'image' | 'file' | 'url';

export interface Artifact {
  /** Unique identifier (UUID v4). */
  id: string;
  /** IANA media type (e.g. "image/png", "application/pdf"). */
  mimeType: string;
  /** CDN URL or data URI. */
  url: string;
  /** Classification hint. */
  type: ArtifactType;
  /** Who added the artifact. */
  addedBy: 'user' | 'agent';
  /** Assigned when HIL associates the artifact with a task. null = unassigned. */
  taskId: string | null;
  /** Unix epoch ms. */
  addedAt: number;
  /** Optional key-value metadata (filename, dimensions, etc.). */
  metadata?: Record<string, unknown>;
}

/** Input for creating a new artifact (id and addedAt are generated). */
export interface ArtifactInput {
  url: string;
  mimeType: string;
  type?: ArtifactType;
  addedBy?: 'user' | 'agent';
  taskId?: string | null;
  metadata?: Record<string, unknown>;
}

// ── Store Interface ───────────────────────────────────────

export interface ArtifactStore {
  /** Add a new artifact. Returns the stored artifact with generated id. */
  add(input: ArtifactInput): Artifact;
  /** Get by id. */
  get(id: string): Artifact | undefined;
  /** Get all artifacts assigned to a task. */
  getByTask(taskId: string): Artifact[];
  /** Get artifacts not yet assigned to any task. */
  getUnassigned(): Artifact[];
  /** Promote an artifact to a task. */
  assignToTask(artifactId: string, taskId: string): boolean;
  /** List all artifacts. */
  list(): Artifact[];
  /** Remove all artifacts. */
  clear(): void;
}

// ── Helpers ───────────────────────────────────────────────

/** Infer ArtifactType from MIME type. */
export function inferArtifactType(mimeType: string): ArtifactType {
  if (mimeType.startsWith('image/')) return 'image';
  return 'file';
}

/** Create an Artifact from input, generating id and timestamp. */
export function createArtifact(input: ArtifactInput): Artifact {
  return {
    id: randomUUID(),
    url: input.url,
    mimeType: input.mimeType,
    type: input.type ?? inferArtifactType(input.mimeType),
    addedBy: input.addedBy ?? 'user',
    taskId: input.taskId ?? null,
    addedAt: Date.now(),
    metadata: input.metadata,
  };
}
