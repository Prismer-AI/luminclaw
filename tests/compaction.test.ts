/**
 * Tests for Compaction — auto-summarize, orphan repair, memory flush
 */

import { describe, it, expect, vi } from 'vitest';
import { compactConversation, repairOrphanedToolResults, memoryFlushBeforeCompaction } from '../src/compaction.js';
import type { Provider, ChatResponse, Message } from '../src/provider.js';
import type { MemoryStore } from '../src/memory.js';

// ── Mock Provider ──────────────────────────────────────

function mockProvider(responseText: string): Provider {
  return {
    name: () => 'mock',
    chat: async (): Promise<ChatResponse> => ({ text: responseText }),
  };
}

// ── compactConversation ────────────────────────────────

describe('compactConversation', () => {
  it('returns summary from LLM response', async () => {
    const provider = mockProvider('Key fact: user prefers TypeScript.');
    const messages: Message[] = [
      { role: 'user', content: 'I prefer TypeScript over JavaScript.' },
      { role: 'assistant', content: 'Got it, noted.' },
      { role: 'user', content: 'Also use Vitest for testing.' },
    ];

    const result = await compactConversation(provider, messages);
    expect(result.summary).toBe('Key fact: user prefers TypeScript.');
    expect(result.droppedCount).toBe(3);
    expect(result.summaryChars).toBeGreaterThan(0);
  });

  it('trims whitespace from summary', async () => {
    const provider = mockProvider('  summary with spaces  \n');
    const result = await compactConversation(provider, [
      { role: 'user', content: 'test' },
    ]);
    expect(result.summary).toBe('summary with spaces');
  });

  it('handles empty messages', async () => {
    const provider = mockProvider('Nothing to summarize.');
    const result = await compactConversation(provider, []);
    expect(result.droppedCount).toBe(0);
    expect(result.summary).toBe('Nothing to summarize.');
  });
});

// ── repairOrphanedToolResults ──────────────────────────

describe('repairOrphanedToolResults', () => {
  it('keeps tool results with matching assistant tool calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant', content: null,
        toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
      },
      { role: 'tool', content: 'Echo result', toolCallId: 'tc-1' },
    ];
    const repaired = repairOrphanedToolResults(messages);
    expect(repaired[1].role).toBe('tool');
    expect(repaired[1].content).toBe('Echo result');
  });

  it('converts orphaned tool results into user messages', () => {
    const messages: Message[] = [
      { role: 'tool', content: 'Orphaned result', toolCallId: 'tc-missing' },
      { role: 'user', content: 'Regular message' },
    ];
    const repaired = repairOrphanedToolResults(messages);
    expect(repaired[0].role).toBe('user');
    expect(repaired[0].content).toContain('[Previous tool result:');
    expect(repaired[0].content).toContain('Orphaned result');
    expect(repaired[1].role).toBe('user');
  });

  it('truncates long orphaned content to 500 chars', () => {
    const longContent = 'X'.repeat(1000);
    const messages: Message[] = [
      { role: 'tool', content: longContent, toolCallId: 'tc-gone' },
    ];
    const repaired = repairOrphanedToolResults(messages);
    expect(repaired[0].role).toBe('user');
    expect(repaired[0].content!.length).toBeLessThan(600);
    expect(repaired[0].content).toContain('...');
  });

  it('preserves non-orphaned messages unchanged', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const repaired = repairOrphanedToolResults(messages);
    expect(repaired).toEqual(messages);
  });
});

// ── memoryFlushBeforeCompaction ────────────────────────

describe('memoryFlushBeforeCompaction', () => {
  it('stores extracted facts to memory', async () => {
    const provider = mockProvider('- User chose file-based memory\n- Workspace dir is /workspace');
    const storeFn = vi.fn();
    const memoryStore = { store: storeFn } as unknown as MemoryStore;

    await memoryFlushBeforeCompaction(provider, [
      { role: 'user', content: 'Let us use file-based memory.' },
      { role: 'assistant', content: 'Done.' },
    ], memoryStore);

    expect(storeFn).toHaveBeenCalledOnce();
    expect(storeFn).toHaveBeenCalledWith(
      expect.stringContaining('file-based memory'),
      ['auto-flush', 'compaction'],
    );
  });

  it('does not store when LLM returns NO_REPLY', async () => {
    const provider = mockProvider('NO_REPLY');
    const storeFn = vi.fn();
    const memoryStore = { store: storeFn } as unknown as MemoryStore;

    await memoryFlushBeforeCompaction(provider, [
      { role: 'user', content: 'Hi' },
    ], memoryStore);

    expect(storeFn).not.toHaveBeenCalled();
  });

  it('does not store empty responses', async () => {
    const provider = mockProvider('');
    const storeFn = vi.fn();
    const memoryStore = { store: storeFn } as unknown as MemoryStore;

    await memoryFlushBeforeCompaction(provider, [
      { role: 'user', content: 'Hi' },
    ], memoryStore);

    expect(storeFn).not.toHaveBeenCalled();
  });
});
