/**
 * Log — zero-dependency structured debug logger for Lumin runtime.
 *
 * Writes to stderr (stdout is reserved for IPC/SSE).
 *
 * **Log levels** (controlled via `LOG_LEVEL` env var, default `info`):
 *   `debug` → `info` → `warn` → `error`
 *
 * **Debug filtering** (controlled via `DEBUG` env var):
 *   `DEBUG=lumin:*`             — all modules
 *   `DEBUG=lumin:agent`         — single module
 *   `DEBUG=lumin:agent,lumin:server` — multiple modules
 *
 * @example
 * ```typescript
 * import { createLogger } from './log.js';
 * const log = createLogger('agent');
 *
 * log.debug('iteration start', { i: 1 });
 * log.info('tool executed', { tool: 'bash', duration: 120 });
 * log.warn('approaching context limit', { chars: 550_000 });
 * log.error('LLM call failed', { error: 'timeout' });
 * ```
 *
 * @module log
 */

// ── Types ────────────────────────────────────────────────

/** Supported log levels in ascending severity order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A structured logger instance bound to a specific module name. */
export interface Logger {
  /** Log at debug level — verbose, only visible when LOG_LEVEL=debug or DEBUG pattern matches. */
  debug(message: string, data?: Record<string, unknown>): void;
  /** Log at info level — normal operational messages. */
  info(message: string, data?: Record<string, unknown>): void;
  /** Log at warn level — potential issues that are not fatal. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Log at error level — failures requiring attention. */
  error(message: string, data?: Record<string, unknown>): void;
}

// ── Constants ────────────────────────────────────────────

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

// ── Internal State ───────────────────────────────────────

let resolvedLevel: number | null = null;
let debugPatterns: RegExp[] | null = null;

function getMinLevel(): number {
  if (resolvedLevel === null) {
    const env = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    resolvedLevel = LEVELS[env] ?? LEVELS.info;
  }
  return resolvedLevel;
}

function getDebugPatterns(): RegExp[] {
  if (debugPatterns === null) {
    const raw = process.env.DEBUG || '';
    if (!raw) {
      debugPatterns = [];
    } else {
      debugPatterns = raw.split(',').map(p => {
        const escaped = p.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`);
      });
    }
  }
  return debugPatterns;
}

function matchesDebug(namespace: string): boolean {
  const patterns = getDebugPatterns();
  return patterns.length > 0 && patterns.some(p => p.test(namespace));
}

function formatLine(level: LogLevel, namespace: string, message: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const suffix = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  return `${ts} ${LEVEL_LABELS[level]} [${namespace}] ${message}${suffix}\n`;
}

// ── Public API ───────────────────────────────────────────

/**
 * Create a named logger instance for a specific module.
 *
 * @param module - Short module name (e.g., 'agent', 'server', 'provider').
 *   The full namespace becomes `lumin:{module}`.
 * @returns A {@link Logger} instance with debug/info/warn/error methods.
 *
 * @example
 * ```typescript
 * const log = createLogger('server');
 * log.info('Listening', { port: 3001, host: '0.0.0.0' });
 * ```
 */
export function createLogger(module: string): Logger {
  const namespace = `lumin:${module}`;

  function write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const minLevel = getMinLevel();

    // Debug level: only emit if LOG_LEVEL=debug OR DEBUG pattern matches
    if (level === 'debug') {
      if (minLevel > LEVELS.debug && !matchesDebug(namespace)) return;
    } else {
      if (LEVELS[level] < minLevel) return;
    }

    process.stderr.write(formatLine(level, namespace, message, data));
  }

  return {
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}

/**
 * Reset internal cached state (for testing).
 * @internal
 */
export function _resetLogState(): void {
  resolvedLevel = null;
  debugPatterns = null;
}
