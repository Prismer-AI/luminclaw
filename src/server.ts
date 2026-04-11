/**
 * Lumin Gateway Server — HTTP + WebSocket for real-time agent interaction.
 *
 * Zero external dependencies (pure Node.js `http` + WebSocket upgrade).
 *
 * **Endpoints:**
 * | Method | Path        | Description                    |
 * |--------|-------------|--------------------------------|
 * | GET    | `/health`   | Health check                   |
 * | GET    | `/v1/tools` | List available tools           |
 * | POST   | `/v1/chat`  | Send message, get JSON response|
 * | WS     | `/v1/stream`| Real-time WebSocket streaming  |
 *
 * **WebSocket protocol:**
 * ```
 * Client → { type: "chat.send", content: "...", sessionId?: "..." }
 * Server → { type: "lifecycle.start" }
 * Server → { type: "text.delta", delta: "..." }
 * Server → { type: "tool.start", tool: "...", args: {...} }
 * Server → { type: "tool.end", tool: "...", result: "..." }
 * Server → { type: "directive", directive: {...} }
 * Server → { type: "chat.final", content: "...", directives: [...] }
 * Server → { type: "error", message: "..." }
 * ```
 *
 * @module server
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { EventBus, type AgentEvent } from './sse.js';
import { ChannelManager } from './channels/manager.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { VERSION } from './version.js';
import { createAgentLoop, resolveLoopMode } from './loop/factory.js';
import type { IAgentLoop } from './loop/types.js';
import type { DualLoopAgent } from './loop/dual.js';

const log = createLogger('server');

// ── Shared loop instance (initialized in startServer) ────
// Using a module-level variable so handlers defined as standalone functions
// can access it via closure — same pattern as `runAgent` was previously used.
let sharedLoop: IAgentLoop | null = null;

function getLoop(): IAgentLoop {
  if (!sharedLoop) {
    // Fallback: create on demand if startServer hasn't run (e.g. tests).
    sharedLoop = createAgentLoop();
  }
  return sharedLoop;
}

// ── Types ────────────────────────────────────────────────

interface ServerOptions {
  port?: number;
  host?: string;
}

interface WsClient {
  socket: import('node:net').Socket;
  sessionId: string;
  alive: boolean;
}

// ── WebSocket Helpers (minimal, no ws library) ───────────

function acceptWebSocket(req: IncomingMessage, socket: import('node:net').Socket): boolean {
  const key = req.headers['sec-websocket-key'];
  if (!key) return false;

  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB9DC85B5F5')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );
  return true;
}

function wsEncode(data: string): Buffer {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;

  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
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
    const payload = buffer.subarray(offset, offset + payloadLen);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
    return { text: payload.toString('utf8'), consumed: offset + payloadLen };
  }

  if (buffer.length < offset + payloadLen) return null;
  return { text: buffer.subarray(offset, offset + payloadLen).toString('utf8'), consumed: offset + payloadLen };
}

function wsSend(socket: import('node:net').Socket, data: unknown): boolean {
  try {
    if (socket.destroyed || !socket.writable) return false;
    socket.write(wsEncode(JSON.stringify(data)));
    return true;
  } catch { return false; /* client disconnected */ }
}

function wsPing(socket: import('node:net').Socket): void {
  try {
    const frame = Buffer.alloc(2);
    frame[0] = 0x89; // FIN + ping
    frame[1] = 0;
    socket.write(frame);
  } catch { /* */ }
}

// ── HTTP Request Handlers ────────────────────────────────

const MAX_BODY_BYTES = 10_000_000; // 10 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Body exceeds ${MAX_BODY_BYTES} bytes`));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
    setTimeout(() => reject(new Error('Body read timeout')), 30_000);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = loadConfig();
  const checks: Record<string, string> = {};

  if (!cfg.llm.apiKey) checks.apiKey = 'missing';

  let pluginOk = false;
  try {
    const { existsSync } = await import('node:fs');
    pluginOk = existsSync(cfg.workspace.pluginPath);
  } catch { /* */ }
  if (!pluginOk) checks.plugin = `not found: ${cfg.workspace.pluginPath}`;

  const healthy = Object.keys(checks).length === 0;
  json(res, healthy ? 200 : 503, {
    status: healthy ? 'ok' : 'degraded',
    version: VERSION,
    runtime: 'lumin',
    loopMode: resolveLoopMode(),
    uptime: process.uptime(),
    ...(healthy ? {} : { checks }),
  });
}

async function handleTools(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { getToolSpecs } = await import('./index.js');
  const cfg = loadConfig();
  const enabledModules = cfg.modules.enabled.length > 0 ? cfg.modules.enabled : undefined;
  const { specs, count } = await getToolSpecs(enabledModules);
  json(res, 200, { tools: specs, count });
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: 'Failed to read request body' });
    return;
  }

  let payload: { content: string; sessionId?: string; config?: Record<string, unknown> };
  try {
    payload = JSON.parse(body);
    if (!payload.content) throw new Error('content is required');
  } catch (err) {
    json(res, 400, { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  const bus = new EventBus();

  // Collect all events for the response
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const result = await getLoop().processMessage(
    {
      content: payload.content,
      sessionId: payload.sessionId,
      config: payload.config as Record<string, string | number | string[] | undefined> | undefined,
    },
    { bus },
  );

  json(res, 200, {
    status: 'success',
    response: result.text,
    thinking: result.thinking,
    directives: result.directives,
    toolsUsed: result.toolsUsed,
    usage: result.usage,
    sessionId: result.sessionId,
    iterations: result.iterations,
    taskId: result.taskId,
    loopMode: getLoop().mode,
    events: events.length,
  });
}

async function handleArtifacts(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: 'Failed to read request body' });
    return;
  }

  let payload: { url: string; mimeType: string; type?: string };
  try {
    payload = JSON.parse(body);
    if (!payload.url || !payload.mimeType) throw new Error('url and mimeType are required');
  } catch (err) {
    json(res, 400, { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  const loop = getLoop();
  // Access the artifact store through the loop's addArtifact
  const { createArtifact } = await import('./artifacts/types.js');
  const artifact = createArtifact({
    url: payload.url,
    mimeType: payload.mimeType,
    type: (payload.type as 'image' | 'file' | 'url') ?? undefined,
    addedBy: 'user',
  });
  loop.addArtifact(artifact);

  json(res, 200, { artifactId: artifact.id, type: artifact.type, mimeType: artifact.mimeType });
}

// ── Task Polling Handlers ─────────────────────────────────

async function handleListTasks(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const loop = getLoop();
  const tasks = loop.getTasks?.() ?? [];
  json(res, 200, { tasks, count: tasks.length });
}

async function handleGetTask(req: IncomingMessage, res: ServerResponse, taskId: string): Promise<void> {
  const loop = getLoop();
  const task = loop.getTask?.(taskId);
  if (!task) {
    json(res, 404, { error: `Task ${taskId} not found` });
    return;
  }
  json(res, 200, task);
}

// ── WebSocket Handler ────────────────────────────────────

function handleWebSocket(req: IncomingMessage, socket: import('node:net').Socket): void {
  if (!acceptWebSocket(req, socket)) {
    socket.destroy();
    return;
  }

  const client: WsClient = {
    socket,
    sessionId: `ws-${randomBytes(8).toString('hex')}`,
    alive: true,
  };

  let recvBuffer = Buffer.alloc(0);
  // Active chat abort controller — set when chat.send starts, aborted on chat.cancel or disconnect
  let activeAbort: AbortController | null = null;

  // Heartbeat — ping every 30s, but tolerate 2 missed pongs before disconnect.
  // RawWebSocket (bridge client) sends masked pongs that may be lost in TCP buffers
  // during heavy agent tool execution (large tool results saturate the write buffer).
  let missedPongs = 0;
  const heartbeat = setInterval(() => {
    if (!client.alive) {
      missedPongs++;
      if (missedPongs >= 3) {
        // 3 consecutive missed pongs (~90s) — client truly gone
        socket.destroy();
        return;
      }
    } else {
      missedPongs = 0;
    }
    client.alive = false;
    wsPing(socket);
  }, 30_000);

  socket.on('data', async (data) => {
    recvBuffer = Buffer.concat([recvBuffer, data]);

    // Handle pong (opcode 0x0A) — client sends masked pong per RFC 6455
    if (recvBuffer.length >= 2 && (recvBuffer[0] & 0x0f) === 0x0a) {
      client.alive = true;
      // Masked pong: 2 header bytes + optional payload length + 4 mask key bytes + payload
      const masked = (recvBuffer[1] & 0x80) !== 0;
      const payloadLen = recvBuffer[1] & 0x7f;
      const frameLen = 2 + (masked ? 4 : 0) + payloadLen;
      if (recvBuffer.length >= frameLen) {
        recvBuffer = recvBuffer.subarray(frameLen);
      } else {
        recvBuffer = Buffer.alloc(0);
      }
      return;
    }

    // Handle close (opcode 0x08) — client may send masked close frame
    if (recvBuffer.length >= 2 && (recvBuffer[0] & 0x0f) === 0x08) {
      // Send close back (unmasked, server→client)
      const closeFrame = Buffer.alloc(2);
      closeFrame[0] = 0x88;
      closeFrame[1] = 0;
      try { socket.write(closeFrame); } catch { /* */ }
      socket.destroy();
      return;
    }

    const decoded = wsDecode(recvBuffer);
    if (!decoded) return;
    recvBuffer = recvBuffer.subarray(decoded.consumed);

    let msg: { type: string; content?: string; sessionId?: string; config?: Record<string, unknown>; images?: Array<{ url: string; path?: string; mimeType?: string }> };
    try {
      msg = JSON.parse(decoded.text);
    } catch {
      wsSend(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type === 'ping') {
      client.alive = true;
      wsSend(socket, { type: 'pong', timestamp: Date.now() });
      return;
    }

    // Approval response from client
    if (msg.type === 'tool.approve') {
      const { toolId, approved } = msg as unknown as { type: string; toolId?: string; approved?: boolean };
      if (toolId) {
        // Resolve via the global approval callback if registered
        const cb = (globalThis as Record<string, unknown>).__luminApprovalCallback as ((toolId: string, approved: boolean) => void) | undefined;
        if (cb) cb(toolId, !!approved);
      }
      return;
    }

    if (msg.type === 'chat.cancel') {
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
        wsSend(socket, { type: 'chat.cancelled', sessionId: client.sessionId });
      }
      return;
    }

    if (msg.type !== 'chat.send') {
      wsSend(socket, { type: 'error', message: `Unknown type: ${msg.type}` });
      return;
    }

    if (!msg.content) {
      wsSend(socket, { type: 'error', message: 'content is required' });
      return;
    }

    // Update session ID if provided
    if (msg.sessionId) {
      client.sessionId = msg.sessionId;
    }

    // Create abort controller for this chat turn
    const abortController = new AbortController();
    activeAbort = abortController;

    // Create event bus that forwards to WebSocket
    const bus = new EventBus();
    bus.subscribe((event) => {
      // Map internal events to WebSocket protocol
      switch (event.type) {
        case 'agent.start':
          wsSend(socket, { type: 'lifecycle.start', sessionId: client.sessionId });
          break;
        case 'text.delta':
          wsSend(socket, { type: 'text.delta', delta: (event.data as { delta: string }).delta });
          break;
        case 'tool.start': {
          const tsData = event.data as { tool: string; toolId?: string; args?: Record<string, unknown> };
          wsSend(socket, { type: 'tool.start', tool: tsData.tool, toolId: tsData.toolId, args: tsData.args });
          break;
        }
        case 'tool.end': {
          const teData = event.data as { tool: string; toolId?: string; result: string };
          wsSend(socket, { type: 'tool.end', tool: teData.tool, toolId: teData.toolId, result: teData.result });
          break;
        }
        case 'directive':
          wsSend(socket, { type: 'directive', directive: event.data });
          break;
        case 'tool.approval_required': {
          const arData = event.data as { tool: string; toolId: string; args: Record<string, unknown>; reason: string };
          wsSend(socket, { type: 'tool.approval_required', tool: arData.tool, toolId: arData.toolId, args: arData.args, reason: arData.reason });
          break;
        }
        case 'tool.approval_response': {
          const respData = event.data as { toolId: string; approved: boolean; reason?: string };
          wsSend(socket, { type: 'tool.approval_response', toolId: respData.toolId, approved: respData.approved, reason: respData.reason });
          break;
        }
        case 'error':
          wsSend(socket, { type: 'error', message: (event.data as { message: string }).message });
          break;
        case 'agent.end':
          // Wait for onResult to send chat.final
          break;
      }
    });

    // Run agent (with cancellation support + optional images for multimodal vision)
    const result = await getLoop().processMessage(
      {
        content: msg.content,
        images: msg.images,
        sessionId: client.sessionId,
        config: msg.config as Record<string, string | number | string[] | undefined> | undefined,
      },
      { bus, signal: abortController.signal },
    );

    activeAbort = null;
    wsSend(socket, {
      type: 'chat.final',
      content: result.text,
      thinking: result.thinking,
      directives: result.directives,
      toolsUsed: result.toolsUsed,
      usage: result.usage,
      sessionId: result.sessionId,
      iterations: result.iterations,
    });
  });

  socket.on('close', () => {
    clearInterval(heartbeat);
    // Abort any active agent run on disconnect
    if (activeAbort) { activeAbort.abort(); activeAbort = null; }
  });

  socket.on('error', () => {
    clearInterval(heartbeat);
    if (activeAbort) { activeAbort.abort(); activeAbort = null; }
  });

  // Welcome message
  wsSend(socket, {
    type: 'connected',
    sessionId: client.sessionId,
    version: VERSION,
    runtime: 'lumin',
  });
}

// ── Server ───────────────────────────────────────────────

/**
 * Start the Lumin gateway server (HTTP + WebSocket).
 *
 * @param opts - Optional overrides for port and host. Falls back to
 *   the unified config (`LUMIN_PORT` env var, default `3001`).
 */
export async function startServer(opts: ServerOptions = {}): Promise<void> {
  const serverCfg = loadConfig();
  const port = opts.port ?? serverCfg.port;
  const host = opts.host ?? serverCfg.host;

  // Initialise the shared agent loop once per server process.
  // Single-loop mode: stateless, safe to share across concurrent requests.
  // Dual-loop mode (Phase 4): DualLoopAgent will manage per-task state internally.
  sharedLoop = createAgentLoop(serverCfg.agent.loopMode);
  log.info('agent loop initialised', { mode: sharedLoop.mode });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    try {
      if (path === '/health' || path === '/') {
        await handleHealth(req, res);
      } else if (path === '/v1/tools' && method === 'GET') {
        await handleTools(req, res);
      } else if (path === '/v1/chat' && method === 'POST') {
        await handleChat(req, res);
      } else if (path === '/v1/artifacts' && method === 'POST') {
        await handleArtifacts(req, res);
      } else if (path === '/v1/tasks' && method === 'GET') {
        await handleListTasks(req, res);
      } else if (path.startsWith('/v1/tasks/') && method === 'GET') {
        const taskId = path.slice('/v1/tasks/'.length);
        await handleGetTask(req, res, taskId);
      } else {
        json(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      log.error('request error', { error: err instanceof Error ? err.message : String(err) });
      json(res, 500, { error: 'Internal server error' });
    }
  });

  // WebSocket upgrade
  server.on('upgrade', (req, socket, _head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const tcpSocket = socket as import('node:net').Socket;

    if (url.pathname === '/v1/stream') {
      handleWebSocket(req, tcpSocket);
    } else {
      tcpSocket.destroy();
    }
  });

  // ── Channel Manager — discover and start messaging channels ──
  const channelManager = new ChannelManager();
  channelManager.setHandler(async (msg) => {
    try {
      const result = await getLoop().processMessage({
        content: msg.text,
        sessionId: `${msg.chatId}-channel`,
      });
      return result.text || '(no response)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  // Start channels (non-blocking)
  channelManager.startAll().catch((err) => {
    log.error('channel startup error', { error: String(err) });
  });

  // Graceful shutdown
  const cfg = loadConfig();
  const shutdown = () => {
    log.info('shutting down');
    channelManager.stopAll().catch(() => {});
    sharedLoop?.shutdown().catch(() => {});
    server.close(() => {
      log.info('goodbye');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), cfg.server.shutdownTimeoutMs);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (err) => {
    log.error('unhandled promise rejection', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception, shutting down', { error: err.message, stack: err.stack });
    shutdown();
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log.info('gateway started', { host, port, http: `http://${host}:${port}/health`, ws: `ws://${host}:${port}/v1/stream` });
      process.stderr.write(`
╔═══════════════════════════════════════════════╗
║  Lumin v${VERSION} — Agent Gateway${' '.repeat(Math.max(0, 20 - VERSION.length))}║
╠═══════════════════════════════════════════════╣
║                                               ║
║  HTTP:  http://${host}:${port}/health${' '.repeat(Math.max(0, 25 - host.length - String(port).length))}║
║  WS:    ws://${host}:${port}/v1/stream${' '.repeat(Math.max(0, 23 - host.length - String(port).length))}║
║  Chat:  POST http://${host}:${port}/v1/chat${' '.repeat(Math.max(0, 20 - host.length - String(port).length))}║
║  Tools: GET  http://${host}:${port}/v1/tools${' '.repeat(Math.max(0, 19 - host.length - String(port).length))}║
║                                               ║
╚═══════════════════════════════════════════════╝
`);
      resolve();
    });
  });
}
