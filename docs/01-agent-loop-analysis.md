# Agent Loop 深度分析：Claude Code vs LuminClaw

> 对比 Claude Code (CC) 的 `query.ts` 与 LuminClaw 的 `agent.ts`，聚焦 dual loop 模式、流式执行、状态管理与错误恢复。

## 1. 架构总览对比

| 维度 | Claude Code | LuminClaw |
|------|------------|-----------|
| **循环模式** | `while(true)` + 7 个 continue 站点 | `while(iteration++ < max)` 单层循环 |
| **返回类型** | `AsyncGenerator<StreamEvent, Terminal>` | `Promise<AgentResult>` |
| **状态管理** | 单一 `State` 对象，每次 continue 重写 | 局部变量散落在循环体中 |
| **流式输出** | 工具执行与 API 流式**交叉并行** | API 流式完成后才执行工具 |
| **恢复路径** | 7 种（模型回退、reactive compact、token 升级等） | 0 种（错误直接终止） |
| **上下文管理** | 三层递进（microcompact → full → API-native） | 单层截断 + 可选 compaction |

## 2. CC 的 Dual Loop 模式

CC 的 agent loop 并非简单的"调用 LLM → 执行工具 → 重复"，而是一个**双层嵌套的异步生成器管道**：

### 外层循环：queryLoop

```
while (true) {
    state = { messages, toolUseContext, turnCount, ... }
    
    // ── 内层循环 1：API 流式响应 ──
    for await (const message of callModel()) {
        // 收到 tool_use block → 立即提交到 StreamingToolExecutor
        streamingToolExecutor.addTool(block)
        
        // 非阻塞轮询已完成的工具结果
        for (const result of streamingToolExecutor.getCompletedResults()) {
            yield result  // 实时流出
        }
    }
    
    // ── 内层循环 2：等待剩余工具完成 ──
    for await (const update of streamingToolExecutor.getRemainingResults()) {
        yield update
    }
    
    // ── 7 个 recovery continue 站点 ──
    // 1. Streaming fallback（流式失败 → 重试）
    // 2. Model fallback（模型失败 → 换模型）
    // 3. Collapse drain（context collapse → 廉价清理）
    // 4. Reactive compact（prompt too long → 紧急压缩）
    // 5. Max output tokens escalate（8k → 64k）
    // 6. Max output tokens recovery（注入"继续"提示）
    // 7. Stop hook blocking（权限拒绝 → 注入错误信息）
    
    // ── 正常继续 ──
    state = {
        messages: [...previous, ...assistant, ...toolResults],
        turnCount: nextTurnCount,
        ...resetRecoveryCounters
    }
}
```

### 关键洞察：State 对象模式

CC 将所有循环状态收束为一个 `State` 类型：

```typescript
type State = {
    messages: Message[]
    toolUseContext: ToolUseContext
    autoCompactTracking: AutoCompactTrackingState | undefined
    maxOutputTokensRecoveryCount: number
    hasAttemptedReactiveCompact: boolean
    maxOutputTokensOverride: number | undefined
    pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
    stopHookActive: boolean | undefined
    turnCount: number
    transition: Continue | undefined  // 为什么 continue（用于测试断言）
}
```

每个 continue 站点都是对 `state` 的完整重写，而非修改局部变量。这带来：
- **可测试性**：每次 continue 的原因被记录在 `transition` 字段
- **可追踪性**：状态变化是显式的、完整的
- **防遗漏**：编译器强制你提供所有字段

## 3. LuminClaw 当前模式分析

LuminClaw 的 `processMessage()` 是一个更传统的命令式循环：

```typescript
async processMessage(input, session, memoryContext): Promise<AgentResult> {
    const messages = session.buildMessages(input, systemPrompt, memoryContext)
    let iteration = 0
    let lastText = '', consecutiveErrors = 0
    const recentToolSigs: string[] = []
    
    while (iteration++ < maxIterations) {
        // 截断 → compaction（同步阻塞）
        // LLM 调用（流式或批量，但完全结束后才继续）
        // 无工具调用 → break
        // Promise.all 并行执行所有工具（无读写区分）
        // Doom loop 检测 → break
    }
    
    return buildResult(...)
}
```

### 差距分析

| 问题 | 影响 | 严重程度 |
|------|------|----------|
| 工具全部 `Promise.all`，无读写区分 | 并发写操作可能产生竞争条件 | ⚠️ 高 |
| API 响应完全结束后才执行工具 | 延迟增加，无法流式交叉 | ⚠️ 中 |
| 状态散落在局部变量中 | 难以扩展 recovery 路径 | ⚠️ 中 |
| 错误直接 return，无恢复机制 | LLM 瞬态错误导致会话终止 | ⚠️ 高 |
| 无 `transition` 记录 | 难以调试和测试循环行为 | ⚠️ 低 |
| 返回 `Promise` 而非 `AsyncGenerator` | 无法在循环中间流出事件 | ⚠️ 中 |

## 4. 建议改进方向

### 4.1 引入 State 对象模式

```typescript
interface LoopState {
    messages: Message[]
    iteration: number
    consecutiveErrors: number
    recentToolSigs: string[]
    hasAttemptedCompact: boolean
    recoveryCount: number
    transition?: { reason: string; detail?: unknown }
}
```

好处：
- 每次 continue 清晰地重写整个状态
- `transition` 字段方便测试和日志
- 扩展 recovery 路径时只需增加 continue 站点

### 4.2 增加 Recovery 路径（优先级排序）

1. **模型回退**（最重要）：LLM 返回 429/5xx 时，用 FallbackProvider 的下一个模型重试，而不是终止
2. **Reactive compact**：LLM 返回 prompt_too_long 时，紧急执行 compaction + 重试
3. **输出截断恢复**：检测到 `finish_reason: 'length'` 时，注入"请继续"消息并重试（最多 N 次）

### 4.3 流式工具交叉执行

CC 的核心优势之一：在 API 还在流式返回的过程中，已完成解析的 tool_use block 就立即开始执行。时间线：

```
CC:     [API streaming...tool1 parsed]→[tool1 exec]→[more streaming...tool2]→[tool2 exec]→[drain]
Lumin:  [API streaming...................complete]→[tool1+tool2+tool3 all at once]
```

建议分两步实现：
1. **短期**：在 `chatStream` 中解析到完整 tool_use block 后立即加入执行队列
2. **长期**：引入 `StreamingToolExecutor` 状态机，管理工具的 queued → executing → completed 转换

### 4.4 AsyncGenerator 改造

将 `processMessage` 改为异步生成器，使循环中间的事件可以流出：

```typescript
async *processMessage(input, session, memoryContext): AsyncGenerator<AgentEvent, AgentResult> {
    // yield { type: 'tool.start', ... }
    // yield { type: 'text.delta', ... }
    // yield { type: 'compaction', ... }
    // return finalResult
}
```

这样上层（server.ts）可以直接 `for await` 消费，无需依赖 EventBus 旁路。

## 5. CC 的 7 个 Recovery 站点详解

| # | 触发条件 | 恢复动作 | 是否一次性 |
|---|---------|---------|----------|
| 1 | 流式响应中断 | 清空 assistantMessages，丢弃 StreamingToolExecutor，重试 | 否 |
| 2 | 模型 API 错误 | 切换到 fallback 模型，重试 | 否 |
| 3 | Context collapse 堆积 | 排空已暂存的 collapse（廉价操作） | 否 |
| 4 | Prompt too long (API 413) | 紧急 compaction，carry over task_budget | 是（guard） |
| 5 | 输出 token 限制命中 | 从 8k 升级到 64k | 是（guard） |
| 6 | `finish_reason: 'length'` | 注入"Resume mid-thought"消息 | 最多 3 次 |
| 7 | Stop hook 阻断 | 注入 hook 错误信息供模型处理 | 否 |

**对 LuminClaw 的启示**：至少应实现 #2（模型回退）和 #4（reactive compact），这两个覆盖了最常见的运行时故障。

## 6. 总结

CC 的 agent loop 是一个经过生产打磨的**弹性执行引擎**，其核心设计哲学是：
- **永远不轻易放弃**：7 个 recovery 路径确保循环尽可能继续
- **流式优先**：AsyncGenerator 使事件可以在产生时立即流出
- **显式状态**：State 对象使每次循环迭代的输入/输出清晰可见
- **读写分离**：工具并发策略避免竞争条件

LuminClaw 当前的循环更接近 CC 的早期版本（简单 while + Promise.all），建议按优先级逐步引入 State 对象、Recovery 路径和流式工具执行。
