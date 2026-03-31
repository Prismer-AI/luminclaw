/**
 * Microcompact — zero-LLM-cost incremental context compression.
 *
 * Mechanically clears old tool result contents, keeping only the most
 * recent {@link keepRecent} results intact. This dramatically reduces
 * context usage without any LLM call — tool results are typically the
 * largest messages in a conversation.
 *
 * Inspired by Claude Code's tiered compaction: microcompact is the
 * cheapest first layer that runs before every LLM call.
 *
 * @module microcompact
 */

import type { Message } from './provider.js';

/** Marker text replacing cleared tool results. */
export const CLEARED_MARKER = '[Old tool result cleared]';

/** Set of tool names whose results are safe to clear (read-only or reproducible). */
const COMPACTABLE_TOOLS = new Set([
  'bash', 'read_file', 'grep', 'glob', 'web_search', 'web_fetch',
  'file_read', 'file_write', 'file_edit', 'search', 'ls',
]);

/**
 * Clear old tool result contents, keeping the most recent ones intact.
 *
 * @param messages - Full conversation message array (mutated in-place for efficiency).
 * @param keepRecent - Number of recent tool results to preserve (default 5).
 * @returns The same array with old tool results cleared.
 */
export function microcompact(messages: Message[], keepRecent = 5): Message[] {
  // Collect indices of tool-result messages
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool' && messages[i].content && messages[i].content !== CLEARED_MARKER) {
      toolIndices.push(i);
    }
  }

  if (toolIndices.length <= keepRecent) return messages;

  // Clear all but the most recent
  const toClear = toolIndices.slice(0, toolIndices.length - keepRecent);
  let clearedChars = 0;
  for (const idx of toClear) {
    clearedChars += messages[idx].content!.length;
    messages[idx] = { ...messages[idx], content: CLEARED_MARKER };
  }

  return messages;
}

/**
 * Check if a tool name's results are safe to compact.
 * Custom tools not in the default set are preserved by default.
 */
export function isCompactableTool(name: string): boolean {
  return COMPACTABLE_TOOLS.has(name);
}
