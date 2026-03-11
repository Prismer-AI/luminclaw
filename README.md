# Lumin — 轻量级 Agent 运行时

**4,665 行 TypeScript** 的独立 Agent 运行时，替代 OpenClaw (913K 行)。

## 核心理念

**Lumin 是纯运行时，不重新实现学术工具。**

- 学术工具（LaTeX、Jupyter、PDF、数据分析等 40+ 工具）已模块化在 `prismer-workspace` 插件中
- Lumin 通过 `loadWorkspaceToolsFromPlugin()` 动态加载这些工具
- 模块系统（`src/lib/modules/catalog.ts`）控制每个 workspace 启用哪些工具
- Lumin 只负责：LLM 调用 → 工具分发 → 流式输出 → 子 Agent 编排

## CLI

```bash
# 单次消息（配置来自环境变量）
lumin agent --message "帮我写一篇 survey"

# 启动 HTTP + WebSocket 网关
lumin serve --port 3001

# 健康检查
lumin health --url http://localhost:3001

# 版本
lumin version

# stdin JSON 模式（IPC 协议）
echo '{"type":"message","content":"hello","config":{"model":"us-kimi-k2.5"}}' | lumin
```

## 网关 API

```bash
# 健康检查
curl http://localhost:3001/health

# 工具列表
curl http://localhost:3001/v1/tools

# 发送消息（同步，等待完整响应）
curl -X POST http://localhost:3001/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello","sessionId":"my-session"}'

# WebSocket 实时流式
wscat -c ws://localhost:3001/v1/stream
> {"type":"chat.send","content":"帮我写一篇 LaTeX 论文"}
```

### WebSocket 协议

```
Client → { type: "chat.send", content: "...", sessionId?: "..." }
Server → { type: "connected", sessionId: "...", version: "0.2.0" }
Server → { type: "lifecycle.start", sessionId: "..." }
Server → { type: "text.delta", delta: "..." }
Server → { type: "tool.start", tool: "latex_compile", toolId: "latex_compile:0", args: {...} }
Server → { type: "tool.end", tool: "latex_compile", toolId: "latex_compile:0", result: "..." }
Server → { type: "directive", directive: { type: "SWITCH_COMPONENT", payload: {...} } }
Server → { type: "chat.final", content: "...", directives: [...], toolsUsed: [...] }
```

**tool.start/tool.end 事件包含 `toolId` 字段**（格式 `toolName:index`），前端通过配对 start/end 的 toolId 追踪工具执行状态。`args` 在 tool.start 中可选提供。

### Directive 投递机制

插件工具通过 `sendUIDirective()` 发送 UI 指令，投递优先级：

1. **Cloud IM** — 跨 K8s pod 实时投递（需要 IM 凭证）
2. **HTTP POST** — 单 pod/Docker 模式回退
3. **文件系统** — 写入 `/workspace/.openclaw/directives/*.json`

Lumin agent 在每次工具执行后**自动扫描**文件系统中的新 directive 文件，发布到 EventBus 并通过 WS 流式转发。文件处理后自动清理。

Bridge SSE 端拦截 `__directive` 伪工具事件，重新发射为原生 `directive` SSE 事件，前端 `useContainerChat` 处理后调用 `executeDirective()` 更新 UI。

## 架构

```
stdin JSON / CLI / HTTP+WS → Lumin Runtime → stdout JSON / WS events
                                │
                                ├── Provider (OpenAI-compatible)
                                │     ├── FallbackProvider (model chain)
                                │     └── Prismer Gateway / OpenRouter / Ollama
                                │
                                ├── PromptBuilder (dynamic system prompt)
                                │     ├── SOUL.md (identity, priority 10)
                                │     ├── TOOLS.md (tool reference, priority 8)
                                │     ├── Agent Instructions (priority 7)
                                │     ├── Skills from SKILL.md (priority 5)
                                │     ├── Workspace Context (priority 4)
                                │     └── Runtime Info (priority 3)
                                │
                                ├── Tool Registry
                                │     ├── prismer-workspace 插件 (40+ 模块化工具)
                                │     ├── bash (内置，容器隔离)
                                │     └── clawhub (技能管理)
                                │
                                ├── SkillLoader
                                │     └── /workspace/skills/*/SKILL.md → prompt injection
                                │
                                ├── Channel Manager
                                │     ├── Cloud IM channel (Prismer Cloud)
                                │     └── Telegram channel (Bot API)
                                │
                                ├── Sub-Agent Registry
                                │     ├── researcher (primary)
                                │     ├── latex-expert (subagent)
                                │     ├── data-analyst (subagent)
                                │     └── literature-scout (subagent)
                                │
                                ├── Directive Scanner
                                │     └── /workspace/.openclaw/directives/ → EventBus
                                │
                                ├── Compaction Engine
                                │     ├── memory flush → extract facts before compaction
                                │     ├── LLM-driven conversation summary
                                │     └── orphaned tool result repair
                                │
                                ├── Memory Store
                                │     └── /workspace/.prismer/memory/YYYY-MM-DD.md
                                │
                                ├── Lifecycle Hooks
                                │     └── before_prompt / before_tool / after_tool / agent_end
                                │
                                └── EventBus → WS / SSE / stdout
```

## 模块清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `agent.ts` | 592 | Agent Loop + sub-agent + doom-loop + context guard + compaction + directive scanner |
| `server.ts` | 492 | HTTP + WebSocket 网关 (tool event 转发含 toolId/args) |
| `provider.ts` | 378 | OpenAI-compatible LLM + FallbackProvider + thinking control |
| `index.ts` | 366 | runAgent() 核心 + PromptBuilder 集成 + 模块导出 |
| `tools/clawhub.ts` | 240 | ClawHub CLI 工具包装 |
| `prompt.ts` | 235 | 动态 system prompt 构建器 (SOUL.md / TOOLS.md / Skills) |
| `cli.ts` | 193 | CLI 入口 + 子命令路由 |
| `skills.ts` | 178 | SKILL.md 加载 + YAML frontmatter 解析 + 缓存 |
| `channels/cloud-im.ts` | 177 | Cloud IM channel (Prismer Cloud SSE) |
| `channels/telegram.ts` | 171 | Telegram Bot channel |
| `tools/loader.ts` | 159 | prismer-workspace 工具适配器 + Cloud IM 凭证注入 |
| `workspace.ts` | 154 | 文件安全中间件 |
| `agents.ts` | 149 | Sub-Agent 注册表 (6 个内置) |
| `sse.ts` | 144 | EventBus + SSE writer (Zod schema，含可选 toolId/args) |
| `compaction.ts` | 141 | 上下文压缩 + memory flush + orphaned tool repair |
| `session.ts` | 138 | 会话管理 + 子会话 + directive 累积 |
| `memory.ts` | 118 | 关键词记忆存储 (/workspace/.prismer/memory/) |
| `observer.ts` | 115 | 可观测性 (事件 + 指标) |
| `ipc.ts` | 109 | stdin/stdout JSON 协议 |
| `hooks.ts` | 99 | 生命周期钩子 (before_prompt, before_tool, after_tool, agent_end) |
| `tools.ts` | 96 | Tool 注册表 + 分发 |
| `channels/manager.ts` | 87 | Channel 管理器 (发现 + 启停) |
| `directives.ts` | 70 | UI 指令 Zod schemas |
| `channels/types.ts` | 34 | Channel 接口定义 |
| `tools/index.ts` | 16 | 导出索引 |
| `schemas.ts` | 14 | 前端类型导出 |
| **总计** | **4,665** | |

## 测试

```bash
npm test              # 运行全部 113 个测试
npm test -- tests/agent.test.ts   # 单独运行某个测试文件
```

| 测试文件 | 测试数 | 覆盖模块 |
|----------|--------|---------|
| `agent.test.ts` | 13 | Agent Loop, compaction, doom-loop, thinking, usage |
| `skills.test.ts` | 17 | SkillLoader, frontmatter, caching, budget |
| `prompt.test.ts` | 11 | PromptBuilder, SOUL.md, TOOLS.md, priority |
| `provider.test.ts` | 10 | FallbackProvider, retryable errors |
| `loader.test.ts` | 6 | Tool loader, filter, createTool |
| `integration.test.ts` | 6 | Full PromptBuilder + Skills + Config flow |
| `llm-integration.test.ts` | 8 | Real LLM: chat, tools, SOUL.md, skills, fallback, thinking |
| `compaction.test.ts` | * | Compaction, memory flush, orphaned repair |
| `memory.test.ts` | * | Memory store, keyword recall |
| `hooks.test.ts` | * | Lifecycle hooks |
| `channels/*.test.ts` | * | Channel manager, Cloud IM, Telegram |
| **总计** | **113** | **1,788 行测试代码** |

## 平台集成

### Host 侧客户端

`src/lib/container/luminGatewayClient.ts` 提供两种通信模式：

1. **WebSocket 模式** (`sendLuminMessage`) — 连接 `ws://<host>:3001/v1/stream`，实时流式事件
2. **Embedded 模式** (`sendLuminEmbeddedMessage`) — `docker exec` / `kubectl exec` 回退

两种模式都正确映射 Lumin 事件到 `StreamEvent` 类型：
- `tool.start` → `tool_start` (含 toolId/args)
- `tool.end` → `tool_result` (含 toolId)
- `directive` → `tool_result` with `toolName: '__directive'`（Bridge 层重新提取为原生 directive 事件）

### K8s Warm Pool 支持

`src/lib/container/k8sWarmPool.ts` 通过 `prismer.runtime` label 区分 OpenClaw 和 Lumin pod：
- `createPoolPod()` 根据 runtime 选择镜像和端口（Lumin 额外暴露 3001）
- `claimIdlePod()` 按 runtime 过滤空闲 pod
- `ensurePoolSize()` 淘汰 runtime 不匹配的 pod

### 双运行时架构

数据库 `AGENT_RUNTIME` 字段（`openclaw` | `lumin`）控制运行时选择。Bridge API 自动检测并路由到对应的 Gateway Client。两个运行时共享：
- 消息持久化代码路径
- Workspace context 注入
- Cloud IM directive 投递

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENAI_API_BASE_URL` | `http://localhost:3000/v1` | LLM API 地址 |
| `OPENAI_API_KEY` | — | LLM API Key |
| `AGENT_DEFAULT_MODEL` | `us-kimi-k2.5` | 默认模型 |
| `MODEL_FALLBACK_CHAIN` | — | 逗号分隔的 fallback 模型列表 |
| `WORKSPACE_DIR` | `/workspace` | 工作目录 |
| `PRISMER_PLUGIN_PATH` | `/opt/prismer/.../tools.js` | 工具插件路径 |
| `LUMIN_PORT` | `3001` | 网关端口 |
| `PRISMER_API_BASE_URL` | `http://host.docker.internal:3000` | Prismer API 地址 |
| `AGENT_ID` | `default` | Agent 实例 ID |
| `WORKSPACE_ID` | — | Workspace ID |
| `PRISMER_IM_BASE_URL` | — | Cloud IM 基础 URL |
| `PRISMER_IM_CONVERSATION_ID` | — | Cloud IM 对话 ID |
| `PRISMER_IM_TOKEN` | — | Cloud IM 认证 Token |
| `MAX_CONTEXT_CHARS` | `600000` | 上下文字符预算 (~150K tokens) |

## Docker

```bash
# 构建独立 Lumin 镜像（基于 C1，无 OpenClaw）
cd docker/ && docker build -f Dockerfile.lumin \
  --build-arg BASE_IMAGE=docker.prismer.dev/prismer-academic:v5.1-lite \
  -t prismer-workspace:lumin .

# 运行
docker run -d -p 3000:3000 -p 3001:3001 \
  -e OPENAI_API_BASE_URL=http://34.60.178.0:3000/v1 \
  -e OPENAI_API_KEY=sk-xxx \
  prismer-workspace:lumin
```

**重要:** 修改 `src/` 后需先本地编译 `npx tsc`，再 `docker build`。Dockerfile 会 COPY `dist/`，不会在构建时重新编译已存在的 dist。
