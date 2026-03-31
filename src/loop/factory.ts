/**
 * Agent loop factory.
 *
 * {@link createAgentLoop} is the single point where the execution architecture
 * is selected. Callers never instantiate `SingleLoopAgent` or `DualLoopAgent`
 * directly.
 *
 * **Mode resolution order** (later wins over earlier):
 * 1. Schema default: `'single'`
 * 2. `LUMIN_LOOP_MODE` environment variable
 * 3. `dbLoopMode` argument — per-container DB field (highest precedence)
 * 4. Explicit `mode` argument to `createAgentLoop()` (overrides all)
 *
 * This order lets the server default be overridden per-workspace from the DB,
 * which in turn can be overridden in tests via an explicit argument.
 *
 * @module loop/factory
 */

import { SingleLoopAgent } from './single.js';
import { DualLoopAgent } from './dual.js';
import type { IAgentLoop, LoopMode } from './types.js';
import { createLogger } from '../log.js';

const log = createLogger('loop:factory');

/**
 * Resolve the effective {@link LoopMode} from the environment and an optional
 * per-container DB value.
 *
 * Priority: `dbLoopMode` (DB) > `LUMIN_LOOP_MODE` (env) > `'single'` (default)
 *
 * Note: there is no "Lumin v1" or "Lumin v2". Both modes run inside the same
 * Lumin runtime. The mode only switches the internal execution architecture.
 */
export function resolveLoopMode(dbLoopMode?: string | null): LoopMode {
  // DB field takes highest precedence (per-container override)
  if (dbLoopMode === 'dual') return 'dual';
  if (dbLoopMode === 'single') return 'single';

  // Env var is the server-wide default
  const envMode = process.env.LUMIN_LOOP_MODE;
  if (envMode === 'dual' || envMode === 'single') return envMode;

  return 'single';
}

/**
 * Create an {@link IAgentLoop} for the given mode.
 *
 * Phase 0: only `'single'` is implemented.
 * Phase 4: `'dual'` will return a `DualLoopAgent` instance.
 *
 * If `'dual'` is requested before Phase 4 is complete, a warning is logged
 * and the factory falls back to `SingleLoopAgent` rather than throwing — this
 * allows env-var misconfiguration to degrade gracefully instead of crashing
 * the server on startup.
 *
 * @param mode - Explicit mode; omit to read from `LUMIN_LOOP_MODE` env var.
 */
export function createAgentLoop(mode?: LoopMode): IAgentLoop {
  const resolved = mode ?? resolveLoopMode();

  if (resolved === 'dual') {
    log.info('creating dual-loop agent', { mode: resolved });
    return new DualLoopAgent();
  }

  log.debug('creating agent loop', { mode: resolved });
  return new SingleLoopAgent();
}
