/**
 * Tests for Phase 0 — Agent loop abstraction layer.
 *
 * Covers:
 * - resolveLoopMode() priority: DB > env > default
 * - createAgentLoop() factory + dual-mode fallback
 * - SingleLoopAgent interface compliance + no-op methods
 * - SingleLoopAgent.processMessage() delegation to runAgent()
 * - Config loopMode env var mapping
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock index.ts to prevent the import cascade (index → agent → config Zod v4 crash).
// This mock provides just the runAgent function needed by SingleLoopAgent.
vi.mock('../src/index.js', () => ({
  runAgent: vi.fn(),
}));

// ── resolveLoopMode ──────────────────────────────────────

describe('resolveLoopMode', () => {
  const savedEnv = process.env.LUMIN_LOOP_MODE;

  beforeEach(() => {
    delete process.env.LUMIN_LOOP_MODE;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.LUMIN_LOOP_MODE = savedEnv;
    } else {
      delete process.env.LUMIN_LOOP_MODE;
    }
  });

  it('defaults to single when no env or DB value', async () => {
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode()).toBe('single');
  });

  it('reads LUMIN_LOOP_MODE=dual from env', async () => {
    process.env.LUMIN_LOOP_MODE = 'dual';
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode()).toBe('dual');
  });

  it('reads LUMIN_LOOP_MODE=single from env', async () => {
    process.env.LUMIN_LOOP_MODE = 'single';
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode()).toBe('single');
  });

  it('ignores invalid env values', async () => {
    process.env.LUMIN_LOOP_MODE = 'invalid';
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode()).toBe('single');
  });

  it('DB dual overrides env single', async () => {
    process.env.LUMIN_LOOP_MODE = 'single';
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode('dual')).toBe('dual');
  });

  it('DB single overrides env dual', async () => {
    process.env.LUMIN_LOOP_MODE = 'dual';
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode('single')).toBe('single');
  });

  it('falls through to env when DB value is null', async () => {
    process.env.LUMIN_LOOP_MODE = 'dual';
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode(null)).toBe('dual');
  });

  it('falls through to env when DB value is undefined', async () => {
    process.env.LUMIN_LOOP_MODE = 'dual';
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode(undefined)).toBe('dual');
  });

  it('falls through to env when DB value is unknown string', async () => {
    process.env.LUMIN_LOOP_MODE = 'dual';
    const { resolveLoopMode } = await import('../src/loop/factory.js');
    expect(resolveLoopMode('unknown')).toBe('dual');
  });
});

// ── createAgentLoop ──────────────────────────────────────

describe('createAgentLoop', () => {
  const savedEnv = process.env.LUMIN_LOOP_MODE;

  beforeEach(() => {
    delete process.env.LUMIN_LOOP_MODE;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.LUMIN_LOOP_MODE = savedEnv;
    } else {
      delete process.env.LUMIN_LOOP_MODE;
    }
  });

  it('returns SingleLoopAgent by default', async () => {
    const { createAgentLoop } = await import('../src/loop/factory.js');
    const loop = createAgentLoop();
    expect(loop.mode).toBe('single');
  });

  it('returns SingleLoopAgent for explicit single', async () => {
    const { createAgentLoop } = await import('../src/loop/factory.js');
    const loop = createAgentLoop('single');
    expect(loop.mode).toBe('single');
  });

  it('returns DualLoopAgent when dual is requested', async () => {
    const { createAgentLoop } = await import('../src/loop/factory.js');
    const loop = createAgentLoop('dual');
    expect(loop.mode).toBe('dual');
  });

  it('reads env when no explicit mode', async () => {
    process.env.LUMIN_LOOP_MODE = 'single';
    const { createAgentLoop } = await import('../src/loop/factory.js');
    const loop = createAgentLoop();
    expect(loop.mode).toBe('single');
  });
});

// ── SingleLoopAgent ──────────────────────────────────────

describe('SingleLoopAgent', () => {
  it('has mode = single', async () => {
    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();
    expect(agent.mode).toBe('single');
  });

  it('addArtifact is a no-op (does not throw)', async () => {
    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();
    expect(() => agent.addArtifact({
      artifactId: 'test-1',
      mimeType: 'image/png',
      url: 'data:image/png;base64,abc',
      addedBy: 'user',
      taskId: null,
      createdAt: Date.now(),
    })).not.toThrow();
  });

  it('resume is a no-op (does not throw)', async () => {
    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();
    expect(() => agent.resume('user clarification')).not.toThrow();
  });

  it('cancel is a no-op (does not throw)', async () => {
    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();
    expect(() => agent.cancel()).not.toThrow();
  });

  it('shutdown resolves without error', async () => {
    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();
    await expect(agent.shutdown()).resolves.toBeUndefined();
  });
});

// ── SingleLoopAgent.processMessage (mocked runAgent) ─────

describe('SingleLoopAgent.processMessage', () => {
  let mockRunAgent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const indexMod = await import('../src/index.js');
    mockRunAgent = indexMod.runAgent as ReturnType<typeof vi.fn>;
    mockRunAgent.mockReset();
  });

  it('delegates to runAgent and returns AgentLoopResult', async () => {
    mockRunAgent.mockImplementation(async (_input: unknown, opts: { onResult: (r: unknown, s: string) => void }) => {
      opts.onResult(
        {
          text: 'Hello from mock',
          thinking: 'I thought about it',
          directives: [{ type: 'NOTIFICATION', payload: { message: 'done' } }],
          toolsUsed: ['bash'],
          usage: { promptTokens: 100, completionTokens: 50 },
          iterations: 2,
        },
        'session-123',
      );
    });

    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();

    const result = await agent.processMessage({
      content: 'test message',
      sessionId: 'session-123',
    });

    expect(result.text).toBe('Hello from mock');
    expect(result.thinking).toBe('I thought about it');
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].type).toBe('NOTIFICATION');
    expect(result.toolsUsed).toEqual(['bash']);
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
    expect(result.iterations).toBe(2);
    expect(result.sessionId).toBe('session-123');

    // Verify runAgent was called with correct input shape
    expect(mockRunAgent).toHaveBeenCalledOnce();
    const [input, opts] = mockRunAgent.mock.calls[0];
    expect(input.type).toBe('message');
    expect(input.content).toBe('test message');
    expect(input.sessionId).toBe('session-123');
    expect(typeof opts.onResult).toBe('function');
  });

  it('passes images through to runAgent', async () => {
    mockRunAgent.mockImplementation(async (_input: unknown, opts: { onResult: (r: unknown, s: string) => void }) => {
      opts.onResult({ text: '', directives: [], toolsUsed: [], iterations: 0 }, 'sid');
    });

    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();

    const images = [{ url: 'https://example.com/img.png', mimeType: 'image/png' }];
    await agent.processMessage({ content: 'look at this', images });

    const [input] = mockRunAgent.mock.calls[0];
    expect(input.images).toEqual(images);
  });

  it('passes config through to runAgent', async () => {
    mockRunAgent.mockImplementation(async (_input: unknown, opts: { onResult: (r: unknown, s: string) => void }) => {
      opts.onResult({ text: '', directives: [], toolsUsed: [], iterations: 0 }, 'sid');
    });

    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();

    const config = { model: 'gpt-4o', maxIterations: 10 };
    await agent.processMessage({ content: 'test', config });

    const [input] = mockRunAgent.mock.calls[0];
    expect(input.config).toEqual(config);
  });

  it('passes custom bus from opts to runAgent', async () => {
    mockRunAgent.mockImplementation(async (_input: unknown, opts: { bus: unknown; onResult: (r: unknown, s: string) => void }) => {
      opts.onResult({ text: '', directives: [], toolsUsed: [], iterations: 0 }, 'sid');
    });

    const { EventBus } = await import('../src/sse.js');
    const { SingleLoopAgent } = await import('../src/loop/single.js');

    const agent = new SingleLoopAgent();
    const customBus = new EventBus();
    await agent.processMessage({ content: 'test' }, { bus: customBus });

    const [, opts] = mockRunAgent.mock.calls[0];
    expect(opts.bus).toBe(customBus);
  });

  it('rejects when runAgent throws', async () => {
    mockRunAgent.mockRejectedValue(new Error('LLM provider down'));

    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();

    await expect(agent.processMessage({ content: 'test' }))
      .rejects.toThrow('LLM provider down');
  });

  it('handles missing optional fields in result', async () => {
    mockRunAgent.mockImplementation(async (_input: unknown, opts: { onResult: (r: unknown, s: string) => void }) => {
      opts.onResult(
        { text: 'minimal', iterations: 1 },  // no directives, toolsUsed, thinking, usage
        'session-minimal',
      );
    });

    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();

    const result = await agent.processMessage({ content: 'test' });
    expect(result.text).toBe('minimal');
    expect(result.directives).toEqual([]);
    expect(result.toolsUsed).toEqual([]);
    expect(result.thinking).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(result.iterations).toBe(1);
    expect(result.sessionId).toBe('session-minimal');
  });
});

// ── Config loopMode env var mapping ──────────────────────

describe('config loopMode env mapping', () => {
  const savedEnv = process.env.LUMIN_LOOP_MODE;

  beforeEach(async () => {
    delete process.env.LUMIN_LOOP_MODE;
    const { resetConfig } = await import('../src/config.js');
    resetConfig();
  });

  afterEach(async () => {
    if (savedEnv !== undefined) {
      process.env.LUMIN_LOOP_MODE = savedEnv;
    } else {
      delete process.env.LUMIN_LOOP_MODE;
    }
    const { resetConfig } = await import('../src/config.js');
    resetConfig();
  });

  it('LUMIN_LOOP_MODE=dual is reflected in config', async () => {
    process.env.LUMIN_LOOP_MODE = 'dual';
    const { loadConfig, resetConfig } = await import('../src/config.js');
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.agent.loopMode).toBe('dual');
  });

  it('LUMIN_LOOP_MODE=single is reflected in config', async () => {
    process.env.LUMIN_LOOP_MODE = 'single';
    const { loadConfig, resetConfig } = await import('../src/config.js');
    resetConfig();
    const cfg = loadConfig();
    expect(cfg.agent.loopMode).toBe('single');
  });

  it('accepts loopMode via overrides', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({ agent: { loopMode: 'dual' } });
    expect(cfg.agent.loopMode).toBe('dual');
  });
});

// ── IAgentLoop interface compliance ──────────────────────

describe('IAgentLoop interface compliance', () => {
  it('SingleLoopAgent implements all required methods', async () => {
    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const agent = new SingleLoopAgent();

    // All interface methods exist and are functions
    expect(typeof agent.processMessage).toBe('function');
    expect(typeof agent.addArtifact).toBe('function');
    expect(typeof agent.resume).toBe('function');
    expect(typeof agent.cancel).toBe('function');
    expect(typeof agent.shutdown).toBe('function');

    // mode is readonly and correct
    expect(agent.mode).toBe('single');
  });

  it('multiple instances are independent', async () => {
    const { SingleLoopAgent } = await import('../src/loop/single.js');
    const a = new SingleLoopAgent();
    const b = new SingleLoopAgent();

    // Both are single mode, independent instances
    expect(a.mode).toBe('single');
    expect(b.mode).toBe('single');
    expect(a).not.toBe(b);
  });
});
