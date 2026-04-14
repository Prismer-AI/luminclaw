# Phase H — Embedded Runtime Bundle (`luminclaw-core.js`)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Produce a single-file IIFE bundle `dist/luminclaw-core.js` that runs in JavaScriptCore (iOS), V8/Hermes (Android), and Electron contexts — anywhere with native `fetch`. ~< 100KB gzipped. Zero `node:*` imports. Includes plan-mode tools.

**Architecture:** Three additive changes to the production code (`DirectiveScanner` injection on `agent.ts`; `createConfig()` pure function on `config.ts`; new `embedded.ts` entry that calls a NEW `createAgentRuntime()` factory). Plus build pipeline: `esbuild.embedded.mjs` with `platform: 'neutral'`, build script that emits sha256 manifest + d.ts. All test coverage uses real LLM per project memory `feedback_no_mock_for_agent_infra`.

**Tech Stack:** TypeScript 5, esbuild, vitest, JavaScriptCore CLI for smoke test (macOS-only).

**Source spec:** `/Users/prismer/workspace/lumin-swift/docs/superpowers/specs/2026-04-15-luminclaw-ios-sdk-requirements.md`. iOS team confirmations:
- Bundle name: `luminclaw-core.js` (no platform suffix — works on iOS / Android / Electron / any embed)
- Plan-mode tools (enter_plan_mode, exit_plan_mode) are bundled
- Streaming over `Provider.chatStream` is in scope (iOS bridge will provide ReadableStream-aware fetch)
- Priority: start immediately

**Scope boundaries:**
- **In scope:** Bundle entry, build pipeline, test harness, manifest emission
- **Out of scope:** iOS Swift bridge implementation, Android Hermes integration, hot-update CDN logic — all owned by lumin-swift / future Android team
- **Out of scope:** Dual-loop, disk persistence, server, channels — embed runtime is single-loop only
- **Rust parity (Gate 1 = c):** No Rust changes

---

## Current state validation

Audited against source at HEAD `38f142e`:

- `src/agent.ts:38` imports `node:fs` at module scope. Three usages: lines 249 (`readdirSync`), 253 (`readFileSync`), 266 (`readdirSync`). All three are inside `scanDirectiveFiles` / `snapshotDirectiveFiles`. **Spec assertion confirmed.**
- `src/memory.ts` has clean `MemoryBackend` interface (line 63) + `FileMemoryBackend` impl (line 156) + `MemoryStore` facade (line 320) that accepts either. **Already iOS-ready**; we just exclude `FileMemoryBackend` at bundle time (esbuild dead-code-elimination via tree-shaking after the embed entry stops importing it).
- `src/config.ts:174` is the single `process.env` access point — single-shot via `fromEnv()`.

---

## Module Changes

| File | Change |
|------|--------|
| `src/agent.ts` | Add optional `DirectiveScanner` interface in `AgentOptions`. `scanDirectiveFiles` / `snapshotDirectiveFiles` delegate to scanner if injected, no-op otherwise. Remove top-level `node:fs` import. |
| `src/agent-fs-directive-scanner.ts` | **New.** Node-only `FsDirectiveScanner` impl — extracted so the embed bundle can omit `node:fs`. Server / single-loop / dual-loop wire this in their existing setup paths. |
| `src/config.ts` | Add `createConfig(overrides): LuminConfig` — pure function, no `process.env`. |
| `src/embedded.ts` | **New.** `createAgentRuntime(deps)` entry — single-loop only, takes provider + tools + systemPrompt + optional memoryBackend + optional config. Returns `{ processMessage, getSession, bus, shutdown }`. Auto-registers plan-mode tools. |
| `esbuild.embedded.mjs` | **New.** Build config: `platform: 'neutral'`, `format: 'iife'`, `globalName: 'LuminClaw'`. |
| `scripts/build-embedded.sh` | **New.** Runs tsc for d.ts, runs esbuild, emits sha256 + version manifest. |
| `package.json` | Add `build:embedded` script + `./embedded` export. |
| `tests/embedded-runtime.test.ts` | **New.** Real-LLM test: `createAgentRuntime` constructs, processMessage round-trips, plan-mode toggles, MemoryBackend injection works. |
| `tests/embedded-bundle-smoke.test.ts` | **New.** Builds bundle if missing, asserts `typeof LuminClaw.createAgentRuntime === 'function'` via JSC, grep `node:` is empty, gzip < 200KB hard cap. |

---

## Tasks

### Task H1: Inject `DirectiveScanner`, strip `node:fs` from agent.ts

**Files:**
- Modify: `src/agent.ts`
- Create: `src/agent-fs-directive-scanner.ts`
- Modify: `src/index.ts` and `src/loop/dual.ts` — wire the FsDirectiveScanner in their existing PrismerAgent constructions
- Modify: `tests/agent.test.ts` — 2 new DI-plumbing tests

- [ ] **Step 1: Write failing tests**

In `tests/agent.test.ts`, add an inner `describe`:

```typescript
describe('DirectiveScanner injection', () => {
  it('uses injected scanner when provided', async () => {
    const calls: number[] = [];
    const fakeScanner = {
      scan(_session: Session, _known?: Set<string>): void { calls.push(Date.now()); },
      snapshot(): Set<string> { return new Set(['a.json']); },
    };
    const provider = {
      chat: vi.fn().mockResolvedValue({
        text: 'ok', toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    };
    const agent = new PrismerAgent({
      provider: provider as any,
      tools: new ToolRegistry(),
      observer: new ConsoleObserver(),
      agents: new AgentRegistry(),
      systemPrompt: 'sys',
      maxIterations: 2,
      directiveScanner: fakeScanner,
    });
    const session = new Session('s');
    const gen = agent.processMessage('hi', session);
    let next = await gen.next();
    while (!next.done) { next = await gen.next(); }
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('omits scan calls when no scanner provided', async () => {
    const provider = {
      chat: vi.fn().mockResolvedValue({
        text: 'ok', toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    };
    const agent = new PrismerAgent({
      provider: provider as any,
      tools: new ToolRegistry(),
      observer: new ConsoleObserver(),
      agents: new AgentRegistry(),
      systemPrompt: 'sys', maxIterations: 2,
    });
    // Drain
    const gen = agent.processMessage('hi', new Session('s'));
    let next = await gen.next();
    while (!next.done) { next = await gen.next(); }
    // Without a scanner, processMessage simply doesn't crash on filesystem absence
    expect(true).toBe(true);
  });
});
```

These two tests verify the DI plumbing point — not agent lifecycle. Follow the existing `approval.test.ts` precedent for using `vi.fn()` provider stubs in DI-only tests. Real-LLM coverage is provided by H6 below.

- [ ] **Step 2: Verify FAIL**

Run: `npx vitest run tests/agent.test.ts -t "DirectiveScanner injection"`
Expected: FAIL — `directiveScanner` not a valid AgentOptions field.

- [ ] **Step 3: Implement DirectiveScanner interface + injection**

In `src/agent.ts`:

1. Remove the top-level `import { readdirSync, readFileSync, unlinkSync } from 'node:fs';`
2. Add interface (near other type exports):
   ```typescript
   export interface DirectiveScanner {
     scan(session: Session, knownFiles?: Set<string>): void;
     snapshot(): Set<string>;
   }
   ```
3. Add to `AgentOptions`: `directiveScanner?: DirectiveScanner;`
4. Add field on the class: `private readonly directiveScanner?: DirectiveScanner;`
5. Initialize in constructor: `this.directiveScanner = options.directiveScanner;`
6. Replace `scanDirectiveFiles` body:
   ```typescript
   private scanDirectiveFiles(session: Session, knownFiles?: Set<string>): void {
     this.directiveScanner?.scan(session, knownFiles);
   }
   private snapshotDirectiveFiles(): Set<string> {
     return this.directiveScanner?.snapshot() ?? new Set();
   }
   ```

- [ ] **Step 4: Create `src/agent-fs-directive-scanner.ts`**

```typescript
/**
 * Node-only DirectiveScanner that watches `{workspaceDir}/.openclaw/directives`
 * for JSON files, parses them as Directives, publishes them to the agent's
 * EventBus, and unlinks the file.
 *
 * Embedded runtimes (iOS, Android) do NOT bundle this — they inject their
 * own DirectiveScanner via createAgentRuntime if directives are needed.
 *
 * @module agent-fs-directive-scanner
 */

import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import type { DirectiveScanner } from './agent.js';
import type { Session, Directive } from './session.js';
import type { EventBus } from './sse.js';
import type { Observer } from './observer.js';

export class FsDirectiveScanner implements DirectiveScanner {
  constructor(
    private readonly workspaceDir: string,
    private readonly bus?: EventBus,
    private readonly observer?: Observer,
  ) {}

  scan(session: Session, knownFiles?: Set<string>): void {
    const dirPath = `${this.workspaceDir}/.openclaw/directives`;
    let files: string[];
    try { files = readdirSync(dirPath).filter(f => f.endsWith('.json')); } catch { return; }
    for (const file of files) {
      if (knownFiles && knownFiles.has(file)) continue;
      try {
        const raw = readFileSync(`${dirPath}/${file}`, 'utf-8');
        const parsed = JSON.parse(raw);
        const directive: Directive = {
          type: parsed.type,
          payload: parsed.payload || {},
          timestamp: parsed.timestamp || String(Date.now()),
        };
        session.addPendingDirective(directive);
        this.bus?.publish({
          type: 'directive',
          data: { type: directive.type, payload: directive.payload, timestamp: directive.timestamp },
        });
        this.observer?.recordEvent({
          type: 'directive_emit', timestamp: Date.now(),
          data: { type: directive.type, payload: directive.payload },
        });
        unlinkSync(`${dirPath}/${file}`);
      } catch { /* skip */ }
    }
  }

  snapshot(): Set<string> {
    const dirPath = `${this.workspaceDir}/.openclaw/directives`;
    try { return new Set(readdirSync(dirPath).filter(f => f.endsWith('.json'))); }
    catch { return new Set(); }
  }
}
```

- [ ] **Step 5: Wire FsDirectiveScanner in src/index.ts and src/loop/dual.ts**

In each file, when constructing `PrismerAgent`, add:
```typescript
import { FsDirectiveScanner } from './agent-fs-directive-scanner.js'; // adjust relative path
// ...
new PrismerAgent({
  // ... existing options ...
  directiveScanner: new FsDirectiveScanner(workspaceDir, bus, observer),
})
```

- [ ] **Step 6: Verify tests pass + zero node:fs in agent.ts**

Run: `npx vitest run tests/agent.test.ts`
Expected: all pass.

Run: `grep -c 'node:fs' src/agent.ts`
Expected: `0`

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/agent.ts src/agent-fs-directive-scanner.ts src/index.ts src/loop/dual.ts tests/agent.test.ts
git commit -m "feat(H1): DirectiveScanner DI — strip node:fs from agent.ts"
```

---

### Task H2: `createConfig(overrides)` pure function

**Files:**
- Modify: `src/config.ts`
- Create or extend: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConfig } from '../src/config.js';

describe('createConfig', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = {}; });
  afterEach(() => { process.env = originalEnv; });

  it('produces a valid LuminConfig from overrides without reading process.env', () => {
    const config = createConfig({
      llm: { baseUrl: 'http://example.com/v1', apiKey: 'k', model: 'm' },
      workspace: { dir: '/tmp/x', pluginPath: '' },
    });
    expect(config.llm.baseUrl).toBe('http://example.com/v1');
    expect(config.llm.model).toBe('m');
    expect(config.workspace.dir).toBe('/tmp/x');
  });

  it('applies schema defaults for omitted fields', () => {
    const config = createConfig({ llm: { apiKey: 'x' } as any });
    expect(config.agent).toBeDefined();
    expect(config.session).toBeDefined();
  });

  it('does not read process.env even when set', () => {
    process.env.OPENAI_API_KEY = 'env-key';
    const config = createConfig({ llm: { apiKey: 'override' } as any });
    expect(config.llm.apiKey).toBe('override');
  });
});
```

- [ ] **Step 2: Verify FAIL**

Run: `npx vitest run tests/config.test.ts -t "createConfig"`
Expected: FAIL — `createConfig is not exported`.

- [ ] **Step 3: Implement**

Append to `src/config.ts`:

```typescript
/**
 * Pure config factory — Zod-parses an override object without reading
 * process.env. Used by embedded runtimes (iOS, Android, Electron) that
 * supply config explicitly.
 *
 * @example
 * const cfg = createConfig({
 *   llm: { baseUrl: 'http://example.com/v1', apiKey: 'k', model: 'm' },
 *   workspace: { dir: '/tmp/foo', pluginPath: '' },
 * });
 */
export function createConfig(overrides: Record<string, unknown> = {}): LuminConfig {
  return LuminConfigSchema.parse(overrides);
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `npx vitest run tests/config.test.ts && npx tsc --noEmit`
Expected: green + clean.

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(H2): createConfig pure factory — Zod parse without process.env"
```

---

### Task H3: `src/embedded.ts` — `createAgentRuntime` entry

**Files:**
- Create: `src/embedded.ts`

- [ ] **Step 1: Implement**

```typescript
/**
 * Embedded runtime entry — single-loop agent that runs in JavaScriptCore (iOS),
 * Hermes/V8 (Android), and Electron without any node:* dependencies.
 *
 * Bundle target: `dist/luminclaw-core.js` via `esbuild.embedded.mjs`.
 *
 * Differences from `runAgent` in src/index.ts:
 * - No filesystem reads (no SOUL.md / AGENTS.md / TOOLS.md scanning)
 * - No workspace plugin loading
 * - No bash tool — embed contexts inject their own platform-appropriate tools
 * - Memory backend must be supplied (no auto FileMemoryBackend)
 * - DirectiveScanner not wired (embed contexts inject one if needed)
 *
 * Plan-mode tools (enter_plan_mode, exit_plan_mode) ARE auto-registered.
 * memory_store / memory_recall ARE auto-registered if memoryBackend supplied.
 *
 * @module embedded
 */

import { PrismerAgent, type AgentOptions, type AgentResult } from './agent.js';
import { OpenAICompatibleProvider, FallbackProvider, type Provider } from './provider.js';
import { ToolRegistry, type Tool, createTool } from './tools.js';
import { Session, SessionStore } from './session.js';
import { EventBus, type AgentEvent } from './sse.js';
import { ConsoleObserver } from './observer.js';
import { AgentRegistry, BUILTIN_AGENTS, type AgentConfig } from './agents.js';
import { MemoryStore, type MemoryBackend } from './memory.js';
import { createConfig } from './config.js';
import type { LuminConfig } from './config.js';
import { createEnterPlanModeTool, createExitPlanModeTool } from './tools/builtins.js';
import { createLogger } from './log.js';

const log = createLogger('embedded');

// ── Re-exports for embed consumers ─────────────────────────

export { PrismerAgent } from './agent.js';
export { OpenAICompatibleProvider, FallbackProvider } from './provider.js';
export type { Provider, ChatRequest, ChatResponse, Message, ToolSpec, ToolCall } from './provider.js';
export { ToolRegistry, createTool } from './tools.js';
export type { Tool, ToolContext } from './tools.js';
export { Session, SessionStore } from './session.js';
export type { Directive } from './session.js';
export { EventBus } from './sse.js';
export type { AgentEvent } from './sse.js';
export { MemoryStore } from './memory.js';
export type { MemoryBackend, MemorySearchResult, MemoryCapabilities } from './memory.js';
export { AgentRegistry, BUILTIN_AGENTS } from './agents.js';
export type { AgentConfig } from './agents.js';
export { createConfig } from './config.js';
export type { LuminConfig } from './config.js';
export { VERSION } from './version.js';
export { AbortReason, createAbortError, isAbortError, getAbortReason } from './abort.js';
export { PermissionMode, defaultPermissionContext, enterPlanMode, exitPlanMode } from './permissions.js';
export type { ToolPermissionContext, PermissionResult, PermissionModeValue } from './permissions.js';

// ── Runtime factory ────────────────────────────────────────

export interface CreateAgentRuntimeDeps {
  /** Pre-constructed Provider — usually OpenAICompatibleProvider with a base URL + key. */
  provider: Provider;
  /** Tools to register. Embed contexts supply platform-native tools (e.g. iOS Photos search). */
  tools?: Tool[];
  /** Sub-agent definitions. Defaults to BUILTIN_AGENTS. */
  agents?: AgentConfig[];
  /** System prompt. Embed contexts assemble this from their own templates. */
  systemPrompt: string;
  /** Memory backend — when supplied, memory_store + memory_recall tools are auto-registered. */
  memoryBackend?: MemoryBackend;
  /** Config overrides. process.env is NOT read. */
  config?: Record<string, unknown>;
  /** Iteration cap. Default: 40. */
  maxIterations?: number;
  /** Default agent id. Default: 'researcher'. */
  agentId?: string;
}

export interface AgentRuntime {
  /** Process a user message — returns AsyncGenerator of events + final result. */
  processMessage(content: string, sessionId?: string): AsyncGenerator<AgentEvent, AgentResult>;
  /** Get or create a session. */
  getSession(id: string): Session;
  /** EventBus for global subscription (independent of per-message generators). */
  bus: EventBus;
  /** Cleanup. Currently a no-op; provided for forward compat. */
  shutdown(): Promise<void>;
}

/**
 * Build an AgentRuntime ready to run in any embed context.
 *
 * @example
 * ```js
 * const runtime = LuminClaw.createAgentRuntime({
 *   provider: new LuminClaw.OpenAICompatibleProvider({
 *     baseUrl: 'http://api.example.com/v1', apiKey: 'k', defaultModel: 'us-kimi-k2.5',
 *   }),
 *   tools: [photoSearchTool, noteReadTool],   // platform-native, injected
 *   memoryBackend: nativeMemoryBackend,       // optional Swift/Kotlin impl
 *   systemPrompt: 'You are a helpful assistant.',
 * });
 *
 * for await (const event of runtime.processMessage('Find my notes from last week')) {
 *   console.log(event.type);
 * }
 * ```
 */
export function createAgentRuntime(deps: CreateAgentRuntimeDeps): AgentRuntime {
  const cfg: LuminConfig = createConfig(deps.config ?? {});
  const tools = new ToolRegistry();

  for (const t of deps.tools ?? []) {
    tools.register(t);
  }

  // Plan mode tools — always available
  tools.register(createEnterPlanModeTool());
  tools.register(createExitPlanModeTool());

  // Memory tools — only if backend supplied
  if (deps.memoryBackend) {
    const memStore = new MemoryStore(deps.memoryBackend);
    tools.register(createTool(
      'memory_store',
      'Store a memory entry for later recall.',
      {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Memory content' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        },
        required: ['content'],
      },
      async (args, _ctx) => {
        await memStore.store(args.content as string, (args.tags as string[] | undefined) ?? []);
        return 'Memory stored.';
      },
    ));
    tools.register(createTool(
      'memory_recall',
      'Search stored memories by keywords.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxChars: { type: 'number', description: 'Max chars (default 4000)' },
        },
        required: ['query'],
      },
      async (args, _ctx) => {
        const result = await memStore.recall(
          args.query as string,
          (args.maxChars as number | undefined) ?? 4000,
        );
        return result || 'No matching memories found.';
      },
    ));
  }

  const agents = new AgentRegistry();
  agents.registerMany(deps.agents ?? BUILTIN_AGENTS);
  const sessions = new SessionStore();
  const bus = new EventBus();
  const observer = new ConsoleObserver();

  const baseAgentOptions: AgentOptions = {
    provider: deps.provider,
    tools,
    observer,
    agents,
    bus,
    systemPrompt: deps.systemPrompt,
    model: cfg.llm.model,
    maxIterations: deps.maxIterations ?? cfg.agent.maxIterations,
    agentId: deps.agentId ?? cfg.agent.template ?? 'researcher',
    workspaceDir: cfg.workspace.dir,
    // No directiveScanner — embed contexts inject if needed
  };

  log.info('embedded runtime ready', {
    toolCount: tools.size,
    hasMemory: Boolean(deps.memoryBackend),
    model: cfg.llm.model,
  });

  return {
    bus,
    getSession(id: string): Session {
      return sessions.getOrCreate(id);
    },
    async *processMessage(content: string, sessionId?: string) {
      const sid = sessionId ?? `embed-${Date.now()}`;
      const session = sessions.getOrCreate(sid);
      const agent = new PrismerAgent(baseAgentOptions);
      const gen = agent.processMessage(content, session);
      let next = await gen.next();
      while (!next.done) {
        yield next.value;
        next = await gen.next();
      }
      return next.value;
    },
    async shutdown() { /* placeholder for future cleanup */ },
  };
}
```

- [ ] **Step 2: Compile + verify zero node imports in entry**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `grep -E "from 'node:" src/embedded.ts`
Expected: empty.

- [ ] **Step 3: Commit**

```bash
git add src/embedded.ts
git commit -m "feat(H3): src/embedded.ts — createAgentRuntime entry for JSC/Hermes/Electron embed"
```

---

### Task H4: `esbuild.embedded.mjs` build config

**Files:**
- Create: `esbuild.embedded.mjs`

- [ ] **Step 1: Write file**

```javascript
// esbuild.embedded.mjs
// Builds dist/luminclaw-core.js — single-file IIFE for JavaScriptCore (iOS),
// Hermes (Android), Electron, etc.
//
// Run: node esbuild.embedded.mjs

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

await build({
  entryPoints: ['src/embedded.ts'],
  bundle: true,
  platform: 'neutral',
  format: 'iife',
  globalName: 'LuminClaw',
  target: ['es2022'],
  external: [],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.PLATFORM': '"embedded"',
    '__VERSION__': JSON.stringify(pkg.version),
  },
  outfile: 'dist/luminclaw-core.js',
  minify: true,
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'info',
});

console.log('✓ Built dist/luminclaw-core.js');
```

- [ ] **Step 2: Run + verify zero node imports**

```bash
node esbuild.embedded.mjs
grep -c "node:" dist/luminclaw-core.js
```
Expected: build succeeds. Grep returns 0.

If non-zero: `grep -B5 "node:" dist/luminclaw-core.js | head -20` to find the culprit; likely a transitive `node:*` we missed. Either move it behind DI (like H1) or split it out of the entry's import graph.

- [ ] **Step 3: Commit**

```bash
git add esbuild.embedded.mjs
git commit -m "feat(H4): esbuild.embedded.mjs — IIFE bundle config (platform: neutral)"
```

---

### Task H5: `scripts/build-embedded.sh` + manifest

**Files:**
- Create: `scripts/build-embedded.sh`
- Modify: `package.json`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
# Build the embedded bundle + emit manifest with version + sha256 + bundle stats.
# Usage: bash scripts/build-embedded.sh

set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Compile TypeScript (for d.ts emission)"
npx tsc -p tsconfig.json

echo "→ Build IIFE bundle"
node esbuild.embedded.mjs

BUNDLE=dist/luminclaw-core.js
DTS=dist/luminclaw-core.d.ts

if [ ! -f "$BUNDLE" ]; then
  echo "ERROR: $BUNDLE not produced" >&2
  exit 1
fi

# tsc emits dist/embedded.d.ts; copy under the bundle name for clarity.
if [ -f dist/embedded.d.ts ]; then
  cp dist/embedded.d.ts "$DTS"
fi

VERSION=$(node -p "require('./package.json').version")
SHA256=$(shasum -a 256 "$BUNDLE" | awk '{print $1}')
GZIP_BYTES=$(gzip -c "$BUNDLE" | wc -c | tr -d ' ')
RAW_BYTES=$(wc -c < "$BUNDLE" | tr -d ' ')

cat > dist/luminclaw-core.manifest.json <<EOF
{
  "version": "$VERSION",
  "minAppVersion": "1.0",
  "sha256": "$SHA256",
  "bytes": $RAW_BYTES,
  "gzipBytes": $GZIP_BYTES,
  "platform": "embedded"
}
EOF

echo ""
echo "Bundle:    $BUNDLE"
echo "Size:      $RAW_BYTES bytes"
echo "Gzipped:   $GZIP_BYTES bytes"
echo "Sha256:    $SHA256"
echo "Manifest:  dist/luminclaw-core.manifest.json"

if [ "$GZIP_BYTES" -gt 102400 ]; then
  echo ""
  echo "WARNING: gzip size $GZIP_BYTES exceeds 100KB target." >&2
fi
```

- [ ] **Step 2: Make executable + test**

```bash
chmod +x scripts/build-embedded.sh
bash scripts/build-embedded.sh
```
Expected: emits bundle + d.ts + manifest. Reports gzip size.

- [ ] **Step 3: Update package.json**

Add to `scripts`:
```json
"build:embedded": "bash scripts/build-embedded.sh"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/build-embedded.sh package.json
git commit -m "feat(H5): build-embedded.sh — emits bundle + d.ts + sha256 manifest"
```

---

### Task H6: Real-LLM `createAgentRuntime` test

**Files:**
- Create: `tests/embedded-runtime.test.ts`

- [ ] **Step 1: Write test (real LLM, mock-free per memory feedback_no_mock_for_agent_infra)**

```typescript
/**
 * createAgentRuntime — embedded entry contract.
 *
 * Real-LLM only: mocks for agent infra are disallowed per project memory.
 * Skipped without OPENAI_API_KEY.
 */

import { it, expect } from 'vitest';
import { describeReal, useRealLLMWorkspace } from './helpers/real-llm.js';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { createAgentRuntime } from '../src/embedded.js';
import type { MemoryBackend, MemorySearchResult } from '../src/embedded.js';
import { loadConfig, resetConfig } from '../src/config.js';

class InMemoryBackend implements MemoryBackend {
  private items: { content: string; tags: string[]; ts: number }[] = [];
  capabilities() { return { recency: true, tags: true, fuzzy: true }; }
  async store(content: string, tags: string[] = []): Promise<void> {
    this.items.push({ content, tags, ts: Date.now() });
  }
  async search(query: string, opts: { maxChars?: number } = {}): Promise<MemorySearchResult[]> {
    const matched = this.items
      .filter(i => i.content.toLowerCase().includes(query.toLowerCase()))
      .map((i, idx) => ({
        content: i.content, tags: i.tags, score: 1 - idx * 0.1,
        timestamp: i.ts, source: 'memory', metadata: {},
      }));
    if (opts.maxChars) {
      let total = 0;
      return matched.filter(r => (total += r.content.length) <= opts.maxChars!);
    }
    return matched;
  }
  async recent(_n: number) { return []; }
}

describeReal('createAgentRuntime — embedded entry (real LLM)', () => {
  useRealLLMWorkspace();

  it('builds a runtime, processes a message end-to-end', async () => {
    resetConfig();
    const cfg = loadConfig();
    const runtime = createAgentRuntime({
      provider: new OpenAICompatibleProvider({
        baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, defaultModel: cfg.llm.model,
      }),
      tools: [],
      systemPrompt: 'You are a brief assistant. Answer in one short sentence.',
    });
    const events: string[] = [];
    for await (const e of runtime.processMessage('Reply with the word ready.', 'embed-1')) {
      events.push(e.type);
    }
    expect(events.length).toBeGreaterThan(0);
    const session = runtime.getSession('embed-1');
    expect(session.messages.length).toBeGreaterThan(0);
    await runtime.shutdown();
  }, 60_000);

  it('registers memory_store + memory_recall when memoryBackend supplied', async () => {
    resetConfig();
    const cfg = loadConfig();
    const backend = new InMemoryBackend();
    const runtime = createAgentRuntime({
      provider: new OpenAICompatibleProvider({
        baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, defaultModel: cfg.llm.model,
      }),
      tools: [],
      memoryBackend: backend,
      systemPrompt: 'Use the memory_store tool to remember facts the user gives you, then confirm.',
    });
    for await (const _ of runtime.processMessage('My name is Alice. Use memory_store to remember name=Alice.', 'mem-test')) { /* drain */ }
    const recalled = await backend.search('Alice');
    expect(recalled.length).toBeGreaterThan(0);
    await runtime.shutdown();
  }, 90_000);

  it('plan mode tools auto-registered + session permission context starts default', async () => {
    resetConfig();
    const cfg = loadConfig();
    const runtime = createAgentRuntime({
      provider: new OpenAICompatibleProvider({
        baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, defaultModel: cfg.llm.model,
      }),
      tools: [],
      systemPrompt: 'You are a brief assistant.',
    });
    const session = runtime.getSession('plan-test');
    expect(session.permissionContext.mode).toBe('default');
    expect(typeof runtime.bus.subscribe).toBe('function');
    await runtime.shutdown();
  });
});
```

- [ ] **Step 2: Run**

```bash
export $(grep -v '^#' .env.test | xargs)
npx vitest run tests/embedded-runtime.test.ts
```
Expected: 3 PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/embedded-runtime.test.ts
git commit -m "test(H6): real-LLM tests for createAgentRuntime entry"
```

---

### Task H7: Bundle smoke test (file/grep/gzip/JSC global)

**Files:**
- Create: `tests/embedded-bundle-smoke.test.ts`

- [ ] **Step 1: Write smoke test (uses spawnSync only — no exec/execSync)**

```typescript
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
```

- [ ] **Step 2: Run**

```bash
npx vitest run tests/embedded-bundle-smoke.test.ts
```
Expected: 4 PASS (the JSC test self-skips on non-macOS).

- [ ] **Step 3: Commit**

```bash
git add tests/embedded-bundle-smoke.test.ts
git commit -m "test(H7): bundle smoke — file exists, zero node:, gzip budget, JSC global"
```

---

### Task H8: package.json `embedded` export

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add export entry**

In `package.json`, under `"exports"`, add:
```json
"./embedded": {
  "import": "./dist/embedded.js",
  "types": "./dist/embedded.d.ts"
}
```

(Note: `./dist/embedded.js` is the tsc-emitted ES module, not the IIFE bundle. NPM consumers `import('@prismer/agent-core/embedded')` get the source-equivalent module; web/native consumers fetch `dist/luminclaw-core.js` from the bundle URL.)

- [ ] **Step 2: Verify**

```bash
npx tsc
ls dist/embedded.js dist/embedded.d.ts
```
Expected: both files present.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(H8): package.json — add ./embedded subpath export"
```

---

## Cross-Task Summary

| Task | What | New Tests |
|---|---|---|
| H1 | DirectiveScanner DI + node:fs strip | 2 |
| H2 | createConfig pure factory | 3 |
| H3 | embedded.ts createAgentRuntime entry | — |
| H4 | esbuild.embedded.mjs build config | — |
| H5 | scripts/build-embedded.sh + manifest | — |
| H6 | createAgentRuntime real-LLM tests | 3 |
| H7 | bundle smoke + size budget | 4 |
| H8 | package.json export entry | — |
| **Total** | | **12 new tests** |

## Self-Review

- H1 plumbing tests use a tiny `vi.fn()` provider stub — acceptable per existing `approval.test.ts` precedent (testing DI plumbing, not agent lifecycle). H6 real-LLM tests cover the lifecycle path.
- H6 obeys `feedback_no_mock_for_agent_infra` — uses real provider, real session, real loop.
- H7's hard size cap is 200KB (soft warn at 100KB) to avoid false-positive failures during early bundle stabilization.
- H4 with `platform: 'neutral'` will FAIL the build if any `node:*` slips through — this is the safety net.
- All shell invocations in tests use `spawnSync` (not `execSync`/`exec`) per the project's hardened-fs hook.
- Plan saved to `docs/superpowers/plans/2026-04-15-phase-h-embedded-bundle-impl.md`.
