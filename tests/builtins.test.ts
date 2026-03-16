/**
 * Tests for built-in tools (v0.4.0)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BUILTIN_TOOLS, getBuiltinTools, safePath } from '../src/tools/builtins.js';
import type { ToolContext } from '../src/tools.js';

// ── Test helpers ──────────────────────────────────────────

let tmpDir: string;
let ctx: ToolContext;

function getTool(name: string) {
  const tool = BUILTIN_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-builtins-'));
  ctx = {
    workspaceDir: tmpDir,
    sessionId: 'test-session',
    agentId: 'test-agent',
    emit: () => {},
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── safePath ──────────────────────────────────────────────

describe('safePath', () => {
  it('resolves relative paths within workspace', () => {
    const result = safePath('src/file.ts', tmpDir);
    expect(result).toBe(path.join(tmpDir, 'src/file.ts'));
  });

  it('rejects path traversal with ../', () => {
    expect(() => safePath('../etc/passwd', tmpDir)).toThrow('Path traversal rejected');
  });

  it('rejects path traversal with absolute path', () => {
    expect(() => safePath('/etc/passwd', tmpDir)).toThrow('Path traversal rejected');
  });

  it('allows workspace root itself', () => {
    const result = safePath('.', tmpDir);
    expect(result).toBe(path.resolve(tmpDir));
  });
});

// ── read_file ─────────────────────────────────────────────

describe('read_file', () => {
  const tool = () => getTool('read_file');

  it('reads a file with line numbers', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'line1\nline2\nline3');
    const result = await tool().execute({ path: 'hello.txt' }, ctx);
    expect(result).toContain('1\tline1');
    expect(result).toContain('2\tline2');
    expect(result).toContain('3\tline3');
  });

  it('supports offset and limit', async () => {
    fs.writeFileSync(path.join(tmpDir, 'nums.txt'), 'a\nb\nc\nd\ne');
    const result = await tool().execute({ path: 'nums.txt', offset: 2, limit: 2 }, ctx);
    expect(result).toBe('2\tb\n3\tc');
  });

  it('throws on path traversal', async () => {
    await expect(tool().execute({ path: '../etc/passwd' }, ctx)).rejects.toThrow('Path traversal');
  });

  it('throws on non-existent file', async () => {
    await expect(tool().execute({ path: 'nope.txt' }, ctx)).rejects.toThrow();
  });
});

// ── write_file ────────────────────────────────────────────

describe('write_file', () => {
  const tool = () => getTool('write_file');

  it('writes a file', async () => {
    const result = await tool().execute({ path: 'out.txt', content: 'hello' }, ctx);
    expect(result).toContain('Wrote');
    expect(fs.readFileSync(path.join(tmpDir, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('creates parent directories', async () => {
    await tool().execute({ path: 'deep/nested/file.txt', content: 'deep' }, ctx);
    expect(fs.readFileSync(path.join(tmpDir, 'deep/nested/file.txt'), 'utf8')).toBe('deep');
  });

  it('rejects path traversal', async () => {
    await expect(tool().execute({ path: '../bad.txt', content: 'x' }, ctx)).rejects.toThrow('Path traversal');
  });
});

// ── list_files ────────────────────────────────────────────

describe('list_files', () => {
  const tool = () => getTool('list_files');

  it('lists files in workspace', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), '');
    const result = await tool().execute({}, ctx);
    expect(result).toContain('a.ts');
    expect(result).toContain('b.js');
  });

  it('applies glob pattern', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), '');
    const result = await tool().execute({ pattern: '*.ts' }, ctx);
    expect(result).toContain('a.ts');
    expect(result).not.toContain('b.js');
  });

  it('lists subdirectories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), '');
    const result = await tool().execute({}, ctx);
    expect(result).toContain('src/');
    expect(result).toContain('src/index.ts');
  });

  it('skips node_modules and .git', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules/pkg.js'), '');
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git/HEAD'), '');
    const result = await tool().execute({}, ctx);
    expect(result).not.toContain('node_modules');
    expect(result).not.toContain('.git');
  });

  it('returns message when no files found', async () => {
    // empty workspace with glob that matches nothing
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), '');
    const result = await tool().execute({ pattern: '*.xyz' }, ctx);
    expect(result).toBe('No files found.');
  });

  it('supports recursive glob with **', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src/app.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '');
    const result = await tool().execute({ pattern: '**/*.ts' }, ctx);
    expect(result).toContain('src/app.ts');
    expect(result).not.toContain('readme.md');
  });
});

// ── edit_file ─────────────────────────────────────────────

describe('edit_file', () => {
  const tool = () => getTool('edit_file');

  it('replaces a unique string', async () => {
    fs.writeFileSync(path.join(tmpDir, 'code.ts'), 'const x = 1;\nconst y = 2;');
    const result = await tool().execute({ path: 'code.ts', old_string: 'const x = 1;', new_string: 'const x = 42;' }, ctx);
    expect(result).toContain('Replaced 1');
    expect(fs.readFileSync(path.join(tmpDir, 'code.ts'), 'utf8')).toBe('const x = 42;\nconst y = 2;');
  });

  it('errors on non-unique string without replace_all', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dup.ts'), 'foo\nfoo\nfoo');
    const result = await tool().execute({ path: 'dup.ts', old_string: 'foo', new_string: 'bar' }, ctx);
    expect(result).toContain('found 3 times');
    // File should be unchanged
    expect(fs.readFileSync(path.join(tmpDir, 'dup.ts'), 'utf8')).toBe('foo\nfoo\nfoo');
  });

  it('replaces all with replace_all: true', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dup.ts'), 'foo\nfoo\nfoo');
    const result = await tool().execute({ path: 'dup.ts', old_string: 'foo', new_string: 'bar', replace_all: true }, ctx);
    expect(result).toContain('Replaced 3');
    expect(fs.readFileSync(path.join(tmpDir, 'dup.ts'), 'utf8')).toBe('bar\nbar\nbar');
  });

  it('errors when old_string not found', async () => {
    fs.writeFileSync(path.join(tmpDir, 'nope.ts'), 'hello world');
    const result = await tool().execute({ path: 'nope.ts', old_string: 'xyz', new_string: 'abc' }, ctx);
    expect(result).toContain('not found');
  });
});

// ── grep ──────────────────────────────────────────────────

describe('grep', () => {
  const tool = () => getTool('grep');

  it('finds matches in files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function hello() {}');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'const x = 1;');
    const result = await tool().execute({ pattern: 'function' }, ctx);
    expect(result).toContain('a.ts:1');
    expect(result).toContain('function hello');
    expect(result).not.toContain('b.ts');
  });

  it('searches recursively', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src/deep.ts'), 'TODO: fix this');
    const result = await tool().execute({ pattern: 'TODO' }, ctx);
    expect(result).toContain('src/deep.ts:1');
  });

  it('supports regex', async () => {
    fs.writeFileSync(path.join(tmpDir, 'code.ts'), 'const count = 42;\nconst name = "test";');
    const result = await tool().execute({ pattern: 'const \\w+ = \\d+' }, ctx);
    expect(result).toContain('const count = 42');
    expect(result).not.toContain('const name');
  });

  it('returns message when no matches', async () => {
    fs.writeFileSync(path.join(tmpDir, 'empty.ts'), 'nothing here');
    const result = await tool().execute({ pattern: 'foobar' }, ctx);
    expect(result).toBe('No matches found.');
  });

  it('respects maxResults', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `match line ${i}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'big.txt'), lines);
    const result = await tool().execute({ pattern: 'match', maxResults: 5 }, ctx);
    const matchCount = result.split('\n').length;
    expect(matchCount).toBe(5);
  });

  it('supports glob filter', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'hello world');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'hello world');
    const result = await tool().execute({ pattern: 'hello', glob: '*.ts' }, ctx);
    expect(result).toContain('a.ts');
    expect(result).not.toContain('b.js');
  });
});

// ── web_fetch ─────────────────────────────────────────────

describe('web_fetch', () => {
  const tool = () => getTool('web_fetch');

  it('has correct parameters', () => {
    expect(tool().name).toBe('web_fetch');
    const params = tool().parameters as { required: string[] };
    expect(params.required).toContain('url');
  });

  // Network tests are skipped in CI — just verify the tool exists and has right shape
});

// ── think ─────────────────────────────────────────────────

describe('think', () => {
  const tool = () => getTool('think');

  it('returns confirmation', async () => {
    const result = await tool().execute({ thought: 'Let me analyze this problem...' }, ctx);
    expect(result).toBe('Thought recorded.');
  });
});

// ── getBuiltinTools ───────────────────────────────────────

describe('getBuiltinTools', () => {
  it('returns all 7 tools by default', () => {
    const tools = getBuiltinTools();
    expect(tools).toHaveLength(7);
    const names = tools.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_files');
    expect(names).toContain('edit_file');
    expect(names).toContain('grep');
    expect(names).toContain('web_fetch');
    expect(names).toContain('think');
  });

  it('excludes specified tools', () => {
    const tools = getBuiltinTools(new Set(['read_file', 'write_file']));
    expect(tools).toHaveLength(5);
    expect(tools.map(t => t.name)).not.toContain('read_file');
    expect(tools.map(t => t.name)).not.toContain('write_file');
  });
});

// ── Tool spec shape ──────────────────────────────────────

describe('tool specs', () => {
  it('all tools have valid JSON Schema parameters', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      const params = tool.parameters as { type: string };
      expect(params.type).toBe('object');
    }
  });
});
