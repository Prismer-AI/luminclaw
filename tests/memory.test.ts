/**
 * Tests for Memory — file-based persistent memory store/recall
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/memory.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;
let memory: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lumin-memory-'));
  memory = new MemoryStore(tmpDir);
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
    const freshMemory = new MemoryStore('/nonexistent/path');
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
