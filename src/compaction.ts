/**
 * Compaction — auto-summarize dropped conversation turns.
 *
 * When the context window guard truncates messages, this module:
 *   1. Serializes dropped messages into markdown
 *   2. Calls the hidden compaction agent for a concise summary
 *   3. Returns a {@link CompactionResult} to inject into the session
 *
 * {@link memoryFlushBeforeCompaction} extracts long-term facts from
 * the dropped messages and persists them to the {@link MemoryStore}.
 *
 * {@link repairOrphanedToolResults} fixes dangling `tool` messages
 * whose parent `assistant` was truncated (prevents API errors).
 *
 * @module compaction
 */

import type { Provider, Message } from './provider.js';
import { BUILTIN_AGENTS } from './agents.js';
import type { MemoryStore } from './memory.js';

// ── Types ────────────────────────────────────────────────

export interface CompactionResult {
  summary: string;
  droppedCount: number;
  summaryChars: number;
}

// ── Compaction ──────────────────────────────────────────

const COMPACTION_SYSTEM_PROMPT = BUILTIN_AGENTS.find(a => a.id === 'compaction')?.systemPrompt
  ?? 'Summarize the conversation into key facts, decisions, and action items.';

/**
 * Summarize a batch of dropped messages using the compaction agent.
 * Returns a structured CompactionResult. Non-streaming, single-turn.
 */
export async function compactConversation(
  provider: Provider,
  messages: Message[],
  model?: string,
): Promise<CompactionResult> {
  const serialized = serializeMessages(messages);

  const response = await provider.chat({
    messages: [
      { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
      { role: 'user', content: `Summarize this conversation excerpt:\n\n${serialized}` },
    ],
    model,
    maxTokens: 2000,
  });

  const summary = response.text.trim();
  return {
    summary,
    droppedCount: messages.length,
    summaryChars: summary.length,
  };
}

// ── Memory Flush ────────────────────────────────────────

const MEMORY_FLUSH_PROMPT = `You are a memory extraction agent. Given a conversation excerpt that is about to be discarded,
extract ONLY facts worth remembering long-term: key decisions, important file paths, architecture choices,
user preferences, and action items. If nothing is worth remembering, reply with exactly "NO_REPLY".
Be extremely concise — bullet points only.`;

/**
 * Before compaction, extract important facts from dropped messages
 * and persist them to the memory store. Silent LLM turn, non-fatal.
 */
export async function memoryFlushBeforeCompaction(
  provider: Provider,
  droppedMessages: Message[],
  memoryStore: MemoryStore,
  model?: string,
): Promise<void> {
  const serialized = serializeMessages(droppedMessages).slice(0, 8000);

  const response = await provider.chat({
    messages: [
      { role: 'system', content: MEMORY_FLUSH_PROMPT },
      { role: 'user', content: serialized },
    ],
    model,
    maxTokens: 500,
  });

  const text = response.text.trim();
  if (text && text !== 'NO_REPLY') {
    await memoryStore.store(text, ['auto-flush', 'compaction']);
  }
}

// ── Orphan Repair ───────────────────────────────────────

/**
 * Fix orphaned tool_result messages whose corresponding assistant
 * (with matching toolCallId) was dropped during truncation.
 *
 * Orphaned tool messages cause "unexpected tool_use_id" API errors.
 * We convert them into synthetic user messages to preserve context.
 */
export function repairOrphanedToolResults(messages: Message[]): Message[] {
  // Collect all tool_call IDs from assistant messages
  const knownCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        knownCallIds.add(tc.id);
      }
    }
  }

  return messages.map(msg => {
    if (msg.role === 'tool' && msg.toolCallId && !knownCallIds.has(msg.toolCallId)) {
      // Convert orphaned tool result into a user-context message
      const preview = (msg.content ?? '').slice(0, 500);
      return {
        role: 'user' as const,
        content: `[Previous tool result: ${preview}${(msg.content?.length ?? 0) > 500 ? '...' : ''}]`,
      };
    }
    return msg;
  });
}

// ── Helpers ──────────────────────────────────────────────

function serializeMessages(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    const content = (msg.content ?? '').slice(0, 3000);
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const tools = msg.toolCalls.map(tc => tc.function.name).join(', ');
      parts.push(`[${role}] ${content}\n  Tools called: ${tools}`);
    } else if (msg.role === 'tool') {
      parts.push(`[TOOL RESULT] ${content.slice(0, 500)}`);
    } else {
      parts.push(`[${role}] ${content}`);
    }
  }
  return parts.join('\n\n');
}
