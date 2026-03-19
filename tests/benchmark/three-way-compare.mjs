/**
 * Three-Way Runtime Comparison: Lumin-TS vs Lumin-Rust vs OpenClaw
 *
 * Tests one runtime at a time with cooldown to avoid 429.
 * Identical prompts with tool usage (bash) for fair comparison.
 *
 * Usage:
 *   node tests/benchmark/three-way-compare.mjs lumin-ts
 *   node tests/benchmark/three-way-compare.mjs lumin-rust
 *   node tests/benchmark/three-way-compare.mjs openclaw
 *   node tests/benchmark/three-way-compare.mjs all
 */

import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || 'sk-JNQdVfQyeTmPqdrKl0oDe2lcocVgWzt9IhBjHtGaP13fFBUX';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'us-kimi-k2.5';
const TS_CLI = join(process.cwd(), 'dist', 'cli.js');
const RUST_BIN = join(process.cwd(), 'rust', 'target', 'release', 'lumin-server');

const WORKSPACE = '/tmp/bench-3way';

// ── Test Tasks ───────────────────────────────────────────

const TASKS = [
  {
    id: 'T1-chat',
    name: 'Pure LLM (no tools)',
    prompt: 'What are the three laws of thermodynamics? One sentence each.',
  },
  {
    id: 'T2-tool',
    name: 'Single tool call (bash)',
    prompt: 'Use bash to run: echo "TOOL_BENCHMARK_OK". Show the output.',
  },
  {
    id: 'T3-multi',
    name: 'Multi-step tool + reasoning',
    prompt: 'Use bash to create a file /tmp/bench-3way/test.txt with content "hello benchmark". Then use bash to read it back. Show both outputs.',
  },
];

// ── Runtime Configs ──────────────────────────────────────

const RUNTIMES = {
  'lumin-ts': {
    port: 14300,
    start: (port) => {
      return spawn('node', [TS_CLI, 'serve', '--port', String(port)], {
        env: { ...process.env, OPENAI_API_BASE_URL: BASE_URL, OPENAI_API_KEY: API_KEY, AGENT_DEFAULT_MODEL: MODEL, WORKSPACE_DIR: WORKSPACE, LUMIN_LOOP_MODE: 'single' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    healthCheck: (url) => fetch(`${url}/health`).then(r => r.json()),
  },
  'lumin-rust': {
    port: 14301,
    start: (port) => {
      return spawn(RUST_BIN, ['serve', '--port', String(port)], {
        env: { ...process.env, OPENAI_API_BASE_URL: BASE_URL, OPENAI_API_KEY: API_KEY, AGENT_DEFAULT_MODEL: MODEL, WORKSPACE_DIR: WORKSPACE },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    healthCheck: (url) => fetch(`${url}/health`).then(r => r.json()),
  },
  'openclaw': {
    port: 14302,
    start: (port) => {
      // OpenClaw runs inside a Docker container
      // For this benchmark, we'll use the Lumin container with OpenClaw-like config
      // since we can't easily start OpenClaw standalone without container orchestration
      return null; // Will handle separately
    },
  },
};

// ── Helpers ──────────────────────────────────────────────

async function waitForHealth(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200 || res.status === 503) return await res.json();
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function sendChat(url, prompt, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const start = performance.now();
    try {
      const res = await fetch(`${url}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: prompt }),
        signal: AbortSignal.timeout(120_000),
      });
      const elapsed = performance.now() - start;
      const body = await res.json();

      const response = body.response ?? body.text ?? '';
      const isError = response.startsWith('Error:') && response.includes('429');

      if (body.status === 'success' && !isError) {
        return {
          ok: true, elapsed, response,
          thinking: body.thinking,
          iterations: body.iterations ?? body.iteration_count,
          toolsUsed: body.tools_used ?? body.toolsUsed ?? [],
          usage: body.usage,
          runtime: body.runtime,
        };
      }

      if (attempt < retries) {
        console.log(`    ⏳ 429/error, retrying in ${15 * (attempt + 1)}s...`);
        await new Promise(r => setTimeout(r, 15_000 * (attempt + 1)));
        continue;
      }
      return { ok: false, elapsed, error: response.slice(0, 100) };
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 15_000));
        continue;
      }
      return { ok: false, elapsed: performance.now() - start, error: err.message };
    }
  }
}

function memRSS() {
  try {
    // Get RSS of child process (approximate)
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
  } catch { return 0; }
}

// ── Benchmark One Runtime ────────────────────────────────

async function benchmarkRuntime(runtimeName) {
  const config = RUNTIMES[runtimeName];
  if (!config) {
    console.log(`  ✗ Unknown runtime: ${runtimeName}`);
    return null;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${runtimeName.toUpperCase()}`);
  console.log(`${'═'.repeat(60)}`);

  // Prepare workspace
  try { mkdirSync(WORKSPACE, { recursive: true }); } catch {}

  if (runtimeName === 'openclaw') {
    console.log('  ℹ OpenClaw requires Docker container orchestration.');
    console.log('  ℹ Use: POST /api/agents/:id/start with openclaw runtime');
    console.log('  ℹ Skipping — not available as standalone process.');
    return null;
  }

  const proc = config.start(config.port);
  const url = `http://127.0.0.1:${config.port}`;

  const health = await waitForHealth(url);
  if (!health) {
    proc?.kill('SIGTERM');
    console.log('  ✗ Server did not start');
    return null;
  }
  console.log(`  ✓ Started: ${health.runtime} (loopMode: ${health.loop_mode ?? health.loopMode})`);

  const results = [];
  for (const task of TASKS) {
    console.log(`\n  ── ${task.id}: ${task.name} ──`);

    if (results.length > 0) {
      console.log('    ⏳ Cooldown 15s...');
      await new Promise(r => setTimeout(r, 15_000));
    }

    const r = await sendChat(url, task.prompt);
    if (r.ok) {
      const thinkLen = r.thinking?.length ?? 0;
      const tools = r.toolsUsed?.length ? r.toolsUsed.join(',') : 'none';
      console.log(`    ✓ ${Math.round(r.elapsed)}ms | ${r.response.length} chars | thinking: ${thinkLen} | tools: ${tools} | iter: ${r.iterations ?? '?'}`);
      results.push({ taskId: task.id, elapsed: r.elapsed, responseLen: r.response.length, thinkingLen: thinkLen, tools: r.toolsUsed, iterations: r.iterations });
    } else {
      console.log(`    ✗ ${r.error?.slice(0, 80)}`);
      results.push({ taskId: task.id, error: r.error });
    }
  }

  proc?.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));

  const successful = results.filter(r => !r.error);
  const summary = {
    runtime: runtimeName,
    passed: successful.length,
    total: TASKS.length,
    avgLatency: successful.length ? Math.round(successful.reduce((a, r) => a + r.elapsed, 0) / successful.length) : null,
    avgResponseLen: successful.length ? Math.round(successful.reduce((a, r) => a + r.responseLen, 0) / successful.length) : null,
    results,
  };

  if (successful.length > 0) {
    console.log(`\n  Summary: ${summary.passed}/${summary.total} passed, avg ${summary.avgLatency}ms`);
  }

  return summary;
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const target = process.argv[2] || 'all';

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Three-Way Runtime Comparison                            ║`);
  console.log(`║  Lumin-TS vs Lumin-Rust vs OpenClaw                      ║`);
  console.log(`║  Gateway: ${BASE_URL.padEnd(47)}║`);
  console.log(`║  Model:   ${MODEL.padEnd(47)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  // Pre-flight
  console.log('\nPre-flight...');
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'OK' }], max_tokens: 3 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200) {
      const body = await res.json().catch(() => ({}));
      console.log(`✗ LLM ${res.status}: ${body.error?.message ?? 'unavailable'}`);
      process.exit(1);
    }
    console.log('✓ LLM ok');
  } catch (e) {
    console.log(`✗ ${e.message}`);
    process.exit(1);
  }

  const allResults = [];
  const targets = target === 'all' ? ['lumin-ts', 'lumin-rust'] : [target];

  for (let i = 0; i < targets.length; i++) {
    if (i > 0) {
      console.log(`\n⏳ Cooldown 30s before next runtime...`);
      await new Promise(r => setTimeout(r, 30_000));
    }
    const r = await benchmarkRuntime(targets[i]);
    if (r) allResults.push(r);
  }

  // ── Final Comparison Table ──
  if (allResults.length >= 2) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  COMPARISON');
    console.log(`${'═'.repeat(60)}`);

    const header = ['Task', ...allResults.map(r => r.runtime)];
    console.log('┌' + header.map((_, i) => '─'.repeat(i === 0 ? 14 : 12)).join('┬') + '┐');
    console.log('│' + header.map((h, i) => ` ${h.padEnd(i === 0 ? 13 : 11)}` ).join('│') + '│');
    console.log('├' + header.map((_, i) => '─'.repeat(i === 0 ? 14 : 12)).join('┼') + '┤');

    for (const task of TASKS) {
      const cells = [task.id];
      for (const runtime of allResults) {
        const r = runtime.results.find(r => r.taskId === task.id);
        cells.push(r && !r.error ? `${Math.round(r.elapsed)}ms` : 'ERR');
      }
      console.log('│' + cells.map((c, i) => ` ${c.padEnd(i === 0 ? 13 : 11)}`).join('│') + '│');
    }

    // Average row
    const avgCells = ['AVERAGE'];
    for (const runtime of allResults) {
      avgCells.push(runtime.avgLatency ? `${runtime.avgLatency}ms` : 'N/A');
    }
    console.log('├' + header.map((_, i) => '─'.repeat(i === 0 ? 14 : 12)).join('┼') + '┤');
    console.log('│' + avgCells.map((c, i) => ` ${c.padEnd(i === 0 ? 13 : 11)}`).join('│') + '│');
    console.log('└' + header.map((_, i) => '─'.repeat(i === 0 ? 14 : 12)).join('┴') + '┘');
  }

  // Save results to JSON
  const outputPath = join(process.cwd(), 'tests', 'benchmark', 'results.json');
  writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), model: MODEL, allResults }, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}

main().catch(console.error);
