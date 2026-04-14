/**
 * Tests for Memory — pluggable backend abstraction + file-based default
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../src/memory.js';
import { FileMemoryBackend } from '../src/memory-file-backend.js';
import type { MemoryBackend, MemorySearchResult } from '../src/memory.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;
let memory: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lumin-memory-'));
  memory = new MemoryStore(new FileMemoryBackend(tmpDir));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('MemoryStore.store', () => {
  it('creates memory directory and today file', async () => {
    await memory.store('Test memory entry');
    const today = new Date().toISOString().split('T')[0];
    const filePath = join(tmpDir, '.prismer', 'memory', `${today}.md`);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Test memory entry');
    expect(content).toContain('---');
  });

  it('includes tags in the entry header', async () => {
    await memory.store('Decision made', ['architecture', 'decision']);
    const today = new Date().toISOString().split('T')[0];
    const filePath = join(tmpDir, '.prismer', 'memory', `${today}.md`);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('[architecture, decision]');
    expect(content).toContain('Decision made');
  });

  it('appends multiple entries to the same file', async () => {
    await memory.store('First entry');
    await memory.store('Second entry');
    const today = new Date().toISOString().split('T')[0];
    const filePath = join(tmpDir, '.prismer', 'memory', `${today}.md`);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('First entry');
    expect(content).toContain('Second entry');
    // Should have 2 separators
    const separators = content.match(/---/g);
    expect(separators!.length).toBe(2);
  });
});

describe('MemoryStore.recall', () => {
  it('returns matching entries by keyword', async () => {
    await memory.store('We decided to use TypeScript for the agent runtime.');
    await memory.store('The database uses SQLite for development.');
    await memory.store('Vitest is our testing framework.');

    const result = await memory.recall('TypeScript agent');
    expect(result).toContain('TypeScript');
    expect(result).toContain('agent runtime');
  });

  it('returns empty string when no matches', async () => {
    await memory.store('Something about Python.');
    const result = await memory.recall('Rust blockchain');
    expect(result).toBe('');
  });

  it('returns empty string when no memory directory exists', async () => {
    const freshMemory = new MemoryStore(new FileMemoryBackend('/nonexistent/path'));
    const result = await freshMemory.recall('anything');
    expect(result).toBe('');
  });

  it('respects maxChars limit', async () => {
    // Store many entries
    for (let i = 0; i < 20; i++) {
      await memory.store(`Memory entry number ${i} about TypeScript patterns and best practices.`);
    }

    const result = await memory.recall('TypeScript', 500);
    expect(result.length).toBeLessThanOrEqual(600); // some slack for date prefix
  });

  it('ignores short keywords (< 3 chars)', async () => {
    await memory.store('The AI model works well.');
    const result = await memory.recall('AI'); // too short
    expect(result).toBe('');
  });
});

describe('MemoryStore.loadRecentContext', () => {
  it('loads today memory', async () => {
    await memory.store('Today we worked on compaction.');
    const context = await memory.loadRecentContext();
    expect(context).toContain('compaction');
    expect(context).toContain(new Date().toISOString().split('T')[0]);
  });

  it('returns empty string when no memory exists', async () => {
    const context = await memory.loadRecentContext();
    expect(context).toBe('');
  });

  it('respects maxChars limit', async () => {
    for (let i = 0; i < 50; i++) {
      await memory.store(`Large entry ${i}: ${'X'.repeat(200)}`);
    }
    const context = await memory.loadRecentContext(500);
    expect(context.length).toBeLessThanOrEqual(600);
  });
});

// ── FileMemoryBackend (direct) ────────────────────────────

describe('FileMemoryBackend', () => {
  let backend: FileMemoryBackend;
  let backendDir: string;

  beforeEach(() => {
    backendDir = mkdtempSync(join(tmpdir(), 'lumin-backend-'));
    backend = new FileMemoryBackend(backendDir);
  });

  afterEach(() => {
    rmSync(backendDir, { recursive: true, force: true });
  });

  it('has name "file"', () => {
    expect(backend.name).toBe('file');
  });

  it('capabilities reports no semantic search or tag filtering', () => {
    const caps = backend.capabilities();
    expect(caps.semanticSearch).toBe(false);
    expect(caps.tagFiltering).toBe(false);
    expect(caps.maxStorageBytes).toBeUndefined();
  });

  it('close() resolves without error', async () => {
    await expect(backend.close()).resolves.toBeUndefined();
  });

  it('search() returns MemorySearchResult[] with normalized scores', async () => {
    await backend.store('TypeScript agent runtime with Zod validation.');
    await backend.store('Python script for data analysis.');

    const results = await backend.search('TypeScript agent Zod');
    expect(results.length).toBeGreaterThan(0);

    const first = results[0];
    expect(first).toHaveProperty('text');
    expect(first).toHaveProperty('date');
    expect(first).toHaveProperty('score');
    expect(first).toHaveProperty('source');
    // 3 keywords match out of 3 → score = 1.0
    expect(first.score).toBe(1.0);
    expect(first.text).toContain('TypeScript');
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('search() scores partial matches correctly', async () => {
    await backend.store('TypeScript is great for backend development.');

    // Only "typescript" and "backend" match, "rust" does not → 2/3
    const results = await backend.search('TypeScript backend rust');
    expect(results.length).toBe(1);
    expect(results[0].score).toBeCloseTo(2 / 3, 5);
  });

  it('search() respects maxResults option', async () => {
    for (let i = 0; i < 10; i++) {
      await backend.store(`Entry ${i} about TypeScript patterns.`);
    }
    const results = await backend.search('TypeScript patterns', { maxResults: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('recent() returns MemorySearchResult[] with score 1.0', async () => {
    await backend.store('Recent memory entry.');

    const results = await backend.recent();
    expect(results.length).toBeGreaterThan(0);

    const first = results[0];
    expect(first.score).toBe(1.0);
    expect(first.date).toBe(new Date().toISOString().split('T')[0]);
    expect(first.text).toContain('Recent memory entry');
    expect(first.source).toBeDefined();
  });

  it('recent() returns empty array when no memory directory', async () => {
    const freshBackend = new FileMemoryBackend('/nonexistent/path');
    const results = await freshBackend.recent();
    expect(results).toEqual([]);
  });
});

// ── MemoryStore facade (with mock backend) ────────────────

describe('MemoryStore facade', () => {
  it('FileMemoryBackend constructor creates file backend', () => {
    const store = new MemoryStore(new FileMemoryBackend('/tmp/test-workspace'));
    expect(store.backendName).toBe('file');
  });

  it('backend constructor uses the provided backend', () => {
    const mockBackend: MemoryBackend = {
      name: 'mock',
      store: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      recent: vi.fn().mockResolvedValue([]),
      capabilities: vi.fn().mockReturnValue({ semanticSearch: true, tagFiltering: true }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const store = new MemoryStore(mockBackend);
    expect(store.backendName).toBe('mock');
  });

  it('delegates store() to backend', async () => {
    const storeFn = vi.fn().mockResolvedValue(undefined);
    const mockBackend: MemoryBackend = {
      name: 'mock',
      store: storeFn,
      search: vi.fn().mockResolvedValue([]),
      recent: vi.fn().mockResolvedValue([]),
      capabilities: vi.fn().mockReturnValue({ semanticSearch: false, tagFiltering: false }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const store = new MemoryStore(mockBackend);
    await store.store('hello', ['tag1']);
    expect(storeFn).toHaveBeenCalledWith('hello', ['tag1']);
  });

  it('recall() delegates to backend.search() and formats as string', async () => {
    const searchFn = vi.fn().mockResolvedValue([
      { text: 'First result', date: '2026-03-12', score: 1.0 },
      { text: 'Second result', date: '2026-03-11', score: 0.5 },
    ] as MemorySearchResult[]);
    const mockBackend: MemoryBackend = {
      name: 'mock',
      store: vi.fn().mockResolvedValue(undefined),
      search: searchFn,
      recent: vi.fn().mockResolvedValue([]),
      capabilities: vi.fn().mockReturnValue({ semanticSearch: false, tagFiltering: false }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const store = new MemoryStore(mockBackend);
    const result = await store.recall('query', 5000);

    expect(searchFn).toHaveBeenCalledWith('query', { maxChars: 5000 });
    expect(result).toContain('[2026-03-12] First result');
    expect(result).toContain('[2026-03-11] Second result');
  });

  it('search() returns structured results from backend', async () => {
    const expected: MemorySearchResult[] = [
      { text: 'Result', date: '2026-03-12', score: 0.8, tags: ['test'] },
    ];
    const searchFn = vi.fn().mockResolvedValue(expected);
    const mockBackend: MemoryBackend = {
      name: 'mock',
      store: vi.fn().mockResolvedValue(undefined),
      search: searchFn,
      recent: vi.fn().mockResolvedValue([]),
      capabilities: vi.fn().mockReturnValue({ semanticSearch: false, tagFiltering: false }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const store = new MemoryStore(mockBackend);
    const results = await store.search('test', { maxResults: 5 });

    expect(searchFn).toHaveBeenCalledWith('test', { maxResults: 5 });
    expect(results).toEqual(expected);
  });

  it('capabilities() passes through backend capabilities', () => {
    const mockBackend: MemoryBackend = {
      name: 'vector',
      store: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      recent: vi.fn().mockResolvedValue([]),
      capabilities: vi.fn().mockReturnValue({
        semanticSearch: true,
        tagFiltering: true,
        maxStorageBytes: 1_000_000,
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const store = new MemoryStore(mockBackend);
    const caps = store.capabilities();
    expect(caps.semanticSearch).toBe(true);
    expect(caps.tagFiltering).toBe(true);
    expect(caps.maxStorageBytes).toBe(1_000_000);
  });

  it('close() delegates to backend', async () => {
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const mockBackend: MemoryBackend = {
      name: 'mock',
      store: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      recent: vi.fn().mockResolvedValue([]),
      capabilities: vi.fn().mockReturnValue({ semanticSearch: false, tagFiltering: false }),
      close: closeFn,
    };

    const store = new MemoryStore(mockBackend);
    await store.close();
    expect(closeFn).toHaveBeenCalledOnce();
  });

  it('loadRecentContext() formats backend.recent() with date headers', async () => {
    const recentFn = vi.fn().mockResolvedValue([
      { text: 'Today memory content', date: '2026-03-12', score: 1.0 },
      { text: 'Yesterday memory content', date: '2026-03-11', score: 1.0 },
    ] as MemorySearchResult[]);
    const mockBackend: MemoryBackend = {
      name: 'mock',
      store: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      recent: recentFn,
      capabilities: vi.fn().mockReturnValue({ semanticSearch: false, tagFiltering: false }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const store = new MemoryStore(mockBackend);
    const context = await store.loadRecentContext(5000);

    expect(recentFn).toHaveBeenCalledWith(5000);
    expect(context).toContain('### 2026-03-12');
    expect(context).toContain('Today memory content');
    expect(context).toContain('### 2026-03-11');
    expect(context).toContain('Yesterday memory content');
  });
});
