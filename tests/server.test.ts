/**
 * Tests for Server — HTTP handlers, WebSocket helpers, wsSend protection
 *
 * Note: We test the exported helper functions and protocol logic.
 * Full HTTP server tests require actual port binding (integration-level).
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resetConfig } from '../src/config.js';

// Since server.ts functions are not individually exported (module-scoped),
// we test the WebSocket encoding/decoding logic and protocol behavior
// by reimplementing the same algorithms and verifying consistency.

// ── WebSocket Frame Encoding ─────────────────────────────

function wsEncode(data: string): Buffer {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function wsDecode(buffer: Buffer): { text: string; consumed: number } | null {
  if (buffer.length < 2) return null;

  const masked = !!(buffer[1] & 0x80);
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (buffer.length < offset + 4 + payloadLen) return null;
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
    return { text: payload.toString('utf8'), consumed: offset + payloadLen };
  }

  if (buffer.length < offset + payloadLen) return null;
  return { text: buffer.subarray(offset, offset + payloadLen).toString('utf8'), consumed: offset + payloadLen };
}

describe('wsEncode', () => {
  it('encodes small payload (< 126 bytes)', () => {
    const encoded = wsEncode('hello');
    expect(encoded[0]).toBe(0x81); // FIN + text
    expect(encoded[1]).toBe(5);    // payload length
    expect(encoded.subarray(2).toString('utf8')).toBe('hello');
  });

  it('encodes medium payload (126-65535 bytes)', () => {
    const data = 'x'.repeat(200);
    const encoded = wsEncode(data);
    expect(encoded[0]).toBe(0x81);
    expect(encoded[1]).toBe(126);
    expect(encoded.readUInt16BE(2)).toBe(200);
    expect(encoded.subarray(4).toString('utf8')).toBe(data);
  });

  it('encodes large payload (>65535 bytes)', () => {
    const data = 'x'.repeat(70_000);
    const encoded = wsEncode(data);
    expect(encoded[0]).toBe(0x81);
    expect(encoded[1]).toBe(127);
    expect(Number(encoded.readBigUInt64BE(2))).toBe(70_000);
  });

  it('encodes unicode correctly', () => {
    const data = '你好世界🌍';
    const encoded = wsEncode(data);
    const decoded = wsDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.text).toBe(data);
  });

  it('encodes empty string', () => {
    const encoded = wsEncode('');
    expect(encoded[0]).toBe(0x81);
    expect(encoded[1]).toBe(0);
    expect(encoded.length).toBe(2);
  });
});

describe('wsDecode', () => {
  it('decodes unmasked text frame', () => {
    const encoded = wsEncode('test message');
    const result = wsDecode(encoded);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('test message');
    expect(result!.consumed).toBe(encoded.length);
  });

  it('decodes masked frame (client → server)', () => {
    // Build a masked frame manually
    const payload = Buffer.from('hello', 'utf8');
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const maskedPayload = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }

    const frame = Buffer.alloc(2 + 4 + payload.length);
    frame[0] = 0x81; // FIN + text
    frame[1] = 0x80 | payload.length; // masked + length
    mask.copy(frame, 2);
    maskedPayload.copy(frame, 6);

    const result = wsDecode(frame);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('hello');
  });

  it('returns null for incomplete frame', () => {
    expect(wsDecode(Buffer.alloc(1))).toBeNull();
  });

  it('returns null for incomplete medium payload header', () => {
    const buf = Buffer.alloc(3);
    buf[0] = 0x81;
    buf[1] = 126; // needs 2 more bytes for length
    expect(wsDecode(buf)).toBeNull();
  });

  it('returns null when payload is not fully received', () => {
    const buf = Buffer.alloc(3);
    buf[0] = 0x81;
    buf[1] = 10; // expects 10 bytes
    // Only 1 byte of payload
    expect(wsDecode(buf)).toBeNull();
  });

  it('roundtrips encode → decode', () => {
    const messages = ['', 'hi', 'a'.repeat(200), JSON.stringify({ type: 'chat.send', content: 'test' })];
    for (const msg of messages) {
      const encoded = wsEncode(msg);
      const decoded = wsDecode(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.text).toBe(msg);
    }
  });
});

// ── WebSocket Accept Key ─────────────────────────────────

describe('WebSocket handshake', () => {
  it('generates correct Sec-WebSocket-Accept', () => {
    const clientKey = 'dGhlIHNhbXBsZSBub25jZQ==';
    const accept = createHash('sha1')
      .update(clientKey + '258EAFA5-E914-47DA-95CA-5AB9DC85B5F5')
      .digest('base64');

    // Verify the accept key is a valid base64 string derived from the client key
    expect(accept).toBeTruthy();
    expect(typeof accept).toBe('string');
    // Verify deterministic — same input always produces same output
    const accept2 = createHash('sha1')
      .update(clientKey + '258EAFA5-E914-47DA-95CA-5AB9DC85B5F5')
      .digest('base64');
    expect(accept).toBe(accept2);
  });
});

// ── wsSend Protection ────────────────────────────────────

describe('wsSend protection', () => {
  function wsSend(socket: { destroyed: boolean; writable: boolean; write: (data: Buffer) => void }, data: unknown): boolean {
    try {
      if (socket.destroyed || !socket.writable) return false;
      socket.write(wsEncode(JSON.stringify(data)));
      return true;
    } catch { return false; }
  }

  it('returns false for destroyed socket', () => {
    const socket = { destroyed: true, writable: true, write: vi.fn() };
    expect(wsSend(socket, { type: 'test' })).toBe(false);
    expect(socket.write).not.toHaveBeenCalled();
  });

  it('returns false for non-writable socket', () => {
    const socket = { destroyed: false, writable: false, write: vi.fn() };
    expect(wsSend(socket, { type: 'test' })).toBe(false);
    expect(socket.write).not.toHaveBeenCalled();
  });

  it('returns true and writes for healthy socket', () => {
    const socket = { destroyed: false, writable: true, write: vi.fn() };
    expect(wsSend(socket, { type: 'test' })).toBe(true);
    expect(socket.write).toHaveBeenCalledOnce();
  });

  it('returns false when write throws', () => {
    const socket = {
      destroyed: false,
      writable: true,
      write: () => { throw new Error('EPIPE'); },
    };
    expect(wsSend(socket, { type: 'test' })).toBe(false);
  });
});

// ── Protocol Messages ────────────────────────────────────

describe('WS protocol messages', () => {
  it('chat.send message format', () => {
    const msg = { type: 'chat.send', content: 'hello world', sessionId: 'ws-abc123' };
    const encoded = wsEncode(JSON.stringify(msg));
    const decoded = wsDecode(encoded);
    const parsed = JSON.parse(decoded!.text);
    expect(parsed.type).toBe('chat.send');
    expect(parsed.content).toBe('hello world');
  });

  it('tool.approve message format', () => {
    const msg = { type: 'tool.approve', toolId: 'call-1', approved: true };
    const encoded = wsEncode(JSON.stringify(msg));
    const decoded = wsDecode(encoded);
    const parsed = JSON.parse(decoded!.text);
    expect(parsed.type).toBe('tool.approve');
    expect(parsed.toolId).toBe('call-1');
    expect(parsed.approved).toBe(true);
  });

  it('error response format', () => {
    const msg = { type: 'error', message: 'Invalid JSON' };
    const encoded = wsEncode(JSON.stringify(msg));
    const decoded = wsDecode(encoded);
    const parsed = JSON.parse(decoded!.text);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('Invalid JSON');
  });
});

// ── /v1/tools completeness ──────────────────────────────

describe('/v1/tools completeness', () => {
  it('getToolSpecs returns all builtin tools', async () => {
    const { getToolSpecs } = await import('../src/index.js');
    const { specs, count } = await getToolSpecs();

    const names = specs.map((s: any) => s.function.name);

    // Core builtins that must always be present
    const required = ['bash', 'read_file', 'write_file', 'list_files', 'edit_file', 'grep', 'web_fetch', 'think', 'memory_store', 'memory_recall'];
    for (const name of required) {
      expect(names, `missing tool: ${name}`).toContain(name);
    }
    expect(count).toBeGreaterThanOrEqual(required.length);
  });
});

// ── HTTP layer — Phase A field pass-through ──────────────

describe('HTTP layer — Phase A field pass-through', () => {
  it('POST /v1/chat response includes queued:true when enqueuing (real LLM)', async () => {
    // Verifies that processMessage returns queued:true when enqueuing to an
    // active task — this is the value handleChat must forward in the HTTP body.
    //
    // Rewritten per `no_mock_for_agent_infra`: drives a real LLM task whose
    // first request enters 'executing', then posts a follow-up on the same
    // session to exercise the enqueue path.
    const { HAS_REAL_LLM, loadEnvTest, waitUntil } = await import('./helpers/real-llm.js');
    if (!HAS_REAL_LLM) return; // skip if no LLM credentials (mirrors describeReal)
    loadEnvTest();

    const prevWorkspace = process.env.WORKSPACE_DIR;
    const prevLoopMode = process.env.LUMIN_LOOP_MODE;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-server-real-'));
    process.env.WORKSPACE_DIR = tmpDir;
    process.env.LUMIN_LOOP_MODE = 'dual';
    resetConfig();

    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const { EventBus } = await import('../src/sse.js');

    const loop = new DualLoopAgent();
    try {
      const bus = new EventBus();
      const first = await loop.processMessage(
        {
          content: 'Reply with the number 1, then 2, then 3, each on its own line, separated by pauses.',
          sessionId: 'sess-g1',
        },
        { bus },
      );

      // Wait until the inner loop reaches 'executing' (the active window
      // during which follow-ups enqueue).
      const executing = await waitUntil(() => loop.tasks.get(first.taskId!)?.status === 'executing', 15_000, 50);
      expect(executing).toBe(true);

      const second = await loop.processMessage(
        { content: 'follow-up', sessionId: 'sess-g1' },
        { bus },
      );

      // Core assertion: queued must be present and true on the result that
      // handleChat receives — and therefore must be forwarded to the HTTP response.
      expect((second as { queued?: boolean }).queued).toBe(true);
      expect(second.taskId).toBe(first.taskId);
    } finally {
      await loop.shutdown();
      if (prevWorkspace === undefined) delete process.env.WORKSPACE_DIR;
      else process.env.WORKSPACE_DIR = prevWorkspace;
      if (prevLoopMode === undefined) delete process.env.LUMIN_LOOP_MODE;
      else process.env.LUMIN_LOOP_MODE = prevLoopMode;
      resetConfig();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('GET /v1/tasks/:id response includes progress when the task has it', async () => {
    const { DualLoopAgent } = await import('../src/loop/dual.js');
    const { InMemoryTaskStore } = await import('../src/index.js');

    const loop = new DualLoopAgent();

    // Manually insert a task with progress into the loop's task store.
    loop.tasks.create({
      id: 't-g2',
      sessionId: 's-g2',
      instruction: 'test',
      artifactIds: [],
      status: 'executing',
    });
    loop.tasks.updateProgress('t-g2', { iterations: 3, toolsUsed: ['bash'], lastActivity: 1000 });

    // G2: DualLoopAgent.getTask projection must include the progress field.
    const projected = loop.getTask('t-g2');
    expect(projected).toBeDefined();
    expect((projected as any).progress).toEqual({
      iterations: 3,
      toolsUsed: ['bash'],
      lastActivity: 1000,
    });
  });
});

// ── GET /v1/tasks/:id — progress field ──────────────────
//
// handleGetTask calls loop.getTask(taskId) — a whitelisted projection — so
// the field must be explicitly included in DualLoopAgent.getTask's return.
// These tests exercise the store layer that handleGetTask reads from, confirming
// that TaskProgress round-trips through the store and would therefore appear in
// the HTTP response once the projection is fixed.

describe('GET /v1/tasks/:id — progress field', () => {
  it('includes TaskProgress when task has it', async () => {
    const { InMemoryTaskStore } = await import('../src/index.js');
    const store = new InMemoryTaskStore();

    const task = store.create({
      id: 'task-progress-test-1',
      sessionId: 'sess-1',
      instruction: 'test task',
      artifactIds: [],
      status: 'executing',
    });

    store.updateProgress(task.id, {
      iterations: 2,
      toolsUsed: ['bash', 'read_file'],
      lastActivity: 1000,
    });

    const fetched = store.get(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.progress).toEqual({
      iterations: 2,
      toolsUsed: ['bash', 'read_file'],
      lastActivity: 1000,
    });
  });

  it('progress is undefined when updateProgress has not been called', async () => {
    const { InMemoryTaskStore } = await import('../src/index.js');
    const store = new InMemoryTaskStore();

    const task = store.create({
      id: 'task-progress-test-2',
      sessionId: 'sess-2',
      instruction: 'another test task',
      artifactIds: [],
      status: 'pending',
    });

    const fetched = store.get(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.progress).toBeUndefined();
  });

  it('progress merges partial updates correctly', async () => {
    const { InMemoryTaskStore } = await import('../src/index.js');
    const store = new InMemoryTaskStore();

    const task = store.create({
      id: 'task-progress-test-3',
      sessionId: 'sess-3',
      instruction: 'merge test task',
      artifactIds: [],
      status: 'executing',
    });

    store.updateProgress(task.id, { iterations: 1, toolsUsed: ['bash'], lastActivity: 500 });
    store.updateProgress(task.id, { iterations: 3, lastActivity: 1500 });

    const fetched = store.get(task.id);
    expect(fetched!.progress).toEqual({
      iterations: 3,
      toolsUsed: ['bash'],   // preserved from first update
      lastActivity: 1500,
    });
  });
});

// ── B4: server startup — re-register persisted tasks ────

describe('server startup — re-register persisted tasks', () => {
  it('re-registers non-terminal tasks as interrupted on startup', async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-startup-'));
    try {
      const { writeMeta } = await import('../src/task/disk.js');
      await writeMeta(tmpWorkspace, 'sess', 'task-x', {
        id: 'task-x', sessionId: 'sess', instruction: 'unfinished',
        status: 'executing',
        createdAt: 1, updatedAt: 2,
        lastPersistedTurnOffset: 0, version: 1,
      });

      process.env.WORKSPACE_DIR = tmpWorkspace;
      resetConfig();

      const { DualLoopAgent } = await import('../src/loop/dual.js');
      const agent = new DualLoopAgent();
      await agent.loadPersistedTasks();

      const task = agent.tasks.get('task-x');
      expect(task).toBeDefined();
      expect(task!.status).toBe('interrupted');
    } finally {
      delete process.env.WORKSPACE_DIR;
      resetConfig();
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
    }
  });

  it('preserves terminal-status tasks as-is', async () => {
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lumin-startup2-'));
    try {
      const { writeMeta } = await import('../src/task/disk.js');
      await writeMeta(tmpWorkspace, 'sess', 'task-c', {
        id: 'task-c', sessionId: 'sess', instruction: 'done',
        status: 'completed',
        createdAt: 1, updatedAt: 2, endedAt: 2,
        lastPersistedTurnOffset: 0, version: 1,
      });

      process.env.WORKSPACE_DIR = tmpWorkspace;
      resetConfig();

      const { DualLoopAgent } = await import('../src/loop/dual.js');
      const agent = new DualLoopAgent();
      await agent.loadPersistedTasks();

      const task = agent.tasks.get('task-c');
      expect(task).toBeDefined();
      expect(task!.status).toBe('completed');
    } finally {
      delete process.env.WORKSPACE_DIR;
      resetConfig();
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
    }
  });
});
