/**
 * Task model types — the unit of work in dual-loop mode.
 *
 * A Task is created by the HIL when a user message arrives and no active
 * task exists. It tracks status, checkpoints, and associated artifacts
 * through its lifecycle.
 *
 * @module task/types
 */

// ── Status ────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'planning' | 'executing' | 'paused' | 'completed' | 'failed';

// ── Checkpoint ────────────────────────────────────────────

export type CheckpointType = 'progress' | 'question' | 'approval' | 'result';

export interface Checkpoint {
  id: string;
  taskId: string;
  type: CheckpointType;
  message: string;
  /** true for 'question' and 'approval' — inner loop pauses until user responds. */
  requiresUserAction: boolean;
  data?: Record<string, unknown>;
  emittedAt: number;
}

// ── TaskProgress ─────────────────────────────────────────

export interface TaskProgress {
  /** Number of agent-loop iterations completed so far. */
  iterations: number;
  /** Unique tool names invoked so far, in first-use order. */
  toolsUsed: string[];
  /** Epoch-ms of last activity (LLM turn end or tool return). */
  lastActivity: number;
}

// ── Task ──────────────────────────────────────────────────

export interface Task {
  id: string;
  /** Workspace this task belongs to. */
  workspaceId?: string;
  /** Session that created this task. */
  sessionId: string;
  /** User's original instruction. */
  instruction: string;
  /** Artifact IDs attached to this task. */
  artifactIds: string[];
  status: TaskStatus;
  checkpoints: Checkpoint[];
  /** Execution plan steps (set during planning phase). */
  plan?: string[];
  /** Final result text (set on completion). */
  result?: string;
  /** Error message (set on failure). */
  error?: string;
  /** Runtime progress tracking (iterations, tools used, last activity). */
  progress?: TaskProgress;
  createdAt: number;
  updatedAt: number;
}

// ── Task Store Interface ──────────────────────────────────

export interface TaskStore {
  create(task: Omit<Task, 'checkpoints' | 'createdAt' | 'updatedAt'>): Task;
  get(id: string): Task | undefined;
  update(id: string, partial: Partial<Pick<Task, 'status' | 'result' | 'error' | 'artifactIds'>>): Task | undefined;
  addCheckpoint(taskId: string, checkpoint: Omit<Checkpoint, 'taskId'>): Checkpoint | undefined;
  /** Get the currently active task (executing or paused). */
  getActive(): Task | undefined;
  /** Get the active (executing or paused) task for a specific session. */
  getActiveForSession(sessionId: string): Task | undefined;
  /** Update progress fields on a task (merges with existing progress). */
  updateProgress(id: string, progress: Partial<TaskProgress>): Task | undefined;
  list(): Task[];
  clear(): void;
}
