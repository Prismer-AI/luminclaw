# CLAUDE.md — @prismer/agent-core

## Project Overview

`@prismer/agent-core` is a lightweight, standalone agent runtime (~4,900 LOC TypeScript).
OpenAI-compatible, zero heavy dependencies (only Zod). Designed for the
[Prismer.AI](https://prismer.ai) academic research platform but works independently
as a general-purpose agent framework.

**npm**: `@prismer/agent-core` v0.3.1
**Repository**: https://github.com/prismer-ai/agent-core
**Main project**: gitlab.app:prismer/library (this repo is at `docker/agent/`)
**License**: MIT

## Quick Start

```bash
npm install
npx tsc                  # Compile TypeScript
npm test                 # Run all tests (vitest)

# Run agent CLI
node dist/cli.js agent --message "Hello"
node dist/cli.js serve --port 3001    # Start HTTP + WebSocket server
```

## Architecture

### Source Layout

```
src/
├── agent.ts          # Core agent loop (LLM → tool → response cycle)
├── server.ts         # HTTP + WebSocket gateway (SSE streaming)
├── index.ts          # runAgent() entry + PromptBuilder + module exports
├── provider.ts       # OpenAI-compatible LLM client + FallbackProvider
├── prompt.ts         # Dynamic system prompt builder (SOUL.md / TOOLS.md / Skills)
├── cli.ts            # CLI entry point
├── sse.ts            # EventBus + SSE writer (Zod schemas)
├── version.ts        # Centralized version string (single source of truth)
├── agents.ts         # Sub-agent registry (6 built-in agents)
├── skills.ts         # SKILL.md loader + YAML frontmatter
├── compaction.ts     # Context overflow → memory flush → LLM summarize
├── session.ts        # Session management + directive accumulation
├── workspace.ts      # Workspace config (AGENTS.md/USER.md)
├── memory.ts         # File-based persistent memory (keyword recall)
├── hooks.ts          # Lifecycle hooks (before_prompt, before_tool, after_tool, agent_end)
├── config.ts         # Runtime configuration from env vars
├── tools.ts          # Tool registry interface
├── directives.ts     # UI directive types
├── observer.ts       # Event type definitions
├── ipc.ts            # Inter-process communication
├── log.ts            # Structured logging
├── schemas.ts        # Zod schema exports
├── channels/         # Communication adapters
│   ├── types.ts      # ChannelAdapter interface
│   ├── manager.ts    # Auto-detect from env vars
│   ├── cloud-im.ts   # Prismer Cloud IM (SSE)
│   └── telegram.ts   # Telegram Bot (long-polling)
└── tools/
    ├── index.ts      # Tool registry
    ├── loader.ts     # prismer-workspace plugin adapter
    └── clawhub.ts    # Pure JS skill installer (git clone)
```

### Templates

```
templates/
├── base/             # Default workspace templates
│   ├── AGENTS.md     # Agent priority/routing config
│   ├── USER.md       # User preferences
│   ├── SOUL.md       # Agent personality/identity
│   ├── TOOLS.md      # Available tools reference
│   └── HEARTBEAT.md  # Health check format
├── lite/             # Minimal template
├── researcher/       # Academic researcher template
├── mathematician/    # Theorem-proving template
└── financial-analyst/ # Quantitative analysis template
```

### Docker Integration

```
Dockerfile.lumin      # Container image build (base: prismer-academic + lumin + plugins)
lumin-entrypoint.sh   # Container entrypoint (starts lumin serve + container gateway)
```

## Key Concepts

### Agent Loop
`agent.ts` implements the core loop: prompt LLM → execute tool calls → accumulate response → repeat until done. Supports sub-agent delegation, doom-loop detection, and context guard.

### Compaction
When context exceeds `MAX_CONTEXT_CHARS` (default 600K), the compaction system:
1. Flushes extractable facts to memory (`{workspace}/.prismer/memory/YYYY-MM-DD.md`)
2. LLM-summarizes the conversation
3. Injects the summary as a compact message pair

### Thinking Control
`/think` and `/nothink` directives control provider-level thinking:
- Kimi: `enable_thinking` parameter
- Claude: `thinking.budget_tokens`

### Workspace Config
- `AGENTS.md` (priority 9) + `USER.md` (priority 3.5) are loaded into the system prompt
- Modifying `AGENTS.md` changes agent behavior immediately

### Channels
ChannelAdapter interface + auto-detection from env vars:
- `TELEGRAM_BOT_TOKEN` → TelegramAdapter (long-polling)
- `PRISMER_IM_*` → CloudIMAdapter (SSE)

### Skills
SKILL.md files with YAML frontmatter define installable skills.
ClawHub integration: `lumin skill install <url>` (pure JS git clone, no external CLI).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | LLM provider API key | required |
| `OPENAI_API_BASE_URL` | LLM provider base URL | `https://api.openai.com/v1` |
| `AGENT_DEFAULT_MODEL` | Default model ID | `gpt-4o` |
| `WORKSPACE_DIR` | Working directory | `./workspace` |
| `LUMIN_PORT` | HTTP/WS server port | `3001` |
| `MAX_CONTEXT_CHARS` | Compaction threshold | `600000` |
| `PRISMER_PLUGIN_PATH` | Path to workspace plugin | — |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (optional) | — |
| `PRISMER_IM_BASE_URL` | Cloud IM base URL (optional) | — |
| `PRISMER_IM_CONVERSATION_ID` | Cloud IM conversation (optional) | — |
| `PRISMER_IM_TOKEN` | Cloud IM auth token (optional) | — |

## Testing

```bash
npm test                              # All tests
npx vitest run tests/agent.test.ts    # Single test
npx vitest --coverage                 # Coverage report
```

## Submodule Usage (Main Project)

In the main Prismer project, this repo is mounted as a submodule:

```bash
# In the main project root
git submodule update --init docker/agent

# Update to latest luminclaw
cd docker/agent
git pull origin main
cd ../..
git add docker/agent
git commit -m "chore: update luminclaw submodule"
```

The Dockerfile.lumin in the main project references `docker/agent/` which maps to this repo.

## Development Practices

- **TypeScript strict mode** — All code is strictly typed
- **Zod validation** — Runtime type safety for configs, events, schemas
- **Zero heavy deps** — Only Zod in production; TypeScript/vitest in dev
- **File-based memory** — No vector DB dependency, keyword-based recall
- **OpenAI-compatible** — Works with any OpenAI-compatible LLM provider
