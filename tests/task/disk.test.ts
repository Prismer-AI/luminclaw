import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendTurn,
  writeMeta,
  readMeta,
  readTranscript,
  enumerateSessionTasks,
  taskJsonlPath,
  taskMetaPath,
} from '../../src/task/disk.js';
import type { TaskMetadata, TurnEntry } from '../../src/task/disk.js';

describe('task/disk', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-disk-'));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  describe('appendTurn + readTranscript', () => {
    it('appends turns in order, reads back as JSONL array', async () => {
      const workspaceDir = tmpRoot;
      const sessionId = 's1';
      const taskId = 't1';
      const u: TurnEntry = { kind: 'user', content: 'hello', timestamp: 1 };
      const a: TurnEntry = { kind: 'assistant', content: 'hi', timestamp: 2 };
      await appendTurn(workspaceDir, sessionId, taskId, u);
      await appendTurn(workspaceDir, sessionId, taskId, a);
      const turns = await readTranscript(workspaceDir, sessionId, taskId);
      expect(turns).toEqual([u, a]);
    });

    it('handles tool turn with toolCallId and tool content', async () => {
      const t: TurnEntry = { kind: 'tool', toolCallId: 'c1', name: 'bash', content: 'ok', timestamp: 3 };
      await appendTurn(tmpRoot, 's1', 't1', t);
      const turns = await readTranscript(tmpRoot, 's1', 't1');
      expect(turns).toEqual([t]);
    });

    it('creates directory structure on first write', async () => {
      await appendTurn(tmpRoot, 'sess', 'task', { kind: 'status', status: 'pending', timestamp: 1 });
      const stat = await fs.stat(path.join(tmpRoot, '.lumin', 'sessions', 'sess', 'tasks'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('readTranscript returns [] for non-existent task', async () => {
      const turns = await readTranscript(tmpRoot, 'nope', 'nope');
      expect(turns).toEqual([]);
    });
  });

  describe('writeMeta + readMeta', () => {
    it('writes and reads metadata atomically', async () => {
      const meta: TaskMetadata = {
        id: 't1', sessionId: 's1', instruction: 'go',
        status: 'executing',
        createdAt: 100, updatedAt: 200,
        lastPersistedTurnOffset: 0, version: 1,
      };
      await writeMeta(tmpRoot, 's1', 't1', meta);
      const read = await readMeta(tmpRoot, 's1', 't1');
      expect(read).toEqual(meta);
    });

    it('overwrites metadata on subsequent writes', async () => {
      const m1: TaskMetadata = { id: 't1', sessionId: 's1', instruction: 'go', status: 'pending', createdAt: 100, updatedAt: 100, lastPersistedTurnOffset: 0, version: 1 };
      const m2: TaskMetadata = { ...m1, status: 'executing', updatedAt: 200 };
      await writeMeta(tmpRoot, 's1', 't1', m1);
      await writeMeta(tmpRoot, 's1', 't1', m2);
      const read = await readMeta(tmpRoot, 's1', 't1');
      expect(read?.status).toBe('executing');
      expect(read?.updatedAt).toBe(200);
    });

    it('readMeta returns null for non-existent task', async () => {
      const read = await readMeta(tmpRoot, 'nope', 'nope');
      expect(read).toBeNull();
    });
  });

  describe('enumerateSessionTasks', () => {
    it('finds all tasks across all sessions', async () => {
      const m1: TaskMetadata = { id: 't1', sessionId: 's1', instruction: 'a', status: 'executing', createdAt: 1, updatedAt: 1, lastPersistedTurnOffset: 0, version: 1 };
      const m2: TaskMetadata = { id: 't2', sessionId: 's1', instruction: 'b', status: 'completed', createdAt: 2, updatedAt: 2, lastPersistedTurnOffset: 0, version: 1 };
      const m3: TaskMetadata = { id: 't3', sessionId: 's2', instruction: 'c', status: 'executing', createdAt: 3, updatedAt: 3, lastPersistedTurnOffset: 0, version: 1 };
      await writeMeta(tmpRoot, 's1', 't1', m1);
      await writeMeta(tmpRoot, 's1', 't2', m2);
      await writeMeta(tmpRoot, 's2', 't3', m3);
      const all = await enumerateSessionTasks(tmpRoot);
      expect(all.map(t => t.id).sort()).toEqual(['t1', 't2', 't3']);
    });

    it('returns [] when no sessions exist', async () => {
      const all = await enumerateSessionTasks(tmpRoot);
      expect(all).toEqual([]);
    });
  });

  describe('path helpers', () => {
    it('produces consistent paths', () => {
      expect(taskJsonlPath(tmpRoot, 's', 't')).toBe(path.join(tmpRoot, '.lumin', 'sessions', 's', 'tasks', 't.jsonl'));
      expect(taskMetaPath(tmpRoot, 's', 't')).toBe(path.join(tmpRoot, '.lumin', 'sessions', 's', 'tasks', 't.meta.json'));
    });
  });
});
