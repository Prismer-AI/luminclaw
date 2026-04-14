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

**Routing behavior (dual-loop mode, Phase A):**

Before a new task is created, the server checks whether the session already has
an active task (via `getActiveForSession(sessionId)`):

- If **no active task** exists → a new task is created and dispatched in the
  background. The response contains `taskId` for the newly-created task.
- If an **active task** exists → the message is enqueued to the task's process-
  global message queue (delivered at the next inner-loop iteration boundary),
  and the response returns immediately with `queued: true` and the existing
  task's `taskId`. No new task is created.

A `task.message.enqueued` WebSocket event is emitted for each enqueued message.

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
  "iterations": 3,
  "taskId": "task-abc123",
  "queued": false,
  "loopMode": "dual"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | `string?` | Present in dual-loop mode. ID of the newly-created or existing active task. |
| `queued` | `boolean?` | `true` if the message was enqueued to an already-running task rather than starting a new one. |
| `loopMode` | `"single"` \| `"dual"` | Current server loop mode. |

**Error Response:**
```json
{
  "status": "error",
  "error": "LLM request failed: timeout",
  "sessionId": "session-1234567890"
}
```

---

### `GET /v1/tasks`

List all tasks known to the dual-loop agent (active, completed, interrupted,
failed, cancelled). Available only when the server runs in dual-loop mode; the
array will be empty in single-loop mode.

**Response:**
```json
{
  "tasks": [
    {
      "id": "task-abc123",
      "sessionId": "session-1234567890",
      "instruction": "Write a survey on attention",
      "status": "executing",
      "checkpoints": [],
      "progress": { "iterations": 3, "toolsUsed": ["bash"], "lastActivity": 1712700000000 },
      "createdAt": 1712699000000,
      "updatedAt": 1712700000000
    }
  ],
  "count": 1
}
```

### `GET /v1/tasks/:id`

Return a single task by ID.

**Response:** same shape as an element of `GET /v1/tasks`:

```json
{
  "id": "task-abc123",
  "sessionId": "session-1234567890",
  "instruction": "Write a survey on attention",
  "status": "completed",
  "checkpoints": [...],
  "progress": { "iterations": 5, "toolsUsed": ["bash","arxiv_search"], "lastActivity": 1712700500000 },
  "plan": { "steps": ["...", "..."] },
  "result": "Survey complete. See /workspace/survey.pdf.",
  "error": null,
  "createdAt": 1712699000000,
  "updatedAt": 1712700500000
}
```

**404 Response** if the task ID is unknown:
```json
{ "error": "Task task-abc123 not found" }
```

### `POST /v1/tasks/:id/cancel`

Cancel the active task identified by `:id` with a structured `AbortReason`
(Phase C7). The cancellation propagates into the inner loop via a per-task
`AbortController`, aborts any in-flight LLM fetch + tool execution, and injects
a synthetic `[Aborted: <reason>]` tool_result into the transcript for any
unresolved tool calls.

**Request body (optional):**
```json
{ "reason": "user_explicit_cancel" }
```

`reason` must be one of:

| Value | Meaning |
|-------|---------|
| `user_interrupted` | User pressed Ctrl-C / closed WS connection |
| `user_explicit_cancel` | User pressed "Cancel" in UI (default when omitted) |
| `timeout` | Task exceeded its deadline |
| `sibling_error` | A sibling sub-agent failed and cancellation cascaded |
| `server_shutdown` | Server is shutting down (SIGTERM / SIGINT) |

**Response 200:**
```json
{ "status": "cancelled", "taskId": "task-abc123", "reason": "user_explicit_cancel" }
```

**Response 400** — invalid `reason` string.
**Response 404** — task not found.
**Response 409** — task is not in an active status (`executing` / `planning` / `paused`); nothing to cancel.

> **v1 limitation**: see `handleCancelTask` JSDoc in `src/server.ts` for the
> current per-task cancellation scope and semantics.

### `POST /v1/tasks/:id/resume`

Resume an `interrupted` task (Phase B5). On server startup `loadPersistedTasks()`
scans `{workspaceDir}/.lumin/sessions/*/tasks/*.meta.json`; non-terminal tasks
from a prior run are re-registered with status `interrupted`. This endpoint
replays the persisted transcript (`*.jsonl`) and re-dispatches the inner loop.

**Request body:** none.

**Response 200:**
```json
{ "status": "resumed", "taskId": "task-abc123", "sessionId": "session-1234567890" }
```

**Response 404** — task not found.
**Response 405** — current loop mode does not support resume (single-loop).
**Response 409** — task is not in a resumable state (e.g. already completed).

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

#### `task.created`

A dual-loop task was created. Emitted immediately after the HTTP `/v1/chat`
response (before the inner loop starts).

```json
{
  "type": "task.created",
  "data": { "taskId": "task-abc123", "sessionId": "session-1234567890", "instruction": "Write a survey..." }
}
```

#### `task.planning`

Emitted when the task enters the planning phase.

```json
{
  "type": "task.planning",
  "data": { "taskId": "task-abc123", "goal": "Write a survey..." }
}
```

#### `task.planned`

Emitted after planning, with the ordered step list.

```json
{
  "type": "task.planned",
  "data": { "taskId": "task-abc123", "steps": ["Search arxiv", "Outline", "Draft", "Compile"] }
}
```

#### `task.progress` (Phase A5)

Emitted once per inner-loop iteration.

```json
{
  "type": "task.progress",
  "data": {
    "taskId": "task-abc123",
    "iteration": 3,
    "toolsUsed": ["bash", "arxiv_search"],
    "lastActivity": 1712700000000
  }
}
```

#### `task.message.enqueued` (Phase A3)

Emitted when `POST /v1/chat` enqueues a message into an already-running task
rather than spawning a new one.

```json
{
  "type": "task.message.enqueued",
  "data": {
    "taskId": "task-abc123",
    "messageId": "msg-xyz",
    "content": "also include figure-level results (truncated to 500 chars)"
  }
}
```

#### `task.message.orphaned` (Phase C5)

Emitted when a task terminates (completion, failure, or cancellation) while
queued messages remain undrained. One event is emitted per orphaned message.

```json
{
  "type": "task.message.orphaned",
  "data": {
    "taskId": "task-abc123",
    "messageId": "msg-xyz",
    "content": "also include figure-level results",
    "reason": "task_completed"
  }
}
```

`reason` is one of `task_completed` | `task_aborted`.

#### `task.completed`

Emitted when the inner loop finishes successfully.

```json
{
  "type": "task.completed",
  "data": {
    "taskId": "task-abc123",
    "sessionId": "session-1234567890",
    "result": "Survey complete. See /workspace/survey.pdf.",
    "toolsUsed": ["bash", "arxiv_search"]
  }
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
