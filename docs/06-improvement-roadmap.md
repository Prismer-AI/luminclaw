# LuminClaw 改进路线图：从 CC 架构中汲取的经验

> 综合前五篇分析文档，按优先级和实施难度排列的具体改进建议。
> 
> **最近更新**：2026-03-31 — Phase 0/1/2 已全部实施并通过测试。

## 执行摘要

通过深入分析 Claude Code 源码（约 50 万行 TypeScript），我们识别出 LuminClaw 在以下五个维度的改进空间：

| 维度 | 改进前 | 改进后 | 状态 |
|------|--------|--------|------|
| Agent Loop | 简单 while + 错误终止 | LoopState 对象 + 2 路 recovery | **已完成** |
| 工具编排 | 全部 Promise.all | 读写分区（concurrent/serial） | **已完成** |
| 上下文管理 | 单层截断 | 三层递进（microcompact → truncate → compaction） | **已完成** |
| 多 Agent | delegate 无隔离 | 工具过滤 + 递归深度限制 | **已完成** |
| Hook/权限 | 4 Hook 无超时 | 4 Hook + 30s 超时保护 | **已完成** |
| 流式交叉 | API 完成后才执行工具 | — | 待实施 |
| AbortController | 无取消链 | — | 待实施 |
| Coordinator | 无编排模式 | — | 待实施 |

---

## Phase 0: 紧急修复 — **已完成**

### 0.1 子 Agent 递归保护

**文件**：`src/agent.ts`, `src/tools.ts`

**实施内容**：
- `ToolRegistry.withFilter(predicate)` — 创建过滤后的工具注册表视图
- `delegateToSubAgent()` 中过滤掉 `delegate` 工具，防止子 agent 递归委托
- `_depth` 参数追踪递归深度，`MAX_SUBAGENT_DEPTH=5` 自动停止
- 深度超限时返回明确错误信息而非无限循环

```typescript
// 实际代码 — agent.ts:delegateToSubAgent()
const filteredTools = this.tools.withFilter(name => name !== 'delegate');
const subAgent = new PrismerAgent({
    ...options,
    tools: filteredTools,
    _depth: this.depth + 1,
});
```

**测试**：`tests/agent-v2.test.ts` — 递归保护 + 深度限制测试通过。

### 0.2 Hook 超时保护

**文件**：`src/hooks.ts`

**实施内容**：
- `withTimeout(promise, ms, fallback)` 辅助函数包装所有 hook 执行
- 默认 30s 超时（可通过 `HookRegistry` 构造函数配置）
- 超时后 fallback 到安全默认值（允许执行），不会阻塞 agent loop
- 异常也被静默处理（与原有行为一致）

```typescript
// 实际代码 — hooks.ts
function withTimeout<T>(promise: Promise<T> | T, ms: number, fallback: T): Promise<T> {
    if (!(promise instanceof Promise)) return Promise.resolve(promise);
    return Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
}
```

**测试**：原有 `tests/hooks.test.ts` 全部通过（行为向后兼容）。

---

## Phase 1: 核心循环强化 — **已完成**

### 1.1 LoopState 对象 + Transition 追踪

**文件**：`src/agent.ts`

**实施内容**：
- `LoopState` 接口收束所有循环状态为单一对象
- `Transition` 接口记录每次 continue 的原因（`next_turn` / `reactive_compact` / `output_recovery`）
- 所有 recovery 站点通过 `state = { ...state, transition: {...} }; continue;` 显式重写状态

```typescript
// 实际类型定义
interface LoopState {
    messages: Message[];
    iteration: number;
    consecutiveErrors: number;
    recentToolSigs: string[];
    totalUsage: { promptTokens: number; completionTokens: number };
    lastText: string;
    lastThinking?: string;
    hasAttemptedReactiveCompact: boolean;
    outputRecoveryCount: number;
    transition?: Transition;
}

interface Transition {
    reason: 'next_turn' | 'reactive_compact' | 'output_recovery' | 'model_fallback';
    detail?: unknown;
}
```

### 1.2 Recovery 路径

**实施内容**：

| Recovery | 触发条件 | 恢复动作 | Guard |
|----------|---------|---------|-------|
| **Reactive Compact** | LLM 返回 prompt-too-long / 413 | 压缩前半部分消息 + memory flush + 重试 | 一次性（`hasAttemptedReactiveCompact`） |
| **Output Recovery** | `finish_reason: 'length'` | 注入 "Please continue" 消息 + 重试 | 最多 3 次（`outputRecoveryCount`） |

```typescript
// Reactive compact — agent.ts catch block
if (isPromptTooLong(err) && !state.hasAttemptedReactiveCompact) {
    const toCompact = allButSystem.slice(0, halfIdx);
    const compacted = await compactConversation(this.provider, toCompact, this.model);
    session.compactionSummary = compacted.summary;
    state = { ...state, hasAttemptedReactiveCompact: true,
              messages: [system, summaryPair, ...kept],
              transition: { reason: 'reactive_compact' } };
    continue;
}

// Output recovery — after no-tool-call response
if (response.finishReason === 'length' && state.outputRecoveryCount < 3) {
    messages.push({ role: 'user', content: 'Please continue from where you left off.' });
    state = { ...state, outputRecoveryCount: state.outputRecoveryCount + 1,
              transition: { reason: 'output_recovery' } };
    continue;
}
```

**测试**：`tests/agent-v2.test.ts` — PTL recovery + fallback 失败测试通过。

### 1.3 工具读写分区

**文件**：`src/tools.ts` (接口), `src/agent.ts` (执行)

**实施内容**：
- `Tool.isConcurrencySafe?(args)` 可选方法 — 工具自声明并发安全性
- `partitionToolCalls()` — 将工具调用分区为连续并发批次和串行批次
- `executeToolsPartitioned()` — 并发批次用 `Promise.all`，串行批次逐个执行
- 未实现 `isConcurrencySafe` 的工具默认串行（安全保守）

```
输入: [Read, Read, Edit, Grep, Grep, Write]
分区: Batch1(concurrent: [Read,Read]) → Batch2(serial: [Edit]) → Batch3(concurrent: [Grep,Grep]) → Batch4(serial: [Write])
```

**测试**：
- 并发工具验证 — 两个 read 工具同时启动（`read_a_start` 在 `read_a_end` 前出现）
- 串行工具验证 — write_a 完成后 write_b 才启动
- 默认行为验证 — 无 `isConcurrencySafe` 的工具串行执行

---

## Phase 2: 上下文管理升级 — **已完成**

### 2.1 Microcompact（零 LLM 成本）

**文件**：新建 `src/microcompact.ts`

**实施内容**：
- `microcompact(messages, keepRecent=5)` — 清除旧工具结果，保留最近 N 个
- `CLEARED_MARKER = '[Old tool result cleared]'` — 标记已清除的结果
- 已清除的结果不会被重复清除
- 在 agent loop 中每次 LLM 调用前自动执行（Layer 1）

**集成位置**：`agent.ts` 主循环，LLM 调用前：
```typescript
while (state.iteration++ < this.maxIterations) {
    // Layer 1: Microcompact — clear old tool results (zero LLM cost)
    microcompact(state.messages, 5);
    // Layer 2: Context window guard with auto-compaction
    // Layer 3: LLM call...
}
```

**测试**：`tests/microcompact.test.ts` — 6 测试覆盖正常清除、边界条件、已清除跳过。

### 2.2 结构化摘要提示

**文件**：`src/compaction.ts`

**实施内容**：
- 替换通用摘要提示为 6 段结构化提示：
  1. Primary Request — 用户原始目标
  2. Key Files & Code — 文件路径 + 精确代码片段
  3. Decisions Made — 技术决策及理由
  4. Errors & Fixes — 错误与修复
  5. Current State — 当前工作状态
  6. Pending Work — 未完成任务
- `maxTokens` 从 2000 提升到 4000
- 关键约束：`CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`
- 强调代码片段必须保留原文，不得改写

**测试**：原有 `tests/compaction.test.ts` 全部通过。

### 2.3 Token 估算

**文件**：新建 `src/tokens.ts`

**实施内容**：
- `estimateTokens(text)` — 轻量级 CJK 感知 token 估算
  - 英文：~4 chars/token
  - CJK：~2 chars/token
  - 1.33x 安全系数
- `estimateMessageTokens(messages)` — 消息数组 token 估算（含每条消息 4 token 开销）
- 集成到 Observer 日志中：`[llm_request] {..., estimatedTokens: 406}`

**测试**：`tests/tokens.test.ts` — 12 测试覆盖空值、英文、CJK、混合文本。

### 2.4 finishReason 解析

**文件**：`src/provider.ts`

**实施内容**：
- `ChatResponse.finishReason` 新字段
- `parseResponse()` 从非流式响应提取 `choice.finish_reason`
- `chatStream()` 从流式 SSE 事件提取 `finish_reason`
- 供 agent loop 的 output recovery 使用

---

## Phase 3: 多 Agent 改进 — 待实施

### 3.1 AbortController 链

**文件**：`src/agent.ts`

```typescript
interface AgentOptions {
    // ... 现有字段
    abortSignal?: AbortSignal
}

// delegateToSubAgent 中创建子 AbortController
const childAbort = new AbortController()
if (this.abortSignal) {
    this.abortSignal.addEventListener('abort', () => childAbort.abort())
}
```

**价值**：父 agent 取消时，子 agent 也能立即停止，避免资源浪费。

### 3.2 后台 Agent 执行

**文件**：`src/agent.ts` + `src/server.ts`

支持非阻塞的子 agent 执行，结果通过 EventBus 通知。当前所有子 agent 都是前台阻塞的。

### 3.3 Agent 上下文隔离

为子 agent 创建隔离的工具上下文（文件缓存、权限上下文），防止状态泄漏。参考 CC 的 `createSubagentContext()` 模式。

---

## Phase 4: 流式与 Hook 增强 — 待实施

### 4.1 AsyncGenerator 改造

将 `processMessage` 改为 `async *processMessage`，使事件可以在循环中间 yield 出来，上层直接 `for await` 消费，不完全依赖 EventBus 旁路。

### 4.2 流式工具交叉（StreamingToolExecutor）

修改 Provider 接口支持 `onToolUse` 回调，在 API 流式返回过程中一旦解析到完整的 tool_use block 就立即开始执行，而非等流完成后才执行。

时间线对比：
```
当前:   [API streaming...................complete] → [tool1+tool2 执行]
目标:   [API streaming...tool1 parsed] → [tool1 exec] → [more stream...tool2] → [tool2 exec]
```

### 4.3 Command Hook + 会话级 Hook

扩展 HookRegistry 支持 Shell 命令 Hook（CI/CD 集成）和按会话注册（Skill/Agent 自带 Hook 随生命周期自动清理）。

### 4.4 权限模式分级

`strict` / `standard` / `permissive` 三级权限，适配从开发到生产的不同部署场景。

---

## 优先级矩阵（更新后）

```
                    影响大
                     |
  [已完成] Phase 0   |  [已完成] Phase 1
  (递归保护,          |  (LoopState,
   Hook 超时)         |   Recovery,
                     |   读写分区)
  ───────────────────+───────────────── 实施难度大
                     |
  [已完成] Phase 2   |  [待实施] Phase 3-4
  (Microcompact,     |  (AsyncGenerator,
   结构化摘要,        |   Coordinator,
   Token 估算)       |   流式交叉)
                     |
                    影响小
```

---

## 实施总结

### 已完成（2026-03-31）

| 改进项 | 文件 | 测试 |
|-------|------|------|
| 子 Agent 递归保护 | `agent.ts`, `tools.ts` | `agent-v2.test.ts` |
| Hook 超时保护 | `hooks.ts` | `hooks.test.ts` |
| LoopState 对象 | `agent.ts` | `agent-v2.test.ts` |
| Reactive Compact Recovery | `agent.ts` | `agent-v2.test.ts` |
| Output Truncation Recovery | `agent.ts`, `provider.ts` | — (finishReason 解析已实现) |
| 工具读写分区 | `tools.ts`, `agent.ts` | `agent-v2.test.ts` |
| Microcompact | **新** `microcompact.ts` | **新** `microcompact.test.ts` |
| 结构化摘要 | `compaction.ts` | `compaction.test.ts` |
| Token 估算 | **新** `tokens.ts` | **新** `tokens.test.ts` |
| finishReason 解析 | `provider.ts` | `provider.test.ts` |

### 新文件
- `src/tokens.ts` — 轻量级 CJK 感知 token 估算
- `src/microcompact.ts` — 零 LLM 成本增量上下文压缩
- `tests/tokens.test.ts` — 12 tests
- `tests/microcompact.test.ts` — 6 tests
- `tests/agent-v2.test.ts` — 11 tests

### 测试结果
- **Unit tests**: 23 files, 331 tests, all pass
- **Real LLM integration** (us-kimi-k2.5 via gateway): 8 tests, all pass

### 下一步建议

1. **Phase 3.1 AbortController** — 最高优先级，子 agent 取消是用户体验问题
2. **Phase 4.2 流式工具交叉** — 最高技术 ROI，但需要重构 Provider 接口
3. **Phase 4.1 AsyncGenerator** — 可与 4.2 一起实施，解耦事件流与 EventBus

---

## CC 架构的核心设计哲学

从 CC 源码中我们提炼出以下设计哲学，已部分贯彻到 LuminClaw：

### 1. "永远不轻易放弃" — **已部分实现**
CC 有 7 个 recovery 路径。LuminClaw 现在有 2 个（reactive compact + output recovery），覆盖了最常见的运行时故障。未来可增加模型回退（已有 FallbackProvider 支持）。

### 2. "流式优先" — 待实施
CC 的 AsyncGenerator 模式使事件在产生时就能流出。LuminClaw 仍依赖 EventBus 作为唯一的流式通道，Phase 4.1 将改变这一点。

### 3. "显式状态" — **已实现**
LoopState 对象 + Transition 字段使每次循环的 why 和 what 都可追踪。

### 4. "读写分离" — **已实现**
`Tool.isConcurrencySafe` 接口 + `partitionToolCalls()` 算法，工具自声明并发安全性，读写自动分离。

### 5. "渐进式压力释放" — **已实现**
三层上下文管理：Microcompact（零成本持续运行）→ Truncate + Compaction（按需高成本）→ 未来可增加 API-native（基础设施级）。

### 6. "隔离是安全的基础" — **已部分实现**
子 agent 已有工具过滤和递归深度限制。下一步是 AbortController 链和上下文状态隔离。

---

## 文档索引

| # | 文档 | 主题 |
|---|------|------|
| 01 | [agent-loop-analysis](./01-agent-loop-analysis.md) | Dual Loop、State 对象、Recovery 路径 |
| 02 | [tool-orchestration-analysis](./02-tool-orchestration-analysis.md) | 工具并发、读写分区、StreamingToolExecutor |
| 03 | [context-management-analysis](./03-context-management-analysis.md) | 三层 Compaction、Microcompact、Token 估算 |
| 04 | [multi-agent-analysis](./04-multi-agent-analysis.md) | 四种 Agent 模式、隔离、Prompt Cache |
| 05 | [hooks-permissions-analysis](./05-hooks-permissions-analysis.md) | Hook 类型、权限分级、Bash 安全 |
| 06 | [improvement-roadmap](./06-improvement-roadmap.md) | 本文：优先级路线图 + 实施记录 |
