/**
 * Built-in Tools — 7 pure Node.js tools, zero external dependencies.
 *
 * These tools make the agent useful without the prismer-workspace plugin.
 * All file paths are resolved relative to the workspace root, with path
 * traversal prevention (`../` rejected).
 *
 * Plugin tools with the same name override builtins (Prismer plugin takes precedence).
 *
 * @module tools/builtins
 */

import { type Tool, type ToolContext } from '../tools.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Path safety ──────────────────────────────────────────

/**
 * Resolve a user-supplied path to an absolute path within the workspace.
 * Throws if the resolved path escapes the workspace root.
 */
export function safePath(userPath: string, workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir, userPath);
  const normalizedWorkspace = path.resolve(workspaceDir);
  if (!resolved.startsWith(normalizedWorkspace + path.sep) && resolved !== normalizedWorkspace) {
    throw new Error(`Path traversal rejected: ${userPath}`);
  }
  return resolved;
}

// ── read_file ────────────────────────────────────────────

const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a file from the workspace. Returns file content with line numbers.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      offset: { type: 'number', description: 'Start line (1-based, default: 1)' },
      limit: { type: 'number', description: 'Max lines to return (default: 2000)' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const filePath = safePath(args.path as string, ctx.workspaceDir);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const offset = Math.max(1, (args.offset as number) ?? 1);
    const limit = (args.limit as number) ?? 2000;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((line, i) => `${offset + i}\t${line}`);
    return numbered.join('\n');
  },
};

// ── write_file ───────────────────────────────────────────

const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file in the workspace. Creates parent directories if needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const filePath = safePath(args.path as string, ctx.workspaceDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, args.content as string, 'utf8');
    const stat = fs.statSync(filePath);
    return `Wrote ${stat.size} bytes to ${args.path}`;
  },
};

// ── list_files ───────────────────────────────────────────

/**
 * Recursive directory listing with optional glob matching.
 * Uses a simple glob matcher (supports `*` and `**`).
 */
function listFilesRecursive(dir: string, base: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const rel = path.relative(base, path.join(dir, entry.name));
    if (entry.name.startsWith('.') && depth > 0) continue; // skip hidden except at root
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results.push(rel + '/');
      results.push(...listFilesRecursive(path.join(dir, entry.name), base, maxDepth, depth + 1));
    } else {
      results.push(rel);
    }
  }
  return results;
}

/** Simple glob match supporting `*` (single segment) and `**` (any depth). */
function globMatch(pattern: string, filePath: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR>>/g, '.*');
  return new RegExp(`^${regexStr}$`).test(filePath);
}

const listFilesTool: Tool = {
  name: 'list_files',
  description: 'List files in the workspace. Supports glob patterns (e.g., "**/*.ts", "src/*.js").',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to workspace root (default: ".")' },
      pattern: { type: 'string', description: 'Glob pattern to filter files (e.g., "**/*.ts")' },
      maxDepth: { type: 'number', description: 'Max directory depth (default: 10)' },
    },
  },
  async execute(args, ctx) {
    const dirPath = safePath((args.path as string) ?? '.', ctx.workspaceDir);
    const maxDepth = (args.maxDepth as number) ?? 10;
    const files = listFilesRecursive(dirPath, dirPath, maxDepth);
    const pattern = args.pattern as string | undefined;
    const filtered = pattern ? files.filter(f => globMatch(pattern, f)) : files;

    if (filtered.length === 0) {
      return 'No files found.';
    }
    const MAX_ENTRIES = 500;
    const truncated = filtered.length > MAX_ENTRIES;
    const output = filtered.slice(0, MAX_ENTRIES).join('\n');
    return truncated ? `${output}\n\n... and ${filtered.length - MAX_ENTRIES} more files` : output;
  },
};

// ── edit_file ────────────────────────────────────────────

const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file by replacing an exact string match. The old_string must appear exactly once in the file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      old_string: { type: 'string', description: 'Exact string to find (must be unique in file)' },
      new_string: { type: 'string', description: 'Replacement string' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args, ctx) {
    const filePath = safePath(args.path as string, ctx.workspaceDir);
    const content = fs.readFileSync(filePath, 'utf8');
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;
    const replaceAll = (args.replace_all as boolean) ?? false;

    if (!content.includes(oldStr)) {
      return `Error: old_string not found in ${args.path}`;
    }

    if (!replaceAll) {
      const firstIdx = content.indexOf(oldStr);
      const lastIdx = content.lastIndexOf(oldStr);
      if (firstIdx !== lastIdx) {
        const count = content.split(oldStr).length - 1;
        return `Error: old_string found ${count} times in ${args.path}. Use replace_all: true or provide a more specific string.`;
      }
    }

    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    fs.writeFileSync(filePath, updated, 'utf8');

    const count = replaceAll ? content.split(oldStr).length - 1 : 1;
    return `Replaced ${count} occurrence(s) in ${args.path}`;
  },
};

// ── grep ─────────────────────────────────────────────────

function grepRecursive(
  dir: string,
  regex: RegExp,
  base: string,
  maxResults: number,
  results: { file: string; line: number; text: string }[],
  depth = 0,
): void {
  if (depth > 20 || results.length >= maxResults) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.name.startsWith('.') && depth > 0) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      grepRecursive(full, regex, base, maxResults, results, depth + 1);
    } else {
      try {
        const content = fs.readFileSync(full, 'utf8');
        const lines = content.split('\n');
        const rel = path.relative(base, full);
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            results.push({ file: rel, line: i + 1, text: lines[i] });
          }
        }
      } catch {
        // skip binary / unreadable files
      }
    }
  }
}

const grepTool: Tool = {
  name: 'grep',
  description: 'Search file contents in the workspace using a regex pattern. Returns matching lines with file paths and line numbers.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search (default: workspace root)' },
      glob: { type: 'string', description: 'File glob filter (e.g., "*.ts")' },
      maxResults: { type: 'number', description: 'Max matches to return (default: 50)' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const searchPath = safePath((args.path as string) ?? '.', ctx.workspaceDir);
    const maxResults = (args.maxResults as number) ?? 50;
    const regex = new RegExp(args.pattern as string, 'g');
    const globPattern = args.glob as string | undefined;

    const results: { file: string; line: number; text: string }[] = [];

    const stat = fs.statSync(searchPath);
    if (stat.isFile()) {
      // Search single file
      const content = fs.readFileSync(searchPath, 'utf8');
      const rel = path.relative(ctx.workspaceDir, searchPath);
      content.split('\n').forEach((line, i) => {
        if (results.length < maxResults && regex.test(line)) {
          results.push({ file: rel, line: i + 1, text: line });
          regex.lastIndex = 0;
        }
      });
    } else {
      grepRecursive(searchPath, regex, ctx.workspaceDir, maxResults, results);
    }

    // Apply glob filter if specified
    const filtered = globPattern
      ? results.filter(r => globMatch(globPattern, r.file) || globMatch(globPattern, path.basename(r.file)))
      : results;

    if (filtered.length === 0) {
      return 'No matches found.';
    }
    return filtered.map(r => `${r.file}:${r.line}\t${r.text}`).join('\n');
  },
};

// ── web_fetch ────────────────────────────────────────────

const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch a URL and return the response body. Supports GET/POST with optional headers and body.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      method: { type: 'string', description: 'HTTP method (default: GET)', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      headers: { type: 'object', description: 'Request headers' },
      body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
      maxBytes: { type: 'number', description: 'Max response bytes to return (default: 100000)' },
    },
    required: ['url'],
  },
  async execute(args) {
    const url = args.url as string;
    const method = (args.method as string) ?? 'GET';
    const headers = (args.headers as Record<string, string>) ?? {};
    const body = args.body as string | undefined;
    const maxBytes = (args.maxBytes as number) ?? 100_000;

    const response = await fetch(url, {
      method,
      headers,
      body: body && method !== 'GET' ? body : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    const truncated = text.length > maxBytes ? text.slice(0, maxBytes) + '\n\n... (truncated)' : text;
    const status = `HTTP ${response.status} ${response.statusText}`;
    return `${status}\n\n${truncated}`;
  },
};

// ── think ────────────────────────────────────────────────

const thinkTool: Tool = {
  name: 'think',
  description: 'A scratchpad for reasoning. Use this to think through complex problems step by step before acting. The thought is recorded but not shown to the user.',
  parameters: {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'Your reasoning or analysis' },
    },
    required: ['thought'],
  },
  async execute() {
    return 'Thought recorded.';
  },
};

// ── Export ────────────────────────────────────────────────

/** All 7 built-in tools. */
export const BUILTIN_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  editFileTool,
  grepTool,
  webFetchTool,
  thinkTool,
];

/**
 * Get built-in tools, optionally excluding names that are already
 * registered (e.g., by a plugin that provides a richer implementation).
 */
export function getBuiltinTools(exclude?: Set<string>): Tool[] {
  if (!exclude || exclude.size === 0) return BUILTIN_TOOLS;
  return BUILTIN_TOOLS.filter(t => !exclude.has(t.name));
}
