import { describe, it, expect } from 'vitest';
import { serializeKnowledgeBaseForMemory } from '../../src/world-model/builder.js';
import type { KnowledgeFact } from '../../src/world-model/types.js';

describe('serializeKnowledgeBaseForMemory', () => {
  it('serializes facts as "key: value" lines', () => {
    const facts: KnowledgeFact[] = [
      { key: 'config.path', value: '/tmp/foo', sourceAgentId: 'agent-1', confidence: 'high' },
      { key: 'budget', value: '$100', sourceAgentId: 'agent-2', confidence: 'medium' },
    ];
    const result = serializeKnowledgeBaseForMemory(facts);
    expect(result).toContain('config.path: /tmp/foo');
    expect(result).toContain('budget: $100');
  });

  it('returns empty string for empty array', () => {
    expect(serializeKnowledgeBaseForMemory([])).toBe('');
  });

  it('orders by confidence (high first)', () => {
    const facts: KnowledgeFact[] = [
      { key: 'low-fact', value: 'maybe', sourceAgentId: 'a', confidence: 'low' },
      { key: 'high-fact', value: 'definitely', sourceAgentId: 'a', confidence: 'high' },
      { key: 'medium-fact', value: 'probably', sourceAgentId: 'a', confidence: 'medium' },
    ];
    const result = serializeKnowledgeBaseForMemory(facts);
    const lines = result.split('\n').filter(Boolean);
    expect(lines[0]).toContain('high-fact');
    expect(lines[1]).toContain('medium-fact');
    expect(lines[2]).toContain('low-fact');
  });
});
