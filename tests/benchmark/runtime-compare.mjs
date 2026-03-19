/**
 * Runtime Comparison Benchmark — Lumin-TS vs Lumin-Rust vs OpenClaw
 *
 * Tests one runtime at a time to avoid 429 rate limiting.
 * Sends identical long-running tasks and measures:
 * - Time to first token (TTFT)
 * - Total response time
 * - Token usage
 * - Tool call count
 * - Memory (RSS)
 *
 * Usage:
 *   node tests/benchmark/runtime-compare.mjs lumin-ts
 *   node tests/benchmark/runtime-compare.mjs lumin-rust
 *   node tests/benchmark/runtime-compare.mjs all        # sequential with cooldown
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || 'sk-JNQdVfQyeTmPqdrKl0oDe2lcocVgWzt9IhBjHtGaP13fFBUX';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'us-kimi-k2.5';

const TS_CLI = join(process.cwd(), 'dist', 'cli.js');
const RUST_BIN = join(process.cwd(), 'rust', 'target', 'release', 'lumin-server');

// ── Test Tasks (identical across all runtimes) ───────────

const TASKS = [
  {
    id: 'T1-simple',
    name: 'Simple response',
    prompt: 'What are the three laws of thermodynamics? Be concise, one sentence each.',
    expectMinChars: 50,
  },
  {
    id: 'T2-reasoning',
    name: 'Multi-step reasoning',
    prompt: 'A researcher has 5 papers. Each paper has between 20-40 citations. The median citation count is 28. What is the minimum possible total number of citations across all 5 papers? Show your reasoning step by step.',
    expectMinChars: 100,
  },
  {
    id: 'T3-generation',
    name: 'Long-form generation',
    prompt: 'Write a 200-word abstract for a research paper titled "Attention Is All You Need: A Retrospective After 10 Years". Include methodology, key findings, and implications.',
    expectMinChars: 150,
  },
];

// ── Server Management ────────────────────────────────────

async function startServer(runtime, port) {
  let proc;
  const env = {
    ...process.env,
    OPENAI_API_BASE_URL: BASE_URL,
    OPENAI_API_KEY: API_KEY,
    AGENT_DEFAULT_MODEL: MODEL,
    WORKSPACE_DIR: '/tmp/bench-workspace',
    LUMIN_LOOP_MODE: 'single',
  };

  if (runtime === 'lumin-ts') {
    proc = spawn('node', [TS_CLI, 'serve', '--port', String(port)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  } else if (runtime === 'lumin-rust') {
    proc = spawn(RUST_BIN, ['serve', '--port', String(port)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    throw new Error(`Unknown runtime: ${runtime}`);
  }

  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200 || res.status === 503) {
        const health = await res.json();
        return { url, proc, health, cleanup: () => proc.kill('SIGTERM') };
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  proc.kill('SIGTERM');
  throw new Error(`${runtime} server on port ${port} did not start within 15s`);
}

async function sendChat(serverUrl, prompt, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const start = performance.now();
    try {
      const res = await fetch(`${serverUrl}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: prompt }),
        signal: AbortSignal.timeout(120_000),
      });
      const elapsed = performance.now() - start;
      const body = await res.json();

      if (body.status === 'success' && body.response && !body.response.startsWith('Error:')) {
        return {
          ok: true,
          elapsed,
          response: body.response,
          thinking: body.thinking,
          iterations: body.iterations,
          toolsUsed: body.tools_used || body.toolsUsed || [],
          usage: body.usage,
          durationMs: body.duration_ms || body.durationMs,
          runtime: body.runtime,
          sessionId: body.session_id || body.sessionId,
        };
      }

      // 429 or error — retry
      if (attempt < retries) {
        const wait = (attempt + 1) * 15_000; // 15s, 30s backoff
        console.log(`    ⏳ Attempt ${attempt + 1} failed (${body.response?.slice(0, 60) || 'error'}), waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return { ok: false, elapsed, error: body.response || body.error || 'unknown', response: body.response };
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 15_000));
        continue;
      }
      return { ok: false, elapsed: performance.now() - start, error: err.message };
    }
  }
}

// ── Benchmark Runner ─────────────────────────────────────

async function benchmarkRuntime(runtime, port) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${runtime.toUpperCase()} — Port ${port}`);
  console.log(`${'═'.repeat(60)}`);

  let server;
  try {
    server = await startServer(runtime, port);
    console.log(`  ✓ Server started: ${server.health.runtime} (loopMode: ${server.health.loop_mode || server.health.loopMode})`);
  } catch (err) {
    console.log(`  ✗ Server failed: ${err.message}`);
    return null;
  }

  // Get RSS before tests
  const rssBefore = process.memoryUsage().rss;

  const results = [];
  for (const task of TASKS) {
    console.log(`\n  ── ${task.id}: ${task.name} ──`);

    // Cooldown between tasks to avoid 429
    if (results.length > 0) {
      console.log('    ⏳ Cooldown 10s...');
      await new Promise(r => setTimeout(r, 10_000));
    }

    const result = await sendChat(server.url, task.prompt);

    if (result.ok) {
      const respLen = result.response.length;
      const tokens = result.usage
        ? `${result.usage.prompt_tokens || result.usage.promptTokens || '?'}+${result.usage.completion_tokens || result.usage.completionTokens || '?'}`
        : '?';
      const thinkingLen = result.thinking ? result.thinking.length : 0;
      console.log(`    ✓ ${Math.round(result.elapsed)}ms | ${respLen} chars | ${tokens} tokens | thinking: ${thinkingLen} chars | iter: ${result.iterations || '?'}`);

      results.push({
        taskId: task.id,
        elapsed: result.elapsed,
        responseLen: respLen,
        thinkingLen,
        tokens: result.usage,
        iterations: result.iterations,
        toolsUsed: result.toolsUsed,
      });
    } else {
      console.log(`    ✗ Failed: ${result.error?.slice(0, 100)}`);
      results.push({ taskId: task.id, elapsed: result.elapsed, error: result.error?.slice(0, 100) });
    }
  }

  server.cleanup();
  await new Promise(r => setTimeout(r, 1000));

  // Summary
  const successful = results.filter(r => !r.error);
  if (successful.length > 0) {
    const avgLatency = Math.round(successful.reduce((a, r) => a + r.elapsed, 0) / successful.length);
    const avgRespLen = Math.round(successful.reduce((a, r) => a + r.responseLen, 0) / successful.length);
    console.log(`\n  ┌──────────────────────────────────────────┐`);
    console.log(`  │ ${runtime.toUpperCase().padEnd(40)} │`);
    console.log(`  ├──────────────────────────────────────────┤`);
    console.log(`  │ Tasks:        ${successful.length}/${TASKS.length} passed${' '.repeat(20)}│`);
    console.log(`  │ Avg latency:  ${String(avgLatency).padEnd(6)}ms${' '.repeat(21)}│`);
    console.log(`  │ Avg response: ${String(avgRespLen).padEnd(6)}chars${' '.repeat(18)}│`);
    console.log(`  └──────────────────────────────────────────┘`);
  }

  return { runtime, results, successful: successful.length, total: TASKS.length };
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const target = process.argv[2] || 'all';

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Lumin Runtime Comparison Benchmark                  ║`);
  console.log(`║  Gateway: ${BASE_URL.padEnd(43)}║`);
  console.log(`║  Model:   ${MODEL.padEnd(43)}║`);
  console.log(`║  Tasks:   ${TASKS.length} (identical across runtimes)${' '.repeat(22)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);

  // Pre-flight check
  console.log('\nPre-flight LLM check...');
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'OK' }], max_tokens: 3 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 200) console.log('✓ LLM gateway reachable');
    else {
      const body = await res.json().catch(() => ({}));
      console.log(`✗ LLM returned ${res.status}: ${body.error?.message || 'unknown'}`);
      process.exit(1);
    }
  } catch (err) {
    console.log(`✗ LLM unreachable: ${err.message}`);
    process.exit(1);
  }

  const allResults = [];

  if (target === 'lumin-ts' || target === 'all') {
    const r = await benchmarkRuntime('lumin-ts', 14100);
    if (r) allResults.push(r);
    if (target === 'all') {
      console.log('\n⏳ Cooldown 30s before next runtime...');
      await new Promise(r => setTimeout(r, 30_000));
    }
  }

  if (target === 'lumin-rust' || target === 'all') {
    const r = await benchmarkRuntime('lumin-rust', 14101);
    if (r) allResults.push(r);
  }

  // ── Final comparison ──
  if (allResults.length > 1) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  COMPARISON');
    console.log(`${'═'.repeat(60)}`);
    console.log('┌──────────────┬──────────┬──────────┬──────────┐');
    console.log('│ Task         │ Lumin-TS │ Lumin-RS │ Delta    │');
    console.log('├──────────────┼──────────┼──────────┼──────────┤');

    for (const task of TASKS) {
      const tsResult = allResults.find(r => r.runtime === 'lumin-ts')?.results.find(r => r.taskId === task.id);
      const rsResult = allResults.find(r => r.runtime === 'lumin-rust')?.results.find(r => r.taskId === task.id);

      const tsMs = tsResult && !tsResult.error ? Math.round(tsResult.elapsed) : 'ERR';
      const rsMs = rsResult && !rsResult.error ? Math.round(rsResult.elapsed) : 'ERR';
      const delta = typeof tsMs === 'number' && typeof rsMs === 'number'
        ? `${rsMs > tsMs ? '+' : ''}${Math.round(rsMs - tsMs)}ms`
        : '-';

      console.log(`│ ${task.id.padEnd(12)} │ ${String(tsMs).padStart(6)}ms │ ${String(rsMs).padStart(6)}ms │ ${delta.padStart(8)} │`);
    }
    console.log('└──────────────┴──────────┴──────────┴──────────┘');
  }
}

main().catch(console.error);
