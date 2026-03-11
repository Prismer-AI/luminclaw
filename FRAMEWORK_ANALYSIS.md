# Agent Framework Analysis: OpenClaw vs nanobot vs nanoclaw vs zeroclaw vs OpenCode

> **Date:** 2026-02-28 (初始分析) | 2026-03-12 (结果更新)
> **Branch:** feat/test-server
> **Status:** ✅ 评估完成 — **方案 G+ (自研 + Sub-Agent) 已实现，4,665 LOC 交付**
>
> ### 实施结果
>
> 基于本分析选择了方案 G+ (自研 Prismer Agent Core)，最终交付 **Lumin** 运行时：
> - **4,665 LOC TypeScript** (初始估算 ~1,050 LOC，增长因生产级能力需求)
> - **113 测试用例** (1,788 行测试代码)
> - **OpenClaw 功能对齐**: Agent Loop, Sub-Agent, FallbackProvider, Compaction, Memory, Hooks, Channels, Skills
> - **Prismer 独有能力**: Directive 文件扫描, Tool ID/Args 配对, PromptBuilder, K8s Warm Pool 双运行时
> - **对比**: OpenClaw ~892K LOC → Lumin 4,665 LOC (**0.52%**，功能对齐)
> - 详见 `AGENT_CORE_DESIGN.md` (技术设计) 和 `ROADMAP.md` (路线图)

---

## 1. Executive Summary

OpenClaw 已成为 Prismer 容器 Agent 系统的核心依赖，但其 ~892K LOC、70+ 依赖、频繁的 breaking change（如 2.26 版本 authtoken 协议变更）带来了不可忽视的适配成本和运行时开销。

本文对比分析五个 Agent 框架（OpenClaw、nanobot、nanoclaw、zeroclaw、OpenCode）与 Prismer 当前的容器集成设计，提出 **"薄适配层 + 自有协议"** 的收敛方案，目标是将 Prismer 对外部 Agent 框架的耦合降至最低，同时保留学术工具链（LaTeX/Jupyter/PDF）的核心能力。

**核心结论:**

| 维度 | OpenClaw | nanobot | nanoclaw | zeroclaw | OpenCode | 推荐路径 |
|------|---------|---------|----------|----------|----------|---------|
| 代码量 | ~892K LOC | ~4K LOC | ~7.6K LOC | ~217K LOC (Rust) | **~233K LOC** | nanoclaw 量级最可控 |
| 运行内存 | >1GB | >100MB | ~100MB+ | **<5MB** | ~200MB+ | zeroclaw 最极致 |
| 启动时间 | >5s | >1s | ~1s | **<10ms** | ~1s | zeroclaw 最快 |
| 依赖 | 70+ | 15+ | 11 | 40+ (feature-gated) | 200+ (monorepo) | nanoclaw 最精简 |
| 协议复杂度 | Protocol v3 (WS+Device Auth) | Async Queue | stdin/stdout + FS IPC | HTTP+WS (Axum) | HTTP+WS (Hono) | nanoclaw/zeroclaw 均简单 |
| LLM 抽象 | 内置 Provider 体系 | LiteLLM (20+) | Claude Agent SDK | 12+ Provider (内置) | **@ai-sdk 20+ Provider** | OpenCode Provider 最丰富 |
| 工具注册 | Plugin SDK (registerTool) | ToolRegistry | MCP Server | **60+ 内置 + MCP** | **30+ 内置 + MCP** | MCP 是行业标准 |
| Sub-Agent | 无 | 无 | 无 | 无 | **5+ 内置 Agent** | OpenCode Sub-Agent 最成熟 |
| Skills 系统 | 无 | Markdown SKILL.md | **manifest.yaml + merge** | templates + audit | Plugin hooks | nanoclaw Skills 最成熟 |
| Channel | 36+ | 12+ | WhatsApp + Skills | **25+** | TUI + Web + Desktop | Prismer 只需 IM bridge |
| 安全 | Device Auth | 无 | Mount allowlist | **Pairing+Autonomy+加密** | Permission model | zeroclaw 最完善 |
| OpenClaw 兼容 | 原生 | 无 | 无 | **有 compat shim** | 无 | zeroclaw 可平滑迁移 |
| Fork 可行性 | 不可行 | 可行但 Python | **最可行 (TS 同栈)** | 可行但 Rust | 可行 (TS+Bun) | 取决于团队技术栈 |

---

## 2. Framework Deep Dive

### 2.1 OpenClaw (当前使用)

**规模:** ~892K LOC, 4,896 TypeScript files, 59 production deps

**架构:**
```
Gateway (WebSocket Protocol v3)
  ├── Plugin SDK (registerTool, registerChannel, registerHook)
  ├── Agent Engine (Session, Context, Model Providers)
  ├── Channel Adapters (36+ messaging platforms)
  └── Extension System (40+ workspace packages)
```

**Prismer 使用的 OpenClaw 能力:**
- Gateway WebSocket 协议 (connect.challenge → hello-ok → chat.send)
- Plugin SDK: `registerTool()` (28 tools), `registerChannel()` (IM bridge)
- Device Auth: Ed25519 签名认证 (auto-pair 流程)
- Config Deploy: JSON merge 机制

**Agent Loop 设计分析 (核心 ~3600 LOC):**

OpenClaw 的 Agent 执行分三层，核心 tool loop 委托给外部库：

```
runEmbeddedPiAgent() — 1164 LOC (外层重试循环)
  ├── Auth Profile 轮换 (最多 160 次重试)
  ├── Context Overflow 检测 → 自动 compaction → 重试
  └── Usage 累计跨重试
      ↓
  runEmbeddedAttempt() — 1438 LOC (单次 Agent Turn)
    ├── Workspace 初始化 + 沙箱
    ├── createAgentSession() ← pi-agent-core 外部库
    │     └── session.prompt() ← 核心 tool loop 在这里面
    │           while (has_tool_calls):
    │             call LLM via streamFn (pi-ai 外部库)
    │             dispatch tools
    │             append results
    ├── Plugin Hooks: before_prompt_build, llm_input, llm_output, agent_end
    └── subscribeEmbeddedPiSession() — 事件订阅 (~600 LOC)
          ├── message_start/update/end → 流式文本
          ├── tool_execution_start/end → 工具进度
          └── auto_compaction_start/end → 上下文压缩
```

**关键设计特征:**
- **Tool loop 不在 OpenClaw 中** — 委托给 `@mariozechner/pi-agent-core` + `pi-ai` 外部库
- **Provider 抽象:** `streamFn: (model, context, options) => AsyncIterable` — 与 nanobot/zeroclaw 的 Provider trait 等价
- **Session 持久化:** JSONL 文件存储消息历史，跨重试保持
- **Compaction:** LLM 驱动的上下文摘要，3 次重试上限
- **Streaming:** 事件驱动 (message_start/update/end)，有 reasoning stream 支持

**对比其他框架的 Agent Loop:**

| | OpenClaw | nanobot | nanoclaw | zeroclaw | OpenCode |
|--|---------|---------|----------|----------|----------|
| 核心 loop LOC | **~3600** (含重试/failover) | ~160 (min) | ~170 (min) | ~240 (min) | ~730 (processor+llm) |
| 生产 loop LOC | ~3600 | ~500 | ~800 | ~3600 | ~5,750 (session 模块) |
| Tool loop 位置 | **外部库** (pi-agent-core) | 自有 | **外部库** (Claude SDK) | 自有 | 自有 (@ai-sdk/streamText) |
| Provider 抽象 | streamFn | provider.chat() | SDK 内置 | Provider trait | **@ai-sdk LanguageModelV2** |
| Sub-Agent 支持 | 无 | 无 | 无 | 无 | **5+ 内置 (primary+subagent)** |
| Session 持久化 | JSONL 文件 | JSON 文件 | SQLite | SQLite/Markdown | **SQLite (Drizzle ORM)** |
| Context 压缩 | LLM compaction | LLM consolidation | 无 | auto_compact | **LLM compaction agent** |
| 重试/Failover | **160 次, auth 轮换** | 无 | 无 | circuit breaker | doom-loop 检测 (3 次) |
| Plugin Hooks | 6 个策略点 | 无 | pre-compact/pre-tool | modifying + void hooks | **Plugin system (hooks)** |
| Permission Model | Device Auth | 无 | Mount allowlist | 3级 Autonomy | **Per-tool + per-agent** |

**痛点:**
1. **版本耦合严重** — 2.26 版本改 authtoken 协议，需要同步修改 Gateway Client + Bridge + Plugin
2. **运行时臃肿** — 容器内加载 70+ 依赖，启动慢、内存占用大
3. **协议过度设计** — Device Auth (Ed25519) 对 1:1 绑定场景完全不必要
4. **调试困难** — 核心 tool loop 在外部库 pi-agent-core 中，892K LOC 黑盒无法追踪
5. **Channel 浪费** — 36+ Channel 适配器我们只用了自定义的 prismer-im
6. **升级风险不可控** — 上游的任何 breaking change 都可能影响线上
7. **过度重试** — 160 次重试 + auth 轮换对 1:1 场景远超所需

### 2.2 nanobot

**规模:** ~3,922 LOC (core), Python 3.11+

**架构:**
```
Gateway (CLI/Docker)
  ├── Agent Loop (LLM call → Tool execute → Response)
  ├── Message Bus (asyncio inbound/outbound queues)
  ├── Channel Manager (12+ channels, config-driven)
  ├── Tool Registry (8 builtin + MCP tools)
  └── Skills (markdown-based SKILL.md files)
```

**优势:**
- 极致精简 — 3,922 行核心代码
- LiteLLM 抽象 — 一行代码切换 25+ LLM Provider
- MCP 支持 — 标准化的 Tool 协议
- Session 管理简单 — 文件系统 + JSON

**劣势:**
- **Python 栈** — Prismer 全栈 TypeScript，引入 Python 增加运维复杂度
- Channel 体系面向消费级 IM（Telegram/Discord），非学术场景
- 无容器隔离能力 — Agent 运行在宿主进程中
- 无 Skill Plugin 架构 — 工具是硬编码的

### 2.3 nanoclaw

**规模:** ~7,600 LOC (src), TypeScript, 11 production deps

**架构:**
```
Host Process (Node.js)
  ├── Container Runner (Docker/Apple Container)
  │     └── Agent Runner (Claude Agent SDK + MCP)
  ├── IPC (stdin/stdout + filesystem)
  ├── Router (message formatting, trigger detection)
  ├── DB (SQLite — messages, sessions, tasks)
  └── Channels (WhatsApp + extensible)
```

**优势:**
- **TypeScript 同栈** — 与 Prismer 无语言摩擦
- **容器隔离** — 每条消息独立容器执行，天然沙箱
- **IPC 极简** — stdin/stdout JSON + 文件系统 IPC，无 WebSocket 协议
- **依赖极少** — 11 个 production deps（baileys, better-sqlite3, pino, yaml, zod 等）
- **MCP 标准** — 工具通过 MCP Server 注册，行业标准协议
- **Skills 系统** — 基于 Claude Code 的 manifest.yaml + SKILL.md，可组合
- **Fork 友好** — 7.6K LOC 完全可以理解和维护

**Skills 系统 (核心亮点):**
- **15 个生产级 Skills:** add-discord, add-telegram, add-slack, add-gmail, add-voice-transcription, x-integration, convert-to-apple-container 等
- **skills-engine (~3K LOC):** 完整的 apply/merge/replay/uninstall/rebase 生命周期管理
- **三向合并:** 基于 `git merge-file` 的确定性代码注入 — 保留用户自定义修改
- **Skills 可创建 Tools:** Skill 修改 `container/agent-runner/src/index.ts` 注入 MCP Server，Agent 自动获得新工具
- **manifest.yaml 声明式:** npm 依赖、环境变量、docker-compose 服务、文件操作一站式管理
- **安全卸载:** Uninstall 时 replay 剩余 skills，保证无残留
- **自定义追踪:** `/customize` 会话追踪用户手工修改，与 skill 更新不冲突

**劣势:**
- 默认绑定 Claude Agent SDK（但 Agent Runner 可替换）
- Channel 体系偏 WhatsApp（但 Skills 可扩展任意 Channel）
- 无 WebSocket 实时流（但 IPC 方式足够我们的场景）

### 2.4 zeroclaw (新发现)

**规模:** ~217K LOC, 100% Rust, 编译后 8.8MB 单二进制

**架构:**
```
zeroclaw (单进程, Tokio async)
  ├── Gateway (Axum HTTP/WS, port 42617)
  │     ├── POST /api/chat         — 原生 Agent loop
  │     ├── POST /v1/chat/completions — OpenAI-compatible + OpenClaw compat
  │     └── WS /ws                 — 实时双向通信
  ├── Agent Loop (process_message → LLM → Tool dispatch → Response)
  ├── Providers (12+: OpenAI, Claude, Gemini, Ollama, Bedrock, OpenRouter...)
  ├── Channels (25+: Telegram, Discord, Slack, WhatsApp, Matrix, QQ, IRC...)
  ├── Tools (60+ 内置 + MCP client)
  ├── Memory (SQLite, Markdown, PostgreSQL)
  ├── Skills (templates + audit trails)
  ├── Runtime Adapters (Native, Docker, WASM, Bubblewrap, Landlock)
  └── Security (Pairing, 3级 Autonomy, ChaCha20 加密, 审计)
```

**优势:**
- **极致性能** — <5MB RAM, <10ms 启动, 单二进制部署
- **Trait 驱动** — Provider/Channel/Tool/Memory/Runtime 全部通过 Rust Trait 抽象，可插拔
- **OpenClaw 兼容层** — `openclaw_compat.rs` 提供 drop-in 迁移路径
- **安全架构成熟** — Pairing 认证、3 级 Autonomy (ReadOnly/Supervised/Full)、ChaCha20-Poly1305 加密、Prompt Guard
- **MCP 原生支持** — 完整的 MCP client (stdio/HTTP/SSE transport)
- **25+ Channel 内置** — 包括 QQ、Lark/Feishu、DingTalk 等国内平台
- **多 Runtime 隔离** — Docker, WASM (Wasmtime), Bubblewrap (Linux namespace), Landlock (LSM)
- **Research Phase** — Agent 回复前主动搜索信息，提高回答质量
- **Thinking Model 支持** — 保留 Claude/Kimi K2.5/GLM-4.7 的 reasoning 内容

**劣势:**
- **Rust 栈** — Prismer 全栈 TypeScript，团队需要 Rust 能力
- **代码量 217K** — 虽然编译后极小，但源码量不可忽视（是 nanoclaw 的 28 倍）
- **Fork 维护成本** — Rust 项目改造需要系统级编程经验
- **Skills 系统较简单** — 基于 templates，不如 nanoclaw 的 manifest + git merge-file 成熟
- **无 stdin/stdout IPC** — Gateway 是 HTTP 服务模式，不是进程级隔离

**与 Prismer 的潜在集成模式:**
- **方案 A: 作为容器内 Agent Runtime** — 替代 OpenClaw，zeroclaw 单二进制 8.8MB 直接跑在容器里，通过 HTTP `/api/chat` 通信
- **方案 B: 作为外部 Gateway** — zeroclaw 的 OpenClaw compat 层让 Prismer 现有的 Gateway Client 代码基本不用改
- **方案 C: 混合模式** — zeroclaw 跑 Agent loop + LLM Provider，学术工具通过 MCP Server 注入

### 2.5 OpenCode (新发现)

**规模:** ~233K LOC, 100% TypeScript, Bun 1.3 runtime, 20-package monorepo

**架构:**
```
OpenCode (Monorepo)
  ├── packages/opencode/     (~40K LOC, 核心引擎)
  │     ├── session/         — Agent Loop (processor.ts + llm.ts)
  │     ├── provider/        — 20+ LLM Provider (@ai-sdk 抽象)
  │     ├── tool/            — 30+ 内置工具 + MCP client
  │     ├── agent/           — Multi-agent 架构 (primary + subagent)
  │     ├── mcp/             — 完整 MCP 支持 (stdio/HTTP/OAuth)
  │     ├── plugin/          — Plugin system (hooks + npm packages)
  │     ├── lsp/             — Language Server Protocol 集成
  │     └── server/          — HTTP API + WebSocket (Hono)
  ├── packages/cli/          — Terminal UI (@opentui/solid)
  ├── packages/app/          — Web UI (SolidJS)
  ├── packages/desktop/      — Desktop (Tauri)
  ├── packages/sdk/          — SDK exports
  └── packages/containers/   — Container orchestration
```

**核心亮点: Multi-Agent 架构**

OpenCode 的 Agent 系统是五个框架中最成熟的：

| Agent | 模式 | 功能 | 可用工具 |
|-------|------|------|---------|
| **build** | Primary | 默认全能 Agent，代码编写 | 全部工具 |
| **plan** | Primary | 只读分析 Agent，探索陌生代码库 | read, grep, glob, bash (ask) |
| **general** | Subagent | 通用多步任务，**并行执行** | 全部工具 |
| **explore** | Subagent | 快速代码库探索 | grep, glob, ls, bash, read |
| **compaction** | Hidden | 会话压缩 — 摘要旧消息 | 无 |
| **title/summary** | Hidden | 生成会话标题/摘要 | 无 |

**Sub-Agent 调用模式:**
```typescript
// 消息中用 @-mention 调用 subagent
"@explore Find all database queries in the project"
"@general Create tests for login flow and optimize database schema"

// 自定义 Agent 配置 (.opencode/opencode.yaml)
agent:
  security-audit:
    name: "Security Scanner"
    prompt: "You are a security expert..."
    permission:
      read: allow
      bash: { "npm audit": allow, "*": deny }
    model: { modelID: claude-opus, providerID: anthropic }
    mode: subagent
```

**Permission Model (细粒度):**
```typescript
// Per-agent + per-tool + per-pattern 权限控制
Agent.Info.permission = [
  { permission: "read", pattern: "*.env", action: "ask" },
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "npm run", action: "ask" },
]
```

**Provider 抽象 (最丰富):**
- 基于 `@ai-sdk` 统一抽象，20+ bundled provider
- 支持 OAuth (GitHub Copilot, OpenCode Zen), API Key, Service Account
- 动态模型发现、能力检测 (temperature, reasoning, vision)
- Token 计费跟踪

**Context 管理:**
- SQLite (Drizzle ORM) 存储完整消息历史
- Automatic compaction — 消息超过阈值时 LLM agent 摘要旧消息
- Doom-loop 检测 — 连续 3+ 次工具调用失败则中止
- 工具输出截断 — >2MB 自动裁剪

**优势:**
- **Sub-Agent 架构最成熟** — primary/subagent 分级、@-mention 调用、并行执行、permission 隔离
- **Provider 最丰富** — @ai-sdk 20+ provider，远超其他框架
- **MCP 完整支持** — stdio/HTTP/SSE + OAuth 认证
- **Plugin 系统** — hooks 模式，可修改 agent loop 行为
- **LSP 集成** — Language Server Protocol 让代码理解更精确
- **TUI/Web/Desktop** — 完整的多端 UI 体系
- **MIT 开源** — 4.6M+ 下载量，活跃社区

**劣势:**
- **代码量巨大** — 233K LOC monorepo，核心引擎 40K LOC，fork 维护成本高
- **Bun runtime** — Prismer 使用 Node.js，引入 Bun 增加复杂度
- **面向 IDE 场景** — 设计为代码编辑助手，非学术研究场景
- **200+ 依赖** — monorepo 带来大量传递依赖
- **无容器隔离** — Agent 运行在宿主进程（有 containers 包但面向代码执行）
- **无 Directive 协议** — 面向终端输出，非 UI 指令驱动

**与 Prismer 的潜在集成模式:**
- **方案 H: 提取 Sub-Agent 模式** — 将 OpenCode 的 agent/ 模块设计模式 (~340 LOC) 移植到 Prismer Agent Core
- **方案 I: 提取 Permission 模式** — 将 per-agent/per-tool/per-pattern 权限模型移植
- **不建议直接 Fork** — 233K LOC + Bun + IDE 导向，与 Prismer 学术场景差异太大

**核心价值: 设计模式而非代码复用。** OpenCode 最值得借鉴的是：
1. Sub-Agent 分级 (primary/subagent/hidden) + @-mention 调用 + 并行执行
2. Per-agent Permission model — 不同 Agent 有不同工具和目录权限
3. Doom-loop 检测 — 避免无限工具重试
4. Compaction Agent — 专职 Agent 做会话摘要

---

## 3. Prismer 当前耦合分析

### 3.1 耦合点清单

| 耦合层 | 文件 | 依赖内容 | 耦合度 |
|--------|------|---------|--------|
| **Plugin SDK** | `docker/plugin/prismer-im/` | `registerChannel()`, Channel lifecycle | **CRITICAL** |
| **Plugin SDK** | `docker/plugin/prismer-workspace/` | `registerTool()`, 28 tool definitions | **CRITICAL** |
| **Gateway Protocol** | `src/lib/container/openclawGatewayClient.ts` | connect.challenge → hello-ok → chat.send | **HIGH** |
| **Device Auth** | `openclawGatewayClient.ts` | Ed25519 key pair, device auto-pair | **HIGH** |
| **Config Deploy** | `dockerOrchestrator.ts` | `openclaw.json` schema, merge 策略 | **MEDIUM** |
| **Container Image** | Dockerfile | OpenClaw runtime + 依赖 | **MEDIUM** |
| **Directive Protocol** | `docker/scripts/prismer-tools/` | 自有协议，**无耦合** | NONE |
| **Container Gateway** | `docker/gateway/container-gateway.mjs` | 自有反代，**无耦合** | NONE |
| **Orchestrator** | `src/lib/container/dockerOrchestrator.ts` | Docker API，**无耦合** | NONE |

### 3.2 已解耦部分（可保留）

以下模块设计良好，与 Agent 框架无关：

1. **Directive Protocol** — `SWITCH_COMPONENT`, `UPDATE_CONTENT` 等 JSON 文件协议，框架无关
2. **Container Gateway** — 零依赖 HTTP/WS 反代，路由到 5 个内部服务
3. **学术工具链** — LaTeX(:8080), Jupyter(:8888), arXiv(:8082) 独立服务
4. **Docker Orchestrator** — 容器生命周期管理，无框架依赖
5. **Bridge API** — 前端到容器的 HTTP 桥梁（但内部调 Gateway Client 有耦合）

### 3.3 需要替换的部分

1. **OpenClaw Gateway Client** (475 LOC) — WebSocket 协议 + Device Auth
2. **prismer-im Plugin** (~200 LOC) — Channel 注册 + IM SDK 桥接
3. **prismer-workspace Plugin** (~400 LOC) — 28 个 Tool 注册
4. **Config Deploy** — openclaw.json schema + 环境变量模板
5. **Container Image** — 需要从 OpenClaw 基础镜像切换

---

## 4. 收敛方案

### 4.1 方案对比

| 方案 | 描述 | 工作量 | 风险 | 维护成本 |
|------|------|--------|------|---------|
| A. 继续 OpenClaw | 跟随上游更新 | 低(短期) | 高(版本风险) | **高** |
| B. Fork nanoclaw | Fork 并适配学术工具链 (TS 同栈) | 3-5 周 | 中 | **低** |
| C. 自研 Agent Runner | 基于 nanoclaw 思路自研 | 6-8 周 | 中 | **中** |
| D. 薄适配层 | 抽象 Agent 接口，底层可插拔 | 2-3 周 | 低 | **最低** |
| E. zeroclaw 替换 | 容器内直接跑 zeroclaw 二进制 | 2-3 周 | 低 | **低** |
| F. zeroclaw + 薄适配层 | D + E 组合，zeroclaw 作为默认 backend | 3-4 周 | 低 | **低** |
| **G. 自研 Prismer Agent Core** | **TS 自研，综合四框架最佳设计** | **4-6 周** | **中** | **最低** |
| **G+. G + Sub-Agent 架构** | **G 基础上加入 OpenCode Sub-Agent 模式** | **5-7 周** | **中** | **最低** | ← **✅ 已选择并实现 (Lumin, 4,665 LOC)** |

### 4.2 方案详解

#### 方案 B+D: Fork nanoclaw + 薄适配层 (TypeScript 同栈路线)

**适用场景:** 团队以 TypeScript 为主，希望完全掌控 Agent Runtime 源码

- Fork nanoclaw 7.6K LOC，改造 Claude Agent SDK → Prismer LLM Gateway
- 学术工具链通过 nanoclaw Skills 系统注入（manifest.yaml + MCP）
- 薄适配层 `AgentTransport` 接口支持 OpenClaw 回退

#### 方案 E+D: zeroclaw 替换 + 薄适配层 (性能优先路线)

**适用场景:** 追求极致容器性能，可以接受 Rust 黑盒

- 容器内放 zeroclaw 8.8MB 二进制，<5MB RAM, <10ms 启动
- 通过 HTTP `/api/chat` 或 OpenClaw compat `/v1/chat/completions` 通信
- 学术工具通过 MCP Server 注入（zeroclaw 原生支持 MCP client）
- **不需要 Fork** — zeroclaw 的 `config.toml` + MCP 已足够配置
- 薄适配层 `AgentTransport` 接口支持 OpenClaw/zeroclaw 切换

**zeroclaw 方案优势:**
1. **零 Fork 成本** — 直接使用上游二进制，通过 config.toml 配置
2. **OpenClaw 兼容** — `openclaw_compat.rs` 让现有 Bridge 代码几乎不用改
3. **极致资源** — 容器镜像可以极小（Alpine + 8.8MB binary + 学术服务）
4. **MCP 原生** — 学术工具以 MCP Server 形式注入，无需改 zeroclaw 源码
5. **安全内置** — Pairing, Autonomy levels, 加密存储，无需我们自建

**zeroclaw 方案风险:**
1. **Rust 黑盒** — 出问题时调试困难（但比 OpenClaw 892K LOC 好）
2. **上游依赖** — 仍然依赖 zeroclaw-labs 维护（但可以 pin 版本）
3. **Skills 较弱** — 不如 nanoclaw 的 manifest + git merge-file 成熟

#### 方案 G/G+: 自研 Prismer Agent Core (完全自主路线)

**适用场景:** 追求 100% 源码掌控，接受失去社区跟进但换取完全自由

分析四个框架的核心 Agent Loop 后，最小可行的 Agent Core 只需要 **~500 LOC TypeScript**：

```
四框架核心 loop LOC 对比:
  nanoclaw:  170 LOC (min) → 800 LOC (prod)  — SDK 隐藏了编排复杂度
  nanobot:   160 LOC (min) → 500 LOC (prod)  — 最清晰的分层抽象
  zeroclaw:  240 LOC (min) → 3600 LOC (prod) — 生产级健壮性最高
  opencode:  730 LOC (min) → 5750 LOC (prod) — Sub-Agent 架构最成熟
```

**自研设计 — Cherry-pick 四框架最佳模式:**

| 模块 | 来源 | 设计 | LOC 估算 |
|------|------|------|---------|
| **Agent Loop** | nanobot | `while (hasToolCalls) { chat → execute → append }` | ~100 |
| **Provider 抽象** | zeroclaw trait | `interface Provider { chat(messages, tools): Response }` | ~80 |
| **Tool Registry** | nanobot | `Map<string, Tool>` + MCP client wrapper | ~60 |
| **MCP Client** | nanoclaw/zeroclaw | `@modelcontextprotocol/sdk` stdio/HTTP transport | ~80 |
| **Sub-Agent 编排** | **OpenCode** | `AgentRegistry` + primary/subagent/hidden 分级 + 并行执行 | ~120 |
| **Permission Model** | **OpenCode** | per-agent + per-tool + per-pattern 权限控制 | ~80 |
| **Memory** | nanobot + Cloud SDK | 四层: working→history→facts→cloud (L4 = sdk.context) | ~120 |
| **Session** | nanobot | `SessionManager` + message history + persist hooks | ~50 |
| **Observability** | zeroclaw observer | `interface Observer { recordEvent, recordMetric }` | ~60 |
| **Streaming** | zeroclaw | `on_delta` callback + chunk sentinel | ~40 |
| **IPC** | nanoclaw | stdin/stdout JSON + filesystem directive output | ~80 |
| **Cloud SDK** | Prismer | cloud.ts + bridge.ts — IM 集成 + Context API | ~180 |
| **总计** | | | **~1050 LOC** |

**核心代码骨架:**

```typescript
// prismer-agent-core/src/agent.ts — 最小 Agent Loop

interface Provider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  supportsNativeTools(): boolean;
}

interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: Record<string, unknown>): Promise<string>;
}

class PrismerAgent {
  constructor(
    private provider: Provider,
    private tools: Map<string, Tool>,
    private memory: MemoryStore,
    private observer: Observer,
  ) {}

  async processMessage(input: string, session: Session): Promise<string> {
    const context = await this.memory.recall(input, 5);
    const messages = session.buildMessages(input, context);
    const toolSpecs = [...this.tools.values()].map(t => t.toSpec());

    let iteration = 0;
    while (iteration++ < 40) {
      this.observer.recordEvent('llm_request', { iteration });
      const response = await this.provider.chat({ messages, tools: toolSpecs });
      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

      if (!response.toolCalls?.length) {
        await this.memory.save(input, response.text);
        return response.text;
      }

      // 工具执行 (可并行)
      const results = await Promise.all(
        response.toolCalls.map(async (call) => {
          this.observer.recordEvent('tool_call', { name: call.name });
          const tool = this.tools.get(call.name);
          const result = tool ? await tool.execute(call.arguments) : `Unknown tool: ${call.name}`;
          return { id: call.id, output: result };
        })
      );

      for (const r of results) {
        messages.push({ role: 'tool', toolCallId: r.id, content: r.output });
      }
    }
    return '[max iterations reached]';
  }
}
```

**自研获得:**
1. **100% 源码掌控** — 没有任何外部框架依赖，每行代码都可审计
2. **完美的可观测性** — Observer 接口从 Day 1 设计，不是后补
3. **交互需求收敛** — Agent ↔ Prismer 的通信协议完全自定义，无适配层
4. **学术 Sub-Agent** — 专业化子 Agent (LaTeX 专家、数据分析专家、文献检索专家) + 并行执行
5. **学术工具原生** — MCP tools 直接为学术场景设计，不是通用框架的插件
6. **Directive 协议原生** — `SWITCH_COMPONENT`, `UPDATE_CONTENT` 等指令不需要任何桥接
7. **Cloud SDK 免维护** — IM、文件、Agent 发现、离线同步 — 全部零维护成本
8. **容器镜像最小** — Node.js + ~1050 LOC agent + 学术服务，无臃肿 runtime

**自研失去:**
1. **社区演进** — LLM 新特性（vision, audio, computer use）需要自己跟进
2. **多 Provider 支持** — 新 LLM Provider 的兼容性需要自建（但 OpenAI-compatible 覆盖 90%）
3. **安全加固** — Pairing, Autonomy, Prompt Guard 需要自研（zeroclaw 内置）
4. **Channel 生态** — 如果未来需要 Telegram/Discord 直连，需要自建
5. **MCP 生态跟进** — MCP 协议演进需要手动更新 client

**风险缓解:**
- Provider 接口设计为 OpenAI-compatible，覆盖 90%+ 的 LLM（包括 Prismer Gateway）
- MCP client 使用 `@modelcontextprotocol/sdk` 官方包，协议更新自动跟进
- 安全层初期只需 token 认证（已有），Autonomy/Prompt Guard 按需后加
- 650 LOC 的代码量意味着 **一个人一周可以完全理解和重写**

### 4.3 推荐路径: D 先行，B/E/G 后选

**核心思路: 薄适配层优先，后端可插拔**

```
┌─────────────────────────────────────────────────────────┐
│  Prismer Frontend                                        │
│  (Workspace Chat → Bridge API)                           │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP POST
               ▼
┌──────────────────────────────────────────────────────────┐
│  Prismer Agent Adapter (新增 ~500 LOC)                    │
│  ┌────────────────────────────────────┐                  │
│  │ AgentTransport interface           │                  │
│  │  - sendMessage(msg) → response     │                  │
│  │  - healthCheck() → status          │                  │
│  │  - deployConfig(config) → void     │                  │
│  └────────────────────────────────────┘                  │
│       │              │              │             │       │
│  ┌────┴─────┐  ┌─────┴──────┐  ┌───┴──────┐  ┌──┴────┐ │
│  │ OpenClaw  │  │ nanoclaw   │  │ zeroclaw │  │Prismer│ │
│  │ Transport │  │ Transport  │  │Transport │  │Agent  │ │
│  │ (现有)    │  │ stdin/IPC  │  │HTTP /api │  │Core   │ │
│  │ WS协议    │  │ fork 改造  │  │ 二进制   │  │自研   │ │
│  └──────────┘  └────────────┘  └──────────┘  └───────┘ │
└──────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  Container                                                │
│  ┌────────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │ Agent Runtime   │  │ Container   │  │ Academic     │  │
│  │ (any backend)   │  │ Gateway     │  │ Services     │  │
│  │ + MCP Server    │  │ (:3000)     │  │ LaTeX/Jupyter│  │
│  │ (学术工具)      │  └─────────────┘  └──────────────┘  │
│  └────────────────┘                                      │
└──────────────────────────────────────────────────────────┘
```

**为什么 D 先行:**

1. **薄适配层是必须的** — 不管最终选哪个 backend，`AgentTransport` 接口解耦了前端和 Agent Runtime
2. **四个 backend 可以共存** — 环境变量 `AGENT_TRANSPORT=openclaw|nanoclaw|zeroclaw|prismer` 切换
3. **渐进迁移** — OpenClaw 保持回退，新 backend 在 dev 环境验证
4. **学术工具链完全保留** — LaTeX/Jupyter/PDF 等服务不受 Agent Runtime 选择影响

**后续三条路线对比:**

| 维度 | B. Fork nanoclaw | E. zeroclaw 二进制 | **G+. 自研 + Sub-Agent** |
|------|-----------------|-------------------|---------------------|
| 团队能力 | TypeScript ✅ | 需要 Rust ⚠️ | TypeScript ✅ |
| 源码掌控 | Fork 7.6K LOC ✅ | 217K LOC 黑盒 ⚠️ | **~1050 LOC 完全掌控** ✅ |
| 容器资源 | ~100MB+ RAM | **<5MB RAM** ✅ | ~50MB RAM |
| Sub-Agent | 无 | 无 | **学术专家 Agent** ✅ |
| Skills 系统 | **manifest+merge** ✅ | templates | 自定义 (按需) |
| 改造工作量 | 3-5 周 | 2-3 周 | 5-7 周 |
| 社区跟进 | nanoclaw 上游 | zeroclaw 上游 | **无** ⚠️ |
| 可观测性 | 需要后加 | 内置 Observer ✅ | **Day 1 设计** ✅ |
| 交互收敛 | Skills 桥接 | MCP 配置化 | **原生 Directive** ✅ |
| Cloud SDK | 需桥接 | 需桥接 | **原生集成** ✅ |
| OpenClaw 兼容 | 无 | **有 compat** ✅ | 无 (不需要) |
| 长期维护 | 跟 nanoclaw 上游 | pin 版本 | **完全自主** ✅ |

---

## 5. 行动计划

> **2026-03-12 更新:** 最终选择了方案 G+ (自研)，以下为原始计划和实际执行的对比。

### 原始计划 vs 实际执行

原始行动计划基于 **D 先行 (适配层)，B/E/G 后选** 的策略，设计了通用的 AgentTransport 接口。
实际执行中，直接选择了方案 G+ 并跳过了适配层抽象，因为：

1. **1:1 workspace 场景不需要多 backend 切换** — 环境变量 `AGENT_RUNTIME` 已足够
2. **直接自研比适配更快** — 省去了抽象层的设计和维护
3. **OpenClaw 共存通过双运行时实现** — 数据库 `AGENT_RUNTIME` 字段控制路由

### 实际执行路线 (Lumin)

| Phase | 周期 | 交付 | LOC |
|-------|------|------|-----|
| P0 | 跳过 | AgentTransport 适配层 — 后续集成时做 | — |
| P1 | Week 1 | Agent Loop + SSE EventBus + Sub-Agent | 2,635 |
| P1.5 | Week 1 | CLI + HTTP/WS 网关 + 真实 LLM 验证 | (含上) |
| P2 | Week 2 | PromptBuilder + Cloud IM 凭证注入 + Skills + Fallback | 3,349 |
| P3 | Week 2-3 | Context Engineering + Memory + Compaction + Hooks | 3,873 |
| P4 | Week 3 | Cloud SDK + Skills + ClawHub + Channels | 4,665 |
| P4.5 | Week 3 | 平台集成层 — Directive 投递 + Tool ID 配对 + K8s Warm Pool | +130 (host 侧) |

**关键决策变更:**
- **跳过 Fork nanoclaw** — 自研 4,665 LOC 比 fork 7,600 LOC + 改造更可控
- **跳过 MCP 工具迁移** — 学术工具保持在 `prismer-workspace` 插件中，通过 `loadWorkspaceToolsFromPlugin()` 动态加载
- **跳过 AgentTransport 抽象** — 双运行时通过 DB 字段 + 独立 Gateway Client 实现

### 待完成

- **Phase 5:** Host 侧 AgentTransport + npm 包
- **Phase 6:** 生产加固 (Approval Gate, 背压控制)
- **Phase 7:** 清理 OpenClaw（移除 openclawGatewayClient.ts 475 LOC 等）

---

## 6. 风险评估与实际情况

### 6.1 技术风险 (回顾)

| 风险 | 预估概率 | 实际情况 |
|------|---------|---------|
| MCP 工具迁移不完整 | 中 | **未发生** — 跳过 MCP 迁移，工具保持在 prismer-workspace 插件中 |
| LLM 响应格式差异 | 低 | **未发生** — OpenAI-compatible API 覆盖所有场景 |
| 容器启动时间回归 | 低 | **未发生** — Lumin 无额外启动开销 |
| 工具量超出预期 | 未预估 | **发生** — 从估算 ~1,050 LOC 增长到 4,665 LOC |

### 6.2 时间 (实际)

- **P1-P1.5:** ~1 周 (Agent Loop + CLI + HTTP/WS)
- **P2-P3:** ~1.5 周 (OpenClaw 能力对齐 + Context Engineering)
- **P4-P4.5:** ~1 周 (Channels + Skills + 平台集成)
- **总计:** ~3.5 周 (初始估算 5-7 周)

### 6.3 回退策略 (已验证)

- 数据库 `AGENT_RUNTIME` 字段 (`openclaw` | `lumin`) 控制运行时选择
- Bridge API 自动检测并路由到对应 Gateway Client
- 两个运行时共享消息持久化代码路径和 workspace context 注入
- K8s Warm Pool 通过 `prismer.runtime` label 区分 pod

---

## 7. 收益预估与实际结果

### 7.1 定量收益 (预估 vs 实际)

| 指标 | OpenClaw | 预估 | Lumin 实际 | 改善 |
|------|----------|------|-----------|------|
| Agent Runtime LOC | ~892K | ~1,050 | **4,665** | **-99.5%** |
| 生产依赖 | 70+ | ~10 | **1** (zod) | **-99%** |
| 测试覆盖 | 不可测 (黑盒) | — | **113 cases** | 从 0 到 113 |
| 协议复杂度 | WS v3 + Device Auth | stdin/stdout | **HTTP + WS + IPC** | 完全可控 |
| 版本升级风险 | 高 | 极低 | **零** (完全自有) | 根本解决 |

### 7.2 定性收益 (已验证)

1. **版本自主** — 不再受上游 breaking change 影响 ✅
2. **完全可调试** — 4,665 LOC 100% 源码掌控，每行可审计 ✅
3. **协议简洁** — HTTP/WS 网关 + stdin/stdout IPC + 文件系统 directive ✅
4. **技术栈统一** — 全 TypeScript，零 Python/Go/Rust 依赖 ✅
5. **可观测性原生** — Observer 从 Day 1 设计，不是后补 ✅
6. **Directive 原生** — 文件扫描 + EventBus，无桥接层 ✅
7. **双运行时共存** — DB `AGENT_RUNTIME` 字段实现 OpenClaw/Lumin 平滑切换 ✅

---

## 8. 附录

### A. 五框架代码规模对比

```
OpenClaw:
  TypeScript files:  4,896
  Estimated LOC:     ~892,000
  Dependencies:      59 production + 20 dev

nanobot:
  Python files:      57 (core)
  Core LOC:          ~3,922
  Dependencies:      15+ production

nanoclaw:
  TypeScript files:  ~80
  Core LOC:          ~7,600
  Dependencies:      11 production

zeroclaw:
  Rust files:        305
  Total LOC:         ~217,000
  Binary size:       8.8 MB (release)
  Runtime RAM:       <5 MB
  Dependencies:      40+ (feature-gated Cargo crates)

OpenCode:
  TypeScript files:  1,167
  Total LOC:         ~233,000
  Core Engine LOC:   ~40,000 (packages/opencode/)
  Runtime:           Bun 1.3
  Packages:          20 (monorepo)
  Dependencies:      200+ (monorepo 传递)
  Agent Types:       5+ built-in (primary + subagent)
  LLM Providers:     20+ (@ai-sdk bundled)
  Built-in Tools:    30+
```

### B. Prismer 实际使用的 OpenClaw 功能占比

```
OpenClaw 总能力:
  ├── Gateway Protocol v3          [使用] 15%
  ├── Plugin SDK                   [使用] 10%
  ├── Agent Engine                 [使用] 5%
  ├── 36+ Channel Adapters         [不使用] 0%  ← 自建 prismer-im
  ├── Device Auth (Ed25519)        [被迫使用]
  ├── 70+ Skills/Extensions        [不使用] 0%  ← 自建 prismer-workspace
  ├── Multi-node Session           [不使用] 0%
  ├── UI Components (Lit)          [不使用] 0%
  └── Native Apps (iOS/Android)    [不使用] 0%

实际使用率: < 10%
```

### C. nanoclaw Fork 改造点详情

**核心 Fork 改造 (修改 nanoclaw 源码):**

| 文件 | 改造内容 | 估算工作量 |
|------|---------|-----------|
| `container/agent-runner/src/index.ts` | 替换 Claude Agent SDK → OpenAI-compatible | 1 天 |
| `src/container-runner.ts` | 适配 Prismer 容器配置 | 1 天 |
| `src/ipc.ts` | 扩展 directive 文件监听 | 0.5 天 |
| `src/index.ts` | 移除 WhatsApp 默认依赖 | 0.5 天 |

**Skill 封装 (不修改 nanoclaw 源码，利用 Skills 系统):**

| Skill | 内容 | 估算工作量 |
|-------|------|-----------|
| `add-academic-tools` | 28 个学术工具 MCP Server + LaTeX/Jupyter docker-compose | 3-4 天 |
| `add-prismer-bridge` | Prismer IM Bridge Channel 实现 | 1-2 天 |
| `add-directive-ipc` | Directive 协议 IPC 输出 (SWITCH_COMPONENT 等) | 1 天 |

**优势:** 核心 Fork 只改 ~3 天工作量的代码，学术能力通过 Skills 注入，可独立升级。nanoclaw 上游更新时只需 `git merge` 核心改动，Skills 通过三向合并自动保留。

### D. 参考仓库

| 仓库 | 位置 | 语言 | 核心 LOC |
|------|------|------|---------|
| OpenClaw | `ref/openclaw/` | TypeScript | ~892K |
| nanobot | `ref/nanobot/` | Python | ~4K |
| nanoclaw | `ref/nanoclaw/` | TypeScript | ~7.6K |
| zeroclaw | `ref/zeroclaw/` | Rust | ~217K |
| OpenCode | `ref/opencode/` | TypeScript (Bun) | ~233K |

### E. Lumin 实际代码规模

```
Lumin (方案 G+ 实现):
  TypeScript files:  26 (source) + 11 (tests)
  Source LOC:        4,665
  Test LOC:          1,788
  Test cases:        113
  Dependencies:      1 production (zod)
  Runtime:           Node.js 20
  Docker image:      基于 prismer-academic (C1 学术镜像)
```

### F. 相关文档

- `docker/agent/AGENT_CORE_DESIGN.md` — 自研 Agent Core 详细技术设计
- `docker/agent/ROADMAP.md` — 自研 Agent Core 路线图
- `docker/agent/README.md` — Lumin 运行时使用文档
- `docs/CONTAINER_PROTOCOL.md` — 容器变更协议
- `docs/ARCH.md` — 系统架构
- `docker/VERSIONS.md` — 容器组件版本
- `docs/OPENSOURCE_ARCHITECTURE.md` — 开源架构设计
