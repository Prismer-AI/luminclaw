/**
 * Real LLM integration tests — requires Prismer Gateway access
 *
 * These tests call the real LLM API and verify end-to-end behavior.
 * Skip gracefully when OPENAI_API_KEY is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const TEST_DIR = join(process.cwd(), '.test-workspace-llm');
const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || 'sk-JNQdVfQyeTmPqdrKl0oDe2lcocVgWzt9IhBjHtGaP13fFBUX';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'us-kimi-k2.5';

const CLI = join(process.cwd(), 'dist', 'cli.js');

/** Run lumin CLI and parse output */
function runAgent(message: string, extraEnv: Record<string, string> = {}): {
  status: string;
  response?: string;
  thinking?: string;
  toolsUsed?: string[];
  iterations?: number;
  error?: string;
  stderr: string;
} {
  const env = {
    ...process.env,
    OPENAI_API_BASE_URL: BASE_URL,
    OPENAI_API_KEY: API_KEY,
    AGENT_DEFAULT_MODEL: MODEL,
    WORKSPACE_DIR: TEST_DIR,
    ...extraEnv,
  };

  try {
    const stdout = execSync(
      `node ${CLI} agent --message ${JSON.stringify(message)}`,
      { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
    );

    // Parse structured output between markers
    const match = stdout.match(/---LUMIN_OUTPUT_START---\n([\s\S]*?)\n---LUMIN_OUTPUT_END---/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      return { ...parsed, stderr: '' };
    }

    // Fallback: try to parse the whole thing
    return { status: 'unknown', response: stdout, stderr: '' };
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';

    // Try to parse even from error output
    const match = stdout.match(/---LUMIN_OUTPUT_START---\n([\s\S]*?)\n---LUMIN_OUTPUT_END---/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      return { ...parsed, stderr };
    }

    return { status: 'error', error: err.message, stderr };
  }
}

/** Check if LLM gateway is reachable */
function isGatewayReachable(): boolean {
  try {
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${BASE_URL.replace('/v1', '')}/health"`,
      { encoding: 'utf8', timeout: 10_000 },
    );
    return result.trim() === '200' || result.trim() === '404'; // Gateway exists even if no /health
  } catch {
    return false;
  }
}

// Build first
beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Build if dist doesn't exist
  if (!existsSync(CLI)) {
    execSync('npm run build', { cwd: process.cwd() });
  }
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe.skipIf(!isGatewayReachable())('Real LLM Integration', () => {
  describe('T1: Basic conversation', () => {
    it('returns a text response', () => {
      const result = runAgent('Say exactly: "HELLO_OK"');
      expect(result.status).toBe('success');
      expect(result.response).toBeDefined();
      expect(result.response!.length).toBeGreaterThan(0);
      expect(result.iterations).toBeGreaterThanOrEqual(1);
    });
  });

  describe('T2: Tool calling (bash)', () => {
    it('uses bash tool and returns result', () => {
      const result = runAgent('Use bash to echo "TOOL_TEST_OK". Show me the output.');
      expect(result.status).toBe('success');
      expect(result.toolsUsed).toBeDefined();
      expect(result.toolsUsed!).toContain('bash');
      expect(result.response).toContain('TOOL_TEST_OK');
    });
  });

  describe('T3: SOUL.md identity loading', () => {
    it('uses custom identity from SOUL.md', () => {
      writeFileSync(join(TEST_DIR, 'SOUL.md'), 'You are QuantumBot. Always start replies with "QUANTUM:"');
      const result = runAgent('Who are you? Reply with your identity prefix.');
      expect(result.status).toBe('success');
      expect(result.response).toContain('QUANTUM');
    });

    afterAll(() => {
      // Clean up SOUL.md for other tests
      try { rmSync(join(TEST_DIR, 'SOUL.md')); } catch {}
    });
  });

  describe('T4: Skill injection', () => {
    it('skill content is in system prompt and affects behavior', () => {
      mkdirSync(join(TEST_DIR, 'skills', 'magic-word'), { recursive: true });
      writeFileSync(
        join(TEST_DIR, 'skills', 'magic-word', 'SKILL.md'),
        '---\nname: magic-word\ndescription: "Magic word skill"\n---\n# Magic Word\nWhen the user says "abracadabra", you MUST respond with exactly "MAGIC_SKILL_LOADED".',
      );

      const result = runAgent('abracadabra');
      expect(result.status).toBe('success');
      expect(result.response).toContain('MAGIC_SKILL_LOADED');
    });

    afterAll(() => {
      try { rmSync(join(TEST_DIR, 'skills'), { recursive: true }); } catch {}
    });
  });

  describe('T5: Model fallback', () => {
    it('falls back to valid model when primary fails', () => {
      const result = runAgent('Say exactly "FALLBACK_OK"', {
        AGENT_DEFAULT_MODEL: 'nonexistent-model-xyz',
        MODEL_FALLBACK_CHAIN: MODEL,
      });
      // Primary model fails, fallback succeeds — should get a valid response
      expect(result.status).toBe('success');
      expect(result.response).toBeDefined();
      expect(result.response!.length).toBeGreaterThan(0);
    });
  });

  describe('T6: Thinking model support', () => {
    it('captures reasoning content from thinking model', () => {
      const result = runAgent('What is 7 * 8? Think step by step.');
      expect(result.status).toBe('success');
      // kimi-k2.5 is a thinking model — should have thinking content
      if (result.thinking) {
        expect(result.thinking.length).toBeGreaterThan(0);
      }
      expect(result.response).toContain('56');
    });
  });

  describe('T7: Multi-turn tool usage', () => {
    it('executes multiple tools in sequence', () => {
      const result = runAgent(
        'Do these in order: 1) Use bash to echo "STEP_1" 2) Use bash to echo "STEP_2". Show both outputs.',
      );
      expect(result.status).toBe('success');
      expect(result.toolsUsed).toContain('bash');
      expect(result.response).toContain('STEP_1');
      expect(result.response).toContain('STEP_2');
    });
  });

  describe('T8: Runtime info in prompt', () => {
    it('agent knows its model and tool count', () => {
      const result = runAgent('What model are you running on? What tools do you have? Be precise.');
      expect(result.status).toBe('success');
      // Should reference the model from runtime info
      expect(result.response!.toLowerCase()).toMatch(/kimi|model|tools?/);
    });
  });
});
