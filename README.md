<p align="center">
  <img src="https://raw.githubusercontent.com/Prismer-AI/luminclaw/main/docs/logo.png" alt="LuminClaw" width="120" />
</p>

<h1 align="center">LuminClaw</h1>

<p align="center">
  <strong>Lightweight Agent Runtime — OpenClaw Alternative in 4,500 Lines</strong>
</p>

<p align="center">
  <a href="#architecture">Architecture</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#protocol">Protocol</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <a href="https://github.com/Prismer-AI/luminclaw/actions"><img src="https://img.shields.io/github/actions/workflow/status/Prismer-AI/luminclaw/ci.yml?branch=main&style=flat-square&labelColor=black&label=CI" alt="CI"></a>
  <a href="https://github.com/Prismer-AI/luminclaw/stargazers"><img src="https://img.shields.io/github/stars/Prismer-AI/luminclaw?color=ffcb47&labelColor=black&style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Prismer-AI/luminclaw/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?labelColor=black&style=flat-square" alt="License"></a>
  <a href="https://www.npmjs.com/package/@prismer/agent-core"><img src="https://img.shields.io/npm/v/@prismer/agent-core?style=flat-square&labelColor=black" alt="npm"></a>
</p>

---

## What is LuminClaw?

LuminClaw is a **standalone agent runtime** that replaces OpenClaw (913K LOC) with ~4,500 lines of TypeScript. It implements the complete agent loop — LLM reasoning, tool execution, sub-agent delegation, context management — with zero heavy dependencies.

### Comparison

| Capability | LuminClaw | OpenClaw | LangChain | CrewAI |
|-----------|:---------:|:--------:|:---------:|:------:|
| Agent Loop + Tool Execution | ✅ | ✅ | ✅ | ✅ |
| Sub-Agent Delegation | ✅ | ✅ | ❌ | ✅ |
| Context Compaction | ✅ | ✅ | ❌ | ❌ |
| Persistent Memory | ✅ | ✅ | ❌ | ❌ |
| WebSocket Streaming | ✅ | ✅ | ❌ | ❌ |
| Dynamic Skill System | ✅ | ✅ | ❌ | ❌ |
| Lifecycle Hooks | ✅ | ✅ | ✅ | ❌ |
| Thinking Control | ✅ | ❌ | ❌ | ❌ |
| Model Fallback Chain | ✅ | ❌ | ❌ | ❌ |
| Codebase Size | **4.5K** | 913K | 180K+ | 30K+ |
| Dependencies | **1** (Zod) | 200+ | 50+ | 30+ |
| Cold Start | **< 1s** | ~35s | ~3s | ~2s |

---

## Features

### Agent Loop

Core reasoning cycle with automatic tool dispatch, parallel tool execution, and configurable iteration limits. Built-in doom-loop detection prevents infinite tool call chains.

### Sub-Agent System

6 built-in specialized agents (researcher, latex-expert, data-analyst, literature-scout, etc.) with automatic delegation based on task complexity. Sub-agents share session context and directive output.

### Context Compaction

When conversation context exceeds the token budget (configurable, default ~150K tokens):
1. **Memory Flush** — Extracts factual knowledge before compression
2. **LLM Summarize** — Compresses conversation to essential context
3. **Orphaned Tool Repair** — Fixes dangling tool calls after truncation

### Persistent Memory

File-based keyword recall system. No vector database required.
- Storage: `/workspace/.prismer/memory/YYYY-MM-DD.md`
- Recall: keyword matching against stored facts
- Lifecycle: auto-flush during compaction, manual via hooks

#### LoCoMo Benchmark

Evaluated on the [LoCoMo](https://github.com/snap-research/locomo) long-term conversation memory benchmark (Snap Research). 19 sessions, 369 turns, 56 QA pairs — keyword search only, zero vector dependencies.

```
LoCoMo Benchmark — Model Comparison (FileMemoryBackend, keyword search)
══════════════════════════════════════════════════════════════════════════
                     Claude Opus 4.6      Kimi K2.5          Letta/MemGPT
──────────────────────────────────────────────────────────────────────────
Single-hop  (11)    ████████████████ 100%  ███░░░░░░░░░░  18%       —
Temporal    (15)    ███████████████░  93%  ██████████░░░  73%       —
Open-domain (15)    ███████████████░  93%  █████████░░░░  67%       —
Adversarial (15)    ██████████░░░░░░  60%  ████████████░  80%       —
──────────────────────────────────────────────────────────────────────────
Overall             █████████████░░░  86%  ██████████░░░  63%     ~74%
No adversarial      ███████████████░  95%  ████████░░░░░  56%       —
══════════════════════════════════════════════════════════════════════════
```

| Metric | LuminClaw + Opus | LuminClaw + Kimi | Letta/MemGPT |
|--------|:----------------:|:----------------:|:------------:|
| Overall accuracy | **86%** | 63% | ~74% |
| Retrieval | Keyword match | Keyword match | Embedding + rerank |
| Dependencies | **0** (pure `fs`) | **0** (pure `fs`) | Python + OpenAI API |

Key finding: a strong LLM + zero-dependency keyword search **outperforms** Letta/MemGPT's embedding pipeline by +12pp. Model capability matters more than search sophistication. See [`docs/MEMORY.md`](docs/MEMORY.md) for full analysis.

### Dynamic Prompt Builder

Priority-weighted system prompt assembly from multiple sources:

| Source | Priority | Description |
|--------|:--------:|-------------|
| SOUL.md | 10 | Agent identity and personality |
| TOOLS.md | 8 | Tool reference documentation |
| Agent Instructions | 7 | Built-in agent-specific instructions |
| Installed Skills | 5 | SKILL.md files with YAML frontmatter |
| Workspace Context | 4 | AGENTS.md + USER.md runtime config |
| Runtime Info | 3 | Date, model, session metadata |

### Skill System

Install and manage agent skills at runtime:

```bash
lumin skill install https://github.com/user/my-skill
lumin skill list
lumin skill update my-skill
```

Skills are SKILL.md files with YAML frontmatter defining name, description, tools, and prompt injection content. Pure JS implementation (git clone) — no external CLI dependency.

### Model Fallback Chain

Automatic failover across LLM providers:

```
Primary: us-kimi-k2.5 → Fallback: gpt-4o → Fallback: claude-sonnet
```

Configurable via `MODEL_FALLBACK_CHAIN` env var. Retries on transient errors (429, 503) with exponential backoff.

### Thinking Control

Per-request control over model reasoning:
- `/think` — Enable extended thinking (Kimi `enable_thinking`, Claude `thinking.budget_tokens`)
- `/nothink` — Disable thinking for faster responses

### Channel Adapters

Multi-channel communication with auto-detection:

| Channel | Trigger | Protocol |
|---------|---------|----------|
| Telegram | `TELEGRAM_BOT_TOKEN` env | Bot API long-polling |
| Cloud IM | `PRISMER_IM_*` env vars | SSE real-time |

### Lifecycle Hooks

Plugin-extensible event system:

```
before_prompt → before_tool → [tool execution] → after_tool → agent_end
```

Hooks can modify prompts, intercept tool calls, post-process results, or trigger side effects.

---

## Quick Start

```bash
# Install
npm install

# Build
npx tsc

# Single message
OPENAI_API_KEY=sk-xxx node dist/cli.js chat --message "Hello"

# Start server
OPENAI_API_KEY=sk-xxx node dist/cli.js serve --port 3001
```

### Docker

```bash
docker build -f Dockerfile.lumin -t luminclaw .

docker run -d -p 3001:3001 \
  -e OPENAI_API_KEY=sk-xxx \
  -e OPENAI_API_BASE_URL=https://api.openai.com/v1 \
  luminclaw
```

---

## Architecture

```
                    ┌─────────────────────────────────────────┐
  CLI / HTTP / WS ──┤          LuminClaw Runtime              │── stdout / WS / SSE
                    │                                         │
                    │  ┌─────────┐    ┌──────────────────┐   │
                    │  │ Provider │    │  PromptBuilder    │   │
                    │  │ (LLM)   │    │  SOUL + TOOLS +   │   │
                    │  │ +Fallbk │    │  Skills + Context  │   │
                    │  └────┬────┘    └────────┬─────────┘   │
                    │       │                  │              │
                    │  ┌────▼──────────────────▼─────────┐   │
                    │  │         Agent Loop               │   │
                    │  │   LLM → Tool Dispatch → Response │   │
                    │  │   + Sub-Agent Delegation         │   │
                    │  │   + Doom-Loop Detection          │   │
                    │  └──┬────────┬────────┬─────────┬──┘   │
                    │     │        │        │         │       │
                    │  ┌──▼──┐ ┌──▼───┐ ┌──▼────┐ ┌──▼──┐   │
                    │  │Tools│ │Compac│ │Memory │ │Hooks│   │
                    │  │     │ │tion  │ │(file) │ │     │   │
                    │  └─────┘ └──────┘ └───────┘ └─────┘   │
                    │                                         │
                    │  ┌──────────┐  ┌──────────┐            │
                    │  │ Channels │  │ Sessions │            │
                    │  │ TG / IM  │  │ +Directv │            │
                    │  └──────────┘  └──────────┘            │
                    └─────────────────────────────────────────┘
```

### Module Map

| Module | LOC | Responsibility |
|--------|----:|---------------|
| `agent.ts` | 592 | Agent loop, sub-agent, doom-loop, context guard, directive scanner |
| `server.ts` | 492 | HTTP + WebSocket gateway, SSE streaming, tool event forwarding |
| `provider.ts` | 378 | OpenAI-compatible LLM client, FallbackProvider, thinking control |
| `index.ts` | 366 | `runAgent()` entry, PromptBuilder integration, module exports |
| `tools/clawhub.ts` | 240 | Skill installer (pure JS git clone) |
| `prompt.ts` | 235 | Dynamic system prompt builder |
| `cli.ts` | 193 | CLI entry + subcommand routing |
| `skills.ts` | 178 | SKILL.md loader, YAML frontmatter, caching |
| `channels/cloud-im.ts` | 177 | Cloud IM adapter (SSE) |
| `channels/telegram.ts` | 171 | Telegram Bot adapter (long-polling) |
| `tools/loader.ts` | 159 | Plugin tool adapter |
| `workspace.ts` | 154 | Workspace file safety middleware |
| `agents.ts` | 149 | Sub-agent registry (6 built-in roles) |
| `sse.ts` | 144 | EventBus + SSE writer (Zod validated) |
| `compaction.ts` | 141 | Context compression + memory flush |
| `session.ts` | 138 | Session state + directive accumulation |
| `memory.ts` | 118 | Keyword-based persistent memory |
| `observer.ts` | 115 | Event types + metrics |
| `ipc.ts` | 109 | stdin/stdout JSON protocol |
| `hooks.ts` | 99 | Lifecycle hook registry |
| `tools.ts` | 96 | Tool registry + dispatch |
| **Total** | **4,665** | |

---

## Protocol

### HTTP API

```bash
# Health check
GET /health

# Tool list
GET /v1/tools

# Send message (synchronous)
POST /v1/chat
Content-Type: application/json
{"content": "Hello", "sessionId": "optional-session-id"}
```

### WebSocket Streaming

```bash
# Connect
wscat -c ws://localhost:3001/v1/stream

# Send message
> {"type": "chat.send", "content": "Write a LaTeX paper", "sessionId": "s1"}
```

**Event Stream:**

| Event | Direction | Schema |
|-------|-----------|--------|
| `connected` | Server → Client | `{type, sessionId, version}` |
| `lifecycle.start` | Server → Client | `{type, sessionId}` |
| `text.delta` | Server → Client | `{type, delta}` |
| `tool.start` | Server → Client | `{type, tool, toolId, args?}` |
| `tool.end` | Server → Client | `{type, tool, toolId, result}` |
| `directive` | Server → Client | `{type, directive: {type, payload}}` |
| `chat.final` | Server → Client | `{type, content, directives[], toolsUsed[]}` |
| `chat.send` | Client → Server | `{type, content, sessionId?}` |

`toolId` format: `toolName:index` — enables pairing start/end events for concurrent tool tracking.

### IPC (stdin/stdout)

```bash
echo '{"type":"message","content":"hello","config":{"model":"gpt-4o"}}' | lumin
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | LLM provider API key (required) |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` | LLM provider endpoint |
| `AGENT_DEFAULT_MODEL` | `gpt-4o` | Default model ID |
| `MODEL_FALLBACK_CHAIN` | — | Comma-separated fallback models |
| `LUMIN_PORT` | `3001` | Server port |
| `MAX_CONTEXT_CHARS` | `600000` | Compaction threshold (~150K tokens) |
| `WORKSPACE_DIR` | `/workspace` | Working directory |
| `TELEGRAM_BOT_TOKEN` | — | Telegram channel (optional) |
| `PRISMER_IM_BASE_URL` | — | Cloud IM channel (optional) |

---

## Testing

```bash
npm test                           # All 113 tests
npx vitest run tests/agent.test.ts # Single file
npx vitest --coverage              # Coverage report
```

| Test File | Tests | Coverage |
|-----------|------:|----------|
| `skills.test.ts` | 17 | Skill loader, frontmatter, caching |
| `agent.test.ts` | 13 | Agent loop, compaction, doom-loop, thinking |
| `prompt.test.ts` | 11 | PromptBuilder, priority system |
| `provider.test.ts` | 10 | FallbackProvider, retryable errors |
| `llm-integration.test.ts` | 8 | Real LLM: chat, tools, skills, fallback |
| `loader.test.ts` | 6 | Tool loader, plugin adapter |
| `integration.test.ts` | 6 | Full PromptBuilder + Skills + Config |
| + 14 more files | 42 | Memory, hooks, channels, compaction, etc. |
| **Total** | **113** | **1,788 LOC test code** |

---

## Contributing

Contributions are welcome! Please open an issue or pull request.

---

## License

[Apache-2.0](LICENSE)

---

<p align="center">
  <sub>Built by <a href="https://github.com/Prismer-AI">Prismer.AI</a></sub>
</p>
