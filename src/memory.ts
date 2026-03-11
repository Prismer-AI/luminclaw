/**
 * Memory — file-based persistent memory for cross-session context.
 *
 * The {@link MemoryStore} persists memories as dated markdown files
 * under `{workspaceDir}/.prismer/memory/`. Entries are separated
 * by `---` dividers and optionally tagged.
 *
 * Recall uses simple keyword matching (no vector DB), sorted by
 * relevance then recency. Recent memory (today + yesterday) is
 * auto-loaded into the system prompt via {@link MemoryStore.loadRecentContext}.
 *
 * @module memory
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── MemoryStore ─────────────────────────────────────────

export class MemoryStore {
  private dir: string;

  constructor(workspaceDir: string) {
    this.dir = join(workspaceDir, '.prismer', 'memory');
  }

  /** Append a memory entry to today's file */
  async store(content: string, tags?: string[]): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
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

  /** Keyword-based recall: search entries by query, return top matches */
  async recall(query: string, maxChars: number = 4000): Promise<string> {
    if (!existsSync(this.dir)) return '';

    const files = readdirSync(this.dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse(); // newest first

    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length === 0) return '';

    const scored: { text: string; score: number; date: string }[] = [];

    for (const file of files) {
      const date = file.replace('.md', '');
      const content = readFileSync(join(this.dir, file), 'utf-8');
      const entries = content.split(/\n---\n/).filter(e => e.trim());

      for (const entry of entries) {
        const lower = entry.toLowerCase();
        const hits = keywords.filter(kw => lower.includes(kw)).length;
        if (hits > 0) {
          scored.push({ text: entry.trim(), score: hits, date });
        }
      }
    }

    // Sort by score desc, then by date desc (already in order)
    scored.sort((a, b) => b.score - a.score);

    const parts: string[] = [];
    let total = 0;
    for (const item of scored) {
      if (total + item.text.length > maxChars) break;
      parts.push(`[${item.date}] ${item.text}`);
      total += item.text.length + item.date.length + 3;
    }

    return parts.join('\n\n');
  }

  /** Load recent memory (today + yesterday) for system prompt injection */
  async loadRecentContext(maxChars: number = 3000): Promise<string> {
    if (!existsSync(this.dir)) return '';

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const dates = [
      today.toISOString().split('T')[0],
      yesterday.toISOString().split('T')[0],
    ];

    const parts: string[] = [];
    let total = 0;

    for (const date of dates) {
      const filePath = join(this.dir, `${date}.md`);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;

      const chunk = `### ${date}\n${content}`;
      if (total + chunk.length > maxChars) {
        // Partial include
        const remaining = maxChars - total;
        if (remaining > 100) {
          parts.push(chunk.slice(0, remaining));
        }
        break;
      }
      parts.push(chunk);
      total += chunk.length;
    }

    return parts.join('\n\n');
  }
}
