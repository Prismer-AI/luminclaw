# Test Coverage — @prismer/agent-core

## Summary

| Runtime | Unit Tests | Integration Tests | Sync Parity | Stress Test |
|---------|-----------|------------------|-------------|-------------|
| **TypeScript** | 510 | 10 (LLM) + 11 (sync) | 11 | 8/8 |
| **Rust** | 483 | 8 (LLM) | (covered by sync) | 8/8 |

## TypeScript Tests (521 total)

Run: `npx vitest run`

LLM integration tests require env vars:
```bash
OPENAI_API_KEY=... OPENAI_API_BASE_URL=... AGENT_DEFAULT_MODEL=... npx vitest run
```

### By Module

| Module | Tests | Description |
|--------|------:|-------------|
| locomo-benchmark | 60 | Memory recall accuracy benchmark |
| directives | 42 | Directive types, serialization, payloads |
| task | 40 | Task state machine, store CRUD, transitions |
| directive-router | 37 | Routing by delivery mode (realtime/checkpoint/HIL) |
| builtins | 32 | Built-in tool implementations |
| loop | 29 | Loop factory, mode resolution, SingleLoopAgent |
| memory-recall-bench | 29 | Memory system benchmark |
| sse | 28 | EventBus pub/sub, backpressure, schemas |
| memory | 27 | File-based memory store/recall |
| ipc | 22 | IPC protocol, markers, serialization |
| session | 20 | Session history, buildMessages, child sessions |
| server | 19 | HTTP/WS server endpoints |
| config | 17 | Config loading, env vars, defaults |
| agents | 17 | Agent registry, built-in agents, mention resolution |
| skills | 17 | SKILL.md parsing, frontmatter, scanning |
| dual-loop | 16 | DualLoopAgent, WorldModel, task lifecycle |
| log | 16 | Structured logging |
| approval | 16 | Sensitive tool approval flow |
| provider | 15 | LLM provider, streaming, thinking models |
| agent | 13 | Core agent loop, doom detection, compaction |
| sync-parity | 11 | TS ↔ Rust behavioral equivalence |
| prompt | 11 | Prompt builder, priority ordering |
| observer | 11 | Event observation |
| hooks | 11 | Lifecycle hooks |
| compaction | 10 | Context overflow compaction |
| integration | 10 | LLM integration (real API calls) |
| workspace | 2 | Workspace middleware |

## Rust Tests (491 total)

Run: `cargo test --workspace`

LLM integration tests require the same env vars:
```bash
OPENAI_API_KEY=... OPENAI_API_BASE_URL=... AGENT_DEFAULT_MODEL=... cargo test --workspace -- --test-threads=1
```

### By Module

| Module | Tests | Description |
|--------|------:|-------------|
| directives | 72 | Directive types, serialization, camelCase JSON |
| provider | 35 | Message constructors, parse_response, FallbackProvider |
| task | 33 | State machine, all transitions, store CRUD |
| sse | 31 | EventBus pub/sub, clone, event types |
| tools | 30 | ToolRegistry CRUD, bash tool, get_specs |
| ipc | 27 | IPC protocol, InputMessage/OutputMessage, roundtrip |
| memory | 25 | File-based store/recall, keywords, scoring |
| agents | 22 | Built-in agents, registry, mention resolution |
| config | 21 | Config defaults, from_env, serde roundtrip |
| session | 20 | Session CRUD, buildMessages, child sessions |
| world_model | 19 | KnowledgeFact, handoff context, fact extraction |
| loop_factory | 18 | Mode resolution, factory creation |
| loop_types | 18 | LoopMode, AgentLoopInput/Result, ImageRef |
| loop_dual | 18 | DualLoopAgent, task creation, cancel, shutdown |
| skills | 17 | SKILL.md parsing, directory scanning |
| artifacts | 15 | Artifact store, assignment, filtering |
| prompt | 13 | PromptBuilder, priority ordering, sections |
| agent | 13 | MockProvider, doom loop, tool compaction, usage |
| loop_single | 11 | SingleLoopAgent, no-op methods |
| compaction | 10 | Truncation, orphan repair |
| hooks | 8 | Hook registry, before_prompt/tool, after_tool |
| workspace | 7 | WorkspaceConfig loading |
| integration | 8 | Real LLM: provider, agent, loops, thinking |

## Sync Parity Test (11 tests)

Run: `npx vitest run tests/sync-parity.test.ts` (requires LLM env vars)

Starts both TS and Rust servers, sends identical requests, verifies structural equivalence:

| Test | Verification |
|------|-------------|
| P1 | Health endpoint: same fields, same `loopMode` value |
| P2 | Basic text response: same `status`, `response`, `sessionId` fields |
| P3 | Tool calling: both execute `bash`, report in `toolsUsed` |
| P4 | Multi-step tools: both handle 2+ tool iterations |
| P5 | Session persistence: both recall context across requests |
| P6 | Memory tools: both `memory_store` + `memory_recall` via LLM |
| P7 | Dual-loop: both return quickly with task info |
| P8 | Dual-loop health: both report `loopMode: "dual"` |
| P9 | WebSocket: both produce `open → connected → chat.final` sequence |
| P10 | Error handling: both handle empty content gracefully |
| P11 | Concurrency: both handle 3 parallel requests |

## Stress Test (8 scenarios × 2 runtimes)

Run: `node tests/benchmark/dual-loop-stress.mjs`

| Scenario | Description |
|----------|-------------|
| S1 | Single-loop basic text response |
| S2 | Single-loop tool calling (bash) |
| S3 | Multi-turn tool usage |
| S4 | Dual-loop quick return |
| S5 | Dual-loop mode verification |
| S6 | Concurrent 3× requests |
| S7 | Session persistence (with retry) |
| S8 | WebSocket lifecycle events |

## JSON Schema Alignment

All HTTP/WS/IPC interfaces use **camelCase** field names:

| Field | JSON Key |
|-------|----------|
| Session ID | `sessionId` |
| Tools used | `toolsUsed` |
| Loop mode | `loopMode` |
| Prompt tokens | `promptTokens` |
| Completion tokens | `completionTokens` |
| Duration | `durationMs` |
| MIME type | `mimeType` |
| Artifact ID | `artifactId` |
| Task ID | `taskId` |
| Created at | `createdAt` |

Rust structs use `#[serde(rename_all = "camelCase")]` with `#[serde(alias = "snake_case")]` for backward compatibility.
