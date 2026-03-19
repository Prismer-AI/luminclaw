/**
 * Kimi K2.5 API Benchmark — measures actual RPM, concurrency, latency, TPM
 * against official specs: 400 concurrency, 4M TPM, 5000 RPM
 */

const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'us-kimi-k2.5';

// ── Helpers ──

async function callAPI(prompt, maxTokens = 10) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const elapsed = performance.now() - start;
    const body = await res.json();

    return {
      ok: res.status === 200,
      status: res.status,
      elapsed,
      tokens: body.usage ?? null,
      error: body.error?.message ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      elapsed: performance.now() - start,
      tokens: null,
      error: err.message,
    };
  }
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(latencies) {
  if (latencies.length === 0) return {};
  return {
    min: Math.round(Math.min(...latencies)),
    p50: Math.round(percentile(latencies, 50)),
    p90: Math.round(percentile(latencies, 90)),
    p99: Math.round(percentile(latencies, 99)),
    max: Math.round(Math.max(...latencies)),
    avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
  };
}

// ── Test 1: Sequential baseline (latency) ──

async function testLatency() {
  console.log('\n━━━ Test 1: Sequential Latency Baseline (5 requests) ━━━');
  const latencies = [];
  let totalTokens = 0;

  for (let i = 0; i < 5; i++) {
    const r = await callAPI(`Count from 1 to 3. Attempt ${i}`, 20);
    const mark = r.ok ? '✓' : '✗';
    const info = r.ok
      ? `${Math.round(r.elapsed)}ms, ${r.tokens?.total_tokens ?? '?'} tokens`
      : `${r.status} ${r.error}`;
    console.log(`  ${mark} req ${i + 1}: ${info}`);
    if (r.ok) {
      latencies.push(r.elapsed);
      totalTokens += r.tokens?.total_tokens ?? 0;
    }
  }

  if (latencies.length > 0) {
    const s = stats(latencies);
    console.log(`  → Latency: min=${s.min}ms p50=${s.p50}ms p90=${s.p90}ms max=${s.max}ms`);
    console.log(`  → Total tokens: ${totalTokens}`);
  }
  return latencies.length;
}

// ── Test 2: Concurrency ramp ──

async function testConcurrency() {
  console.log('\n━━━ Test 2: Concurrency Ramp (10 → 25 → 50 → 100) ━━━');

  for (const n of [10, 25, 50, 100]) {
    const start = performance.now();
    const promises = Array.from({ length: n }, (_, i) =>
      callAPI(`Say ${i}`, 5)
    );
    const results = await Promise.all(promises);
    const wallTime = performance.now() - start;

    const ok = results.filter(r => r.ok);
    const r429 = results.filter(r => r.status === 429);
    const other = results.filter(r => !r.ok && r.status !== 429);
    const latencies = ok.map(r => r.elapsed);
    const s = latencies.length > 0 ? stats(latencies) : null;

    console.log(`  C=${n}: ${ok.length}✓ ${r429.length}×429 ${other.length}×err | wall=${Math.round(wallTime)}ms` +
      (s ? ` | p50=${s.p50}ms p99=${s.p99}ms` : ''));

    // Brief pause between levels
    if (n < 100) await new Promise(r => setTimeout(r, 3000));
  }
}

// ── Test 3: RPM burst (sustained 1 minute) ──

async function testRPM() {
  console.log('\n━━━ Test 3: RPM Burst (60s, concurrency=20) ━━━');

  const DURATION_MS = 60_000;
  const CONCURRENCY = 20;
  const startTime = Date.now();
  let totalReqs = 0;
  let totalOk = 0;
  let total429 = 0;
  let totalTokens = 0;
  const latencies = [];
  let inflight = 0;

  // Status updates every 10s
  const statusInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rpm = Math.round(totalReqs / ((Date.now() - startTime) / 60_000));
    console.log(`  [${elapsed}s] reqs=${totalReqs} ok=${totalOk} 429=${total429} inflight=${inflight} rpm≈${rpm}`);
  }, 10_000);

  async function worker() {
    while (Date.now() - startTime < DURATION_MS) {
      inflight++;
      const r = await callAPI(`Ping ${totalReqs}`, 5);
      inflight--;
      totalReqs++;
      if (r.ok) {
        totalOk++;
        latencies.push(r.elapsed);
        totalTokens += r.tokens?.total_tokens ?? 0;
      } else if (r.status === 429) {
        total429++;
        // Back off on 429
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  clearInterval(statusInterval);

  const durationSec = (Date.now() - startTime) / 1000;
  const actualRPM = Math.round(totalOk / (durationSec / 60));
  const actualTPM = Math.round(totalTokens / (durationSec / 60));
  const s = latencies.length > 0 ? stats(latencies) : null;

  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │ Duration:    ${durationSec.toFixed(1)}s`);
  console.log(`  │ Total reqs:  ${totalReqs} (${totalOk} ok, ${total429} ×429)`);
  console.log(`  │ Actual RPM:  ${actualRPM} / 5000 (official)`);
  console.log(`  │ Actual TPM:  ${actualTPM} / 4,000,000 (official)`);
  console.log(`  │ Success %:   ${(totalOk / totalReqs * 100).toFixed(1)}%`);
  if (s) {
    console.log(`  │ Latency:     min=${s.min} p50=${s.p50} p90=${s.p90} p99=${s.p99} max=${s.max}ms`);
  }
  console.log(`  └─────────────────────────────────────────────┘`);
}

// ── Main ──

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Kimi K2.5 API Benchmark                        ║`);
  console.log(`║  Gateway: ${BASE_URL.padEnd(39)}║`);
  console.log(`║  Model:   ${MODEL.padEnd(39)}║`);
  console.log(`║  Official: 400 conc / 5000 RPM / 4M TPM         ║`);
  console.log(`╚══════════════════════════════════════════════════╝`);

  // Pre-flight check
  console.log('\nPre-flight check...');
  const check = await callAPI('Say OK', 5);
  if (!check.ok) {
    console.log(`✗ Gateway unreachable or model unavailable: ${check.status} ${check.error}`);
    console.log('Aborting benchmark.');
    process.exit(1);
  }
  console.log(`✓ Gateway ok (${Math.round(check.elapsed)}ms)`);

  const baseline = await testLatency();
  if (baseline === 0) {
    console.log('✗ No successful requests — aborting.');
    process.exit(1);
  }

  await new Promise(r => setTimeout(r, 5000));
  await testConcurrency();

  await new Promise(r => setTimeout(r, 5000));
  await testRPM();
}

main().catch(console.error);
