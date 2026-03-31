/**
 * Memory — pluggable persistent memory with a file-based default backend.
 *
 * The {@link MemoryBackend} interface defines the contract for all memory
 * backends (file, cloud, vector, etc.). {@link FileMemoryBackend} is the
 * zero-dependency default that stores entries as dated markdown files.
 *
 * {@link MemoryStore} is the public facade — it wraps any backend and
 * exposes both the original string API (`store`/`recall`/`loadRecentContext`)
 * and a new structured API (`search` returning {@link MemorySearchResult}[]).
 *
 * @module memory
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────

/** A single memory search result returned by a backend. */
export interface MemorySearchResult {
  /** The matched memory content. */
  text: string;
  /** Date of the memory entry (ISO format YYYY-MM-DD). */
  date: string;
  /** Relevance score, normalized 0–1 (1 = perfect match). */
  score: number;
  /** Tags associated with the entry (if backend supports tags). */
  tags?: string[];
  /** Backend-specific source identifier (file path, record ID, etc.). */
  source?: string;
}

/** Capabilities declared by a memory backend. */
export interface MemoryCapabilities {
  /** Supports embedding-based semantic similarity search. */
  semanticSearch: boolean;
  /** Supports filtering search results by tags. */
  tagFiltering: boolean;
  /** Storage limit in bytes (undefined = unlimited). */
  maxStorageBytes?: number;
}

/** Options for a memory search operation. */
export interface MemorySearchOptions {
  /** Maximum number of results to return. */
  maxResults?: number;
  /** Maximum total characters across all results. */
  maxChars?: number;
  /** Filter by tags (requires `tagFiltering` capability). */
  tags?: string[];
}

// ── Backend Interface ────────────────────────────────────

/**
 * Pluggable storage backend for the memory system.
 *
 * Implementations must support at least `store()` and `search()`.
 * The `recent()` method provides optimized access to recent entries;
 * backends without efficient recency support can delegate to `search()`.
 */
export interface MemoryBackend {
  /** Human-readable backend name (e.g., `'file'`, `'cloud'`, `'vector'`). */
  readonly name: string;

  /** Persist a memory entry. */
  store(content: string, tags?: string[]): Promise<void>;

  /** Search memories by query, returning structured results. */
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;

  /** Load recent memory entries (today + yesterday by default). */
  recent(maxChars?: number): Promise<MemorySearchResult[]>;

  /** Declare what this backend supports. */
  capabilities(): MemoryCapabilities;

  /** Release resources (close connections, flush buffers). */
  close(): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Split a large memory entry into turn-level chunks for finer-grained search.
 *
 * Groups consecutive lines into chunks of ~3 turns, with 1-turn overlap
 * to preserve context across chunk boundaries. A "turn" is a line that
 * starts with a speaker pattern (e.g., "Jon: ...", "[USER] ...").
 *
 * Entries that don't look like conversation (e.g., bullet-point notes)
 * are split by paragraph breaks instead.
 */
function splitIntoChunks(text: string): string[] {
  const lines = text.split('\n');

  // Detect if this is conversational (most lines start with "Name: ...")
  const turnPattern = /^(?:\w[\w\s]*?:|##?\s|\[(?:USER|ASSISTANT)\])/;
  const turnLines = lines.filter(l => turnPattern.test(l.trim()));
  const isConversational = turnLines.length >= 3;

  if (isConversational) {
    // Group by turns (each turn starts with speaker pattern)
    const turns: string[] = [];
    let current = '';
    for (const line of lines) {
      if (turnPattern.test(line.trim()) && current) {
        turns.push(current.trim());
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }
    if (current.trim()) turns.push(current.trim());

    // Sliding window: 3 turns per chunk, 1 turn overlap
    const WINDOW = 3;
    const STEP = 2;
    const chunks: string[] = [];
    for (let i = 0; i < turns.length; i += STEP) {
      const window = turns.slice(i, i + WINDOW);
      chunks.push(window.join('\n'));
    }
    // Always include the full entry as a candidate too (for broad matches)
    if (chunks.length > 1) {
      chunks.push(text.trim());
    }
    return chunks;
  }

  // Non-conversational: split by paragraph breaks
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  if (paragraphs.length <= 1) return [text];

  // Group 2-3 paragraphs per chunk with overlap
  const chunks: string[] = [];
  for (let i = 0; i < paragraphs.length; i += 2) {
    chunks.push(paragraphs.slice(i, i + 3).join('\n\n'));
  }
  if (chunks.length > 1) {
    chunks.push(text.trim());
  }
  return chunks;
}

// ── FileMemoryBackend ────────────────────────────────────

/**
 * File-based memory backend — zero dependencies.
 *
 * Stores entries as dated markdown files (`YYYY-MM-DD.md`) under
 * `{workspaceDir}/.prismer/memory/`. Search is keyword-based with
 * scores normalized to 0–1 (hit ratio).
 */
export class FileMemoryBackend implements MemoryBackend {
  readonly name = 'file';
  private dir: string;

  constructor(workspaceDir: string) {
    this.dir = join(workspaceDir, '.prismer', 'memory');
  }

  async store(content: string, tags?: string[]): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const today = new Date().toISOString().split('T')[0];
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const tagStr = tags?.length ? ` — [${tags.join(', ')}]` : '';

    const entry = `## ${time}${tagStr}\n${content.trim()}\n\n---\n\n`;
    const filePath = join(this.dir, `${today}.md`);

    let existing = '';
    if (existsSync(filePath)) {
      existing = readFileSync(filePath, 'utf-8');
    }
    writeFileSync(filePath, existing + entry, 'utf-8');
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    if (!existsSync(this.dir)) return [];
    const maxChars = options?.maxChars ?? 4000;

    const files = readdirSync(this.dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse(); // newest first

    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return [];

    // P1: Multi-query — when query has 5+ keywords, also search sub-groups
    // to catch entries that match a focused subset of the question
    const keywordSets: string[][] = [keywords];
    if (keywords.length >= 5) {
      // Split into overlapping windows of 3 keywords
      for (let i = 0; i <= keywords.length - 3; i += 2) {
        keywordSets.push(keywords.slice(i, i + 3));
      }
    }

    const scored: MemorySearchResult[] = [];
    const seen = new Set<string>(); // dedup by text hash

    for (const file of files) {
      const date = file.replace('.md', '');
      const content = readFileSync(join(this.dir, file), 'utf-8');
      const entries = content.split(/\n---\n/).filter(e => e.trim());

      for (const entry of entries) {
        // P0: Turn-level chunking — split large entries into individual
        // turns (~1-3 lines each) for finer-grained matching.
        // Small entries (< 500 chars) are searched as-is.
        const chunks = entry.length > 500
          ? splitIntoChunks(entry)
          : [entry];

        for (const chunk of chunks) {
          const lower = chunk.toLowerCase();
          const trimmed = chunk.trim();
          if (!trimmed || trimmed.length < 10) continue;

          const dedup = trimmed.slice(0, 100);
          if (seen.has(dedup)) continue;

          // Score against all keyword sets, take best
          let bestScore = 0;
          for (const kws of keywordSets) {
            const hits = kws.filter(kw => lower.includes(kw)).length;
            const score = hits / kws.length;
            if (score > bestScore) bestScore = score;
          }

          if (bestScore > 0) {
            seen.add(dedup);
            scored.push({
              text: trimmed,
              date,
              score: bestScore,
              source: join(this.dir, file),
            });
          }
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);

    // Apply maxChars budget
    const results: MemorySearchResult[] = [];
    let total = 0;
    for (const item of scored) {
      if (options?.maxResults && results.length >= options.maxResults) break;
      if (total + item.text.length > maxChars) break;
      results.push(item);
      total += item.text.length + item.date.length + 3;
    }

    return results;
  }

  async recent(maxChars: number = 3000): Promise<MemorySearchResult[]> {
    if (!existsSync(this.dir)) return [];

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const dates = [
      today.toISOString().split('T')[0],
      yesterday.toISOString().split('T')[0],
    ];

    const results: MemorySearchResult[] = [];
    let total = 0;

    for (const date of dates) {
      const filePath = join(this.dir, `${date}.md`);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;

      if (total + content.length > maxChars) {
        const remaining = maxChars - total;
        if (remaining > 100) {
          results.push({ text: content.slice(0, remaining), date, score: 1.0, source: filePath });
        }
        break;
      }

      results.push({ text: content, date, score: 1.0, source: filePath });
      total += content.length;
    }

    return results;
  }

  capabilities(): MemoryCapabilities {
    return { semanticSearch: false, tagFiltering: false };
  }

  async close(): Promise<void> {
    // No resources to release for file-based backend.
  }
}

// ── MemoryStore (facade) ─────────────────────────────────

/**
 * Public API facade for memory operations.
 *
 * Wraps a {@link MemoryBackend} and provides both the original string-based
 * API (`store`/`recall`/`loadRecentContext`) and the new structured API
 * (`search` returning {@link MemorySearchResult}[]).
 *
 * Backward-compatible: `new MemoryStore(workspaceDir)` still works,
 * auto-creating a {@link FileMemoryBackend}.
 */
export class MemoryStore {
  private backend: MemoryBackend;

  /**
   * @param backendOrDir — Either a {@link MemoryBackend} instance, or a
   *   workspace directory path (creates {@link FileMemoryBackend}).
   */
  constructor(backendOrDir: MemoryBackend | string) {
    if (typeof backendOrDir === 'string') {
      this.backend = new FileMemoryBackend(backendOrDir);
    } else {
      this.backend = backendOrDir;
    }
  }

  /** Persist a memory entry (delegates to backend). */
  async store(content: string, tags?: string[]): Promise<void> {
    return this.backend.store(content, tags);
  }

  /**
   * Keyword-based recall — returns matching entries as a plain string.
   * This is the backward-compatible API used by the `memory_recall` tool.
   */
  async recall(query: string, maxChars: number = 4000): Promise<string> {
    const results = await this.backend.search(query, { maxChars });
    return MemoryStore.formatResults(results);
  }

  /**
   * Structured search — returns {@link MemorySearchResult}[] for richer consumers.
   */
  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return this.backend.search(query, options);
  }

  /** Load recent memory for system prompt injection. */
  async loadRecentContext(maxChars: number = 3000): Promise<string> {
    const results = await this.backend.recent(maxChars);
    if (results.length === 0) return '';

    // Group by date for readability
    const byDate = new Map<string, string[]>();
    for (const r of results) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date)!.push(r.text);
    }

    const parts: string[] = [];
    let total = 0;
    for (const [date, texts] of byDate) {
      const chunk = `### ${date}\n${texts.join('\n\n---\n\n')}`;
      if (total + chunk.length > maxChars) {
        const remaining = maxChars - total;
        if (remaining > 100) parts.push(chunk.slice(0, remaining));
        break;
      }
      parts.push(chunk);
      total += chunk.length;
    }

    return parts.join('\n\n');
  }

  /** Backend capabilities (passthrough). */
  capabilities(): MemoryCapabilities {
    return this.backend.capabilities();
  }

  /** Backend name. */
  get backendName(): string {
    return this.backend.name;
  }

  /** Release backend resources. */
  async close(): Promise<void> {
    return this.backend.close();
  }

  /** Format search results into a plain string (used by recall). */
  private static formatResults(results: MemorySearchResult[]): string {
    if (results.length === 0) return '';
    return results.map(r => `[${r.date}] ${r.text}`).join('\n\n');
  }
}
