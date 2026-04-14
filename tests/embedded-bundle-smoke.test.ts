/**
 * Embedded bundle smoke tests.
 *
 * - Bundle exists after `npm run build:embedded`
 * - No `node:` imports in the bundle
 * - Bundle stays under gzip budget (200KB hard cap; 100KB soft target)
 * - JSC can load the bundle and the global `LuminClaw` exists with expected functions
 *   (skipped automatically when /System/.../jsc CLI is not present)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUNDLE = 'dist/luminclaw-core.js';
const JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc';

describe('embedded bundle', () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE)) {
      // Use spawnSync (not execSync) — passes hardened-fs hook.
      const r = spawnSync('bash', ['scripts/build-embedded.sh'], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('build-embedded.sh failed');
    }
  });

  it('bundle file exists', () => {
    expect(existsSync(BUNDLE)).toBe(true);
  });

  it('contains zero node: imports', () => {
    const content = readFileSync(BUNDLE, 'utf8');
    const matches = content.match(/['"]node:[a-z/]+['"]/g) ?? [];
    expect(matches).toEqual([]);
  });

  it('stays under 200KB gzipped (hard cap; 100KB soft target)', () => {
    const raw = readFileSync(BUNDLE);
    const gz = gzipSync(raw).length;
    if (gz > 100 * 1024) {
      console.warn(`Bundle size ${gz} exceeds 100KB soft target`);
    }
    expect(gz).toBeLessThan(200 * 1024);
  });

  it('LuminClaw global exposes createAgentRuntime in JSC (macOS only)', () => {
    if (!existsSync(JSC)) {
      console.warn('JSC CLI not found, skipping (non-macOS or missing JavaScriptCore)');
      return;
    }
    const result = spawnSync(JSC, [
      BUNDLE,
      '-e', 'print(typeof LuminClaw); print(typeof LuminClaw.createAgentRuntime); print(typeof LuminClaw.OpenAICompatibleProvider);',
    ], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toEqual(['object', 'function', 'function']);
  }, 30_000);
});
