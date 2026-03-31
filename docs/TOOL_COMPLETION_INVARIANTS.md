# Tool Completion Ordering Invariants

This document records critical architectural invariants for tool execution
ordering and stream finalization. These constraints are derived from a
real-world bug class (OpenClaw "dead state") where the agent runtime sends
`agent.end` / `chat.final` before all tool results have been delivered to
clients. Violating these invariants causes the frontend to show an
incomplete response with no further progress — a silent failure that is
extremely hard to diagnose in production.

---

## The OpenClaw Bug (Root Cause Analysis)

OpenClaw v2026.2.26 has a three-layer failure:

### Layer 1 — Pi Framework (fire-and-forget tool handlers)

```typescript
// pi-embedded-subscribe.handlers.ts (v2026.2.26)
case "tool_execution_start":
  handleToolExecutionStart(ctx, evt).catch(err => { ... });
  return;  // Non-blocking — does not await
case "tool_execution_end":
  handleToolExecutionEnd(ctx, evt).catch(err => { ... });
  return;  // Non-blocking — does not await
```

Tool handlers run as fire-and-forget promises. The `handleAgentEnd` lifecycle
event fires independently, with **no coordination** against pending tool
handlers. When a tool takes >100ms to complete, `agent_end` arrives first.

### Layer 2 — Gateway (immediate cleanup on lifecycle:end)

```typescript
// server-chat.ts (v2026.2.26)
// On lifecycle:end:
emitChatFinal(...);  // Sends chat.final + cleans up buffers
// No flush of 150ms-throttled deltas before final
// No check for pending tool_result events
```

The gateway has a 150ms delta throttle — assistant text deltas are batched
and sent at 150ms intervals. When `lifecycle:end` fires, `emitChatFinal`
does **not** call `flushBufferedChatDeltaIfNeeded()` first (fixed in later
versions), so the last batch of text can be lost. More critically, it does
not wait for any pending `tool_result` events.

### Layer 3 — Client (immediate WS close)

The WebSocket client (our `openclawGatewayClient.ts`) originally closed the
connection immediately on `lifecycle:end` or `chat.final`, discarding any
late-arriving tool results.

**Result:** Frontend shows 10 `tool.start` events, 0 `tool.end` events,
then silence. The agent appears frozen ("dead state").

---

## Why Lumin Is Safe (Current Architecture)

Lumin's agent loop in `agent.ts` is **synchronous at the iteration level**:

```typescript
// agent.ts — The critical section
const toolResults = await Promise.all(
  response.toolCalls.map(async (call) => {
    bus.publish({ type: 'tool.start', ... });   // ← Client sees tool start
    const result = await tools.execute(...);      // ← Await completion
    bus.publish({ type: 'tool.end', ... });       // ← Client sees tool end
    return result;
  })
);
// Only AFTER all tools complete:
// → Push tool results into messages[]
// → Loop back to LLM, or break if no more tool calls

// agent.end is published AFTER the loop exits:
bus.publish({ type: 'agent.end', ... });
```

The guarantee chain:

1. `tool.start` → `await execute()` → `tool.end` — each tool completes
   before its end event fires.
2. `Promise.all` — all parallel tools must resolve before the iteration
   continues.
3. `agent.end` — only published after the `while` loop exits, which
   requires `!response.toolCalls?.length` (no more tools to call).
4. **Single process** — EventBus is in-memory; `publish()` is synchronous
   delivery to all subscribers. No network hop, no message reordering.

**Therefore:** A client that receives `agent.end` is guaranteed to have
already received every `tool.start` / `tool.end` pair.

---

## Invariants That MUST Be Maintained

### INV-1: tool.end before agent.end

`agent.end` MUST NOT be published until every `tool.end` for the current
iteration has been published. This is currently guaranteed by `await
Promise.all(...)` gating the loop iteration.

**If violated:** Frontend shows tools "in progress" that never complete.

### INV-2: No fire-and-forget tool execution

Tool execution MUST be awaited. Never use `.catch(() => {})` / `.then()`
patterns that detach tool execution from the agent loop control flow.

**If violated:** Same as OpenClaw Layer 1 — agent loop proceeds while tools
are still running.

### INV-3: Text flush before final

If text deltas are throttled or buffered (e.g., for streaming optimization),
all buffered text MUST be flushed before `agent.end` is published.

**If violated:** Last few tokens of the assistant response are silently
dropped. User sees truncated text.

### INV-4: EventBus ordering preserves causality

Events published in sequence on the EventBus MUST be delivered to
subscribers in the same order. The current synchronous `publish()` loop
guarantees this. If EventBus ever becomes async (batched, networked), this
invariant needs explicit enforcement (sequence numbers, ordered delivery).

**If violated:** Client may receive `tool.end` before `tool.start`, or
`agent.end` before `tool.end`, even if the agent published them in order.

### INV-5: Directive scan after tool batch

`scanDirectiveFiles()` MUST run after `Promise.all(toolResults)` resolves,
not concurrently. Directive files are written by tools during execution —
scanning before all tools finish will miss files from slower tools.

**If violated:** UI directives (component switches, content updates) are
lost for slow-completing tools.

---

## Future Risk Scenarios

### Scenario A: Parallel tool execution with timeouts

If Lumin adds per-tool timeouts (e.g., kill a tool after 60s), the timeout
handler must still emit `tool.end` with an error result. The agent loop
must not proceed to `agent.end` until all timed-out tools have their
`tool.end` events emitted.

```typescript
// WRONG — breaks INV-1:
const timeout = setTimeout(() => { /* silently cancel */ }, 60_000);

// CORRECT:
const timeout = setTimeout(() => {
  bus.publish({ type: 'tool.end', data: { tool, toolId, result: 'Error: timeout' } });
  // resolve the Promise.all entry with error
}, 60_000);
```

### Scenario B: Streaming tool results

If tools emit incremental results (e.g., streaming shell output), the
`tool.end` event must only fire after the stream is fully consumed. Do
not emit `tool.end` when the stream starts — emit it when it ends.

### Scenario C: Sub-agent tool delegation

When a tool delegates to a sub-agent (`handleDelegateCall`), the outer
agent's `Promise.all` already awaits the sub-agent's full completion.
If sub-agents ever run in a separate process or over a network boundary,
ensure the delegation call blocks until the sub-agent emits its own
`agent.end`.

### Scenario D: WebSocket gateway layer

If Lumin adds a gateway process (separate from the agent process) that
proxies events over WebSocket, the gateway MUST NOT close the connection
or emit `chat.final` until it has forwarded all events through `agent.end`.
Use the same pattern as the client-side fix: track pending `tool.start`
events and only finalize when all `tool.end` events have been forwarded.

### Scenario E: Multi-agent orchestration

If multiple agents share an EventBus or event transport, ensure that
`agent.end` from Agent A does not cause the transport layer to drop
pending events from Agent B. Each agent's event stream should have
independent lifecycle management.

---

## Testing Checklist

When modifying tool execution, the agent loop, or the EventBus:

- [ ] Emit a message with 5+ parallel tool calls. Verify every `tool.start`
      has a matching `tool.end` before `agent.end` arrives.
- [ ] Add an artificial 2s delay to one tool. Verify `agent.end` waits for
      the slow tool.
- [ ] Simulate a tool that throws. Verify `tool.end` still fires (with
      error result) and `agent.end` still fires after.
- [ ] If using streaming: verify text deltas are fully flushed before
      `agent.end`.
- [ ] If using WebSocket proxy: verify WS stays open until `agent.end` is
      forwarded to the client.
