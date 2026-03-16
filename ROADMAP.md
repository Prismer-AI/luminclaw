# @prismer/agent-core — Roadmap

<p align="center">
  <img src="assets/logo.jpeg" alt="Prismer" width="80" />
</p>

Lightweight TypeScript agent runtime. Zero heavy dependencies. OpenAI-compatible.

---

## v0.3.1 — Publish-Ready (DONE)

Make the package publishable to npm without breaking Prismer container backward compatibility.
All Prismer-specific values are overridden by env vars in the container.

### Blocking Issues

| # | Task | File(s) | Status |
|---|------|---------|--------|
| 1 | Add MIT LICENSE file | `LICENSE` | DONE |
| 2 | Add npm README.md | `README.md` | DONE |
| 3 | Fix hardcoded config defaults | `src/config.ts` | DONE |
| 4 | Plugin loader graceful degradation | `src/tools/loader.ts` | DONE |
| 5 | Generic default identity prompt | `src/prompt.ts` | DONE |
| 6 | Generic default agents | `src/agents.ts` | DONE |
| 7 | Fix hardcoded workspace paths | `src/tools/clawhub.ts`, `src/skills.ts` | DONE |
| 8 | Centralize version string | `src/version.ts`, `src/cli.ts`, `src/server.ts` | DONE |
| 9 | Package.json metadata | `package.json` | DONE |
| 10 | Update CLAUDE.md env table | `CLAUDE.md` | DONE |
| 11 | Regenerate package-lock.json | `package-lock.json` | DONE |

### Config Default Changes

| Field | Before (Prismer-specific) | After (Generic) | Container Override |
|-------|--------------------------|-----------------|-------------------|
| `llm.baseUrl` | `http://localhost:3000/v1` | `https://api.openai.com/v1` | `OPENAI_API_BASE_URL` |
| `llm.model` | `us-kimi-k2.5` | `gpt-4o` | `AGENT_DEFAULT_MODEL` |
| `workspace.dir` | `/workspace` | `./workspace` | `WORKSPACE_DIR` |
| `workspace.pluginPath` | `/opt/prismer/plugins/...` | `''` (empty) | `PRISMER_PLUGIN_PATH` |

---

## v0.4.0 — Built-in Tools + Examples (DONE)

Add core tools so the agent is useful without the prismer-workspace plugin.

### Built-in Tools (7 pure Node.js, zero deps)

| # | Tool | Parameters | Status |
|---|------|-----------|--------|
| 1 | `read_file` | path, offset?, limit? | DONE |
| 2 | `write_file` | path, content | DONE |
| 3 | `list_files` | path?, pattern?, maxDepth? | DONE |
| 4 | `edit_file` | path, old_string, new_string, replace_all? | DONE |
| 5 | `grep` | pattern, path?, glob?, maxResults? | DONE |
| 6 | `web_fetch` | url, method?, headers?, body?, maxBytes? | DONE |
| 7 | `think` | thought | DONE |

**Design:**
- All file paths relative to workspace root, `safePath()` prevents traversal
- Plugin tools override same-name builtins (Prismer plugin takes precedence)
- `node_modules`/`.git` skipped in listing/grep; 500 entry cap on `list_files`

### Other Tasks

| # | Task | File(s) | Status |
|---|------|---------|--------|
| 8 | Create `src/tools/builtins.ts` | ~280 LOC | DONE |
| 9 | Register builtins in `ensureInitialized` | `src/index.ts` | DONE |
| 10 | Export builtins + subpath export | `src/tools/index.ts`, `package.json` | DONE |
| 11 | Tests for built-in tools | `tests/builtins.test.ts` (32 tests) | DONE |
| 12 | Examples directory | `examples/basic.ts`, `custom-tools.ts`, `streaming.ts` | DONE |
| 13 | peerDependencies for @prismer/sdk | Deferred — SDK is optional | SKIPPED |

---

## v0.4.1 — Chat Cancel Protocol

Allow clients to cancel an in-progress agent response mid-stream.

| # | Task | File(s) | Description |
|---|------|---------|-------------|
| 1 | `chat.cancel` WebSocket message | `src/server.ts` | New message type — cancels the active `runAgent()` for the session |
| 2 | AbortSignal threading | `src/agent.ts` | Pass `AbortSignal` through the agent loop; check between tool calls and LLM rounds |
| 3 | Provider abort | `src/provider.ts` | `AbortSignal` on `fetch()` to cancel in-flight LLM request |
| 4 | Tool abort | `src/tools.ts`, `src/tools/loader.ts` | Forward signal to long-running tools (bash, web_fetch) |
| 5 | `chat.cancelled` event | `src/sse.ts` | Emit cancellation confirmation event to client |
| 6 | HTTP SSE cancel | `src/server.ts` | Detect SSE client disconnect → trigger same abort path |
| 7 | Tests | `tests/cancel.test.ts` | Cancel during LLM, cancel during tool, cancel during multi-step |

**Design:**
- Each `chat.send` creates an `AbortController`; `chat.cancel` calls `.abort()`
- Agent loop checks `signal.aborted` before each iteration and tool call
- Graceful: current tool finishes (or is aborted if supported), then loop exits
- Client receives `{ type: 'chat.cancelled', sessionId }` confirmation
- No data loss: partial response up to cancel point is preserved in session history

---

## v0.5.0 — Ecosystem Polish

Production readiness and developer experience.

| # | Task | File(s) | Description |
|---|------|---------|-------------|
| 1 | Session file persistence | `src/session.ts` | `save(id)` / `load(id)` → JSON files |
| 2 | Provider registry | `src/providers.ts` | Named presets: openai, anthropic, openrouter, ollama |
| 3 | Structured output | `src/provider.ts` | `responseFormat` (JSON mode / JSON schema) |
| 4 | CHANGELOG.md | `CHANGELOG.md` | Version history from v0.1.0 |
| 5 | GitHub Actions CI | `.github/workflows/ci.yml` | Test on push, publish on tag |
| 6 | JSDoc improvements | Multiple files | `@example` blocks on key exports |

---

## Architecture Overview

```
@prismer/agent-core
├── Core
│   ├── PrismerAgent        — agent loop + tool execution + doom-loop detection
│   ├── OpenAICompatibleProvider — LLM client (any /chat/completions endpoint)
│   ├── ToolRegistry        — tool registration + JSON Schema specs
│   └── EventBus            — SSE/WebSocket event streaming
├── Memory
│   ├── MemoryStore (facade) — store / recall / search / recent
│   └── FileMemoryBackend   — keyword-based, zero-dependency
├── Infrastructure
│   ├── HTTP + WebSocket server (zero external deps)
│   ├── CLI (chat / serve / health)
│   ├── SessionStore        — session management
│   └── Config (Zod-validated, env var override)
├── Extensions
│   ├── HookRegistry        — before_prompt, before_tool, after_tool, agent_end
│   ├── SkillLoader         — SKILL.md + YAML frontmatter
│   ├── AgentRegistry       — sub-agent delegation
│   └── ChannelManager      — Telegram, Cloud IM adapters
└── Tools
    ├── Built-in (v0.4.0)   — read_file, write_file, list_files, edit_file, grep, web_fetch, think
    ├── bash                 — shell execution
    ├── memory_store/recall  — persistent memory
    └── clawhub             — skill installer (git clone)
```

---

## Evaluation Results (LoCoMo Benchmark)

| Model | Overall | No Adversarial | vs Letta/MemGPT |
|-------|---------|---------------|-----------------|
| claude-opus-4-6 | **86%** | **95%** | +12pp |
| us-kimi-k2.5 | 63% | 56% | -11pp |
| *Letta/MemGPT* | *~74%* | *—* | *baseline* |

Zero-dependency keyword search + strong LLM outperforms Letta's embedding+rerank pipeline.
