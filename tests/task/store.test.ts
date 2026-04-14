import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTaskStore } from '../../src/task/store.js';

describe('InMemoryTaskStore — Phase A additions', () => {
  let store: InMemoryTaskStore;
  beforeEach(() => { store = new InMemoryTaskStore(); });

  describe('getActiveForSession', () => {
    it('returns the executing task for a given sessionId', () => {
      const t = store.create({
        id: 't1', sessionId: 'sess-A', instruction: 'x',
        artifactIds: [], status: 'executing',
      });
      expect(store.getActiveForSession('sess-A')).toEqual(t);
    });

    it('ignores tasks in other sessions', () => {
      store.create({
        id: 't1', sessionId: 'sess-A', instruction: 'x',
        artifactIds: [], status: 'executing',
      });
      expect(store.getActiveForSession('sess-B')).toBeUndefined();
    });

    it('ignores completed / failed tasks', () => {
      store.create({
        id: 't1', sessionId: 'sess-A', instruction: 'x',
        artifactIds: [], status: 'completed',
      });
      store.create({
        id: 't2', sessionId: 'sess-A', instruction: 'y',
        artifactIds: [], status: 'failed',
      });
      expect(store.getActiveForSession('sess-A')).toBeUndefined();
    });

    it('treats paused as active', () => {
      const t = store.create({
        id: 't1', sessionId: 'sess-A', instruction: 'x',
        artifactIds: [], status: 'paused',
      });
      expect(store.getActiveForSession('sess-A')).toEqual(t);
    });
  });

  describe('interrupted status', () => {
    it('getActiveForSession treats interrupted as NOT active', () => {
      const store = new InMemoryTaskStore();
      store.create({
        id: 't1', sessionId: 's', instruction: 'x',
        artifactIds: [], status: 'interrupted',
      });
      expect(store.getActiveForSession('s')).toBeUndefined();
    });
  });

  describe('updateProgress', () => {
    it('sets progress on a task', () => {
      store.create({
        id: 't1', sessionId: 'sess', instruction: 'x',
        artifactIds: [], status: 'executing',
      });
      const updated = store.updateProgress('t1', {
        iterations: 3,
        toolsUsed: ['bash', 'read_file'],
        lastActivity: 1234567890,
      });
      expect(updated?.progress).toEqual({
        iterations: 3,
        toolsUsed: ['bash', 'read_file'],
        lastActivity: 1234567890,
      });
    });

    it('merges partial progress updates', () => {
      store.create({
        id: 't1', sessionId: 'sess', instruction: 'x',
        artifactIds: [], status: 'executing',
      });
      store.updateProgress('t1', { iterations: 1, toolsUsed: [], lastActivity: 100 });
      const updated = store.updateProgress('t1', { iterations: 2, lastActivity: 200 });
      expect(updated?.progress).toEqual({
        iterations: 2, toolsUsed: [], lastActivity: 200,
      });
    });

    it('returns undefined for unknown taskId', () => {
      expect(store.updateProgress('nope', { iterations: 1, toolsUsed: [], lastActivity: 0 })).toBeUndefined();
    });
  });
});
