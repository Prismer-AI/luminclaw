/**
 * Tests for Phase 1a — ArtifactStore.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryArtifactStore } from '../src/artifacts/memory.js';
import { createArtifact, inferArtifactType } from '../src/artifacts/types.js';

describe('inferArtifactType', () => {
  it('returns image for image/* MIME types', () => {
    expect(inferArtifactType('image/png')).toBe('image');
    expect(inferArtifactType('image/jpeg')).toBe('image');
    expect(inferArtifactType('image/webp')).toBe('image');
  });

  it('returns file for non-image types', () => {
    expect(inferArtifactType('application/pdf')).toBe('file');
    expect(inferArtifactType('text/plain')).toBe('file');
  });
});

describe('createArtifact', () => {
  it('generates id and timestamp', () => {
    const a = createArtifact({ url: 'https://example.com/img.png', mimeType: 'image/png' });
    expect(a.id).toBeTruthy();
    expect(a.addedAt).toBeGreaterThan(0);
    expect(a.type).toBe('image');
    expect(a.addedBy).toBe('user');
    expect(a.taskId).toBeNull();
  });

  it('respects explicit type and addedBy', () => {
    const a = createArtifact({ url: 'x', mimeType: 'text/csv', type: 'file', addedBy: 'agent' });
    expect(a.type).toBe('file');
    expect(a.addedBy).toBe('agent');
  });
});

describe('InMemoryArtifactStore', () => {
  let store: InMemoryArtifactStore;

  beforeEach(() => {
    store = new InMemoryArtifactStore();
  });

  it('add + get round-trip', () => {
    const a = store.add({ url: 'https://img.png', mimeType: 'image/png' });
    expect(a.id).toBeTruthy();
    expect(store.get(a.id)).toBe(a);
  });

  it('get returns undefined for missing id', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('list returns all artifacts', () => {
    store.add({ url: 'a', mimeType: 'image/png' });
    store.add({ url: 'b', mimeType: 'image/jpeg' });
    expect(store.list()).toHaveLength(2);
  });

  it('getByTask filters by taskId', () => {
    const a1 = store.add({ url: 'a', mimeType: 'image/png', taskId: 'task-1' });
    store.add({ url: 'b', mimeType: 'image/jpeg', taskId: 'task-2' });
    store.add({ url: 'c', mimeType: 'image/webp' }); // unassigned

    const result = store.getByTask('task-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(a1.id);
  });

  it('getUnassigned returns artifacts with null taskId', () => {
    store.add({ url: 'a', mimeType: 'image/png', taskId: 'task-1' });
    const a2 = store.add({ url: 'b', mimeType: 'image/jpeg' });

    const result = store.getUnassigned();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(a2.id);
  });

  it('assignToTask promotes an artifact', () => {
    const a = store.add({ url: 'a', mimeType: 'image/png' });
    expect(a.taskId).toBeNull();

    const ok = store.assignToTask(a.id, 'task-99');
    expect(ok).toBe(true);
    expect(store.get(a.id)!.taskId).toBe('task-99');
    expect(store.getByTask('task-99')).toHaveLength(1);
    expect(store.getUnassigned()).toHaveLength(0);
  });

  it('assignToTask returns false for missing artifact', () => {
    expect(store.assignToTask('nope', 'task-1')).toBe(false);
  });

  it('clear removes all artifacts', () => {
    store.add({ url: 'a', mimeType: 'image/png' });
    store.add({ url: 'b', mimeType: 'image/jpeg' });
    store.clear();
    expect(store.list()).toHaveLength(0);
  });
});
