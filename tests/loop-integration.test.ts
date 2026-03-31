/**
 * Real LLM integration tests for Phase 0 — Agent loop abstraction.
 *
 * Validates that the SingleLoopAgent.processMessage() path produces correct
 * results using real LLM inference, real tool execution, and real streaming.
 *
 * Requires Prismer Gateway access. Skips gracefully when unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, type ChildProcess } from 'node:child_process';

const TEST_DIR = join(process.cwd(), '.test-workspace-loop');
const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'us-kimi-k2.5';
const CLI = join(process.cwd(), 'dist', 'cli.js');

function isGatewayReachable(): boolean {
  try {
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${BASE_URL.replace('/v1', '')}/health"`,
      { encoding: 'utf8', timeout: 10_000 },
    );
    return result.trim() === '200' || result.trim() === '404';
  } catch {
    return false;
  }
}

/** Run agent via compiled CLI — full path: cli → runAgent → SingleLoopAgent */
function runViaCLI(message: string, extraEnv: Record<string, string> = {}, retries = 2): {
  status: string;
  response?: string;
  thinking?: string;
  toolsUsed?: string[];
  iterations?: number;
  error?: string;
} {
  const env = {
    ...process.env,
    OPENAI_API_BASE_URL: BASE_URL,
    OPENAI_API_KEY: API_KEY,
    AGENT_DEFAULT_MODEL: MODEL,
    WORKSPACE_DIR: TEST_DIR,
    LUMIN_LOOP_MODE: 'single',
    ...extraEnv,
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const stdout = execSync(
        `node ${CLI} agent --message ${JSON.stringify(message)}`,
        { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const match = stdout.match(/---LUMIN_OUTPUT_START---\n([\s\S]*?)\n---LUMIN_OUTPUT_END---/);
      if (match) {
        const parsed = JSON.parse(match[1]);
        if (parsed.status === 'success') return parsed;
        // 429 / transient error — retry
        if (attempt < retries && parsed.error?.includes('429')) {
          continue;
        }
        return parsed;
      }
      return { status: 'unknown', response: stdout };
    } catch (err: any) {
      const stdout = err.stdout?.toString() || '';
      const match = stdout.match(/---LUMIN_OUTPUT_START---\n([\s\S]*?)\n---LUMIN_OUTPUT_END---/);
      if (match) {
        const parsed = JSON.parse(match[1]);
        if (attempt < retries && parsed.error?.includes('429')) {
          continue;
        }
        return parsed;
      }
      if (attempt >= retries) {
        return { status: 'error', error: err.message };
      }
    }
  }
  return { status: 'error', error: 'exhausted retries' };
}

/** Start a Lumin server process, wait for /health, return cleanup function */
async function startServer(port: number): Promise<{ url: string; cleanup: () => void }> {
  const { spawn } = await import('node:child_process');
  const url = `http://127.0.0.1:${port}`;

  const proc: ChildProcess = spawn('node', [CLI, 'serve', '--port', String(port)], {
    env: {
      ...process.env,
      OPENAI_API_BASE_URL: BASE_URL,
      OPENAI_API_KEY: API_KEY,
      AGENT_DEFAULT_MODEL: MODEL,
      WORKSPACE_DIR: TEST_DIR,
      LUMIN_LOOP_MODE: 'single',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });

  // Wait for healthy
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const res = await fetch(`${url}/health`);
      // Accept both 200 (ok) and 503 (degraded — plugin not available locally)
      if (res.status === 200 || res.status === 503) {
        return {
          url,
          cleanup: () => { try { proc.kill('SIGTERM'); } catch {} },
        };
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 300));
  }

  proc.kill('SIGTERM');
  throw new Error(`Server on port ${port} did not start within 20s`);
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  if (!existsSync(CLI)) {
    execSync('npm run build', { cwd: process.cwd() });
  }
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── All tests require real gateway ──

describe.skipIf(!isGatewayReachable())('Phase 0 — Real LLM via SingleLoopAgent', () => {

  // ── CLI path: full agent loop through processMessage ──

  it('T1: basic LLM response through SingleLoopAgent', () => {
    const result = runViaCLI('Say exactly: "LOOP_OK". Nothing else.');
    expect(result.status).toBe('success');
    expect(result.response).toContain('LOOP_OK');
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('T2: tool calling (bash) through processMessage', () => {
    const result = runViaCLI('Use bash to run: echo "LOOP_TOOL_TEST". Show the output.');
    expect(result.status).toBe('success');
    expect(result.toolsUsed).toContain('bash');
    expect(result.response).toContain('LOOP_TOOL_TEST');
  }, 90_000);

  it('T3: multi-step tool usage', () => {
    const result = runViaCLI('Run these bash commands in order: echo "STEP_A" then echo "STEP_B". Show outputs.');
    expect(result.status).toBe('success');
    expect(result.toolsUsed).toContain('bash');
    expect(result.response).toContain('STEP_A');
    expect(result.response).toContain('STEP_B');
  }, 90_000);

  it('T4: LUMIN_LOOP_MODE=dual graceful fallback', () => {
    const result = runViaCLI('Say exactly: "DUAL_FALLBACK_OK"', { LUMIN_LOOP_MODE: 'dual' });
    expect(result.status).toBe('success');
    expect(result.response).toContain('DUAL_FALLBACK_OK');
  }, 90_000);

  // ── HTTP server path ──

  describe('T5: HTTP /v1/chat through loop', () => {
    let server: { url: string; cleanup: () => void } | null = null;

    beforeAll(async () => {
      server = await startServer(13901);
    }, 25_000);

    afterAll(() => { server?.cleanup(); });

    it('/health exposes loopMode=single', async () => {
      const res = await fetch(`${server!.url}/health`);
      const body = await res.json() as Record<string, unknown>;
      expect(body.runtime).toBe('lumin');
      expect(body.loopMode).toBe('single');
    });

    it('POST /v1/chat returns LLM response', async () => {
      const res = await fetch(`${server!.url}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Say exactly: "HTTP_LOOP_OK"' }),
      });
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('success');
      expect(body.response as string).toContain('HTTP_LOOP_OK');
      expect(body.sessionId).toBeDefined();
    }, 60_000);

    it('POST /v1/chat tool call works', async () => {
      const res = await fetch(`${server!.url}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Use bash to echo "HTTP_TOOL_OK". Show output.' }),
      });
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('success');
      expect(body.response as string).toContain('HTTP_TOOL_OK');
      expect(body.toolsUsed as string[]).toContain('bash');
    }, 60_000);

    it('session persists across requests', async () => {
      const sid = 'persist-' + Date.now();

      await fetch(`${server!.url}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Remember the code: PERSIST_GAMMA', sessionId: sid }),
      });

      const res = await fetch(`${server!.url}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'What was the code I just told you?', sessionId: sid }),
      });
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('success');
      expect(body.response as string).toContain('PERSIST_GAMMA');
    }, 120_000);
  });

  // ── WebSocket streaming path ──

  describe('T6: WebSocket streaming through loop', () => {
    let server: { url: string; cleanup: () => void } | null = null;

    beforeAll(async () => {
      server = await startServer(13902);
    }, 25_000);

    afterAll(() => { server?.cleanup(); });

    /**
     * Raw WebSocket client using node:http upgrade (the `ws` npm library
     * has a pre-existing handshake compatibility issue with Lumin's
     * zero-dependency WS implementation).
     */
    function rawWsConnect(url: string): Promise<{
      send: (data: unknown) => void;
      events: Array<{ type: string; [k: string]: unknown }>;
      waitForType: (type: string, timeoutMs?: number) => Promise<{ type: string; [k: string]: unknown }>;
      close: () => void;
    }> {
      const http = require('node:http') as typeof import('node:http');
      const crypto = require('node:crypto') as typeof import('node:crypto');
      const parsed = new URL(url);

      return new Promise((resolve, reject) => {
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
          const events: Array<{ type: string; [k: string]: unknown }> = [];
          const listeners: Array<(msg: { type: string }) => void> = [];
          let recvBuf = Buffer.alloc(0);

          socket.on('data', (data) => {
            recvBuf = Buffer.concat([recvBuf, data]);
            // Minimal WS decode (unmasked text frames from server)
            while (recvBuf.length >= 2) {
              const opcode = recvBuf[0] & 0x0f;
              if (opcode === 0x09 || opcode === 0x0a) { recvBuf = recvBuf.subarray(2); continue; } // ping/pong
              if (opcode === 0x08) { socket.end(); return; } // close
              let payloadLen = recvBuf[1] & 0x7f;
              let offset = 2;
              if (payloadLen === 126) { if (recvBuf.length < 4) break; payloadLen = recvBuf.readUInt16BE(2); offset = 4; }
              else if (payloadLen === 127) { if (recvBuf.length < 10) break; payloadLen = Number(recvBuf.readBigUInt64BE(2)); offset = 10; }
              if (recvBuf.length < offset + payloadLen) break;
              const text = recvBuf.subarray(offset, offset + payloadLen).toString('utf8');
              recvBuf = recvBuf.subarray(offset + payloadLen);
              try {
                const msg = JSON.parse(text);
                events.push(msg);
                for (const l of listeners) l(msg);
              } catch { /* skip non-JSON */ }
            }
          });

          // WS send (masked, as required for client→server)
          const send = (data: unknown) => {
            const payload = Buffer.from(JSON.stringify(data), 'utf8');
            const mask = crypto.randomBytes(4);
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
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
            socket.write(Buffer.concat([header, masked]));
          };

          const waitForType = (type: string, timeoutMs = 60_000) =>
            new Promise<{ type: string; [k: string]: unknown }>((res, rej) => {
              const existing = events.find(e => e.type === type);
              if (existing) { res(existing); return; }
              const timer = setTimeout(() => rej(new Error(`WS timeout waiting for ${type}`)), timeoutMs);
              listeners.push((msg) => {
                if (msg.type === type) { clearTimeout(timer); res(msg as any); }
              });
            });

          resolve({ send, events, waitForType, close: () => socket.end() });
        });

        req.on('error', reject);
        req.end();
      });
    }

    it('receives lifecycle → text.delta → chat.final events', async () => {
      const wsUrl = `${server!.url.replace('http', 'ws')}/v1/stream`;
      const ws = await rawWsConnect(wsUrl);

      // Wait for connected, then send message
      await ws.waitForType('connected');
      ws.send({ type: 'chat.send', content: 'Say exactly: "WS_STREAM_OK"' });

      // Wait for chat.final
      const final = await ws.waitForType('chat.final', 60_000);
      ws.close();

      const types = ws.events.map(e => e.type);
      expect(types).toContain('connected');
      expect(types).toContain('lifecycle.start');
      expect(types).toContain('chat.final');

      const deltas = ws.events.filter(e => e.type === 'text.delta');
      expect(deltas.length).toBeGreaterThan(0);

      expect((final as any).content).toContain('WS_STREAM_OK');
    }, 90_000);

    it('tool events streamed via WebSocket', async () => {
      const wsUrl = `${server!.url.replace('http', 'ws')}/v1/stream`;
      const ws = await rawWsConnect(wsUrl);

      await ws.waitForType('connected');
      ws.send({ type: 'chat.send', content: 'Use bash to echo "WS_TOOL_EVENT". Show output.' });

      const final = await ws.waitForType('chat.final', 60_000);
      ws.close();

      const types = ws.events.map(e => e.type);
      expect(types).toContain('tool.start');
      expect(types).toContain('tool.end');

      const toolStart = ws.events.find(e => e.type === 'tool.start');
      expect(toolStart?.tool).toBe('bash');

      expect((final as any).content).toContain('WS_TOOL_EVENT');
      expect((final as any).toolsUsed).toContain('bash');
    }, 90_000);
  });
});
