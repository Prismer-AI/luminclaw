/**
 * Tests for microcompact.ts — zero-LLM-cost tool result clearing
 */

import { describe, it, expect } from 'vitest';
import { microcompact, CLEARED_MARKER } from '../src/microcompact.js';
import type { Message } from '../src/provider.js';

function toolResult(id: string, content: string): Message {
  return { role: 'tool', content, toolCallId: id };
}

describe('microcompact', () => {
  it('does nothing when tool results <= keepRecent', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      toolResult('t1', 'result 1'),
      toolResult('t2', 'result 2'),
    ];
    const result = microcompact(messages, 5);
    expect(result[2].content).toBe('result 1');
    expect(result[3].content).toBe('result 2');
  });

  it('clears old tool results, keeps recent', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      toolResult('t1', 'old result 1'),
      toolResult('t2', 'old result 2'),
      toolResult('t3', 'old result 3'),
      { role: 'user', content: 'question' },
      toolResult('t4', 'recent result 1'),
      toolResult('t5', 'recent result 2'),
    ];

    microcompact(messages, 2);

    expect(messages[1].content).toBe(CLEARED_MARKER);
    expect(messages[2].content).toBe(CLEARED_MARKER);
    expect(messages[3].content).toBe(CLEARED_MARKER);
    expect(messages[5].content).toBe('recent result 1');
    expect(messages[6].content).toBe('recent result 2');
  });

  it('does not clear non-tool messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user message' },
      toolResult('t1', 'old'),
      toolResult('t2', 'old'),
      toolResult('t3', 'recent'),
    ];

    microcompact(messages, 1);

    expect(messages[0].content).toBe('system prompt');
    expect(messages[1].content).toBe('user message');
    expect(messages[2].content).toBe(CLEARED_MARKER);
    expect(messages[3].content).toBe(CLEARED_MARKER);
    expect(messages[4].content).toBe('recent');
  });

  it('does not re-clear already cleared results', () => {
    const messages: Message[] = [
      toolResult('t1', CLEARED_MARKER),
      toolResult('t2', 'actual content'),
      toolResult('t3', 'actual content 2'),
    ];

    microcompact(messages, 1);

    // t1 was already cleared, shouldn't count. t2 should be cleared, t3 kept.
    expect(messages[0].content).toBe(CLEARED_MARKER);
    expect(messages[1].content).toBe(CLEARED_MARKER);
    expect(messages[2].content).toBe('actual content 2');
  });

  it('returns the same array reference', () => {
    const messages: Message[] = [toolResult('t1', 'data')];
    const result = microcompact(messages, 5);
    expect(result).toBe(messages);
  });
});
