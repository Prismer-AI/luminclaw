/**
 * Tests for Config — LuminConfigSchema, loadConfig, env var mapping
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig, LuminConfigSchema, createConfig, type LuminConfig } from '../src/config.js';

describe('LuminConfigSchema defaults', () => {
  it('parses empty object with all defaults', () => {
    const config = LuminConfigSchema.parse({});
    expect(config.port).toBe(3001);
    expect(config.host).toBe('0.0.0.0');
    expect(config.llm.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.llm.model).toBe('gpt-4o');
    expect(config.llm.maxTokens).toBe(8192);
    expect(config.agent.maxIterations).toBe(40);
    expect(config.agent.maxContextChars).toBe(600_000);
    expect(config.agent.doomLoopThreshold).toBe(3);
    expect(config.approval.timeoutMs).toBe(30_000);
    expect(config.approval.sensitiveTools).toEqual(['bash']);
    expect(config.workspace.dir).toBe('./workspace');
    expect(config.session.maxIdleMs).toBe(30 * 60_000);
    expect(config.server.shutdownTimeoutMs).toBe(5_000);
    expect(config.eventBus.maxBuffer).toBe(1000);
    expect(config.log.level).toBe('info');
    expect(config.prismer.agentId).toBe('default');
  });

  it('parses nested overrides', () => {
    const config = LuminConfigSchema.parse({
      port: 8080,
      llm: { model: 'gpt-4o', maxTokens: 4096 },
      agent: { maxIterations: 20 },
    });
    expect(config.port).toBe(8080);
    expect(config.llm.model).toBe('gpt-4o');
    expect(config.llm.maxTokens).toBe(4096);
    expect(config.llm.baseUrl).toBe('https://api.openai.com/v1'); // default preserved
    expect(config.agent.maxIterations).toBe(20);
    expect(config.agent.maxContextChars).toBe(600_000); // default preserved
  });
});

describe('loadConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'LUMIN_PORT', 'OPENAI_API_BASE_URL', 'OPENAI_API_KEY',
    'AGENT_DEFAULT_MODEL', 'MODEL_FALLBACK_CHAIN', 'MAX_CONTEXT_CHARS',
    'APPROVAL_TIMEOUT_MS', 'SENSITIVE_TOOLS', 'WORKSPACE_DIR',
    'PRISMER_PLUGIN_PATH', 'AGENT_TEMPLATE', 'LOG_LEVEL', 'DEBUG',
    'PRISMER_API_BASE_URL', 'AGENT_ID', 'WORKSPACE_ID',
    'PRISMER_IM_BASE_URL', 'PRISMER_IM_CONVERSATION_ID', 'PRISMER_IM_TOKEN',
  ];

  beforeEach(() => {
    resetConfig();
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    resetConfig();
  });

  it('returns defaults when no env vars set', () => {
    const config = loadConfig();
    expect(config.port).toBe(3001);
    expect(config.llm.model).toBe('gpt-4o');
  });

  it('reads LUMIN_PORT from env', () => {
    process.env.LUMIN_PORT = '8080';
    const config = loadConfig();
    expect(config.port).toBe(8080);
  });

  it('reads OPENAI_API_BASE_URL from env', () => {
    process.env.OPENAI_API_BASE_URL = 'http://myserver:5000/v1';
    const config = loadConfig();
    expect(config.llm.baseUrl).toBe('http://myserver:5000/v1');
  });

  it('reads AGENT_DEFAULT_MODEL and strips prefix', () => {
    process.env.AGENT_DEFAULT_MODEL = 'prismer-gateway/us-kimi-k2.5';
    const config = loadConfig();
    expect(config.llm.model).toBe('us-kimi-k2.5');
  });

  it('reads MODEL_FALLBACK_CHAIN as array', () => {
    process.env.MODEL_FALLBACK_CHAIN = 'gpt-4o,claude-sonnet,kimi-k2.5';
    const config = loadConfig();
    expect(config.llm.fallbackModels).toEqual(['gpt-4o', 'claude-sonnet', 'kimi-k2.5']);
  });

  it('reads MAX_CONTEXT_CHARS from env', () => {
    process.env.MAX_CONTEXT_CHARS = '400000';
    const config = loadConfig();
    expect(config.agent.maxContextChars).toBe(400_000);
  });

  it('reads APPROVAL_TIMEOUT_MS from env', () => {
    process.env.APPROVAL_TIMEOUT_MS = '60000';
    const config = loadConfig();
    expect(config.approval.timeoutMs).toBe(60_000);
  });

  it('reads SENSITIVE_TOOLS as array', () => {
    process.env.SENSITIVE_TOOLS = 'bash,docker,kubectl';
    const config = loadConfig();
    expect(config.approval.sensitiveTools).toEqual(['bash', 'docker', 'kubectl']);
  });

  it('reads WORKSPACE_DIR from env', () => {
    process.env.WORKSPACE_DIR = '/home/user/workspace';
    const config = loadConfig();
    expect(config.workspace.dir).toBe('/home/user/workspace');
  });

  it('reads LOG_LEVEL from env', () => {
    process.env.LOG_LEVEL = 'DEBUG';
    const config = loadConfig();
    expect(config.log.level).toBe('debug');
  });

  it('reads Prismer IM config from env', () => {
    process.env.PRISMER_IM_BASE_URL = 'https://im.prismer.cloud';
    process.env.PRISMER_IM_CONVERSATION_ID = 'conv-123';
    process.env.PRISMER_IM_TOKEN = 'tok-abc';
    const config = loadConfig();
    expect(config.prismer.imBaseUrl).toBe('https://im.prismer.cloud');
    expect(config.prismer.imConversationId).toBe('conv-123');
    expect(config.prismer.imToken).toBe('tok-abc');
  });

  it('caches config on subsequent calls', () => {
    const c1 = loadConfig();
    const c2 = loadConfig();
    expect(c1).toBe(c2); // same reference
  });

  it('does not cache when overrides provided', () => {
    const c1 = loadConfig();
    const c2 = loadConfig({ port: 9999 });
    expect(c1).not.toBe(c2);
    expect(c2.port).toBe(9999);
    // Original cache unchanged
    const c3 = loadConfig();
    expect(c3.port).toBe(3001);
  });

  it('merges overrides with env values', () => {
    process.env.OPENAI_API_KEY = 'env-key';
    const config = loadConfig({ llm: { model: 'override-model' } });
    expect(config.llm.apiKey).toBe('env-key');
    expect(config.llm.model).toBe('override-model');
  });
});

describe('resetConfig', () => {
  it('clears cache so next loadConfig re-reads env', () => {
    const c1 = loadConfig();
    resetConfig();
    process.env.LUMIN_PORT = '7777';
    const c2 = loadConfig();
    expect(c2.port).toBe(7777);
    // cleanup
    delete process.env.LUMIN_PORT;
    resetConfig();
  });
});

describe('createConfig', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = {}; });
  afterEach(() => { process.env = originalEnv; });

  it('produces a valid LuminConfig from overrides without reading process.env', () => {
    const config = createConfig({
      llm: { baseUrl: 'http://example.com/v1', apiKey: 'k', model: 'm' },
      workspace: { dir: '/tmp/x', pluginPath: '' },
    });
    expect(config.llm.baseUrl).toBe('http://example.com/v1');
    expect(config.llm.model).toBe('m');
    expect(config.workspace.dir).toBe('/tmp/x');
  });

  it('applies schema defaults for omitted fields', () => {
    const config = createConfig({ llm: { apiKey: 'x' } as any });
    expect(config.agent).toBeDefined();
    expect(config.session).toBeDefined();
  });

  it('does not read process.env even when set', () => {
    process.env.OPENAI_API_KEY = 'env-key';
    const config = createConfig({ llm: { apiKey: 'override' } as any });
    expect(config.llm.apiKey).toBe('override');
  });
});
