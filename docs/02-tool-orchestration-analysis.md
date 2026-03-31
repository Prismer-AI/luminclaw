# 工具编排深度分析：并发模型与流式执行

> 对比 CC 的 `toolOrchestration.ts` / `StreamingToolExecutor.ts` 与 LuminClaw 的 `Promise.all` 模型。

## 1. CC 的工具并发架构

CC 的工具执行不是简单的"全部并行"或"全部串行"，而是一个**分区执行**模型：

### 1.1 分区算法：partitionToolCalls

```typescript
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
    return toolUseMessages.reduce((acc, toolUse) => {
        const tool = findToolByName(tools, toolUse.name)
        const isConcurrencySafe = tool?.isConcurrencySafe(parsedInput.data) ?? false
        
        // 连续的只读工具合并为一个并发批次
        // 写工具独占一个批次
        if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
            acc[acc.length - 1].blocks.push(toolUse)
        } else {
            acc.push({ isConcurrencySafe, blocks: [toolUse] })
        }
        return acc
    }, [])
}
```

**输入**：`[Read, Read, Edit, Grep, Grep, Write]`
**输出**：
```
Batch 1 (concurrent): [Read, Read]
Batch 2 (serial):     [Edit]
Batch 3 (concurrent): [Grep, Grep]
Batch 4 (serial):     [Write]
```

### 1.2 读写安全性判断

每个工具通过 `isConcurrencySafe(input)` 方法声明自己是否并发安全：

```typescript
// Bash 工具：根据命令内容动态判断
BashTool.isConcurrencySafe(input) {
    // 无管道、无副作用的命令可以并发
    return !input.command.includes('|') && isReadCommand(input.command)
}

// Read 工具：始终安全
FileReadTool.isConcurrencySafe() { return true }

// Edit 工具：始终不安全
FileEditTool.isConcurrencySafe() { return false }
```

### 1.3 Context Modifier 队列

关键设计：工具执行可能修改上下文（如切换工作目录、更新文件状态缓存）。CC 对此有不同策略：

**并发批次**：Modifier 排队，批次结束后按工具顺序依次应用
```typescript
// 并发执行时，modifier 不能立即生效（可能影响同批次其他工具）
const queuedContextModifiers = {}
for await (const update of runToolsConcurrently(blocks, ...)) {
    if (update.contextModifier) {
        queuedContextModifiers[block.id] = update.contextModifier
    }
}
// 批次结束后，按原始顺序应用
for (const block of blocks) {
    const modifier = queuedContextModifiers[block.id]
    if (modifier) currentContext = modifier(currentContext)
}
```

**串行批次**：Modifier 立即生效
```typescript
for (const toolUse of serialBlocks) {
    for await (const update of runToolUse(toolUse, ...)) {
        if (update.contextModifier) {
            currentContext = update.contextModifier(currentContext)  // 即时
        }
    }
}
```

## 2. StreamingToolExecutor：状态机

CC 最精巧的组件之一——一个管理工具从排队到完成的状态机：

```
         addTool()              processQueue()           getCompletedResults()
            │                       │                           │
            v                       v                           v
┌─────────────────┐    ┌──────────────────┐    ┌──────────────────────┐
│     queued      │───>│    executing     │───>│     completed        │───> yielded
└─────────────────┘    └──────────────────┘    └──────────────────────┘
         │                                              │
         │  canExecuteTool() 检查：                      │  保序输出：
         │  - 无正在执行的工具？可以                       │  - 按添加顺序 yield
         │  - 自己是只读 && 全部在执行的也是只读？可以      │  - progress 消息立即 yield
         │  - 否则等待                                   │  - 遇到未完成的写工具时停止
         │                                              │
         └──── 写工具阻塞后续所有工具 ──────────────────────┘
```

### 关键行为

1. **即时启动**：`addTool()` 后立即检查能否执行（不等 API 流完成）
2. **Progress 流出**：工具的中间进度（如 bash 输出）通过 `pendingProgress` 立即 yield，不等工具完成
3. **保序**：结果按添加顺序 yield，即使后面的工具先完成也要等前面的
4. **级联取消**：Bash 工具出错时，通过 `siblingAbortController` 取消同批次的其他 Bash 工具
5. **并发限制**：`getMaxToolUseConcurrency()` 默认 10

### 时间线对比

```
CC (StreamingToolExecutor):
  T0: API 开始流式返回
  T1: 解析到 tool_use_1 (Read) → addTool → 立即开始执行
  T2: 解析到 tool_use_2 (Read) → addTool → 并发执行
  T3: tool_use_1 完成 → getCompletedResults() yield result_1
  T4: 解析到 tool_use_3 (Edit) → addTool → 排队（等 Read 完成）
  T5: API 流完成 → getRemainingResults()
  T6: tool_use_2 完成 → yield result_2 → Edit 开始
  T7: Edit 完成 → yield result_3
  总时间: ~T7

LuminClaw (Promise.all):
  T0: API 开始流式返回
  ...
  T5: API 流完成
  T6: Promise.all([Read, Read, Edit]) 同时开始
  T7: Read 完成 × 2, Edit 完成
  总时间: ~T7 (但 Edit 与 Read 并发执行，可能有竞争)
```

**关键区别**：CC 的模式不仅更快（API 流期间就开始执行工具），而且更安全（Edit 等到 Read 完成后才执行）。

## 3. LuminClaw 当前模式

```typescript
// agent.ts:415-489
const toolResults = await Promise.all(
    response.toolCalls.map(async (call) => {
        // 所有工具无差别并行执行
        const result = await this.tools.execute(call.name, call.arguments, ctx)
        return { id: call.id, output: result.output, error: !!result.error }
    })
)
```

### 问题

| 问题 | 场景 | 风险 |
|------|------|------|
| **无读写区分** | LLM 同时调用 `Read file.txt` 和 `Edit file.txt` | 竞争条件：Edit 可能在 Read 之前完成 |
| **无级联取消** | bash 命令 A 失败，bash 命令 B 仍在运行 | 浪费资源，可能产生不一致状态 |
| **无并发限制** | LLM 一次返回 20 个工具调用 | 可能耗尽文件描述符或内存 |
| **无 progress 流出** | 长时间运行的 bash 命令 | 用户看不到中间输出 |
| **无流式交叉** | API 返回完毕后才开始执行 | 额外延迟 |

## 4. 建议改进

### 4.1 Phase 1：工具读写分区（最小改动）

在 `ToolRegistry` 接口中增加并发安全标记：

```typescript
interface Tool {
    name: string
    description: string
    parameters: Record<string, unknown>
    execute(args, ctx): Promise<ToolResult>
    isConcurrencySafe?(args: Record<string, unknown>): boolean  // 新增
}
```

在 agent.ts 中实现分区执行：

```typescript
// 分区
const batches = partitionToolCalls(response.toolCalls, this.tools)

for (const batch of batches) {
    if (batch.concurrent) {
        // 并发执行只读工具
        const results = await Promise.all(
            batch.calls.map(call => this.executeToolCall(call, session, ...))
        )
        toolResults.push(...results)
    } else {
        // 串行执行写工具
        for (const call of batch.calls) {
            toolResults.push(await this.executeToolCall(call, session, ...))
        }
    }
}
```

### 4.2 Phase 2：StreamingToolExecutor 状态机

实现一个简化版的状态机：

```typescript
class ToolExecutor {
    private queue: TrackedTool[] = []
    private maxConcurrency = 10
    
    addTool(call: ToolCall, execute: () => Promise<ToolResult>): void {
        this.queue.push({ call, status: 'queued', execute, promise: null })
        this.processQueue()
    }
    
    private processQueue(): void {
        for (const tool of this.queue) {
            if (tool.status !== 'queued') continue
            if (this.canExecute(tool)) {
                tool.status = 'executing'
                tool.promise = tool.execute().then(result => {
                    tool.status = 'completed'
                    tool.result = result
                    this.processQueue()  // 触发下一个
                })
            }
        }
    }
    
    async *drain(): AsyncGenerator<ToolResult> {
        while (this.hasUnfinished()) {
            await Promise.race(this.executingPromises())
            for (const tool of this.queue) {
                if (tool.status === 'completed') {
                    tool.status = 'yielded'
                    yield tool.result!
                } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
                    break  // 写工具阻塞后续输出
                }
            }
        }
    }
}
```

### 4.3 Phase 3：流式交叉（需重构 Provider）

需要 `chatStream` 在解析到完整 tool_use block 时通过回调通知，而不是等流完成后一次性返回。

修改 Provider 接口：

```typescript
interface StreamCallbacks {
    onDelta: (delta: string) => void
    onToolUse?: (toolCall: ToolCall) => void  // 新增：tool_use block 完整时回调
}

chatStream(request: ChatRequest, callbacks: StreamCallbacks): Promise<ChatResponse>
```

## 5. 并发安全性参考表

| 工具类型 | CC 判定 | LuminClaw 建议 |
|---------|---------|---------------|
| 文件读取 | ✅ 始终安全 | ✅ 并发 |
| Grep/Glob | ✅ 始终安全 | ✅ 并发 |
| 文件编辑/写入 | ❌ 始终不安全 | ❌ 串行 |
| Bash (只读命令) | ✅ 动态判断 | ✅ 并发（需命令分析） |
| Bash (写命令) | ❌ 动态判断 | ❌ 串行 |
| Web 搜索/获取 | ✅ 始终安全 | ✅ 并发 |
| delegate | ❌ 不安全 | ❌ 串行 |
| memory_store | ❌ 追加写 | 可并发（追加操作） |

## 6. 总结

CC 的工具编排是一个**读写感知的流式执行引擎**，核心创新在于：
1. **分区算法**：连续只读工具合并为并发批次，写工具独占
2. **状态机管理**：工具从 queued → executing → completed → yielded 的完整生命周期
3. **流式交叉**：API 流期间就开始执行工具
4. **保序输出**：即使异步执行，结果也按原始顺序流出
5. **级联取消**：失败的 bash 命令取消兄弟命令

LuminClaw 应优先实现**读写分区**（Phase 1），这是最低成本、最高收益的改进。
