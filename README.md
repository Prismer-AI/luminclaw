<p align="center">
  <img src="assets/logo.jpeg" alt="Prismer" width="120" />
</p>

<h1 align="center">@prismer/agent-core</h1>

<p align="center">
  Lightweight TypeScript agent runtime. Zero heavy dependencies. OpenAI-compatible.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prismer/agent-core"><img src="https://img.shields.io/npm/v/@prismer/agent-core" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@prismer/agent-core" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="node" />
  <img src="https://img.shields.io/badge/deps-1%20(zod)-blue" alt="deps" />
</p>

---

## Features

- **Agent loop** — tool calling, sub-agent delegation, doom-loop detection, context guard
- **OpenAI-compatible** — works with any `/chat/completions` endpoint (OpenAI, Anthropic, Ollama, etc.)
- **File-based memory** — keyword recall, zero vector DB dependency. Beats Letta/MemGPT on LoCoMo (86% vs 74%)
- **Context compaction** — automatic fact extraction + LLM summarization when context overflows
- **Lifecycle hooks** — `before_prompt`, `before_tool`, `after_tool`, `agent_end`
- **Skills** — installable SKILL.md extensions with ClawHub (pure JS git clone)
- **Channels** — Telegram, Cloud IM adapters (auto-detected from env)
- **HTTP + WebSocket gateway** — zero external dependencies, real-time streaming
- **CLI** — `lumin agent`, `lumin serve`, `lumin health`
- **~4,900 LOC** — single production dependency (Zod)

## Quick Start

### Install

```bash
npm install @prismer/agent-core
```

### Programmatic

```typescript
import { runAgent } from '@prismer/agent-core';

process.env.OPENAI_API_KEY = 'sk-...';

await runAgent({
  type: 'message',
  content: 'What is 2 + 2?',
});
```

### CLI

```bash
# Run agent with a message
lumin agent --message "Hello, world!"

# Start HTTP + WebSocket gateway
lumin serve --port 3001

# Health check
lumin health
```

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:3001/v1/stream');

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'chat.send', content: 'Hello!' }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'text.delta') process.stdout.write(msg.delta);
  if (msg.type === 'chat.final') console.log('\n---\nDone:', msg.toolsUsed);
};
```

### HTTP

```bash
# Chat (synchronous)
curl -X POST http://localhost:3001/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"content": "List files in the workspace"}'

# List tools
curl http://localhost:3001/v1/tools

# Health
curl http://localhost:3001/health
```

## Configuration

All settings via environment variables. Sensible defaults for standalone use.

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | LLM provider API key | *(required)* |
| `OPENAI_API_BASE_URL` | LLM provider base URL | `https://api.openai.com/v1` |
| `AGENT_DEFAULT_MODEL` | Default model ID | `gpt-4o` |
| `WORKSPACE_DIR` | Working directory | `./workspace` |
| `LUMIN_PORT` | HTTP/WS server port | `3001` |
| `MAX_CONTEXT_CHARS` | Compaction threshold (chars) | `600000` |
| `MODEL_FALLBACK_CHAIN` | Fallback models (comma-separated) | — |
| `PRISMER_PLUGIN_PATH` | Path to workspace plugin | — |
| `TELEGRAM_BOT_TOKEN` | Telegram channel (optional) | — |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |

## Custom Tools

```typescript
import { createTool } from '@prismer/agent-core';
import { ToolRegistry } from '@prismer/agent-core/tools';

const tools = new ToolRegistry();

tools.register(createTool(
  'weather',
  'Get current weather for a city',
  {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
  async (args) => {
    const res = await fetch(`https://wttr.in/${args.city}?format=j1`);
    return JSON.stringify(await res.json());
  },
));
```

## Architecture

```
@prismer/agent-core
├── Core
│   ├── PrismerAgent             — agent loop + tool execution + doom-loop detection
│   ├── OpenAICompatibleProvider — LLM client (any /chat/completions endpoint)
│   ├── FallbackProvider         — automatic model fallback chain
│   ├── ToolRegistry             — tool registration + JSON Schema specs
│   └── EventBus                 — SSE / WebSocket event streaming
├── Memory
│   ├── MemoryStore (facade)     — store / recall / search / recent
│   └── FileMemoryBackend        — keyword-based, zero-dependency
├── Infrastructure
│   ├── HTTP + WebSocket server  — zero external deps (pure node:http)
│   ├── CLI                      — agent / serve / health commands
│   ├── SessionStore             — session management + compaction state
│   └── Config                   — Zod-validated, env var override
└── Extensions
    ├── HookRegistry             — before_prompt, before_tool, after_tool, agent_end
    ├── SkillLoader              — SKILL.md + YAML frontmatter
    ├── AgentRegistry            — sub-agent delegation via @mention
    └── ChannelManager           — Telegram, Cloud IM adapters
```

## Subpath Exports

```typescript
import { PrismerAgent } from '@prismer/agent-core/agent';
import { OpenAICompatibleProvider } from '@prismer/agent-core/provider';
import { ToolRegistry } from '@prismer/agent-core/tools';
import { SessionStore } from '@prismer/agent-core/session';
import { MemoryStore, FileMemoryBackend } from '@prismer/agent-core/memory';
import { HookRegistry } from '@prismer/agent-core/hooks';
import { EventBus } from '@prismer/agent-core/sse';
import { loadConfig } from '@prismer/agent-core/config';
import { createLogger } from '@prismer/agent-core/log';
import { VERSION } from '@prismer/agent-core';
```

## Memory System

Zero-dependency file-based memory with keyword recall. Tested on the [LoCoMo](https://github.com/snap-research/locomo) long-term conversation memory benchmark:

| Model | Overall | No Adversarial | vs Letta/MemGPT |
|-------|---------|---------------|-----------------|
| Claude Opus 4.6 | **86%** | **95%** | +12pp |
| Kimi K2.5 | 63% | 56% | -11pp |
| *Letta/MemGPT* | *~74%* | *—* | *baseline* |

Zero-dependency keyword search + strong LLM outperforms Letta's embedding+rerank pipeline.

```typescript
import { MemoryStore } from '@prismer/agent-core/memory';

const memory = new MemoryStore('./workspace');
await memory.store('The calibration coefficient is 0.03847', ['numeric']);
const results = await memory.search('calibration coefficient');
console.log(results); // [{ content: '...', score: 1.0, tags: ['numeric'] }]
```

## Workspace Templates

Drop markdown files into your workspace to customize agent behavior:

| File | Priority | Purpose |
|------|----------|---------|
| `IDENTITY.md` / `SOUL.md` | 10 | Agent identity and persona |
| `AGENTS.md` | 9 | Sub-agent routing and priorities |
| `TOOLS.md` | 8 | Tool reference documentation |
| `USER.md` | 3.5 | User preferences and context |

## Skills

Install agent skills from git repositories:

```bash
# Via agent tool call
clawhub install research-paper
clawhub install https://github.com/user/my-skill.git
clawhub list
clawhub search "data analysis"
```

Each skill is a directory with a `SKILL.md` file (YAML frontmatter + markdown body) that gets injected into the system prompt.

## API Reference

See [docs/API.md](docs/API.md) for the complete HTTP, WebSocket, and IPC protocol documentation.

## Contributing

```bash
git clone https://github.com/prismer-ai/agent-core.git
cd agent-core
npm install
npm run build      # TypeScript compilation
npm test           # Run all tests (vitest)
npm run typecheck  # Type checking only
```

## License

[MIT](LICENSE) &copy; 2026 [Prismer.AI](https://prismer.ai)
