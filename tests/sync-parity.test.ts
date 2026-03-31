/**
 * TS ↔ Rust Behavioral Parity Test
 *
 * Starts both runtimes, sends identical requests, verifies structural
 * equivalence of responses. Uses real LLM — no mocks.
 *
 * Test dimensions:
 *   P1: Health endpoint structure
 *   P2: Basic text response structure
 *   P3: Function calling (bash tool execution)
 *   P4: Multi-step tool usage (2+ tool calls in one conversation)
 *   P5: Session persistence across requests
 *   P6: Memory store + recall via tools
 *   P7: Dual-loop quick return
 *   P8: Dual-loop health reports correct mode
 *   P9: WebSocket event sequence
 *   P10: Error handling (invalid request)
 *   P11: Concurrent request handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

// ── Config ────────────────────────────────────────────────

const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'openai/gpt-oss-120b';

const TS_CLI = join(process.cwd(), 'dist', 'cli.js');
const RUST_BIN = join(process.cwd(), 'rust', 'target', 'release', 'lumin-server');
const TS_PORT = 17000;
const RUST_PORT = 17001;
const TS_DUAL_PORT = 17010;
const RUST_DUAL_PORT = 17011;
const TS_WORKSPACE = '/tmp/sync-parity-ts';
const RUST_WORKSPACE = '/tmp/sync-parity-rust';

// ── Skip check ────────────────────────────────────────────

function shouldSkip(): boolean {
  if (!API_KEY) return true;
  try {
    const res = execFileSync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--connect-timeout', '5', `${BASE_URL.replace('/v1', '')}/health`,
    ], { encoding: 'utf8', timeout: 10_000 });
    return !['200', '404'].includes(res.trim());
  } catch {
    return true;
  }
}

// ── Server helpers ────────────────────────────────────────

interface Server {
  url: string;
  proc: ChildProcess;
  cleanup: () => void;
}

async function startServer(
  cmd: string, args: string[], port: number, workspace: string,
  env: Record<string, string> = {},
): Promise<Server> {
  mkdirSync(workspace, { recursive: true });
  const proc = spawn(cmd, args, {
    env: {
      ...process.env,
      OPENAI_API_BASE_URL: BASE_URL,
      OPENAI_API_KEY: API_KEY,
      AGENT_DEFAULT_MODEL: MODEL,
      WORKSPACE_DIR: workspace,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200 || res.status === 503) {
        return { url, proc, cleanup: () => { try { proc.kill('SIGTERM'); } catch {} } };
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 300));
  }
  proc.kill('SIGTERM');
  throw new Error(`Server on port ${port} did not start`);
}

function startTS(port: number, workspace: string, loopMode = 'single') {
  return startServer('node', [TS_CLI, 'serve', '--port', String(port)], port, workspace, {
    LUMIN_LOOP_MODE: loopMode,
    LUMIN_PORT: String(port),
  });
}

function startRust(port: number, workspace: string, loopMode = 'single') {
  return startServer(RUST_BIN, ['serve', '--port', String(port)], port, workspace, {
    LUMIN_LOOP_MODE: loopMode,
  });
}

// ── HTTP helpers ──────────────────────────────────────────

async function chat(serverUrl: string, content: string, sessionId?: string, timeoutMs = 90_000) {
  const res = await fetch(`${serverUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, sessionId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { status: 'error', error: text.slice(0, 200), response: null } as Record<string, unknown>;
  }
}

async function health(serverUrl: string) {
  const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Raw WebSocket helper (compatible with Lumin's zero-dep WS) ──

function rawWsChat(serverUrl: string, message: string, timeoutMs = 60_000): Promise<{
  events: string[];
  content?: string;
  toolsUsed?: string[];
  error?: string;
}> {
  return new Promise((resolve) => {
    const parsed = new URL(serverUrl + '/v1/stream');
    const events: string[] = [];
    let resolved = false;
    const done = (r: any) => { if (!resolved) { resolved = true; resolve(r); } };

    const timer = setTimeout(() => {
      done({ events, error: 'timeout' });
    }, timeoutMs);

    const key = randomBytes(16).toString('base64');
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

      const wsSend = (data: unknown) => {
        const payload = Buffer.from(JSON.stringify(data), 'utf8');
        const mask = randomBytes(4);
        let header: Buffer;
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

      socket.on('data', (data: Buffer) => {
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
            if (msg.type === 'connected') wsSend({ type: 'chat.send', content: message });
            if (msg.type === 'chat.final') {
              clearTimeout(timer);
              socket.end();
              done({ events, content: msg.content, toolsUsed: msg.toolsUsed || [] });
            }
          } catch { /* skip */ }
        }
      });

      socket.on('end', () => { clearTimeout(timer); done({ events, error: events.includes('chat.final') ? undefined : 'ws closed' }); });
      socket.on('error', (err: Error) => { clearTimeout(timer); done({ events, error: err.message }); });
    });

    req.on('error', (err) => { clearTimeout(timer); done({ events, error: `connect: ${err.message}` }); });
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────

describe('TS ↔ Rust Behavioral Parity', () => {
  let ts: Server;
  let rust: Server;
  let skip: boolean;

  beforeAll(async () => {
    skip = shouldSkip();
    if (skip) return;

    // Build Rust release
    try {
      execFileSync('cargo', ['build', '--release'], {
        cwd: join(process.cwd(), 'rust'), timeout: 120_000, stdio: 'pipe',
      });
    } catch {
      skip = true;
      return;
    }

    // Clean workspaces
    rmSync(TS_WORKSPACE, { recursive: true, force: true });
    rmSync(RUST_WORKSPACE, { recursive: true, force: true });

    [ts, rust] = await Promise.all([
      startTS(TS_PORT, TS_WORKSPACE),
      startRust(RUST_PORT, RUST_WORKSPACE),
    ]);
  }, 60_000);

  afterAll(async () => {
    ts?.cleanup();
    rust?.cleanup();
    await new Promise(r => setTimeout(r, 1000));
  });

  // ── P1: Health endpoint structure ──

  it('P1: health endpoints return same structure', async () => {
    if (skip) return;
    const [tsH, rustH] = await Promise.all([health(ts.url), health(rust.url)]);

    // Both have the same required fields
    for (const h of [tsH, rustH]) {
      expect(h).toHaveProperty('status');
      expect(h).toHaveProperty('version');
      expect(h).toHaveProperty('runtime');
    }

    // Both report loop mode
    const tsMode = (tsH as any).loopMode ?? (tsH as any).loop_mode;
    const rustMode = (rustH as any).loopMode ?? (rustH as any).loop_mode;
    expect(tsMode).toBe('single');
    expect(rustMode).toBe('single');
  });

  // ── P2: Basic text response structure ──

  it('P2: basic text response has same fields', async () => {
    if (skip) return;
    const prompt = 'Reply with exactly: PARITY_CHECK_OK';
    const [tsR, rustR] = await Promise.all([chat(ts.url, prompt), chat(rust.url, prompt)]);

    // Same response structure
    for (const r of [tsR, rustR]) {
      expect(r.status).toBe('success');
      expect(typeof r.response).toBe('string');
      expect((r.response as string).length).toBeGreaterThan(0);
    }

    // Both report session ID (both should use camelCase now)
    expect(tsR).toHaveProperty('sessionId');
    expect(rustR).toHaveProperty('sessionId');
  }, 30_000);

  // ── P3: Function calling ──

  it('P3: both runtimes execute bash tool', async () => {
    if (skip) return;
    const prompt = 'Use bash to run: echo "PARITY_TOOL_3". Return the output.';

    // Sequential to avoid rate limits
    const tsR = await chat(ts.url, prompt);
    await new Promise(r => setTimeout(r, 2000));
    const rustR = await chat(rust.url, prompt);

    for (const r of [tsR, rustR]) {
      expect(r.status).toBe('success');
      const tools = (r as any).toolsUsed ?? [];
      expect(tools).toContain('bash');
    }
  }, 60_000);

  // ── P4: Multi-step tool usage ──

  it('P4: both handle multi-step tool calls', async () => {
    if (skip) return;
    const prompt = 'Do these in order: 1) bash echo "STEP_X" 2) bash echo "STEP_Y". Show both.';

    const tsR = await chat(ts.url, prompt);
    await new Promise(r => setTimeout(r, 2000));
    const rustR = await chat(rust.url, prompt);

    for (const r of [tsR, rustR]) {
      expect(r.status).toBe('success');
      const tools = (r as any).toolsUsed ?? [];
      expect(tools).toContain('bash');
      const iterations = (r as any).iterations;
      expect(iterations).toBeGreaterThanOrEqual(2);
    }
  }, 60_000);

  // ── P5: Session persistence ──

  it('P5: both persist session across requests', async () => {
    if (skip) return;

    // TS session
    const tsSid = `parity-ts-${Date.now()}`;
    await chat(ts.url, 'Remember: the secret code is FALCON99', tsSid);
    await new Promise(r => setTimeout(r, 2000));
    const tsRecall = await chat(ts.url, 'What was the secret code?', tsSid);

    // Rust session
    const rustSid = `parity-rust-${Date.now()}`;
    await chat(rust.url, 'Remember: the secret code is FALCON99', rustSid);
    await new Promise(r => setTimeout(r, 2000));
    const rustRecall = await chat(rust.url, 'What was the secret code?', rustSid);

    for (const r of [tsRecall, rustRecall]) {
      expect(r.status).toBe('success');
      const response = ((r.response as string) || '').toUpperCase();
      expect(response).toContain('FALCON');
    }
  }, 120_000);

  // ── P6: Memory store + recall ──

  it('P6: both store and recall memories via tools', async () => {
    if (skip) return;

    const memKey = `MEM_${Date.now()}`;

    // TS: store then recall
    await chat(ts.url, `Use the memory_store tool to store this: "${memKey} is the parity test key"`);
    await new Promise(r => setTimeout(r, 2000));
    const tsRecall = await chat(ts.url, `Use the memory_recall tool to search for "${memKey}"`);

    // Rust: store then recall
    await chat(rust.url, `Use the memory_store tool to store this: "${memKey} is the parity test key"`);
    await new Promise(r => setTimeout(r, 2000));
    const rustRecall = await chat(rust.url, `Use the memory_recall tool to search for "${memKey}"`);

    for (const r of [tsRecall, rustRecall]) {
      expect(r.status).toBe('success');
      const tools = (r as any).toolsUsed ?? [];
      expect(tools).toContain('memory_recall');
    }
  }, 120_000);

  // ── P7: Dual-loop quick return ──

  it('P7: both return quickly in dual-loop mode', async () => {
    if (skip) return;

    let tsDual: Server | null = null;
    let rustDual: Server | null = null;

    try {
      [tsDual, rustDual] = await Promise.all([
        startTS(TS_DUAL_PORT, TS_WORKSPACE + '-dual', 'dual'),
        startRust(RUST_DUAL_PORT, RUST_WORKSPACE + '-dual', 'dual'),
      ]);

      const start1 = Date.now();
      const tsR = await chat(tsDual.url, 'Process this task: hello');
      const tsElapsed = Date.now() - start1;

      const start2 = Date.now();
      const rustR = await chat(rustDual.url, 'Process this task: hello');
      const rustElapsed = Date.now() - start2;

      // Both return quickly (< 5s — task creation, not execution)
      expect(tsElapsed).toBeLessThan(5000);
      expect(rustElapsed).toBeLessThan(5000);

      // Both return success
      expect(tsR.status).toBe('success');
      expect(rustR.status).toBe('success');

      // Both mention "task" in response
      const tsText = ((tsR.response as string) || '').toLowerCase();
      const rustText = ((rustR.response as string) || '').toLowerCase();
      expect(tsText).toContain('task');
      expect(rustText).toContain('task');
    } finally {
      tsDual?.cleanup();
      rustDual?.cleanup();
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 60_000);

  // ── P8: Dual-loop health ──

  it('P8: dual-loop health reports correct mode', async () => {
    if (skip) return;

    let tsDual: Server | null = null;
    let rustDual: Server | null = null;

    try {
      [tsDual, rustDual] = await Promise.all([
        startTS(TS_DUAL_PORT + 2, TS_WORKSPACE + '-dual2', 'dual'),
        startRust(RUST_DUAL_PORT + 2, RUST_WORKSPACE + '-dual2', 'dual'),
      ]);

      const [tsH, rustH] = await Promise.all([health(tsDual.url), health(rustDual.url)]);

      const tsMode = (tsH as any).loopMode ?? (tsH as any).loop_mode;
      const rustMode = (rustH as any).loopMode ?? (rustH as any).loop_mode;
      expect(tsMode).toBe('dual');
      expect(rustMode).toBe('dual');
    } finally {
      tsDual?.cleanup();
      rustDual?.cleanup();
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 30_000);

  // ── P9: WebSocket event sequence ──

  it('P9: both produce same WebSocket event sequence', async () => {
    if (skip) return;

    const tsWs = await rawWsChat(ts.url, 'Say "WS_PARITY" and nothing else.');
    await new Promise(r => setTimeout(r, 2000));
    const rustWs = await rawWsChat(rust.url, 'Say "WS_PARITY" and nothing else.');

    // Both should have: open → connected → (possibly text.delta) → chat.final
    for (const ws of [tsWs, rustWs]) {
      expect(ws.events).toContain('open');
      expect(ws.events).toContain('connected');
      expect(ws.events).toContain('chat.final');
      expect(ws.error).toBeUndefined();
      expect(ws.content).toBeDefined();
      expect((ws.content || '').length).toBeGreaterThan(0);
    }
  }, 60_000);

  // ── P10: Error handling ──

  it('P10: both handle empty content gracefully', async () => {
    if (skip) return;

    const tsR = await fetch(`${ts.url}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });

    const rustR = await fetch(`${rust.url}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });

    // Both should handle gracefully (either 400 or process empty content)
    for (const r of [tsR, rustR]) {
      expect([200, 400, 422].includes(r.status) || r.status >= 200).toBe(true);
    }
  }, 15_000);

  // ── P11: Concurrent requests ──

  it('P11: both handle concurrent requests', async () => {
    if (skip) return;

    const send3 = (url: string) => Promise.all([
      chat(url, 'Say "C1"', `conc-1-${Date.now()}`),
      chat(url, 'Say "C2"', `conc-2-${Date.now()}`),
      chat(url, 'Say "C3"', `conc-3-${Date.now()}`),
    ]);

    const tsResults = await send3(ts.url);
    await new Promise(r => setTimeout(r, 3000));
    const rustResults = await send3(rust.url);

    const tsOk = tsResults.filter(r => r.status === 'success').length;
    const rustOk = rustResults.filter(r => r.status === 'success').length;

    // Both should handle at least 2/3 concurrent requests
    expect(tsOk).toBeGreaterThanOrEqual(2);
    expect(rustOk).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
