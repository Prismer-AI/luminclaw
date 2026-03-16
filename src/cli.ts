#!/usr/bin/env node
/**
 * Lumin CLI — lightweight agent runtime.
 *
 * Process entry point. Parses argv, dispatches to the appropriate
 * command handler, and manages the stdin/stdout IPC protocol for
 * backward-compatible container integration.
 *
 * **Commands:**
 * | Command | Description |
 * |---------|-------------|
 * | `agent --message <text>` | Run agent with a message |
 * | `serve [--port N]` | Start HTTP + WebSocket gateway |
 * | `health [--url URL]` | Check gateway health |
 * | `version` | Show version |
 *
 * **Stdin mode** (no subcommand):
 * ```bash
 * echo '{"type":"message","content":"hello"}' | lumin
 * ```
 *
 * @module cli
 */

import { writeOutput, readStdin } from './ipc.js';
import { createLogger } from './log.js';
import { VERSION } from './version.js';

const log = createLogger('cli');
const args = process.argv.slice(2);
const command = args[0];

// ── Helpers ──────────────────────────────────────────────

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

function printUsage(): void {
  process.stdout.write(`
Lumin v${VERSION} — lightweight agent runtime for academic research

Usage:
  lumin agent --message <text>  [options]   Run agent
  lumin serve [--port 3001]                 Start gateway server
  lumin health [--url http://localhost:3001] Check health
  lumin version                             Show version

Agent options:
  --message <text>       Message to send to the agent
  --session-id <id>      Reuse existing session
  --stream               Enable SSE event streaming on stdout
  --agent <id>           Agent identity (default: researcher)
  --model <name>         Override model
  --max-iterations <n>   Override max iterations (default: 40)

Server options:
  --port <n>             Gateway port (default: 3001)

Environment:
  OPENAI_API_BASE_URL    LLM API endpoint
  OPENAI_API_KEY         LLM API key
  AGENT_DEFAULT_MODEL    Default model (default: gpt-4o)
  WORKSPACE_DIR          Working directory (default: ./workspace)
  PRISMER_PLUGIN_PATH    Plugin tools path
  LUMIN_PORT             Server port (default: 3001)
`);
}

// ── Commands ─────────────────────────────────────────────

async function cmdVersion(): Promise<void> {
  process.stdout.write(`${VERSION}\n`);
}

async function cmdHealth(): Promise<void> {
  const url = getArg('--url') || 'http://localhost:3001';
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      log.error('health check failed', { status: res.status });
      process.exit(1);
    }
  } catch (err) {
    log.error('cannot reach server', { url, error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

async function cmdAgent(): Promise<void> {
  const message = getArg('--message');
  if (!message) {
    log.error('--message is required for agent command');
    process.exit(1);
  }

  const { runAgent } = await import('./index.js');
  await runAgent({
    type: 'message',
    content: message,
    sessionId: getArg('--session-id'),
    config: {
      agentId: getArg('--agent'),
      model: getArg('--model'),
      maxIterations: getArg('--max-iterations') ? parseInt(getArg('--max-iterations')!) : undefined,
    },
  }, {
    stream: hasFlag('--stream'),
  });
}

async function cmdServe(): Promise<void> {
  const port = parseInt(getArg('--port') || process.env.LUMIN_PORT || '3001', 10);
  const { startServer } = await import('./server.js');
  await startServer({ port });
}

async function cmdStdin(): Promise<void> {
  // Legacy stdin/stdout mode for backward compatibility
  try {
    const input = await readStdin();

    if (input.type === 'health') {
      writeOutput({ status: 'health_ok' });
      process.exit(0);
    }

    if (input.type === 'shutdown') {
      process.exit(0);
    }

    const { runAgent } = await import('./index.js');
    await runAgent(input, { stream: hasFlag('--stream') });
  } catch (err) {
    writeOutput({
      status: 'error',
      error: `Failed to read input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }
}

// ── Router ───────────────────────────────────────────────

async function main(): Promise<void> {
  switch (command) {
    case 'version':
    case '--version':
    case '-v':
      await cmdVersion();
      break;

    case 'health':
      await cmdHealth();
      break;

    case '--health':
      // Legacy: direct health output (no HTTP)
      writeOutput({ status: 'health_ok' });
      break;

    case 'agent':
      await cmdAgent();
      break;

    case 'serve':
    case 'server':
    case 'start':
      await cmdServe();
      break;

    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;

    case undefined:
      // No command — stdin mode (backward compat with IPC protocol)
      if (process.stdin.isTTY) {
        printUsage();
      } else {
        await cmdStdin();
      }
      break;

    default:
      log.error('unknown command', { command });
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
