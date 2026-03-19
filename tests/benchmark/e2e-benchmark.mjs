/**
 * E2E Server Benchmark — measures HTTP/WS throughput for both loop modes.
 *
 * Starts a Lumin server, sends requests via HTTP POST, measures:
 * - Sequential request latency
 * - Concurrent request throughput
 * - Mode comparison (single vs dual)
 *
 * Requires: LLM gateway or will test server overhead only.
 *
 * Usage: node tests/benchmark/e2e-benchmark.mjs
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'us-kimi-k2.5';

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
}

function stats(arr) {
  if (!arr.length) return null;
  return {
    min: Math.round(arr.reduce((a, b) => Math.min(a, b))),
    p50: Math.round(percentile(arr, 50)),
    p90: Math.round(percentile(arr, 90)),
    p99: Math.round(percentile(arr, 99)),
    max: Math.round(arr.reduce((a, b) => Math.max(a, b))),
    avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
  };
}

// ── Server Management ─────────────────────────────────────

async function startServer(port, loopMode) {
  const proc = spawn('node', [CLI, 'serve', '--port', String(port)], {
    env: {
      ...process.env,
      OPENAI_API_BASE_URL: BASE_URL,
      OPENAI_API_KEY: API_KEY,
      AGENT_DEFAULT_MODEL: MODEL,
      WORKSPACE_DIR: '/tmp/bench-workspace',
      LUMIN_LOOP_MODE: loopMode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200 || res.status === 503) {
        return { url, proc, cleanup: () => proc.kill('SIGTERM') };
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  proc.kill('SIGTERM');
  throw new Error(`Server on port ${port} (${loopMode}) did not start`);
}

async function chatRequest(serverUrl, message, sessionId) {
  const start = performance.now();
  try {
    const res = await fetch(`${serverUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, sessionId }),
      signal: AbortSignal.timeout(90_000),
    });
    const elapsed = performance.now() - start;
    const body = await res.json();
    return { ok: body.status === 'success', elapsed, status: res.status, body };
  } catch (err) {
    return { ok: false, elapsed: performance.now() - start, status: 0, error: err.message };
  }
}

// ── Benchmarks ────────────────────────────────────────────

async function benchmarkMode(mode, port) {
  console.log(`\n  ── ${mode.toUpperCase()} mode (port ${port}) ──`);

  let server;
  try {
    server = await startServer(port, mode);
  } catch (err) {
    console.log(`  ✗ Server failed to start: ${err.message}`);
    return null;
  }

  // Verify health
  const healthRes = await fetch(`${server.url}/health`);
  const health = await healthRes.json();
  console.log(`  Health: ${health.status}, loopMode=${health.loopMode}`);

  const results = { mode, sequential: [], concurrent: {} };

  // Sequential: 3 requests
  console.log('  Sequential (3 requests)...');
  for (let i = 0; i < 3; i++) {
    const r = await chatRequest(server.url, `Say "${mode}_SEQ_${i}"`, `seq-${mode}-${i}`);
    const mark = r.ok ? '✓' : '✗';
    console.log(`    ${mark} req ${i}: ${Math.round(r.elapsed)}ms ${r.ok ? '' : `(${r.status})`}`);
    if (r.ok) results.sequential.push(r.elapsed);
    await new Promise(r => setTimeout(r, 1000)); // cooldown
  }

  // Concurrent: 5 parallel requests
  console.log('  Concurrent (5 parallel)...');
  const concStart = performance.now();
  const promises = Array.from({ length: 5 }, (_, i) =>
    chatRequest(server.url, `Say "${mode}_CONC_${i}"`, `conc-${mode}-${i}`)
  );
  const concResults = await Promise.all(promises);
  const concWall = performance.now() - concStart;
  const concOk = concResults.filter(r => r.ok);
  const concLatencies = concOk.map(r => r.elapsed);

  results.concurrent = {
    total: 5,
    ok: concOk.length,
    wallTime: Math.round(concWall),
    latencies: concLatencies,
  };
  console.log(`    ${concOk.length}/5 ok, wall=${Math.round(concWall)}ms` +
    (concLatencies.length ? `, p50=${Math.round(percentile(concLatencies, 50))}ms` : ''));

  server.cleanup();
  await new Promise(r => setTimeout(r, 1000));

  return results;
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║  Lumin E2E Server Benchmark                      ║
║  Gateway: ${BASE_URL.padEnd(39)}║
║  Model:   ${MODEL.padEnd(39)}║
╚══════════════════════════════════════════════════╝`);

  // Pre-flight LLM check
  console.log('\nPre-flight LLM check...');
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'OK' }], max_tokens: 3 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 200) {
      console.log('✓ LLM gateway reachable');
    } else {
      const body = await res.json().catch(() => ({}));
      console.log(`⚠ LLM returned ${res.status}: ${body.error?.message || 'unknown'}`);
      console.log('  Benchmark will test server overhead only (LLM calls may fail)');
    }
  } catch (err) {
    console.log(`⚠ LLM unreachable: ${err.message}`);
    console.log('  Benchmark will test server overhead only');
  }

  const singleResult = await benchmarkMode('single', 14001);
  await new Promise(r => setTimeout(r, 3000));
  const dualResult = await benchmarkMode('dual', 14002);

  // ── Comparison ──
  console.log('\n━━━ Comparison ━━━');
  console.log('┌────────────┬──────────────┬──────────────┐');
  console.log('│ Metric     │ Single       │ Dual         │');
  console.log('├────────────┼──────────────┼──────────────┤');

  const sSeq = singleResult?.sequential.length ? stats(singleResult.sequential) : null;
  const dSeq = dualResult?.sequential.length ? stats(dualResult.sequential) : null;
  console.log(`│ Seq p50    │ ${sSeq ? `${sSeq.p50}ms`.padStart(12) : 'N/A'.padStart(12)} │ ${dSeq ? `${dSeq.p50}ms`.padStart(12) : 'N/A'.padStart(12)} │`);
  console.log(`│ Seq avg    │ ${sSeq ? `${sSeq.avg}ms`.padStart(12) : 'N/A'.padStart(12)} │ ${dSeq ? `${dSeq.avg}ms`.padStart(12) : 'N/A'.padStart(12)} │`);

  const sConc = singleResult?.concurrent;
  const dConc = dualResult?.concurrent;
  console.log(`│ Conc ok    │ ${sConc ? `${sConc.ok}/${sConc.total}`.padStart(12) : 'N/A'.padStart(12)} │ ${dConc ? `${dConc.ok}/${dConc.total}`.padStart(12) : 'N/A'.padStart(12)} │`);
  console.log(`│ Conc wall  │ ${sConc ? `${sConc.wallTime}ms`.padStart(12) : 'N/A'.padStart(12)} │ ${dConc ? `${dConc.wallTime}ms`.padStart(12) : 'N/A'.padStart(12)} │`);

  console.log('└────────────┴──────────────┴──────────────┘');
}

main().catch(console.error);
