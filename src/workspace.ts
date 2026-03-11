/**
 * Workspace Middleware — safe file operations with path validation.
 *
 * The {@link WorkspaceMiddleware} validates all file paths against the
 * workspace root and deny patterns (path traversal, `/etc`, `.env`,
 * credentials) before performing reads, writes, deletes, or listings.
 *
 * @module workspace
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ────────────────────────────────────────────────

export interface FileEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
  timestamp: number;
}

// ── Workspace Middleware ─────────────────────────────────

export class WorkspaceMiddleware {
  private readonly root: string;
  private readonly denyPatterns: RegExp[];

  constructor(workspaceDir: string = '/workspace') {
    this.root = path.resolve(workspaceDir);
    this.denyPatterns = [
      /\.\./, // Path traversal
      /^\/etc\//,
      /^\/proc\//,
      /^\/sys\//,
      /^\/dev\//,
      /\.env$/,
      /credentials\.json$/,
      /\.ssh\//,
      /\.gnupg\//,
    ];
  }

  /** Validate that a path is within workspace and not denied */
  validatePath(filePath: string): { valid: boolean; resolved: string; error?: string } {
    const resolved = path.resolve(this.root, filePath);

    // Must be within workspace root
    if (!resolved.startsWith(this.root)) {
      return { valid: false, resolved, error: `Path escapes workspace: ${filePath}` };
    }

    // Check deny patterns
    for (const pattern of this.denyPatterns) {
      if (pattern.test(filePath) || pattern.test(resolved)) {
        return { valid: false, resolved, error: `Path matches deny pattern: ${filePath}` };
      }
    }

    return { valid: true, resolved };
  }

  /** Read a file safely */
  async read(filePath: string): Promise<{ content: string; mime: string }> {
    const { valid, resolved, error } = this.validatePath(filePath);
    if (!valid) throw new Error(error);

    const content = fs.readFileSync(resolved, 'utf8');
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_MAP[ext] ?? 'text/plain';

    return { content, mime };
  }

  /** Write a file safely */
  async write(filePath: string, content: string): Promise<void> {
    const { valid, resolved, error } = this.validatePath(filePath);
    if (!valid) throw new Error(error);

    // Ensure parent directory exists
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(resolved, content, 'utf8');
  }

  /** List files in a directory */
  async list(dirPath: string, pattern?: string): Promise<string[]> {
    const { valid, resolved, error } = this.validatePath(dirPath);
    if (!valid) throw new Error(error);

    if (!fs.existsSync(resolved)) return [];

    const entries = fs.readdirSync(resolved, { withFileTypes: true, recursive: true });
    let files = entries
      .filter(e => e.isFile())
      .map(e => path.relative(this.root, path.join(e.parentPath ?? resolved, e.name)));

    if (pattern) {
      const regex = globToRegex(pattern);
      files = files.filter(f => regex.test(f));
    }

    return files;
  }

  /** Check if a file exists */
  exists(filePath: string): boolean {
    const { valid, resolved } = this.validatePath(filePath);
    if (!valid) return false;
    return fs.existsSync(resolved);
  }

  /** Delete a file safely */
  async delete(filePath: string): Promise<void> {
    const { valid, resolved, error } = this.validatePath(filePath);
    if (!valid) throw new Error(error);

    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }
  }

  /** Get absolute path (after validation) */
  resolve(filePath: string): string {
    const { valid, resolved, error } = this.validatePath(filePath);
    if (!valid) throw new Error(error);
    return resolved;
  }
}

// ── Helpers ──────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.tex': 'text/x-latex',
  '.bib': 'text/x-bibtex',
  '.py': 'text/x-python',
  '.ipynb': 'application/x-ipynb+json',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
