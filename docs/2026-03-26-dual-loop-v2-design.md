# Dual Loop V2 — 长程智能体架构设计

> **状态**: 设计草案 v2 (审查后修订)
> **日期**: 2026-03-26
> **基于**: Agent Loop UX 设计文档 + Cloud SDK v1.7.2 能力审计
> **核心目标**:
> 1. 长程智能体的稳定性、鲁棒性和全生命周期可观测性
> 2. Agent 自我进化 — 避免反复犯同类错、节省 token
> 3. 人类交互时钟周期与形式对齐

---

## 1. 现状问题的根源分析

当前 Dual Loop 的问题不在于单次执行能力，而在于 **三个时间尺度上的断裂**：

| 时间尺度 | 现状 | 问题 |
|---------|------|------|
| **秒级** (一次 tool call) | EventBus 内存事件流 | 容器重启即丢失；前端重连无法恢复 |
| **分钟级** (一次任务) | InMemoryTaskStore | 无持久化；无跨容器复用；WorldModel 只在单次任务内存活 |
| **天级** (跨任务学习) | FileMemoryBackend (关键词搜索) | 没有结构化的"什么行/什么不行"；同类错误重复发生 |

Cloud SDK 恰好提供了覆盖这三个尺度的基础设施：

```
秒级 → Cloud IM (持久消息 + 实时推送)
分钟级 → Task Marketplace (状态机 + 服务端持久化)
天级 → Evolution Runtime (基因 + 贝叶斯信号匹配)
```

---

## 2. 架构总览

```
                    ┌─────────────────────────────────┐
                    │         Human / Frontend         │
                    │   (LuminPulse / 任意 IM 客户端)   │
                    └────────────┬────────────────────┘
                                 │ Cloud IM (WS/SSE)
                    ┌────────────▼────────────────────┐
                    │       Cloud IM Server            │
                    │  (消息持久化 + 路由 + 离线队列)     │
                    └────────────┬────────────────────┘
                                 │
              ┌──────────────────▼──────────────────────┐
              │           Orchestrator (HIL)             │
              │                                         │
              │  ┌──────────┐ ┌──────────┐ ┌──────────┐│
              │  │  Plan    │ │ World    │ │Evolution ││
              │  │  (markdown│ │ Model    │ │ Runtime  ││
              │  │   steps) │ │(黑板)    │ │(基因库)  ││
              │  └────┬─────┘ └────┬─────┘ └────┬─────┘│
              │       │            │             │      │
              │  ┌────▼────────────▼─────────────▼────┐│
              │  │       Sequential Executor           ││
              │  │  (逐步执行 + 步间 checkpoint)        ││
              │  └──────────────┬──────────────────────┘│
              └────────────────│────────────────────────┘
                               │
              ┌────────────────▼────────────────────────┐
              │           AgentAdapter                   │
              │  (Local PrismerAgent / Cloud IM Agent)   │
              └─────────────────────────────────────────┘
```

### 2.1 三层通信模型

```
层 1: Cloud IM (跨容器、可恢复、人类可见)
  ├── 人 → Agent 消息
  ├── Agent → 人 回复
  ├── Agent → Agent 协作消息
  ├── Checkpoint 消息 (带结构化 metadata)
  └── System events (状态变更通知)

层 2: EventBus (容器内、低延迟、高频)
  ├── text.delta (逐 token)
  ├── thinking.delta (推理过程)
  ├── tool.start / tool.end / tool.progress
  ├── iteration.start
  └── 所有实时 UX 事件

层 3: Memory + Evolution (跨会话、持久)
  ├── MemoryStore (事实、决策记录)
  ├── Gene Database (错误模式 → 修复策略)
  └── WorldModel snapshots (via Cloud Memory API)
```

**关键设计**: 层 2 事件 **异步镜像** 到层 1。EventBus 保证容器内低延迟，
Cloud IM 保证持久化和可恢复性。前端优先读 EventBus（快），fallback 读 IM 历史（恢复）。

**降级原则**: Cloud IM 是**可选增强层**，不是核心依赖。无 Cloud IM 时 agent 正常运行（EventBus + 本地文件），只是失去跨容器恢复能力。`PersistenceAdapter` 接口抽象持久化，Cloud IM 和本地文件系统各是一个实现。

---

## 3. 核心设计：三个问题的解决方案

### 3.1 稳定性、鲁棒性、全生命周期可观测性

#### 3.1.1 Checkpoint-Resume 机制

长程任务的核心问题：**容器可能随时崩溃/重启/被调度走**。

```
任务开始
  │
  ▼
[Checkpoint 0] ─── 保存到 Cloud IM + Memory API
  │                 {messages(compacted), worldModel, iteration: 0}
  ▼
tool.start → tool.end → ...
  │
  ▼
[Checkpoint 1] ─── 每 N 次 tool call 或每 T 秒
  │                 {messages(compacted), worldModel, iteration: 5}
  ▼
  ✕ 容器崩溃

  ... 新容器启动 ...

  ▼
[Resume] ─── 从 Cloud IM 读最后一个 Checkpoint 消息
  │           恢复 messages + WorldModel + 进度
  ▼
继续从 iteration 6 执行 (语义漂移不可避免，但可接受)
```

**Checkpoint 必须包含完整 messages**（compacted 版本），不只是 WorldModel。
LLM 的真实状态是对话上下文，丢失后恢复的 agent 行为会发生语义漂移。

**Resume 决策阈值**: 如果 checkpoint 的进度 < 30%，直接从头重跑比恢复更可靠。
只有进度 > 30% 时才从 checkpoint 恢复。

```typescript
interface CheckpointMessage {
  type: 'system_event';
  metadata: {
    'prismer.type': 'AGENT_CHECKPOINT',
    'prismer.taskId': string,
    'prismer.iteration': number,
    'prismer.maxIterations': number,
    'prismer.messages': string,        // compacted messages JSON
    'prismer.worldModel': string,
    'prismer.toolHistory': string[],
    'prismer.tokensBurned': number,    // 已消耗 token 数
  };
}
```

恢复流程:
```typescript
const lastCheckpoint = await loadLastCheckpoint(conversationId);
if (lastCheckpoint) {
  const progress = lastCheckpoint.iteration / lastCheckpoint.maxIterations;
  if (progress > 0.3) {
    // 恢复: 重建 messages + WorldModel
    messages = JSON.parse(lastCheckpoint.messages);
    worldModel = JSON.parse(lastCheckpoint.worldModel);
    startIteration = lastCheckpoint.iteration + 1;
  } else {
    // 进度太少，从头开始更可靠
    log.info('checkpoint progress too low, restarting', { progress });
  }
}
```

#### 3.1.2 Heartbeat + Deadman Switch

```
Agent 容器 ──── heartbeat (每 10s) ──── Cloud IM Server
                                            │
                                            ├── 正常: 更新 presence
                                            └── 超时 30s: 标记 task 为 stale
                                                  │
                                                  ├── 通知前端: "Agent 可能已断开"
                                                  └── 触发重调度 (如果配置了 auto-restart)
```

**注意**: 用 `updatePresence('online')` 做心跳（语义正确），**不用** `startTyping()`。
typing indicator 只在 agent 真正生成文本时发送，否则人类会看到永久的"正在输入..."。

```typescript
// Agent 端 — heartbeat 用 presence
const heartbeat = setInterval(() => {
  client.im.realtime.updatePresence('online');
}, 10_000);

// Agent 端 — typing 只在真正生成时
bus.subscribe((event) => {
  if (event.type === 'text.delta') {
    client.im.realtime.startTyping(conversationId);
  }
});
```

#### 3.1.3 Token 预算机制

长程任务必须有成本约束，避免 agent 无限消耗 token。

```typescript
interface TokenBudget {
  maxTokens: number;          // 本次任务上限 (默认: 100K)
  burned: number;             // 已消耗
  warningThreshold: number;   // 告警阈值 (默认: 80%)
}

// 在 agent loop 中
if (totalUsage.promptTokens + totalUsage.completionTokens > budget.maxTokens * budget.warningThreshold) {
  bus.publish({ type: 'budget.warning', data: { used: burned, limit: budget.maxTokens } });
}
if (totalUsage.promptTokens + totalUsage.completionTokens > budget.maxTokens) {
  bus.publish({ type: 'human.input_needed', data: {
    reason: 'budget_exceeded',
    message: `已消耗 ${burned} tokens (上限 ${budget.maxTokens})，是否继续？`,
  }});
  // 暂停等待人类决策
}
```

#### 3.1.4 结构化生命周期事件

所有事件通过 Cloud IM 的 `metadata` 字段携带结构化信息：

```typescript
const LIFECYCLE_EVENTS = {
  // 任务级别
  'TASK_CREATED':     { human_label: '任务已创建', urgency: 'info' },
  'TASK_PLANNING':    { human_label: '正在规划...', urgency: 'info' },
  'TASK_EXECUTING':   { human_label: '开始执行', urgency: 'info' },
  'TASK_CHECKPOINT':  { human_label: '进度更新', urgency: 'low' },
  'TASK_COMPLETED':   { human_label: '任务完成', urgency: 'info' },
  'TASK_FAILED':      { human_label: '任务失败', urgency: 'high' },

  // Agent 级别
  'AGENT_THINKING':   { human_label: '正在思考...', urgency: 'low' },
  'AGENT_TOOL_USE':   { human_label: '使用工具', urgency: 'low' },
  'AGENT_QUESTION':   { human_label: '需要你的输入', urgency: 'high' },
  'AGENT_HANDOFF':    { human_label: '交接给另一个 Agent', urgency: 'info' },

  // 进化级别
  'EVOLUTION_GENE_APPLIED':  { human_label: '应用了历史修复策略', urgency: 'low' },
  'EVOLUTION_NEW_LEARNING':  { human_label: '学到了新经验', urgency: 'low' },

  // 成本
  'BUDGET_WARNING':   { human_label: 'Token 消耗接近上限', urgency: 'high' },
};
```

#### 3.1.5 降级策略

每个外部依赖都必须有明确的降级行为：

| 依赖 | 不可用时的行为 | 影响 |
|------|-------------|------|
| Cloud IM | 事件只走 EventBus，checkpoint 写本地文件 | 失去跨容器恢复 |
| Evolution Server | suggest() 返回 `{ action: 'none' }`，跳过 gene 注入 | 失去经验复用 |
| LLM Provider | 已有 FallbackProvider 处理 | 切换备用模型 |
| Memory API | 降级到 FileMemoryBackend | 失去云端同步 |

---

### 3.2 Agent 自我进化 — Gene-Guided Execution

#### 3.2.1 问题：Token 浪费的根源

观察到的模式：
1. Agent 写 Python 代码 → 用了不合适的 API → 审查指出 → 修改
2. 下一个任务：Agent 再次用同样的 API → 再次被纠正
3. 同样的错误重复 N 次 → 每次消耗 ~2000 tokens 纠正

**根因**: Agent 没有"什么做法是错的"的结构化记忆。keyword-based memory 能找到
"上次用了 X"但不知道为什么、什么条件下适用。

#### 3.2.2 Evolution Runtime 集成点

```
LLM 调用前                  LLM 调用后
    │                           │
    ▼                           ▼
┌──────────┐              ┌──────────┐
│ suggest()│              │ learned()│
│  ≤200ms  │              │  fire &  │
│  本地缓存│              │  forget  │
└──────────┘              └──────────┘
```

**关键约束**:
- `suggest()` 必须 **≤200ms 超时**，超时则跳过（不阻塞主循环）
- 优先命中本地缓存（EvolutionRuntime 的 `fromCache` 字段），避免网络调用
- `learned()` 是 fire-and-forget，不阻塞 tool 执行
- 冷启动时（无 gene）不调用 suggest()，避免无意义延迟

**基因中毒防护**: 一个 gene 连续 3 次应用后仍然失败 → 本地自动隔离，不再 suggest。
等待人类审查或 Bayesian 置信度自然衰减。

```typescript
// agent.ts 主循环 — LLM 调用前
if (lastToolErrors.length > 0 && evolution) {
  try {
    const suggestion = await Promise.race([
      evolution.suggest(lastToolErrors.join('\n'), { signals: extractSignals(lastToolErrors) }),
      new Promise<null>(r => setTimeout(() => r(null), 200)),  // 200ms 硬超时
    ]);
    if (suggestion?.action === 'apply_gene' && suggestion.strategy) {
      // 合并到 system prompt 的固定 section，不是追加 message
      evolutionSection = `## 历史经验\n${suggestion.strategy}\n(置信度: ${Math.round(suggestion.confidence * 100)}%)`;
      appliedGeneId = suggestion.geneId;
    }
  } catch {
    // Evolution 不可用 — 静默跳过
  }
}

// tool 执行后 — fire and forget
if (toolResult.error) {
  evolution?.learned(toolResult.error, 'failure',
    `Tool ${call.name} failed: ${toolResult.error.slice(0, 200)}`,
    appliedGeneId);
} else {
  evolution?.learned(null, 'success',
    `Tool ${call.name} succeeded`, appliedGeneId);
}
```

**Gene hint 注入方式**: 合并到 system prompt 的一个固定 section（通过 `PromptBuilder.addSection`），
每次 LLM 调用前重建。不用 `messages.push(Message.system(...))`，避免消息膨胀和多 gene 互相矛盾。

#### 3.2.3 Signal 提取

从 tool 错误中提取结构化信号，用于 gene 匹配：

```typescript
function extractSignals(errors: string[]): SignalTag[] {
  const signals: SignalTag[] = [];
  for (const err of errors) {
    if (/ModuleNotFoundError/.test(err))
      signals.push({ type: 'error', provider: 'python', stage: 'import', severity: 'medium' });
    if (/SyntaxError/.test(err))
      signals.push({ type: 'error', provider: 'python', stage: 'parse', severity: 'high' });
    if (/command not found/.test(err))
      signals.push({ type: 'error', provider: 'bash', stage: 'exec', severity: 'medium' });
    if (/Permission denied/.test(err))
      signals.push({ type: 'error', provider: 'bash', stage: 'access', severity: 'high' });
    if (/Undefined control sequence/.test(err))
      signals.push({ type: 'error', provider: 'latex', stage: 'compile', severity: 'medium' });
  }
  return signals;
}
```

#### 3.2.4 Gene 生命周期

```
本地探索                      发布与共享
    │                             │
    ▼                             ▼
[Agent 犯错]              [Gene 成功率 > 80%]
    │                             │
    ▼                             ▼
[suggest() → 无匹配]       [agent 发布 gene]
    │                             │
    ▼                             ▼
[explore → LLM 生成修复]   [其他 agent 导入]
    │                             │
    ▼                             ▼
[record(outcome)]          [Bayesian 更新]
    │                             │
    ▼                             ▼
[本地 gene 创建]           [gene 被 fork/改进]
    │
    ▼
[多次使用后信心值上升]
    │
    ▼
[连续失败 3 次 → 自动隔离]
```

---

### 3.3 人类交互时钟周期对齐

#### 3.3.1 问题：Agent 时钟 ≠ 人类时钟

| Agent 内部状态 | 持续时间 | 人类感知 | 当前 UX |
|---------------|---------|---------|---------|
| 等待 LLM 回复 | 2-10s | 焦虑("在干嘛?") | "Responding" 静态文字 |
| 执行 5 个 tool calls | 5-30s | 无聊("怎么还没好?") | 5 行 "Running xxx" |
| 思考复杂问题 | 30-120s | 怀疑("是不是卡死了?") | 无反馈 |
| 完成任务 | 瞬间 | 意外("突然就好了?") | 一大段文字弹出 |

#### 3.3.2 对齐方案：三级时钟

```
┌─────────────────────────────────────────────────────────┐
│                    人类时钟周期                           │
│                                                         │
│  0-1s    1-5s      5-15s       15-30s      30s+        │
│  │       │         │           │           │           │
│  ▼       ▼         ▼           ▼           ▼           │
│  即时    短等待    中等等待     长等待      需要通知      │
│  反馈    有动画    有进度       有解释      可关注其他    │
│                                                         │
└─────────────────────────────────────────────────────────┘

级别 1: 亚秒级反馈 (EventBus → 前端直连)
  ├── presence: online → 前端知道 agent 存活
  ├── thinking.delta → 推理文字流式显示
  └── text.delta → 回复文字流式显示

级别 2: 5 秒级进度 (EventBus + Cloud IM checkpoint)
  ├── iteration.start → "Step 3/40"
  ├── tool.start/end → "✅ Write backtest.py (280 行)"
  ├── tool.progress → 进度条
  └── AGENT_CHECKPOINT → Cloud IM 持久化 (可恢复)

级别 3: 30 秒级摘要 (Cloud IM 消息)
  ├── 阶段性总结消息: "已完成数据获取，开始回测框架搭建"
  ├── 需要人类输入: "请确认回测时间范围: 2020-2024?"
  └── 错误报告: "API 密钥无效，请检查 .env"
```

#### 3.3.3 两种交互模式

| 模式 | 适用场景 | 消息频率 | 人类期望 |
|------|---------|---------|---------|
| **协作模式** (< 5 min) | 简单任务、需要频繁确认 | 每步一条消息 | 实时跟踪每个动作 |
| **托管模式** (> 5 min) | 复杂任务、人类去忙别的 | 只发关键节点 | 10 秒内了解"现在到哪了" |

协作模式 — IM 对话：
```
[User] 帮我写一个 US 股票回测系统

[Agent] 好的，我来规划一下。
执行计划 (3 步):
  1. 搭建项目结构
  2. 实现数据获取 + 回测引擎
  3. 添加性能分析模块

[Agent] 正在执行步骤 1...
  ✅ 创建 us_backtest/ 目录
  ✅ 写入 __init__.py (32 行)
  ⏳ 写入 data.py...

[Agent] 步骤 1 完成。已创建 4 个文件，共 420 行代码

[Agent] 执行步骤 2 时遇到问题:
yfinance 不在容器中，需要安装。
历史经验: 上次安装 yfinance 需要同时安装 pandas>=2.0
要继续安装吗？

[User] 继续

[Agent] ✅ 安装完成。继续步骤 2...
```

托管模式 — 只发关键节点：
```
[User] 帮我完成这个论文的数据分析和图表

[Agent] 收到，预计 10-15 分钟。开始执行。

  ... 5 分钟后 ...

[Agent] 进度: 60%。已完成统计分析，正在生成图表。

  ... 8 分钟后 ...

[Agent] 完成。生成了 6 张图表 + 3 个分析表格。
查看结果: [Notes] [Jupyter]
```

关键设计原则:
- **Agent 消息 = 人类可读的对话**，不是 JSON dump
- **每条消息有明确的"对话意图"**: 通知 / 提问 / 确认 / 汇报
- **错误 + 历史经验一起呈现**，让人类看到 Agent 在学习
- **长程任务不刷屏**，只在关键节点打扰人类

---

## 4. 多 Agent 编排

### 4.1 设计哲学：线性编排，不做 DAG

LLM 生成的任务分解天然不可靠——可能有循环依赖、遗漏步骤、或错误标记独立性。
用拓扑排序 + 并行调度来编排 LLM 生成的 DAG 是过度设计。

编排的核心是 **markdown plan + 逐步执行**，和人类程序员的工作方式一致：
写一个 plan，按步骤执行，每步结束后 review，根据结果调整下一步。

```typescript
// plan 就是一个 string[]，不需要 SubTask/dependsOn/DAG
const plan = [
  "1. 搭建项目结构 (mkdir, __init__.py)",
  "2. 实现数据获取模块 (yfinance API)",
  "3. 实现回测引擎 (Backtest class)",
  "4. 添加性能分析 (Sharpe, MaxDD)",
  "5. 编写测试用例",
];

// 逐步执行
for (const step of plan) {
  const result = await adapter.execute(step, handoffContext);
  worldModel.recordCompletion(result);

  // 步间 checkpoint — 持久化到 Cloud IM
  await saveCheckpoint({ plan, completedSteps, worldModel, messages });

  // 步间 evolution — 学习本步的经验
  if (result.errors.length > 0) {
    evolution?.learned(result.errors, 'partial_failure', step);
  }

  // 步间人类通知 — 阶段性摘要
  await notifyHuman(`步骤 ${i}/${plan.length} 完成: ${step}`);
}
```

### 4.2 AgentAdapter 接口

```typescript
interface AgentAdapter {
  readonly id: string;
  readonly type: 'local' | 'cloud-im';
  readonly capabilities: string[];

  execute(instruction: string, context: HandoffContext): Promise<AgentResult>;
  isAvailable(): Promise<boolean>;
  cancel(): void;
}

interface HandoffContext {
  worldModel: WorldModel;
  evolutionHints: string[];    // 来自 gene 的提示
  tokenBudget: TokenBudget;    // 剩余预算
}
```

### 4.3 Adapter 实现

```
LocalAgentAdapter
  └── 包装 PrismerAgent (single loop)
  └── 可配置: skills, tools, model
  └── 通信: EventBus (进程内)

CloudIMAgentAdapter
  └── 通过 Cloud IM 消息路由到远程 Agent
  └── 利用 SDK workspace.initGroup() 创建协作空间
  └── 通信: Cloud IM (跨容器)
```

### 4.4 部分失败处理

线性执行的好处：步骤 N 失败时，步骤 1..N-1 的成果已通过 checkpoint 持久化。

| 场景 | 处理 |
|------|------|
| 某步 tool 调用失败 | Agent 内部重试（已有 doom loop 检测） |
| 某步整体失败 | 保留已完成步骤的成果，通知人类决策：跳过/重试/终止 |
| Agent 崩溃 | 从最近 checkpoint 恢复，继续下一步 |
| Token 预算耗尽 | 暂停，保存进度，等人类追加预算 |

---

## 5. 数据流全景

```
Human Message
  │
  ▼
Cloud IM Server ──────────────────────────────────────────┐
  │                                                       │
  ▼                                                       │
Orchestrator                                              │
  │                                                       │
  ├─ 1. Plan 生成 (LLM → markdown steps)                  │
  │                                                       │
  ├─ 2. Evolution Pre-flight                              │
  │    └── suggest(context) → gene hints (≤200ms)         │
  │                                                       │
  ├─ 3. Sequential Execution                              │
  │    └── for each step:                                 │
  │         ├── AgentAdapter.execute(step, context)       │
  │         │     ├── EventBus: tool events (实时)        │
  │         │     └── Evolution: learned() (fire&forget)  │
  │         ├── Checkpoint → Cloud IM (持久化)             │
  │         ├── WorldModel.recordCompletion()             │
  │         └── 阶段性摘要 → Cloud IM (人类可见)           │
  │                                                       │
  ├─ 4. Result Assembly                                   │
  │    └── 合并所有步骤结果 → 结构化回复                    │
  │                                                       │
  └─ 5. Cloud IM: 发送最终回复 ──────────────────────────│
       └── 类型: markdown, 含 artifacts 引用               │
                                                          │
  Cloud IM Server ◄───────────────────────────────────────┘
  │
  ▼
Human (前端实时更新)
```

---

## 6. 实施路线

### Phase A: Evolution 集成 (最高 ROI)

**目标**: Agent 不再重复犯同类错误。

| 任务 | 文件 | 改动量 |
|------|------|--------|
| A1: agent.ts 主循环集成 suggest() (200ms 超时 + 本地缓存优先) | agent.ts | ~40 行 |
| A2: tool 执行后 learned() (fire & forget) | agent.ts | ~20 行 |
| A3: Signal 提取器 (error → SignalTag) | evolution.ts (新) | ~80 行 |
| A4: Gene 注入改为 PromptBuilder section (不追加 message) | agent.ts, prompt.ts | ~20 行 |
| A5: 基因中毒防护 (连续失败 3 次 → 隔离) | evolution.ts | ~30 行 |
| A6: 降级策略 (Evolution 不可用 → 静默跳过) | agent.ts | ~10 行 |
| A7: 测试 | tests/evolution.test.ts | ~120 行 |

**预期效果**: 同类 tool 错误第二次出现时，命中 gene 概率 > 70%，节省 ~2000 tokens/次。

### Phase B: Cloud IM 通信骨架 + Token 预算

**目标**: 事件持久化 + 状态可恢复 + 成本可控。

| 任务 | 文件 | 改动量 |
|------|------|--------|
| B1: PersistenceAdapter 接口 (Cloud IM / 本地文件两种实现) | persistence.ts (新) | ~80 行 |
| B2: Checkpoint 写入 (含完整 compacted messages) | dual.ts | ~60 行 |
| B3: Resume-from-checkpoint (含 30% 进度阈值) | dual.ts | ~80 行 |
| B4: Heartbeat via presence (不用 typing) | dual.ts | ~20 行 |
| B5: TokenBudget 机制 (warning + pause) | agent.ts, dual.ts | ~50 行 |
| B6: 降级策略 (Cloud IM 不可用 → 本地文件) | persistence.ts | ~30 行 |
| B7: 测试 | tests/persistence.test.ts | ~120 行 |

**预期效果**: 容器重启后 < 5s 恢复执行；token 消耗可见可控。

### Phase C: 交互时钟对齐

**目标**: 人类在任何时刻都知道 Agent 在做什么。

| 任务 | 文件 | 改动量 |
|------|------|--------|
| C1: 协作/托管模式切换 (基于预估时长) | dual.ts | ~40 行 |
| C2: 阶段性摘要生成 (每完成一个 plan step) | dual.ts | ~40 行 |
| C3: 错误 + gene 提示合并消息 (人类可读) | agent.ts | ~30 行 |
| C4: Human-in-the-loop via IM 消息 (非仅 approval gate) | dual.ts | ~60 行 |

### Phase D: 多 Agent 编排 (基于 A-C)

| 任务 | 文件 | 改动量 |
|------|------|--------|
| D1: AgentAdapter 接口 | loop/adapter.ts (新) | ~40 行 |
| D2: LocalAgentAdapter (包装 PrismerAgent) | loop/adapter-local.ts (新) | ~80 行 |
| D3: CloudIMAgentAdapter (远程 Agent 路由) | loop/adapter-cloud.ts (新) | ~120 行 |
| D4: 线性 plan executor (markdown steps) | dual.ts | ~60 行 |
| D5: 部分失败处理 (保留已完成步骤 + 通知) | dual.ts | ~40 行 |

---

## 7. 与 Cloud SDK 的接口约定

### 7.1 luminclaw 需要的 SDK 能力

| SDK 能力 | 用途 | SDK 方法 | 可选? |
|---------|------|---------|------|
| 发消息到对话 | Checkpoint、摘要、回复 | `client.im.messages.send()` | 是 (降级到本地文件) |
| 读历史消息 | Resume from checkpoint | `client.im.messages.list()` | 是 |
| Presence 更新 | Heartbeat | `client.im.realtime.updatePresence()` | 是 |
| Task 创建/更新 | 任务持久化 | `client.im.tasks.create/complete()` | 是 |
| Evolution suggest | Gene 匹配 | `evolution.suggest()` | 是 (超时跳过) |
| Evolution learned | 结果记录 | `evolution.learned()` | 是 (fire&forget) |
| Memory 文件 | WorldModel 持久化 | `client.im.memory.write()` | 是 |

**所有 SDK 依赖均为可选**。luminclaw 在无 Cloud SDK 时仍可独立运行。

### 7.2 luminclaw 暴露的事件

```typescript
// ── 已实现 (Agent Loop UX Phase 0-4) ──
'thinking.delta'        // 推理过程
'iteration.start'       // 循环进度
'tool.progress'         // 工具内进度
'tool.start' / 'tool.end'
'task.created'          // 任务创建
'task.planning'         // 规划开始
'task.planned'          // 规划完成
'memory.accessed'       // 记忆访问
'task.completed'        // 任务完成 (typed)

// ── 新增 (Phase A-C) ──
'evolution.suggest'     // 命中 gene
'evolution.learned'     // 记录学习结果
'checkpoint.saved'      // Checkpoint 已持久化
'human.input_needed'    // 需要人类输入
'budget.warning'        // Token 预算告警
'step.completed'        // plan step 完成 (多步任务)
```

---

## 8. 成功指标

| 指标 | Phase A 目标 | Phase B 目标 | Phase C 目标 |
|------|-------------|-------------|-------------|
| 同类错误重复率 | < 30% (从 ~100%) | — | — |
| Token 浪费 (纠错) | 减少 40% | — | — |
| 容器重启恢复率 | — | > 90% | — |
| 状态丢失率 | — | < 5% (从 ~100%) | — |
| Token 超支率 | — | < 5% (有预算机制) | — |
| 人类无反馈最大时长 | — | — | < 10s (从 30s+) |
| 人类理解度 | — | — | 每条消息有明确意图 |
| suggest() 延迟 P99 | < 200ms | — | — |
| Evolution 降级触发率 | < 5% | — | — |
