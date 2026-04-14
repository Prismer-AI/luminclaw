/**
 * Disk persistence for tasks — JSONL transcript + JSON metadata.
 * Layout:
 *   {workspaceDir}/.lumin/sessions/{sessionId}/tasks/{taskId}.jsonl
 *   {workspaceDir}/.lumin/sessions/{sessionId}/tasks/{taskId}.meta.json
 *
 * All writes are atomic (write-tmp + rename). Reads return null/[] for missing.
 * @module task/disk
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskStatus } from './types.js';

const LUMIN_DIR = '.lumin';
const SESSIONS_DIR = 'sessions';
const TASKS_DIR = 'tasks';

export interface TaskMetadata {
  id: string;
  sessionId: string;
  instruction: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  iterations?: number;
  toolsUsed?: string[];
  error?: string;
  lastPersistedTurnOffset: number;
  version: 1;
}

export type TurnEntry =
  | { kind: 'user'; content: string; enqueuedAt?: number; messageId?: string; timestamp: number }
  | { kind: 'assistant'; content: string; thinking?: string; toolCalls?: Array<{ id: string; name: string; arguments: unknown }>; timestamp: number }
  | { kind: 'tool'; toolCallId: string; name: string; content: string; timestamp: number }
  | { kind: 'status'; status: TaskStatus; reason?: string; timestamp: number };

export function taskJsonlPath(workspaceDir: string, sessionId: string, taskId: string): string {
  return path.join(workspaceDir, LUMIN_DIR, SESSIONS_DIR, sessionId, TASKS_DIR, `${taskId}.jsonl`);
}

export function taskMetaPath(workspaceDir: string, sessionId: string, taskId: string): string {
  return path.join(workspaceDir, LUMIN_DIR, SESSIONS_DIR, sessionId, TASKS_DIR, `${taskId}.meta.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, filePath);
}

export async function appendTurn(workspaceDir: string, sessionId: string, taskId: string, entry: TurnEntry): Promise<void> {
  const filePath = taskJsonlPath(workspaceDir, sessionId, taskId);
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

export async function readTranscript(workspaceDir: string, sessionId: string, taskId: string): Promise<TurnEntry[]> {
  const filePath = taskJsonlPath(workspaceDir, sessionId, taskId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as TurnEntry);
}

export async function writeMeta(workspaceDir: string, sessionId: string, taskId: string, meta: TaskMetadata): Promise<void> {
  await atomicWrite(taskMetaPath(workspaceDir, sessionId, taskId), JSON.stringify(meta, null, 2));
}

export async function readMeta(workspaceDir: string, sessionId: string, taskId: string): Promise<TaskMetadata | null> {
  try {
    const raw = await fs.readFile(taskMetaPath(workspaceDir, sessionId, taskId), 'utf8');
    return JSON.parse(raw) as TaskMetadata;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

export async function enumerateSessionTasks(workspaceDir: string): Promise<TaskMetadata[]> {
  const sessionsRoot = path.join(workspaceDir, LUMIN_DIR, SESSIONS_DIR);
  const results: TaskMetadata[] = [];
  let sessionDirs: string[];
  try {
    sessionDirs = await fs.readdir(sessionsRoot);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  for (const sessionId of sessionDirs) {
    const tasksDir = path.join(sessionsRoot, sessionId, TASKS_DIR);
    let files: string[];
    try {
      files = await fs.readdir(tasksDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.meta.json')) continue;
      const taskId = f.slice(0, -'.meta.json'.length);
      const meta = await readMeta(workspaceDir, sessionId, taskId);
      if (meta) results.push(meta);
    }
  }
  return results;
}
