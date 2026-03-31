# Hook 系统与权限模型深度分析

> 对比 CC 的 5 类 Hook + 细粒度权限系统与 LuminClaw 的 4 Hook HookRegistry + 审批门控。

## 1. CC 的 Hook 架构

### 1.1 五种 Hook 类型

| 类型 | 执行方式 | 可阻断 | 用途 |
|------|---------|--------|------|
| **Command** | Shell 命令 | Yes (exit code 2) | CI 集成、lint 检查 |
| **HTTP** | Webhook | Yes | 外部审批系统 |
| **Prompt** | 迷你 LLM agent | Yes (结构化输出) | 智能验证 |
| **Agent** | 完整 agent 循环 | Yes | 复杂审核流程 |
| **Function** | TypeScript 回调 | Yes (返回 boolean) | 运行时插件 |

```typescript
// Command Hook 示例
{
    type: 'command',
    command: 'eslint --fix ${FILE}',
    timeout: 30,
    exitCode: 0  // exit 0 = 允许, exit 2 = 阻断
}

// Prompt Hook 示例 — LLM 判断是否允许
{
    type: 'prompt',
    prompt: 'Is this bash command safe? $ARGUMENTS',
    timeout: 60
}

// Function Hook 示例 — 运行时回调
{
    type: 'function',
    callback: async (messages, signal) => {
        return !messages.some(m => m.content?.includes('DROP TABLE'))
    },
    errorMessage: 'Destructive SQL detected'
}
```

### 1.2 Hook 事件矩阵

CC 支持的事件远超 LuminClaw 的 4 个：

| 事件 | CC | LuminClaw | 说明 |
|------|-----|-----------|------|
| SessionStart | Yes | No | 会话初始化 |
| SessionStop | Yes | No | 会话结束 |
| SubagentStart | Yes | No | 子 agent 启动 |
| SubagentStop | Yes | No | 子 agent 完成 |
| TeammateIdle | Yes | No | 团队成员空闲 |
| UserPromptSubmit | Yes | No | 用户提交输入 |
| PreCompact | Yes | No | Compaction 前 |
| PostCompact | Yes | No | Compaction 后 |
| ToolUse | Yes | Yes (before/after_tool) | 工具使用 |
| MessageReceived | Yes | No | 消息接收 |
| before_prompt | No | Yes | 首次 LLM 调用前 |
| agent_end | No | Yes | 循环结束 |

### 1.3 Session Hook 注册

CC 的 Hook 不仅可以全局注册，还可以按会话、按 Skill、按 Agent 注册：

```typescript
// 会话级 Hook（skill 激活时注册，skill 结束时清理）
type SessionHookMatcher = {
    matcher: string        // 正则匹配工具名/agent 类型
    skillRoot?: string     // 限定 skill 作用域
    hooks: Array<{
        hook: HookCommand | FunctionHook
        onHookSuccess?: (hook, result) => void
    }>
}

// SKILL.md frontmatter 中的 hooks 定义
registerFrontmatterHooks(setAppState, sessionId, hooks, sourceName, isAgent)
```

### 1.4 异步 Hook

CC 支持非阻塞异步 Hook，结果稍后通过附件注入：

```typescript
// AsyncHookRegistry 跟踪正在运行的异步 Hook
registerPendingAsyncHook({
    processId,     // Shell 进程 ID
    hookId,
    hookEvent,
    command,
    timeout,
    startTime,
    responseAttachmentSent: false
})

// 轮询完成状态，结果作为 <hook-response> 附件返回
checkForAsyncHookResponses()
```

## 2. CC 的权限系统

### 2.1 权限模式

```typescript
type PermissionMode = 
    | 'default'           // 大多数操作需要确认
    | 'acceptEdits'       // 文件编辑自动允许
    | 'bypassPermissions' // 全部自动允许（管理员）
    | 'plan'              // 只读模式（Plan 模式）
    | 'simple'            // 受限工具集
```

### 2.2 权限检查流程

```
Tool Call -> canUseTool(input)
    |
    +-- 1. 工具存在检查
    +-- 2. 输入验证 (Zod schema)
    +-- 3. 工具特定验证 (validateInput)
    +-- 4. Hook 权限检查 (resolveHookPermissionDecision)
    |   +-- Session hooks（先检查）
    |   +-- Global hooks（后检查）
    +-- 5. Permission mode 检查
    |   +-- bypassPermissions -> 直接允许
    |   +-- acceptEdits -> 编辑类允许
    |   +-- default -> 检查规则
    +-- 6. Permission rules 检查
    |   +-- 白名单匹配 -> 允许
    |   +-- 黑名单匹配 -> 拒绝
    |   +-- 无匹配 -> 询问用户
    +-- 7. 返回: allow | deny | ask_user
```

### 2.3 Bash 安全检查（102KB 的专用模块）

CC 对 Bash 工具有极其深入的安全分析：

```typescript
// bashSecurity.ts (102KB)
// bashPermissions.ts (98KB)
// pathValidation.ts (43KB)

// 检查项包括：
// - 命令是否是破坏性命令 (rm, mkfs, dd, etc.)
// - 路径是否在允许的目录内
// - 是否有 sandbox 限制
// - 管道链中的每个命令是否安全
// - 环境变量注入风险
// - 路径遍历攻击
```

### 2.4 Permission Denial Tracking

```typescript
// 跟踪被拒绝的权限，避免重复弹框
type DenialTracking = {
    denials: Map<string, {
        tool: string
        input: unknown
        reason: string
        count: number
        lastDenied: number
    }>
}

// 如果同一请求被连续拒绝 N 次，自动注入拒绝信息供 LLM 处理
```

## 3. LuminClaw 当前模式

### 3.1 HookRegistry

```typescript
// 4 种 Hook，纯 TypeScript 回调
class HookRegistry {
    hooks: Hook[] = []
    
    register(hook: Hook): void
    runBeforePrompt(ctx, prompt): Promise<string>
    runBeforeTool(ctx, tool, args): Promise<{ proceed, args }>
    runAfterTool(ctx, tool, result, error): Promise<void>
    runAgentEnd(ctx, result): Promise<void>
}
```

### 3.2 审批门控

```typescript
// 基于工具名和 bash 命令模式的二元判断
needsApproval(toolName, args): boolean {
    if (!SENSITIVE_TOOLS.has(toolName)) return false
    if (toolName === 'bash') {
        return SENSITIVE_BASH_PATTERNS.some(p => p.test(cmd))
    }
    return true
}

// 等待外部审批（WebSocket），超时默认拒绝
waitForApproval(toolId): Promise<boolean> {
    return new Promise(resolve => {
        this.approvalResolvers.set(toolId, resolve)
        setTimeout(() => resolve(false), APPROVAL_TIMEOUT_MS)
    })
}
```

## 4. 差距分析

| 维度 | Claude Code | LuminClaw | 优先级 |
|------|------------|-----------|--------|
| **Hook 类型** | 5 种（command/http/prompt/agent/function） | 1 种（function） | Medium |
| **Hook 事件** | 10+ 种 | 4 种 | Low |
| **会话级 Hook** | Yes, 按 skill/agent 注册 | No, 仅全局 | Medium |
| **异步 Hook** | Yes, 非阻塞 + 稍后注入 | No | Low |
| **权限模式** | 5 种分级 | 二元（需要/不需要审批） | Medium |
| **Bash 安全** | 243KB 深度分析 | 正则模式匹配 | Medium |
| **拒绝追踪** | Yes, 避免重复弹框 | No | Low |
| **Frontmatter hooks** | Yes, Skill/Agent 自带 | No | Medium |

## 5. 建议改进

### 5.1 Phase 1：增加 Command Hook 类型

```typescript
interface CommandHook {
    type: 'command'
    command: string     // Shell 命令，$TOOL_NAME 和 $ARGS 可替换
    timeout?: number
    exitCode?: number   // 期望的退出码，默认 0
}

// 在 before_tool 时执行（使用 execFile 避免注入）
async runCommandHook(hook: CommandHook, tool: string, args: unknown): Promise<boolean> {
    const { status } = await execFileNoThrow(hook.command, [tool, JSON.stringify(args)], {
        timeout: hook.timeout ?? 30_000
    })
    return status === (hook.exitCode ?? 0)
}
```

**用途**：CI/CD 集成、代码检查、安全扫描。

### 5.2 Phase 2：会话级 Hook 注册

```typescript
class HookRegistry {
    private globalHooks: Hook[] = []
    private sessionHooks = new Map<string, Hook[]>()
    
    registerForSession(sessionId: string, hook: Hook): void {
        const hooks = this.sessionHooks.get(sessionId) ?? []
        hooks.push(hook)
        this.sessionHooks.set(sessionId, hooks)
    }
    
    clearSessionHooks(sessionId: string): void {
        this.sessionHooks.delete(sessionId)
    }
    
    // 运行时先执行 session hooks，再执行 global hooks
    private getHooks(sessionId: string): Hook[] {
        return [
            ...(this.sessionHooks.get(sessionId) ?? []),
            ...this.globalHooks,
        ]
    }
}
```

### 5.3 Phase 3：增加 PreCompact / PostCompact 事件

```typescript
type HookType = 
    | 'before_prompt' | 'before_tool' | 'after_tool' | 'agent_end'
    | 'pre_compact' | 'post_compact'  // 新增
    | 'session_start' | 'session_end' // 新增

interface PreCompactHook {
    type: 'pre_compact'
    fn: (ctx: HookContext, messages: Message[]) => Promise<{
        customInstructions?: string  // 注入额外摘要指令
    }>
}
```

### 5.4 Phase 4：权限模式分级

```typescript
type PermissionMode = 'strict' | 'standard' | 'permissive'

// strict: 所有工具都需要审批
// standard: 只有 sensitive 工具需要审批（当前行为）
// permissive: 无需审批（容器内自动化场景）

// 配置
const cfg = {
    approval: {
        mode: process.env.APPROVAL_MODE ?? 'standard',
        sensitiveTools: ['bash'],
        bashPatterns: [/rm\s/, /mv\s/, /dd\s/],
    }
}
```

## 6. CC Hook 系统中值得借鉴的设计模式

### 6.1 Hook 链式执行 + 短路

```typescript
// CC 的 Hook 执行是链式的：任何一个 Hook 返回"阻断"就短路
for (const hook of hooks) {
    const result = await executeHook(hook, input)
    if (result.blocked) {
        return { blocked: true, reason: result.reason }
    }
    // 否则继续下一个 hook
}
```

LuminClaw 的 `runBeforeTool` 已经实现了类似模式（好的设计）。

### 6.2 Hook 超时保护

```typescript
// CC 的每个 Hook 都有超时保护
const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 60_000

async function executeHookWithTimeout(hook, input, signal) {
    const result = await Promise.race([
        executeHook(hook, input),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Hook timeout')), hook.timeout ?? TOOL_HOOK_EXECUTION_TIMEOUT_MS)
        ),
    ])
    return result
}
```

LuminClaw 的 HookRegistry 没有超时保护——一个 hang 住的 Hook 会阻塞整个 agent loop。建议增加。

### 6.3 Hook 失败不应破坏循环

LuminClaw 已经实现了这一点：
```typescript
// hooks.ts:89 — 好的设计
try { await h.fn(ctx, tool, result, error); } catch { /* hooks should not break the loop */ }
```

## 7. 总结

CC 的 Hook/权限系统是一个**多层防御体系**：
- **Hook 类型多样**：从简单 Shell 命令到完整 LLM agent
- **事件覆盖全面**：会话生命周期的每个阶段都有钩子
- **权限分级细腻**：5 种模式覆盖从开发到生产的不同场景
- **Bash 安全深入**：200KB+ 的专用安全检查模块

LuminClaw 的系统更简洁但也更脆弱。建议：
1. **增加 Hook 超时保护**（立即，防止 hang）
2. **增加 Command Hook**（短期，CI/CD 集成）
3. **增加会话级 Hook**（中期，Skill 自带 Hook）
4. **权限模式分级**（中期，适配不同部署场景）
