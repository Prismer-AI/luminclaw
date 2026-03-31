/**
 * Compaction — auto-summarize dropped conversation turns.
 *
 * When the context window guard truncates messages, this module:
 *   1. Serializes dropped messages into markdown
 *   2. Calls the hidden compaction agent for a structured summary
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

// ── Structured Compaction Prompt ─────────────────────────

const STRUCTURED_COMPACT_PROMPT = `You are a conversation summarizer for an AI agent system. Given a conversation excerpt that was truncated from context, produce a structured summary.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Structure your summary with these sections:

1. **Primary Request**: The user's original goal (1-2 sentences)
2. **Key Files & Code**: File paths discussed with relevant code snippets — preserve exact code, do NOT paraphrase
3. **Decisions Made**: Technical decisions and their rationale
4. **Errors & Fixes**: Any errors encountered and how they were resolved
5. **Current State**: What was last being worked on (precise, with file names)
6. **Pending Work**: Tasks not yet completed

Rules:
- Preserve exact code snippets and file paths — these are critical for continuity
- Keep tool names and their exact outputs when relevant
- Be concise but complete — this summary replaces the original messages
- If a section has nothing relevant, skip it entirely`;

// ── Compaction ──────────────────────────────────────────

const FALLBACK_SYSTEM_PROMPT = BUILTIN_AGENTS.find(a => a.id === 'compaction')?.systemPrompt
  ?? STRUCTURED_COMPACT_PROMPT;

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
      { role: 'system', content: STRUCTURED_COMPACT_PROMPT },
      { role: 'user', content: `Summarize this conversation excerpt:\n\n${serialized}` },
    ],
    model,
    maxTokens: 4000,
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
