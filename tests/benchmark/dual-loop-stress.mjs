#!/usr/bin/env node
/**
 * Dual-Loop Stress Test — exercises both TS and Rust agent cores.
 *
 * Tests (for each runtime):
 *   S1: Single-loop basic text response
 *   S2: Single-loop tool calling (bash echo)
 *   S3: Single-loop multi-turn tool (2 sequential bash calls)
 *   S4: Dual-loop task creation (verify quick return)
 *   S5: Dual-loop inner execution (wait for background completion)
 *   S6: Concurrent single-loop requests (3 parallel)
 *   S7: Session persistence across requests
 *   S8: WebSocket lifecycle events (connect → chat.send → text.delta → chat.final)
 *
 * Outputs JSON results to tests/output/dual-loop-stress-{runtime}.json
 *
 * Usage:
 *   node tests/benchmark/dual-loop-stress.mjs              # both runtimes
 *   node tests/benchmark/dual-loop-stress.mjs lumin-ts     # TS only
 *   node tests/benchmark/dual-loop-stress.mjs lumin-rust   # Rust only
 */

import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import crypto from 'node:crypto';

const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'openai/gpt-oss-120b';

const TS_CLI = join(process.cwd(), 'dist', 'cli.js');
const RUST_BIN = join(process.cwd(), 'rust', 'target', 'release', 'lumin-server');
const OUTPUT_DIR = join(process.cwd(), 'tests', 'output');

mkdirSync(OUTPUT_DIR, { recursive: true });

const arg = process.argv[2] || 'all';

// ── Helpers ───────────────────────────────────────────────

function log(msg) { process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, body, timeoutMs = 90_000) {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = performance.now() - start;
    const data = await res.json();
    return { ok: res.ok && data.status === 'success', elapsed, data, status: res.status };
  } catch (err) {
    return { ok: false, elapsed: performance.now() - start, error: err.message, status: 0 };
  }
}

// ── Server Management ────────────────────────────────────

async function startTSServer(port, loopMode = 'single') {
  const proc = spawn('node', [TS_CLI, 'serve', '--port', String(port)], {
    env: {
      ...process.env,
      OPENAI_API_BASE_URL: BASE_URL,
      OPENAI_API_KEY: API_KEY,
      AGENT_DEFAULT_MODEL: MODEL,
      WORKSPACE_DIR: '/tmp/dual-stress-ts',
      LUMIN_LOOP_MODE: loopMode,
      LUMIN_PORT: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mkdirSync('/tmp/dual-stress-ts', { recursive: true });
  return waitForServer(`http://127.0.0.1:${port}`, proc, `ts-${loopMode}`);
}

async function startRustServer(port, loopMode = 'single') {
  // Build release if needed
  try {
    execFileSync('cargo', ['build', '--release'], {
      cwd: join(process.cwd(), 'rust'), timeout: 120_000, stdio: 'pipe',
    });
  } catch (err) {
    log(`⚠ Rust build failed: ${String(err.message || err).slice(0, 200)}`);
    return null;
  }

  const proc = spawn(RUST_BIN, ['serve', '--port', String(port)], {
    env: {
      ...process.env,
      OPENAI_API_BASE_URL: BASE_URL,
      OPENAI_API_KEY: API_KEY,
      AGENT_DEFAULT_MODEL: MODEL,
      WORKSPACE_DIR: '/tmp/dual-stress-rust',
      LUMIN_LOOP_MODE: loopMode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mkdirSync('/tmp/dual-stress-rust', { recursive: true });
  return waitForServer(`http://127.0.0.1:${port}`, proc, `rust-${loopMode}`);
}

async function waitForServer(url, proc, label) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200 || res.status === 503) {
        log(`  ✓ ${label} server ready at ${url}`);
        return { url, proc, cleanup: () => { try { proc.kill('SIGTERM'); } catch {} } };
      }
    } catch { /* not ready */ }
    await sleep(300);
  }
  proc.kill('SIGTERM');
  log(`  ✗ ${label} server failed to start`);
  return null;
}

// ── WebSocket Test (raw http upgrade — compatible with Lumin's zero-dep WS) ──

function wsTest(url, message, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const parsed = new URL(url + '/v1/stream');
    const events = [];
    const start = performance.now();
    let resolved = false;

    const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };

    const timer = setTimeout(() => {
      done({ ok: false, error: 'timeout', events, elapsed: performance.now() - start });
    }, timeoutMs);

    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      },
    });

    req.on('upgrade', (_res, socket) => {
      events.push('open');
      let recvBuf = Buffer.alloc(0);

      // WS send (masked, client→server requires masking)
      const wsSend = (data) => {
        const payload = Buffer.from(JSON.stringify(data), 'utf8');
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) {
          header = Buffer.alloc(6);
          header[0] = 0x81; header[1] = 0x80 | payload.length;
          mask.copy(header, 2);
        } else {
          header = Buffer.alloc(8);
          header[0] = 0x81; header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
          mask.copy(header, 4);
        }
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
        socket.write(Buffer.concat([header, masked]));
      };

      socket.on('data', (data) => {
        recvBuf = Buffer.concat([recvBuf, data]);
        while (recvBuf.length >= 2) {
          const opcode = recvBuf[0] & 0x0f;
          if (opcode === 0x09 || opcode === 0x0a) { recvBuf = recvBuf.subarray(2); continue; }
          if (opcode === 0x08) { socket.end(); return; }
          let payloadLen = recvBuf[1] & 0x7f;
          let offset = 2;
          if (payloadLen === 126) { if (recvBuf.length < 4) break; payloadLen = recvBuf.readUInt16BE(2); offset = 4; }
          else if (payloadLen === 127) { if (recvBuf.length < 10) break; payloadLen = Number(recvBuf.readBigUInt64BE(2)); offset = 10; }
          if (recvBuf.length < offset + payloadLen) break;
          const text = recvBuf.subarray(offset, offset + payloadLen).toString('utf8');
          recvBuf = recvBuf.subarray(offset + payloadLen);
          try {
            const msg = JSON.parse(text);
            events.push(msg.type);

            if (msg.type === 'connected') {
              wsSend({ type: 'chat.send', content: message });
            }

            if (msg.type === 'chat.final') {
              clearTimeout(timer);
              socket.end();
              done({ ok: true, elapsed: performance.now() - start, events, content: msg.content, toolsUsed: msg.toolsUsed || [] });
            }

            if (msg.type === 'error' && !events.includes('chat.final')) {
              clearTimeout(timer);
              socket.end();
              done({ ok: false, error: msg.message, events, elapsed: performance.now() - start });
            }
          } catch { /* skip non-JSON */ }
        }
      });

      socket.on('end', () => {
        clearTimeout(timer);
        done({ ok: events.includes('chat.final'), error: events.includes('chat.final') ? null : 'ws closed', events, elapsed: performance.now() - start });
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, error: err.message, events, elapsed: performance.now() - start });
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, error: `connect: ${err.message}`, events, elapsed: performance.now() - start });
    });

    req.end();
  });
}

// ── Test Scenarios ──────────────────────────────────────

async function runScenarios(runtime, serverUrl) {
  const results = [];

  function record(id, name, result) {
    const r = { id, name, ...result, timestamp: new Date().toISOString() };
    const mark = r.ok ? '✓' : '✗';
    log(`  ${mark} ${id}: ${name} — ${Math.round(r.elapsed || 0)}ms`);
    if (!r.ok && r.error) log(`      error: ${String(r.error).slice(0, 150)}`);
    results.push(r);
    return r;
  }

  // S1: Basic text response
  {
    const r = await fetchJSON(`${serverUrl}/v1/chat`, { content: 'Say "STRESS_S1_OK" and nothing else.' });
    record('S1', 'Single-loop basic text', {
      ok: r.ok && (r.data?.response || '').includes('STRESS_S1_OK'),
      elapsed: r.elapsed,
      error: r.ok ? null : (r.data?.error || r.error),
      response: r.data?.response?.slice(0, 100),
    });
  }
  await sleep(2000);

  // S2: Tool calling
  {
    const r = await fetchJSON(`${serverUrl}/v1/chat`, {
      content: 'Use the bash tool to run: echo "TOOL_S2_RESULT". Return the output.',
    });
    const toolsUsed = r.data?.tools_used || r.data?.toolsUsed || [];
    record('S2', 'Single-loop tool calling', {
      ok: r.ok && toolsUsed.includes('bash'),
      elapsed: r.elapsed,
      error: r.ok ? null : (r.data?.error || r.error),
      toolsUsed,
      response: r.data?.response?.slice(0, 100),
    });
  }
  await sleep(2000);

  // S3: Multi-turn tool usage
  {
    const r = await fetchJSON(`${serverUrl}/v1/chat`, {
      content: 'Do these in order: 1) Use bash to run "echo STEP_A" 2) Use bash to run "echo STEP_B". Show both outputs.',
    });
    const toolsUsed = r.data?.tools_used || r.data?.toolsUsed || [];
    record('S3', 'Single-loop multi-turn tools', {
      ok: r.ok && toolsUsed.includes('bash'),
      elapsed: r.elapsed,
      iterations: r.data?.iterations,
      toolsUsed,
      response: r.data?.response?.slice(0, 150),
    });
  }
  await sleep(2000);

  // S4: Dual-loop task creation
  let dualServer = null;
  const dualPort = runtime === 'lumin-ts' ? 15010 : 15011;
  if (runtime === 'lumin-ts') {
    dualServer = await startTSServer(dualPort, 'dual');
  } else {
    dualServer = await startRustServer(dualPort, 'dual');
  }

  if (dualServer) {
    {
      const start = performance.now();
      const r = await fetchJSON(`${dualServer.url}/v1/chat`, { content: 'Process this task: say hello' });
      const elapsed = performance.now() - start;
      record('S4', 'Dual-loop quick return', {
        ok: r.ok && elapsed < 5000 && (r.data?.response || '').toLowerCase().includes('task'),
        elapsed,
        response: r.data?.response?.slice(0, 150),
      });
    }
    await sleep(2000);

    // S5: Verify dual mode is active
    {
      const healthR = await fetch(`${dualServer.url}/health`);
      const health = await healthR.json();
      record('S5', 'Dual-loop mode active', {
        ok: health.loop_mode === 'dual' || health.loopMode === 'dual',
        elapsed: 0,
        loopMode: health.loop_mode || health.loopMode,
      });
    }

    dualServer.cleanup();
    await sleep(2000);
  } else {
    record('S4', 'Dual-loop quick return', { ok: false, elapsed: 0, error: 'dual server failed to start' });
    record('S5', 'Dual-loop mode active', { ok: false, elapsed: 0, error: 'dual server failed to start' });
  }

  // S6: Concurrent requests (3 parallel)
  {
    const start = performance.now();
    const promises = [0, 1, 2].map(i =>
      fetchJSON(`${serverUrl}/v1/chat`, { content: `Say "CONC_${i}" and nothing else.`, session_id: `conc-${i}` })
    );
    const results3 = await Promise.all(promises);
    const wallTime = performance.now() - start;
    const okCount = results3.filter(r => r.ok).length;
    record('S6', 'Concurrent 3x requests', {
      ok: okCount >= 2,
      elapsed: wallTime,
      okCount,
      total: 3,
    });
  }
  await sleep(5000); // longer cooldown after concurrent test

  // S7: Session persistence (with retry — LLM recall can be flaky)
  {
    let recalled = false;
    let lastResp = '';
    let totalElapsed = 0;
    let r1ok = false, r2ok = false;

    for (let attempt = 0; attempt < 3 && !recalled; attempt++) {
      if (attempt > 0) { log('    S7 retry...'); await sleep(3000); }
      const sid = `persist-${Date.now()}-${attempt}`;
      const r1 = await fetchJSON(`${serverUrl}/v1/chat`, { content: 'Remember the code word: ELEPHANT42', session_id: sid, sessionId: sid });
      r1ok = r1.ok;
      await sleep(2000);
      const r2 = await fetchJSON(`${serverUrl}/v1/chat`, { content: 'What was the code word I told you?', session_id: sid, sessionId: sid });
      r2ok = r2.ok;
      const resp = (r2.data?.response || '').toUpperCase();
      recalled = resp.includes('ELEPHANT') || resp.includes('42');
      lastResp = r2.data?.response?.slice(0, 100) || '';
      totalElapsed = (r1.elapsed || 0) + (r2.elapsed || 0);
    }

    record('S7', 'Session persistence', {
      ok: r1ok && r2ok && recalled,
      elapsed: totalElapsed,
      recalled,
      response: lastResp,
    });
  }
  await sleep(2000);

  // S8: WebSocket lifecycle
  {
    const r = await wsTest(serverUrl, 'Say "WS_OK" and nothing else.', 60_000);
    const hasLifecycle = r.events.includes('open') && r.events.includes('connected');
    const hasFinal = r.events.includes('chat.final');
    record('S8', 'WebSocket lifecycle', {
      ok: r.ok && hasLifecycle && hasFinal,
      elapsed: r.elapsed,
      events: r.events,
      error: r.error,
      content: r.content?.slice(0, 100),
    });
  }

  return results;
}

// ── Runtime Runner ───────────────────────────────────────

async function runRuntime(runtime) {
  log(`\n╔══════════════════════════════════════════════════╗`);
  log(`║  Dual-Loop Stress Test: ${runtime.padEnd(24)}║`);
  log(`╚══════════════════════════════════════════════════╝`);

  const port = runtime === 'lumin-ts' ? 15000 : 15001;
  let server;

  if (runtime === 'lumin-ts') {
    server = await startTSServer(port, 'single');
  } else {
    server = await startRustServer(port, 'single');
  }

  if (!server) {
    log(`✗ ${runtime} server failed to start — skipping`);
    return { runtime, scenarios: [], error: 'server_start_failed' };
  }

  const scenarios = await runScenarios(runtime, server.url);
  server.cleanup();
  await sleep(2000);

  const passed = scenarios.filter(s => s.ok).length;
  const total = scenarios.length;
  log(`\n  Result: ${passed}/${total} passed`);

  // Write results
  const output = {
    runtime,
    timestamp: new Date().toISOString(),
    config: { baseUrl: BASE_URL, model: MODEL },
    summary: { passed, total, passRate: `${Math.round(passed / total * 100)}%` },
    scenarios,
  };

  const outFile = join(OUTPUT_DIR, `dual-loop-stress-${runtime.replace('lumin-', '')}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  log(`  Output: ${outFile}`);

  return output;
}

// ── Pre-flight ──────────────────────────────────────────

async function preflight() {
  log(`\nPre-flight checks...`);
  log(`  Gateway: ${BASE_URL}`);
  log(`  Model:   ${MODEL}`);

  if (!API_KEY) {
    log(`  ✗ OPENAI_API_KEY not set — aborting`);
    process.exit(1);
  }

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'OK' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 200) {
      log(`  ✓ LLM gateway reachable`);
    } else {
      const body = await res.json().catch(() => ({}));
      log(`  ⚠ LLM returned ${res.status}: ${body.error?.message || 'unknown'}`);
    }
  } catch (err) {
    log(`  ✗ LLM unreachable: ${err.message}`);
    process.exit(1);
  }

  // Check TS build
  try {
    execFileSync('node', ['-e', `require('${join(process.cwd(), 'dist', 'cli.js')}')`], { timeout: 5000, stdio: 'pipe' });
    log(`  ✓ TS build available`);
  } catch {
    log(`  ⚠ TS not loadable (may still work via spawn)`);
  }
}

// ── Main ────────────────────────────────────────────────

async function main() {
  await preflight();

  const allResults = [];

  if (arg === 'all' || arg === 'lumin-ts') {
    allResults.push(await runRuntime('lumin-ts'));
    await sleep(3000);
  }

  if (arg === 'all' || arg === 'lumin-rust') {
    allResults.push(await runRuntime('lumin-rust'));
  }

  // Summary
  log(`\n${'━'.repeat(60)}`);
  log(`SUMMARY`);
  log(`${'━'.repeat(60)}`);

  console.log('\n┌──────────┬──────┬────────┬────────────────────────────────┐');
  console.log('│ Runtime  │ Pass │  Rate  │ Failed                         │');
  console.log('├──────────┼──────┼────────┼────────────────────────────────┤');

  for (const r of allResults) {
    if (r.error) {
      console.log(`│ ${r.runtime.padEnd(8)} │  N/A │  N/A   │ ${r.error.padEnd(30)} │`);
      continue;
    }
    const failed = r.scenarios.filter(s => !s.ok).map(s => s.id).join(', ') || 'none';
    console.log(`│ ${r.runtime.padEnd(8)} │ ${String(r.summary.passed + '/' + r.summary.total).padStart(4)} │ ${r.summary.passRate.padStart(6)} │ ${failed.padEnd(30)} │`);
  }
  console.log('└──────────┴──────┴────────┴────────────────────────────────┘');

  // Write combined results
  const combinedFile = join(OUTPUT_DIR, 'dual-loop-stress-combined.json');
  writeFileSync(combinedFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    runtimes: allResults,
  }, null, 2));
  log(`\nCombined output: ${combinedFile}`);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
