# API Reference

Lumin exposes three interfaces: **HTTP API**, **WebSocket**, and **IPC** (stdin/stdout JSON).

---

## HTTP API

Start the server with `lumin serve --port 3001` or programmatically via `startServer()`.

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "version": "0.3.1",
  "uptime": 12345
}
```

### `GET /v1/tools`

List all registered tools.

**Response:**
```json
{
  "tools": [
    {
      "name": "bash",
      "description": "Execute a bash command in the container.",
      "parameters": { ... }
    }
  ],
  "count": 42
}
```

### `POST /v1/chat`

Send a message and receive the complete response (synchronous).

**Request:**
```json
{
  "content": "Write a LaTeX survey on attention mechanisms",
  "sessionId": "optional-session-id",
  "config": {
    "model": "gpt-4o",
    "agentId": "researcher",
    "maxIterations": 20,
    "tools": ["latex", "arxiv"]
  }
}
```

**Response:**
```json
{
  "status": "success",
  "response": "I'll help you write...",
  "thinking": "Let me plan the survey structure...",
  "directives": [
    { "type": "SWITCH_COMPONENT", "payload": { "component": "latex-editor" } }
  ],
  "toolsUsed": ["latex_project", "arxiv_search"],
  "usage": { "promptTokens": 1500, "completionTokens": 800, "totalTokens": 2300 },
  "sessionId": "session-1234567890",
  "iterations": 3
}
```

**Error Response:**
```json
{
  "status": "error",
  "error": "LLM request failed: timeout",
  "sessionId": "session-1234567890"
}
```

---

## WebSocket API

Connect to `ws://<host>:<port>/v1/stream` for real-time streaming.

### Client → Server

#### `chat.send`

Send a message to the agent.

```json
{
  "type": "chat.send",
  "content": "Write a LaTeX paper on transformers",
  "sessionId": "optional-session-id",
  "config": {
    "model": "gpt-4o",
    "agentId": "researcher"
  }
}
```

#### `ping`

Keep-alive ping.

```json
{ "type": "ping" }
```

### Server → Client

#### `connected`

Sent immediately after WebSocket connection.

```json
{
  "type": "connected",
  "sessionId": "session-1234567890",
  "version": "0.3.1"
}
```

#### `lifecycle.start`

Agent loop has started processing.

```json
{
  "type": "lifecycle.start",
  "sessionId": "session-1234567890"
}
```

#### `text.delta`

Streaming text token from the LLM.

```json
{
  "type": "text.delta",
  "delta": "I'll help you "
}
```

#### `tool.start`

Tool execution has begun. `toolId` uniquely identifies this invocation (format: `toolName:index`).

```json
{
  "type": "tool.start",
  "tool": "latex_project",
  "toolId": "latex_project:0",
  "args": { "action": "compile", "file": "main.tex" }
}
```

#### `tool.end`

Tool execution completed.

```json
{
  "type": "tool.end",
  "tool": "latex_project",
  "toolId": "latex_project:0",
  "result": "Compilation successful. PDF: output/main.pdf"
}
```

#### `directive`

UI directive from a plugin tool.

```json
{
  "type": "directive",
  "directive": {
    "type": "SWITCH_COMPONENT",
    "payload": { "component": "latex-editor" }
  }
}
```

#### `chat.final`

Agent loop completed. Contains the full response.

```json
{
  "type": "chat.final",
  "content": "I've compiled your LaTeX paper...",
  "thinking": "...",
  "directives": [...],
  "toolsUsed": ["latex_project"],
  "sessionId": "session-1234567890",
  "iterations": 2,
  "usage": { "promptTokens": 1500, "completionTokens": 800, "totalTokens": 2300 }
}
```

#### `error`

An error occurred during processing.

```json
{
  "type": "error",
  "error": "LLM request failed: timeout"
}
```

#### `pong`

Response to a `ping`.

```json
{ "type": "pong" }
```

### Event Flow

A typical agent interaction produces events in this order:

```
Client: chat.send
Server: lifecycle.start
Server: text.delta (0..N tokens)     ← LLM streaming
Server: tool.start                   ← Tool begins
Server: directive (0..N)             ← UI directives from tool
Server: tool.end                     ← Tool completes
Server: text.delta (0..N tokens)     ← LLM continues
Server: chat.final                   ← Done
```

Multiple `tool.start → tool.end` cycles may occur in a single turn. Pair them by `toolId`.

---

## IPC Protocol (stdin/stdout)

Used in embedded mode (`docker exec lumin agent --message "..."`) and CLI piping.

### Input Format

JSON messages on stdin, one per line:

```json
{"type":"message","content":"hello","sessionId":"sess-1","config":{"model":"us-kimi-k2.5"}}
```

### Output Format

Responses are wrapped with markers for reliable parsing:

```
---LUMIN_OUTPUT_START---
{"status":"success","response":"Hello! How can I help?","sessionId":"sess-1","iterations":1}
---LUMIN_OUTPUT_END---
```

### Output Fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"success"` \| `"error"` | Result status |
| `response` | `string` | Agent's text response |
| `thinking` | `string?` | Reasoning content (if thinking model used) |
| `directives` | `Directive[]` | UI directives emitted during execution |
| `toolsUsed` | `string[]` | Tool names invoked during the turn |
| `usage` | `object?` | Token usage stats |
| `sessionId` | `string` | Session identifier |
| `iterations` | `number` | Agent loop iterations |
| `error` | `string?` | Error message (when `status: "error"`) |

---

## Programmatic API

```typescript
import { runAgent, EventBus } from '@prismer/agent-core';

// Simple usage
await runAgent({
  type: 'message',
  content: 'Hello',
  sessionId: 'my-session',
  config: { model: 'us-kimi-k2.5' },
});

// Server mode with custom EventBus
const bus = new EventBus();
bus.subscribe('*', (event) => console.log(event));

await runAgent(
  { type: 'message', content: 'Hello' },
  {
    bus,
    onResult: (result, sessionId) => {
      console.log('Agent response:', result.text);
      console.log('Tools used:', result.toolsUsed);
    },
  },
);
```

### Key Exports

```typescript
// Core
export { runAgent, RunAgentOptions } from './index.js';
export { PrismerAgent, AgentResult, AgentOptions } from './agent.js';
export { loadConfig, resetConfig, LuminConfigSchema, LuminConfig } from './config.js';
export { createLogger, Logger, LogLevel } from './log.js';

// Infrastructure
export { OpenAICompatibleProvider, FallbackProvider, Provider } from './provider.js';
export { ToolRegistry, Tool, ToolContext } from './tools.js';
export { EventBus, StdoutSSEWriter } from './sse.js';
export { SessionStore, Session } from './session.js';
export { PromptBuilder, PromptSection } from './prompt.js';
export { SkillLoader, LoadedSkill, SkillMeta } from './skills.js';
export { MemoryStore } from './memory.js';
export { HookRegistry, Hook, HookType, HookContext } from './hooks.js';
export { ChannelManager } from './channels/manager.js';

// Tools
export { loadWorkspaceToolsFromPlugin, createTool, createClawHubTool } from './tools/index.js';

// Protocol
export { InputMessage, OutputMessage, writeOutput, parseOutput } from './ipc.js';
```
