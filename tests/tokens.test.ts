/**
 * Tests for tokens.ts — token estimation
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessageTokens } from '../src/tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates English text (~4 chars per token)', () => {
    const text = 'Hello world, this is a test.'; // 28 chars
    const tokens = estimateTokens(text);
    // 28/4 * 1.33 ≈ 9.3 → 10
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
  });

  it('estimates CJK text (~2 chars per token)', () => {
    const text = '你好世界这是测试'; // 8 CJK chars
    const tokens = estimateTokens(text);
    // 8/2 * 1.33 ≈ 5.3 → 6
    expect(tokens).toBeGreaterThan(3);
    expect(tokens).toBeLessThan(15);
  });

  it('handles mixed text', () => {
    const text = 'Hello 你好 world 世界';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(3);
    expect(tokens).toBeLessThan(20);
  });
});

describe('estimateMessageTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessageTokens([])).toBe(0);
  });

  it('adds overhead per message', () => {
    const tokens = estimateMessageTokens([
      { role: 'user', content: null },
    ]);
    expect(tokens).toBe(4); // just overhead
  });

  it('sums across messages', () => {
    const tokens = estimateMessageTokens([
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(tokens).toBeGreaterThan(8); // 2 * 4 overhead + text
  });
});
