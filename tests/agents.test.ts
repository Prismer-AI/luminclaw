/**
 * Tests for Agent Registry — registration, lookup, mentions, delegation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry, BUILTIN_AGENTS, type AgentConfig } from '../src/agents.js';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('registers and retrieves an agent', () => {
    const config: AgentConfig = {
      id: 'test-agent',
      name: 'Test Agent',
      mode: 'primary',
      systemPrompt: 'You are a test agent.',
    };
    registry.register(config);

    expect(registry.get('test-agent')).toEqual(config);
  });

  it('returns undefined for unknown agent', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('registerMany registers multiple agents', () => {
    registry.registerMany(BUILTIN_AGENTS);
    expect(registry.list().length).toBe(BUILTIN_AGENTS.length);
  });

  it('list() returns all agents', () => {
    registry.registerMany(BUILTIN_AGENTS);
    const all = registry.list();
    expect(all.length).toBe(6);
  });

  it('list(mode) filters by mode', () => {
    registry.registerMany(BUILTIN_AGENTS);

    const primary = registry.list('primary');
    expect(primary.length).toBe(1);
    expect(primary[0].id).toBe('researcher');

    const subagents = registry.list('subagent');
    expect(subagents.length).toBe(3);
    expect(subagents.map(a => a.id)).toContain('latex-expert');
    expect(subagents.map(a => a.id)).toContain('data-analyst');
    expect(subagents.map(a => a.id)).toContain('literature-scout');

    const hidden = registry.list('hidden');
    expect(hidden.length).toBe(2);
  });

  it('getDelegatableAgents returns subagent IDs', () => {
    registry.registerMany(BUILTIN_AGENTS);
    const delegatable = registry.getDelegatableAgents();

    expect(delegatable).toContain('latex-expert');
    expect(delegatable).toContain('data-analyst');
    expect(delegatable).toContain('literature-scout');
    expect(delegatable).not.toContain('researcher');
    expect(delegatable).not.toContain('compaction');
  });
});

describe('BUILTIN_AGENTS', () => {
  it('has 6 predefined agents', () => {
    expect(BUILTIN_AGENTS).toHaveLength(6);
  });

  it('includes expected agent IDs', () => {
    const ids = BUILTIN_AGENTS.map(a => a.id);
    expect(ids).toEqual([
      'researcher', 'latex-expert', 'data-analyst',
      'literature-scout', 'compaction', 'summarizer',
    ]);
  });

  it('researcher is primary with all tools', () => {
    const researcher = BUILTIN_AGENTS.find(a => a.id === 'researcher')!;
    expect(researcher.mode).toBe('primary');
    expect(researcher.tools).toBeNull(); // null = all tools
    expect(researcher.maxIterations).toBe(40);
  });

  it('subagents have restricted tool lists', () => {
    const latex = BUILTIN_AGENTS.find(a => a.id === 'latex-expert')!;
    expect(latex.mode).toBe('subagent');
    expect(latex.tools).toContain('latex_compile');
    expect(latex.tools).toContain('bash');
    expect(latex.maxIterations).toBe(20);
  });

  it('hidden agents have empty tool lists', () => {
    const compaction = BUILTIN_AGENTS.find(a => a.id === 'compaction')!;
    expect(compaction.mode).toBe('hidden');
    expect(compaction.tools).toEqual([]);
    expect(compaction.maxIterations).toBe(1);
  });
});

describe('resolveFromMention', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
    registry.registerMany(BUILTIN_AGENTS);
  });

  it('resolves @latex-expert mention', () => {
    const result = registry.resolveFromMention('@latex-expert compile this paper');
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('latex-expert');
    expect(result!.message).toBe('compile this paper');
  });

  it('resolves @data-analyst mention', () => {
    const result = registry.resolveFromMention('@data-analyst plot sine wave');
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('data-analyst');
    expect(result!.message).toBe('plot sine wave');
  });

  it('returns null for no @ mention', () => {
    expect(registry.resolveFromMention('just a regular message')).toBeNull();
  });

  it('returns null for unknown agent mention', () => {
    expect(registry.resolveFromMention('@unknown-agent do something')).toBeNull();
  });

  it('returns null for hidden agent mention', () => {
    expect(registry.resolveFromMention('@compaction summarize this')).toBeNull();
  });

  it('returns null for @mention without message', () => {
    // The regex requires at least a space + content after agent ID
    expect(registry.resolveFromMention('@latex-expert')).toBeNull();
  });
});
