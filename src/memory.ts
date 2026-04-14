/**
 * Memory — pluggable persistent memory with a file-based default backend.
 *
 * The {@link MemoryBackend} interface defines the contract for all memory
 * backends (file, cloud, vector, etc.). The file-based default backend
 * ({@link FileMemoryBackend}) lives in `memory-file-backend.ts` — Node-only.
 *
 * {@link MemoryStore} is the public facade — it wraps any backend and
 * exposes both the original string API (`store`/`recall`/`loadRecentContext`)
 * and a new structured API (`search` returning {@link MemorySearchResult}[]).
 *
 * Embed note: MemoryStore only accepts a MemoryBackend instance (no string path).
 * To create a file-backed store in Node environments, pass a FileMemoryBackend
 * from `memory-file-backend.ts`.
 *
 * @module memory
 */

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

// ── MemoryStore (facade) ─────────────────────────────────

/**
 * Public API facade for memory operations.
 *
 * Wraps a {@link MemoryBackend} and provides both the original string-based
 * API (`store`/`recall`/`loadRecentContext`) and the new structured API
 * (`search` returning {@link MemorySearchResult}[]).
 *
 * Node environments: use `new MemoryStore(new FileMemoryBackend(workspaceDir))`
 * (import FileMemoryBackend from `./memory-file-backend.js`).
 * Embedded contexts: supply any MemoryBackend implementation.
 */
export class MemoryStore {
  private backend: MemoryBackend;

  /**
   * @param backend — A {@link MemoryBackend} instance.
   */
  constructor(backend: MemoryBackend) {
    this.backend = backend;
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
