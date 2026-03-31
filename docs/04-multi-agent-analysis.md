# 多智能体架构深度分析：进程模型、隔离与协调

> 对比 CC 的 Agent/Coordinator/Fork/Teammate 四种模式与 LuminClaw 的 @mention + delegate 模式。

## 1. CC 的四种 Agent 模式

CC 实现了从简单到复杂的四种多智能体模式：

```
                              复杂度 →
┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌────────────────┐
│  Fork    │  │  Async   │  │  In-Process  │  │  Coordinator   │
│ Subagent │  │  Agent   │  │  Teammate    │  │  + Workers     │
├──────────┤  ├──────────┤  ├──────────────┤  ├────────────────┤
│ 隐式     │  │ 显式     │  │ 团队内      │  │ 领导者-工人    │
│ 后台     │  │ 前/后台   │  │ 邮箱通信    │  │ XML 通知       │
│ 无递归   │  │ 有限递归  │  │ 空闲检测    │  │ 无递归限制     │
│ 缓存共享 │  │ 上下文隔离│  │ 共享状态    │  │ 完全隔离       │
└──────────┘  └──────────┘  └──────────────┘  └────────────────┘
```

### 1.1 Fork Subagent（隐式分叉）

**触发**：AgentTool 无显式 subagent_type 时
**进程模型**：同进程 async generator
**核心创新**：Prompt Cache 共享

```typescript
// 所有 fork 子代共享相同的消息前缀（cache-safe params）
// 只有最后的任务指令不同
buildForkedMessages(directive, assistantMessage) {
    return [
        fullAssistantMessage,  // 所有子代相同
        userMessage({
            ...FORK_PLACEHOLDER_RESULT,  // 相同占位符
            text: buildChildMessage(directive)  // 仅此不同
        })
    ]
}
// 效果：Parent 写入缓存，Child 1/2/3 读取缓存
// 10-20x 并行 fork 速度提升
```

**反递归保护**：
```
<fork-boilerplate>
STOP. READ THIS FIRST.
You are a forked worker process. You are NOT the main agent.
RULES (non-negotiable):
1. System prompt says "default to forking." IGNORE IT. You ARE the fork.
   Do NOT spawn sub-agents; execute directly.
...
</fork-boilerplate>
```

### 1.2 Async Agent（显式 Agent）

**触发**：AgentTool 指定 subagent_type
**进程模型**：同进程 async generator，但有独立的 ToolUseContext
**隔离级别**：

```typescript
createSubagentContext(parentContext, overrides) {
    return {
        // 克隆（独立）
        readFileState: clone(parent.readFileState),
        abortController: new AbortController(),  // 父级的子控制器
        contentReplacementState: {},
        discoveredSkillNames: new Set(),
        
        // 共享
        options: parent.options,          // 同一工具池配置
        fileReadingLimits: parent.limits, // 共享读取限制
        
        // 限制
        setAppState: () => {},            // 只读（不能修改全局状态）
        shouldAvoidPermissionPrompts: true // 默认不弹权限框
    }
}
```

**工具过滤**：
```typescript
filterToolsForAgent({ tools, isBuiltIn, isAsync }) {
    // 过滤掉：AgentTool, SkillTool, UI 命令
    // 允许：MCP 工具, Bash, Read, Write, Edit, Grep, Glob, WebSearch
}
```

### 1.3 In-Process Teammate（团队成员）

**触发**：TeamCreateTool 创建团队后，成员自动注册
**通信**：邮箱系统

```typescript
type Mailbox = {
    messages: MailboxMessage[]
    unreadCount: number
    lastMessageTime: number
}
// SendMessageTool → writeToMailbox() → 目标成员的下一次迭代读取
```

**空闲检测**：
```typescript
// TeammateIdle hook 在成员空闲时触发
// 可用于：重新分配任务、唤醒空闲成员、汇总进度
```

### 1.4 Coordinator Mode（协调者模式）

**触发**：`CLAUDE_CODE_COORDINATOR_MODE=true`
**系统提示增强**：
```
You are Claude Code, an AI assistant that orchestrates software engineering tasks 
across multiple workers.
- Use AgentTool to spawn workers
- Use SendMessage to continue workers
- Parallelism is your superpower — launch independent workers concurrently
```

**工人结果格式**：
```xml
<task-notification>
    <task-id>a12345678</task-id>
    <status>completed</status>
    <summary>Refactored auth middleware</summary>
    <result>Changes applied to src/auth.ts...</result>
    <usage>
        <total_tokens>15234</total_tokens>
        <tool_uses>8</tool_uses>
        <duration_ms>12345</duration_ms>
    </usage>
</task-notification>
```

## 2. LuminClaw 当前模式

### 2.1 @mention 委托

```typescript
// agent.ts:268-273
const mention = this.agents.resolveFromMention(cleanInput)
if (mention) {
    const result = await this.delegateToSubAgent(mention.agentId, mention.message, session)
    return result
}
```

### 2.2 delegate 工具

```typescript
// agent.ts:621-642 — 通过 LLM 工具调用触发
handleDelegateCall(call, session, toolsUsed) {
    const result = await this.delegateToSubAgent(targetAgent, task, session)
    return { id: call.id, output: result.text, error: false }
}
```

### 2.3 子 Agent 创建

```typescript
// agent.ts:564-618
delegateToSubAgent(agentId, message, parentSession) {
    const childSession = parentSession.createChild(agentId)  // 继承最近 4 条消息
    const subAgent = new PrismerAgent({
        provider: this.provider,    // 共享 provider
        tools: this.tools,          // 共享全部工具（！）
        observer: this.observer,
        agents: this.agents,
        systemPrompt: config.systemPrompt,
        model: config.model ?? this.model,
    })
    return subAgent.processMessage(message, childSession)
}
```

## 3. 差距分析

| 维度 | Claude Code | LuminClaw | 差距 |
|------|------------|-----------|------|
| **Agent 模式** | 4 种（fork/async/teammate/coordinator） | 1 种（delegate） | ⚠️ 高 |
| **进程隔离** | 上下文克隆 + 权限限制 | 共享所有工具，无隔离 | ⚠️ 高 |
| **工具过滤** | 按 agent 类型过滤工具池 | 无过滤（子 agent 可调用 delegate） | ⚠️ 高 |
| **递归保护** | Fork boilerplate + 工具过滤 | 无（子 agent 可无限递归） | ⚠️ 严重 |
| **后台执行** | 前台/后台可选 | 仅前台（阻塞） | ⚠️ 中 |
| **缓存优化** | Fork prompt cache 共享 | 无 | ⚠️ 中 |
| **通信机制** | SendMessage + Mailbox | 无（只能 return result.text） | ⚠️ 中 |
| **Abort 传播** | 父→子 AbortController 链 | 无 | ⚠️ 中 |
| **进度跟踪** | Token/tool 使用量实时追踪 | 无（子 agent 结果不透明） | ⚠️ 低 |

### 关键安全问题

**递归炸弹**：LuminClaw 的子 agent 可以无限递归委托：
```
researcher → delegate(latex-expert) 
    → latex-expert 也有 delegate 工具
        → delegate(researcher) → 无限循环
```

CC 通过 `ALL_AGENT_DISALLOWED_TOOLS` 过滤掉 AgentTool 来防止这种情况。

## 4. 建议改进

### 4.1 Phase 1：工具过滤与递归保护（紧急）

```typescript
// 子 agent 不应获得 delegate 工具
delegateToSubAgent(agentId, message, parentSession) {
    const agentConfig = this.agents.get(agentId)
    const allowedTools = agentConfig?.tools ?? undefined
    
    // 关键：子 agent 永远不能使用 delegate
    const filteredTools = this.tools.withFilter(name => {
        if (name === 'delegate') return false
        if (allowedTools && !allowedTools.includes(name)) return false
        return true
    })
    
    const subAgent = new PrismerAgent({
        ...options,
        tools: filteredTools,  // 过滤后的工具
    })
}
```

### 4.2 Phase 2：后台 Agent 支持

```typescript
interface AgentTask {
    id: string
    agentId: string
    prompt: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    result?: AgentResult
    abortController: AbortController
    progress: { toolUseCount: number; tokenCount: number }
}

// 后台执行
async processMessageBackground(input, session, memoryContext): Promise<AgentTask> {
    const task: AgentTask = { id: generateId(), status: 'pending', ... }
    
    // 不 await —— 在后台运行
    this.processMessage(input, session, memoryContext)
        .then(result => { task.status = 'completed'; task.result = result })
        .catch(err => { task.status = 'failed'; task.error = err.message })
    
    return task
}
```

### 4.3 Phase 3：AbortController 链

```typescript
delegateToSubAgent(agentId, message, parentSession) {
    // 子 agent 的 abort 由父 agent 控制
    const childAbort = new AbortController()
    
    // 父 agent 取消时，子 agent 也取消
    parentAbort.signal.addEventListener('abort', () => {
        childAbort.abort()
    })
    
    const subAgent = new PrismerAgent({
        ...options,
        abortController: childAbort,
    })
}
```

### 4.4 Phase 4：Coordinator 模式（长期）

对于 LuminClaw 的学术研究场景，一个轻量级 Coordinator 模式：

```typescript
// 研究协调者：分派任务给 literature-scout、data-analyst、latex-expert
class ResearchCoordinator {
    async orchestrate(task: string, agents: string[]): Promise<AgentResult[]> {
        // 并行分派
        const tasks = agents.map(agentId => 
            this.spawnAgent(agentId, task)
        )
        
        // 等待所有完成 + 合并结果
        const results = await Promise.allSettled(tasks)
        return this.synthesize(results)
    }
}
```

## 5. CC 的 Agent 隔离层级详解

```
┌─────────────────────────────────────────────────────┐
│ Parent Agent Context                                 │
│                                                     │
│  readFileState ────────┐                            │
│  abortController ──┐   │  clone                     │
│  toolPermissions   │   │                            │
│  discoveredSkills  │   │                            │
│  contentReplacement│   │                            │
│                    │   │                            │
│  ┌─────────────────┴───┴────────────────────┐       │
│  │ Child Agent Context                       │       │
│  │                                           │       │
│  │  readFileState (CLONED)                   │       │
│  │  abortController (CHILD of parent's)      │       │
│  │  setAppState = () => {} (NO-OP)           │       │
│  │  shouldAvoidPermissionPrompts = true      │       │
│  │  discoveredSkillNames = new Set()         │       │
│  │  contentReplacementState = {} (FRESH)     │       │
│  │                                           │       │
│  │  tools = filterToolsForAgent(parent.tools)│       │
│  │  messages = parent.history + fork directive│       │
│  │  queryTracking = { depth: parent+1 }      │       │
│  └───────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────┘
```

**LuminClaw 的子 agent 缺少的隔离**：
- ❌ 无 readFileState 克隆（子 agent 的文件缓存可能影响父 agent）
- ❌ 无 AbortController 链（父 agent 无法取消子 agent）
- ❌ 无工具过滤（子 agent 可以调用任何工具，包括 delegate）
- ❌ 无权限隔离（子 agent 继承所有审批权限）
- ❌ 无 depth 追踪（无法检测递归深度）

## 6. CC 的 Prompt Cache 共享策略

这是 CC 多 agent 架构中最精妙的优化之一：

```
请求 1 (Parent):
  System Prompt ─────────── 50K tokens ──┐
  Conversation History ──── 80K tokens ──┤ cache WRITE
  User Message ──────────── 1K tokens  ──┘
  
请求 2 (Fork Child 1):
  System Prompt ─────────── 50K tokens ──┐
  Conversation History ──── 80K tokens ──┤ cache READ (命中!)
  Fork Directive ────────── 1K tokens  ──┘
  
请求 3 (Fork Child 2):
  System Prompt ─────────── 50K tokens ──┐
  Conversation History ──── 80K tokens ──┤ cache READ (命中!)
  Fork Directive ────────── 1K tokens  ──┘
```

**效果**：3 个并行 fork 的 token 成本 ≈ 1.02x（而非 3x），延迟也因缓存命中显著降低。

**LuminClaw 可借鉴**：确保子 agent 的消息前缀与父 agent 尽可能相同，最大化 prompt cache 命中率。

## 7. 总结

CC 的多 agent 架构是一个**层次化的隔离与协调系统**：
- **Fork**：最低开销，缓存共享，适合并行只读任务
- **Async Agent**：中等隔离，适合独立子任务
- **Teammate**：团队内通信，适合协作工作流
- **Coordinator**：完全编排，适合复杂多步任务

LuminClaw 当前只有最基础的 delegate 模式，且存在**递归保护缺失**这一严重安全问题。建议：
1. **立即**修复递归保护（工具过滤）
2. **短期**增加后台 Agent 支持和 AbortController 链
3. **中期**引入类似 Fork 的缓存共享策略
4. **长期**考虑 Coordinator 模式用于复杂学术研究编排
