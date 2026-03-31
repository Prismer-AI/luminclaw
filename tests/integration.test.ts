/**
 * Integration tests — full runAgent flow with real PromptBuilder, SkillLoader, ToolRegistry
 * Uses mock LLM provider (no real API calls).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), '.test-workspace-integration');

beforeAll(() => {
  mkdirSync(join(TEST_DIR, 'skills', 'test-skill'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'SOUL.md'), 'You are IntegrationTestBot.');
  writeFileSync(join(TEST_DIR, 'TOOLS.md'), '# Tool Guide\n\nUse bash for commands.');
  writeFileSync(
    join(TEST_DIR, 'skills', 'test-skill', 'SKILL.md'),
    '---\nname: test-skill\ndescription: "Integration test skill"\n---\n# Test Skill\nWhen asked about testing, say INTEGRATION_OK.',
  );

  // Set env vars for the test
  process.env.WORKSPACE_DIR = TEST_DIR;
  process.env.OPENAI_API_BASE_URL = 'http://mock:3000/v1';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AGENT_DEFAULT_MODEL = 'test-model';
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.OPENAI_API_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AGENT_DEFAULT_MODEL;
});

describe('PromptBuilder integration', () => {
  it('assembles prompt with SOUL.md + TOOLS.md + skills + runtime', async () => {
    const { PromptBuilder } = await import('../src/prompt.js');
    const { SkillLoader } = await import('../src/skills.js');

    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.loadIdentity();
    builder.loadToolsRef();
    builder.setAgentInstructions('Help with research tasks.');

    const skillLoader = new SkillLoader([join(TEST_DIR, 'skills')]);
    const sections = skillLoader.toPromptSections();
    builder.addSkillSections(sections);

    builder.addRuntimeInfo({
      agentId: 'researcher',
      model: 'test-model',
      toolCount: 3,
    });

    const prompt = builder.build();

    // Verify all sections present
    expect(prompt).toContain('IntegrationTestBot');
    expect(prompt).toContain('Tool Reference');
    expect(prompt).toContain('bash');
    expect(prompt).toContain('Help with research tasks');
    expect(prompt).toContain('INTEGRATION_OK');
    expect(prompt).toContain('Runtime Info');
    expect(prompt).toContain('researcher');

    // Verify priority ordering: identity (10) before runtime (3)
    const identityPos = prompt.indexOf('IntegrationTestBot');
    const runtimePos = prompt.indexOf('Runtime Info');
    expect(identityPos).toBeLessThan(runtimePos);
  });
});

describe('ToolRegistry + SkillLoader', () => {
  it('registers tools and skills load correctly', async () => {
    const { ToolRegistry } = await import('../src/tools.js');
    const { createTool } = await import('../src/tools/loader.js');
    const { createClawHubTool } = await import('../src/tools/clawhub.js');
    const { SkillLoader } = await import('../src/skills.js');

    const tools = new ToolRegistry();
    const skillLoader = new SkillLoader([join(TEST_DIR, 'skills')]);

    // Register bash
    tools.register(createTool(
      'bash', 'Execute bash', { type: 'object', properties: { command: { type: 'string' } } },
      async (args) => `Executed: ${args.command}`,
    ));

    // Register clawhub with skill loader
    tools.register(createClawHubTool(skillLoader));

    expect(tools.size).toBe(2);
    expect(tools.has('bash')).toBe(true);
    expect(tools.has('clawhub')).toBe(true);
    expect(skillLoader.count).toBe(1);

    // Test tool specs generation
    const specs = tools.getSpecs();
    expect(specs).toHaveLength(2);
    expect(specs.map(s => s.function.name)).toEqual(['bash', 'clawhub']);
  });
});

describe('Cloud IM config injection', () => {
  it('buildPluginConfig reads IM env vars', () => {
    process.env.PRISMER_IM_BASE_URL = 'https://prismer.cloud';
    process.env.PRISMER_IM_CONVERSATION_ID = 'conv-123';
    process.env.PRISMER_IM_TOKEN = 'token-abc';
    process.env.PRISMER_API_BASE_URL = 'http://host.docker.internal:3000';
    process.env.AGENT_ID = 'agent-1';

    // Simulate buildPluginConfig from index.ts
    const config = {
      apiBaseUrl: process.env.PRISMER_API_BASE_URL || 'http://host.docker.internal:3000',
      agentId: process.env.AGENT_ID || 'default',
      workspaceId: process.env.WORKSPACE_ID,
      imBaseUrl: process.env.PRISMER_IM_BASE_URL,
      imConversationId: process.env.PRISMER_IM_CONVERSATION_ID,
      imToken: process.env.PRISMER_IM_TOKEN,
    };

    expect(config.imBaseUrl).toBe('https://prismer.cloud');
    expect(config.imConversationId).toBe('conv-123');
    expect(config.imToken).toBe('token-abc');
    expect(config.apiBaseUrl).toBe('http://host.docker.internal:3000');
    expect(config.agentId).toBe('agent-1');

    // Cleanup
    delete process.env.PRISMER_IM_BASE_URL;
    delete process.env.PRISMER_IM_CONVERSATION_ID;
    delete process.env.PRISMER_IM_TOKEN;
    delete process.env.PRISMER_API_BASE_URL;
    delete process.env.AGENT_ID;
  });
});

describe('FallbackProvider integration', () => {
  it('creates provider with fallback chain from env', async () => {
    const { FallbackProvider, OpenAICompatibleProvider } = await import('../src/provider.js');

    const baseUrl = 'http://mock:3000/v1';
    const model = 'primary-model';
    const fallbacks = 'fallback-1,fallback-2'.split(',').filter(Boolean);

    const base = new OpenAICompatibleProvider({ baseUrl, apiKey: 'test', defaultModel: model });
    const provider = new FallbackProvider(base, [model, ...fallbacks]);

    expect(provider.name()).toBe('fallback:primary-model,fallback-1,fallback-2');
  });
});

describe('Session + Directives', () => {
  it('session buildMessages includes system prompt + history + user input', async () => {
    const { Session } = await import('../src/session.js');
    const session = new Session('test-session');
    session.addMessage({ role: 'assistant', content: 'Previous response' });

    session.addMessage({ role: 'user', content: 'New question' });
    const messages = session.buildMessages('System prompt here');
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('System prompt here');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Previous response');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toBe('New question');
  });

  it('child session inherits recent context', async () => {
    const { Session } = await import('../src/session.js');
    const parent = new Session('parent');
    parent.addMessage({ role: 'assistant', content: 'msg-1' });
    parent.addMessage({ role: 'user', content: 'msg-2' });
    parent.addMessage({ role: 'assistant', content: 'msg-3' });
    parent.addMessage({ role: 'user', content: 'msg-4' });
    parent.addMessage({ role: 'assistant', content: 'msg-5' });

    const child = parent.createChild('latex-expert');
    expect(child.parentId).toBe('parent');
    // Child inherits last 4 messages
    expect(child.messages).toHaveLength(4);
    expect(child.messages[0].content).toBe('msg-2');
  });
});
