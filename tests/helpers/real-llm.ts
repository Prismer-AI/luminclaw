/**
 * Real-LLM test harness.
 *
 * Agent infra tests must drive a real LLM per project memory feedback
 * `no_mock_for_agent_infra`. This helper centralizes the setup so individual
 * tests stay focused on assertions.
 *
 * Usage:
 * ```ts
 * import { describeReal, useRealLLMWorkspace } from '../helpers/real-llm.js';
 * describeReal('my suite', () => {
 *   const env = useRealLLMWorkspace();
 *   it('does a thing', async () => {
 *     const agent = env.makeAgent();
 *     // ...
 *   });
 * });
 * ```
 *
 * When OPENAI_API_KEY is absent, `describeReal` becomes `describe.skip`
 * so CI without LLM credentials runs clean.
 */

import { describe, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DualLoopAgent, type DualLoopAgentOptions } from '../../src/loop/dual.js';
import { resetConfig } from '../../src/config.js';

export const HAS_REAL_LLM = Boolean(process.env.OPENAI_API_KEY) || fs.existsSync(path.join(process.cwd(), '.env.test'));

/** describe.skip when no LLM credentials; describe when available. */
export const describeReal = HAS_REAL_LLM ? describe : describe.skip;

/**
 * Load key=value lines from .env.test into process.env (non-destructive — only
 * sets keys that aren't already set, so explicit test env still wins).
 */
export function loadEnvTest(): void {
  const envPath = path.join(process.cwd(), '.env.test');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

interface RealLLMWorkspaceHandle {
  /** Per-test tmpdir under OS tmp, cleaned in afterEach. */
  readonly dir: () => string;
  /** Construct a fresh DualLoopAgent rooted at the tmpdir. */
  readonly makeAgent: (options?: DualLoopAgentOptions) => DualLoopAgent;
}

/**
 * Sets up a fresh workspace + LLM env per test. Each call in a describe block
 * returns a handle; cleanup is wired via beforeEach/afterEach automatically.
 */
export function useRealLLMWorkspace(): RealLLMWorkspaceHandle {
  let tmpDir = '';
  const agents: DualLoopAgent[] = [];

  beforeAll(() => {
    loadEnvTest();
  });

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumin-real-'));
    process.env.WORKSPACE_DIR = tmpDir;
    process.env.LUMIN_LOOP_MODE = 'dual';
    resetConfig();
  });

  afterEach(async () => {
    for (const agent of agents) {
      try { await agent.shutdown(); } catch { /* agent may already be shut down */ }
    }
    agents.length = 0;
    delete process.env.WORKSPACE_DIR;
    delete process.env.LUMIN_LOOP_MODE;
    resetConfig();
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
      tmpDir = '';
    }
  });

  return {
    dir: () => tmpDir,
    makeAgent: (options?: DualLoopAgentOptions) => {
      const a = new DualLoopAgent(options);
      agents.push(a);
      return a;
    },
  };
}

/**
 * Wait until a predicate is true or timeout elapses. Yields control between
 * polls. Returns true if predicate held, false on timeout.
 */
export async function waitUntil(pred: () => boolean, timeoutMs = 30_000, stepMs = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return pred();
}

/** Wait until task has a terminal status. Returns the final status (or 'pending' on timeout). */
export async function waitUntilTerminal(agent: DualLoopAgent, taskId: string, timeoutMs = 45_000): Promise<string> {
  const terminal = ['completed', 'failed', 'killed'];
  await waitUntil(() => {
    const t = agent.tasks.get(taskId);
    return !!t && terminal.includes(t.status);
  }, timeoutMs);
  return agent.tasks.get(taskId)?.status ?? 'pending';
}
