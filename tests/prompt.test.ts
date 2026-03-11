/**
 * Tests for PromptBuilder — dynamic system prompt assembly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PromptBuilder } from '../src/prompt.js';

const TEST_DIR = join(process.cwd(), '.test-workspace-prompt');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('PromptBuilder', () => {
  it('builds prompt with default identity when no SOUL.md', () => {
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.loadIdentity();
    const result = builder.build();
    expect(result).toContain('Prismer research assistant');
  });

  it('loads custom identity from SOUL.md', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), 'You are TestBot. Always be helpful.');
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.loadIdentity();
    const result = builder.build();
    expect(result).toContain('TestBot');
    expect(result).not.toContain('Prismer research assistant');
  });

  it('loads TOOLS.md reference', () => {
    writeFileSync(join(TEST_DIR, 'TOOLS.md'), '# Tool Guide\n\nUse `bash` for commands.');
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.loadToolsRef();
    const result = builder.build();
    expect(result).toContain('Tool Reference');
    expect(result).toContain('bash');
  });

  it('skips TOOLS.md when not present', () => {
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.loadToolsRef();
    expect(builder.sectionCount).toBe(0);
  });

  it('sets agent instructions', () => {
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.setAgentInstructions('You are a LaTeX expert.');
    const result = builder.build();
    expect(result).toContain('LaTeX expert');
  });

  it('sets workspace context', () => {
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.setWorkspaceContext('Workspace has 5 LaTeX files.');
    const result = builder.build();
    expect(result).toContain('Workspace Context');
    expect(result).toContain('5 LaTeX files');
  });

  it('adds runtime info', () => {
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.addRuntimeInfo({
      agentId: 'researcher',
      model: 'us-kimi-k2.5',
      toolCount: 42,
    });
    const result = builder.build();
    expect(result).toContain('Runtime Info');
    expect(result).toContain('researcher');
    expect(result).toContain('us-kimi-k2.5');
    expect(result).toContain('42');
  });

  it('adds skill sections with correct prefix', () => {
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.addSkillSections([
      { id: 'latex', content: 'LaTeX skill instructions', priority: 5 },
      { id: 'jupyter', content: 'Jupyter skill instructions', priority: 5 },
    ]);
    expect(builder.sectionCount).toBe(2);
    const result = builder.build();
    expect(result).toContain('LaTeX skill');
    expect(result).toContain('Jupyter skill');
  });

  it('sorts sections by priority (highest first)', () => {
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.addSection({ id: 'low', content: 'LOW_PRIORITY_CONTENT', priority: 1 });
    builder.addSection({ id: 'high', content: 'HIGH_PRIORITY_CONTENT', priority: 10 });
    const result = builder.build();
    const highPos = result.indexOf('HIGH_PRIORITY');
    const lowPos = result.indexOf('LOW_PRIORITY');
    expect(highPos).toBeLessThan(lowPos);
  });

  it('truncates lowest priority sections when over budget', () => {
    const builder = new PromptBuilder({ workspaceDir: TEST_DIR, maxChars: 200 });
    builder.addSection({ id: 'important', content: 'A'.repeat(150), priority: 10 });
    builder.addSection({ id: 'extra', content: 'B'.repeat(200), priority: 1 });
    const result = builder.build();
    expect(result).toContain('AAA');
    // Extra section should be truncated or excluded
    expect(result.length).toBeLessThanOrEqual(210); // some slack for truncation marker
  });

  it('assembles full prompt with all sections', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), 'You are TestBot.');
    writeFileSync(join(TEST_DIR, 'TOOLS.md'), '# Tools\nUse bash.');

    const builder = new PromptBuilder({ workspaceDir: TEST_DIR });
    builder.loadIdentity();
    builder.loadToolsRef();
    builder.setAgentInstructions('Help with research.');
    builder.setWorkspaceContext('3 papers loaded.');
    builder.addSkillSections([{ id: 'test', content: 'Test skill body', priority: 5 }]);
    builder.addRuntimeInfo({ agentId: 'researcher', model: 'test-model' });

    const result = builder.build();
    expect(builder.sectionCount).toBe(6);
    // Identity (10) should come before runtime (3)
    expect(result.indexOf('TestBot')).toBeLessThan(result.indexOf('Runtime Info'));
  });
});
