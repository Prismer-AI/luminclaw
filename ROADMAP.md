# Prismer Agent Core — 自研 Roadmap

> **Status:** Phase 3 + 平台集成完成 (4,665 LOC) — 全能力对齐 OpenClaw + 平台集成层完备
> **前置文档:** `FRAMEWORK_ANALYSIS.md` (五框架对比), `AGENT_CORE_DESIGN.md` (技术设计 + 七大核心能力)
> **目标产物:** `@prismer/agent-core` npm 包 — TypeScript, Schema-Driven (Zod)
>
> ## 重要变更：学术能力已模块化
>
> 学术工具（LaTeX、Jupyter、PDF、数据分析等 40+ 工具）已在 `prismer-workspace` 插件中模块化实现：
> - `docker/plugin/prismer-workspace/src/tools.ts` — 工具定义 + 执行器 (4300+ 行)
> - `docker/plugin/prismer-workspace/src/modules.ts` — 模块分组 (TOOL_MODULES)
> - `src/lib/modules/catalog.ts` — 8 个 tech modules, lite/full presets
> - `src/app/api/workspace/[id]/modules/` — 模块安装 API
>
> **因此 Agent-core 是纯运行时，不包含工具实现。** 工具通过 `loadWorkspaceToolsFromPlugin()` 动态加载。
>
> ### Phase 进度
>
> | Phase | 状态 | 说明 | LOC |
> |-------|------|------|-----|
> | P0 | **跳过** | AgentTransport 适配层 — 后续集成时做 | — |
> | P1 | **✅ 完成** | Agent Loop + SSE EventBus + Sub-Agent | 2,635 |
> | P1.5 | **✅ 完成** | CLI + HTTP/WS 网关 + 真实 LLM 验证 | 2,635 |
> | P2 | **✅ 完成** | OpenClaw 能力集成 — PromptBuilder + Cloud IM + Skills + Fallback | 3,349 |
> | P2 | **✅ 跳过** | Workspace 中间件 + 工具 — 已由模块系统覆盖 | — |
> | P3 | **✅ 完成** | Context Engineering + Memory + Compaction + Hooks | 3,873 |
> | P4 | **✅ 完成** | Cloud SDK + Skills + ClawHub + Channels (Cloud IM + Telegram) | 4,665 |
> | P4.5 | **✅ 完成** | **平台集成层** — Directive 投递 + Tool ID 配对 + K8s Warm Pool | +130 (host 侧) |
> | P5 | **下一步** | Host 侧 AgentTransport + 容器镜像 + 集成测试 | |
> | P6 | 部分完成 | 生产加固: FallbackProvider ✅, 上下文守卫 ✅, 工具压缩 ✅ | |
> | P7 | 待定 | 清理 OpenClaw | |

---

## 核心理念

**不重复造轮子，而是只造我们需要的那部分轮子。**

分析五个框架后发现：
- 核心 Agent Loop (LLM → Tool → Response) 只需 **~100 LOC**
- OpenClaw 用 3600 LOC 做这件事是因为它要解决通用平台的问题（160 次重试、36+ Channel、40+ 插件）
- OpenCode 用 5750 LOC 做这件事是因为它要支持 20+ Provider、30+ 工具、5+ Agent 类型
- Prismer 只需要 1:1 workspace 场景，但需要 **专业化的学术 Sub-Agent**
- **Cloud SDK v1.7 已经提供了丰富的 Agent 基础设施**，不需要从零开始
- **OpenCode 的 Sub-Agent 模式** (primary/subagent/hidden + delegate 工具) 值得完整移植

---

## 已完成 Phase 详情

### Phase 1: Agent Loop + SSE 实时推送 ✅

核心循环 + Sub-Agent 编排 + EventBus 实时推送 + doom-loop 检测。

**交付物:** agent.ts, agents.ts, provider.ts, tools.ts, sse.ts, observer.ts, ipc.ts, session.ts

### Phase 1.5: CLI + HTTP/WS 网关 ✅

完整的 CLI 工具 + HTTP 同步 API + WebSocket 实时流式 + 真实 LLM 验证。

**交付物:** cli.ts, server.ts + 8 个 LLM 集成测试

### Phase 2: OpenClaw 能力集成 ✅

PromptBuilder (动态 system prompt) + Cloud IM 凭证注入 + Skills 系统 + FallbackProvider + 上下文守卫 + 工具输出压缩。

**交付物:** prompt.ts, skills.ts, tools/loader.ts, workspace.ts + 工具插件加载

### Phase 3: Context Engineering + Memory + Compaction + Hooks ✅

上下文溢出检测 → memory flush（提取事实） → LLM 摘要压缩 → 注入摘要对。关键词记忆存储 + 生命周期钩子。

**交付物:** compaction.ts, memory.ts, hooks.ts

### Phase 4: Cloud SDK + Skills + Channels ✅

Skill 自安装 (ClawHub CLI) + workspace 自定义 (SOUL.md/IDENTITY.md) + Channel Plugin 系统 (Cloud IM + Telegram) + Channel Manager。

**交付物:** tools/clawhub.ts, channels/manager.ts, channels/cloud-im.ts, channels/telegram.ts, channels/types.ts

### Phase 4.5: 平台集成层 ✅

**问题:** Lumin 核心能力已完全对齐 OpenClaw，但平台集成层存在 3 个 gap：
1. Directive 到不了前端（WindowView 不切换/不更新）
2. Tool ID 不配对（前端工具调用状态错乱）
3. K8s 预热池不支持 Lumin 镜像

**修复 (8 文件, ~130 LOC):**

| 改动 | 文件 | 说明 |
|------|------|------|
| Directive 文件扫描 | `agent.ts` | 工具执行后扫描 `/workspace/.openclaw/directives/`，发布到 EventBus |
| Tool ID + Args | `agent.ts`, `sse.ts`, `server.ts` | bus.publish/WS 转发含 toolId/args |
| Bridge directive 提取 | `bridge/[workspaceId]/route.ts` | 拦截 `__directive` → 重发为原生 directive SSE |
| 前端 directive handler | `useContainerChat.ts` | `case 'directive'` → mapPluginDirective → executeDirective |
| Client 接口更新 | `luminGatewayClient.ts` | toolId/args 映射 + embedded 模式 directive 提取 |
| K8s Warm Pool | `k8sWarmPool.ts` | runtime label/过滤/端口/淘汰逻辑 |

**验证结果:**
- Tool ID 配对: `update_notes:0` start/end 完美匹配 ✓
- Directive 投递: `SWITCH_COMPONENT` + `UPDATE_NOTES` 实时到达 WS 流 ✓

---

## 待完成 Phase

### Phase 5: Host 侧 AgentTransport + npm 包

**目标:** 实现 Phase 0 的 `AgentTransport` 接口 + 打包为 `@prismer/agent-core` npm 包。

**当前状态:** Lumin 已通过 `luminGatewayClient.ts` 在 host 侧完全可用，但尚未抽象为统一的 AgentTransport 接口。

### Phase 6: 生产加固

**已完成部分:**
- FallbackProvider (model chain) ✅
- 上下文守卫 (MAX_CONTEXT_CHARS) ✅
- 工具输出压缩 (150K char limit) ✅
- Doom-loop 检测 (3 次连续错误) ✅
- Memory flush before compaction ✅
- Orphaned tool result repair ✅

**待完成:**
- Approval Gate (敏感工具人工确认)
- 背压控制 (SSE 队列溢出检测)

### Phase 7: 清理 OpenClaw

**前提:** Phase 5 验证矩阵全部通过，生产环境运行稳定。

**清理清单:**
- [ ] 移除 `src/lib/container/openclawGatewayClient.ts` (475 LOC)
- [ ] 移除 OpenClaw config deploy 代码
- [ ] 更新容器镜像: 移除 OpenClaw runtime
- [ ] 更新文档

---

## 能力-Phase 交叉矩阵

| 核心能力 | P1 | P2 | P3 | P4 | P4.5 | P5 | P6 |
|---------|-----|-----|-----|-----|------|-----|-----|
| Agent Loop + Sub-Agent | **✅** | | | | | 集成验证 | |
| 文件系统中间件 | | **✅** | | | | | |
| UI Directive | | **✅** | | | **✅ 端到端** | | |
| Skill 扩展 + ClawHub | | | | **✅** | | | |
| Context Engineering | | | **✅** | | | | |
| Memory Recall | | | **✅** | | | | |
| SSE 实时推送 | **✅** | | | | **✅ toolId** | | 背压 |
| Compaction + Memory Flush | | | **✅** | | | | |
| Lifecycle Hooks | | | **✅** | | | | |
| Channel Plugins | | | | **✅** | | | |
| Directive Scanner | | | | | **✅** | | |
| Tool ID/Args 配对 | | | | | **✅** | | |
| K8s Warm Pool | | | | | **✅** | | |

---

## LOC 总览 (当前)

| 模块 | LOC | Phase |
|------|-----|-------|
| agent.ts | 592 | P1 + P3 + P4.5 |
| server.ts | 492 | P1.5 + P4.5 |
| provider.ts | 378 | P1 + P2 |
| index.ts | 366 | P1 + P2 |
| tools/clawhub.ts | 240 | P4 |
| prompt.ts | 235 | P2 |
| cli.ts | 193 | P1.5 |
| skills.ts | 178 | P2 |
| channels/cloud-im.ts | 177 | P4 |
| channels/telegram.ts | 171 | P4 |
| tools/loader.ts | 159 | P2 |
| workspace.ts | 154 | P2 |
| agents.ts | 149 | P1 |
| sse.ts | 144 | P1 + P4.5 |
| compaction.ts | 141 | P3 |
| session.ts | 138 | P1 + P3 |
| memory.ts | 118 | P3 |
| observer.ts | 115 | P1 |
| ipc.ts | 109 | P1 |
| hooks.ts | 99 | P3 |
| tools.ts | 96 | P1 |
| channels/manager.ts | 87 | P4 |
| directives.ts | 70 | P2 |
| channels/types.ts | 34 | P4 |
| tools/index.ts | 16 | P1 |
| schemas.ts | 14 | P1 |
| **自研合计** | **4,665** | **P1-P4.5** |
| 测试代码 | 1,788 | 113 test cases |

**对比:** OpenClaw ~892K LOC → Lumin 4,665 LOC (**0.52%** of OpenClaw, 功能对齐)
