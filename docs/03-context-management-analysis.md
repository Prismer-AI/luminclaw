# 上下文管理深度分析：三层压缩 vs 单层截断

> 对比 CC 的三层递进 compaction 体系与 LuminClaw 的 truncateOldestTurns + compactConversation。

## 1. CC 的三层上下文管理

CC 实现了一个精密的三层递进系统，每层在不同时机触发，成本和效果递增：

```
Layer 1: Microcompact (增量)
    ├─ Time-based: 60min 空闲后清除旧工具结果
    └─ Cached: 通过 API cache_edits 延迟清除（零客户端成本）

Layer 2: Full Compaction (摘要)
    ├─ Auto: token 超过阈值时自动触发
    └─ Manual: /compact 命令手动触发

Layer 3: API-native Clearing (协议级)
    └─ clear_tool_uses_20250919 策略（服务端处理）
```

### 1.1 Layer 1: Microcompact

**Time-based 路径**（会话间隙 > 60 分钟）：
```typescript
// 直接清除旧工具结果内容
function maybeTimeBasedMicrocompact(messages, querySource) {
    const gap = Date.now() - lastAssistantMessageTime
    if (gap < gapThresholdMinutes * 60_000) return null
    
    // 保留最近 5 个工具结果，清除其余
    for (const toolResult of oldToolResults) {
        toolResult.content = '[Old tool result content cleared]'
    }
}
```

**Cached 路径**（API 层延迟清除）：
```typescript
// 不修改消息，而是生成 cache_edits 指令
function cachedMicrocompactPath(messages, querySource) {
    // 注册可清除的工具 ID
    for (const toolUse of compactableTools) {
        cachedMCState.registeredTools.set(toolUse.id, registrationTime)
    }
    // 生成 cache_edits 块供 API 使用
    return { messages, cacheEdits: buildCacheEdits(cachedMCState) }
}
```

**可清除工具列表**：
- File Read, Bash/Shell, Grep, Glob, Web Search, Web Fetch, File Edit, File Write

**关键设计**：Microcompact 是**零 LLM 调用**的——只是机械地清除旧工具结果，不需要理解内容。

### 1.2 Layer 2: Full Compaction

**触发条件**：
```typescript
function getAutoCompactThreshold(model: string): number {
    const effective = getContextWindowForModel(model) - 20_000  // 预留输出
    return effective - 13_000  // 安全缓冲
}
// 例：Claude 200K → 有效 180K → 阈值 167K tokens
```

**摘要流程**（9 个结构化段落）：
```
1. Primary Request and Intent — 用户最初的目标
2. Key Technical Concepts — 讨论的技术概念
3. Files and Code Sections — 完整代码片段（非摘要！）
4. Errors and Fixes — 遇到的错误及修复方案
5. Problem Solving — 解决问题的推理过程
6. All User Messages — 所有非工具结果的用户消息
7. Pending Tasks — 未完成的任务
8. Current Work — 当前工作（精确到文件名和代码片段）
9. Optional Next Step — 建议的下一步（含直接引用）
```

**关键约束**：
- 摘要 agent 禁止调用工具（`NO_TOOLS_PREAMBLE`）
- 最大输出 20K tokens
- 如果摘要请求本身触发 prompt_too_long，按 API round 分组截断 + 重试（最多 3 次）
- 摘要使用 `<analysis>` + `<summary>` 格式，`<analysis>` 段落被丢弃（仅作草稿）

**Post-compact 重注入**（最多 5 类附件）：
```typescript
const postCompactAttachments = [
    fileAttachments,          // 最近 5 个文件（各 5K tokens）
    asyncAgentAttachments,    // 异步 agent 结果
    planAttachment,           // Plan 模式状态
    skillAttachment,          // 已激活的 Skill
    deferredToolSchemas,      // 延迟工具定义
    mcpInstructionsDelta,     // MCP 增量
]
```

### 1.3 Layer 3: API-native Clearing

```typescript
function getAPIContextManagement() {
    return {
        strategy: 'clear_tool_uses_20250919',
        trigger: 180_000,    // tokens
        target: 40_000,      // 保留 tokens
        clearable: ['Bash', 'Shell', 'Grep', 'Glob', 'Web*'],
    }
}
```

这一层完全由 API 服务端处理，客户端只需声明策略。

## 2. LuminClaw 当前模式

### 2.1 truncateOldestTurns（机械截断）

```typescript
function truncateOldestTurns(messages: Message[], maxChars: number): Message[] {
    // 保留: system prompt + 最近 6 条消息
    // 从中间部分由新到旧保留，超出预算时停止
    // 问题：以 chars 而非 tokens 计量
}
```

### 2.2 compactConversation（简单摘要）

```typescript
async function compactConversation(provider, messages, model) {
    const serialized = serializeMessages(messages)  // 每条消息截断到 3000 chars
    const response = await provider.chat({
        messages: [
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: `Summarize this conversation excerpt:\n\n${serialized}` },
        ],
        maxTokens: 2000,  // 很小
    })
    return { summary: response.text.trim(), ... }
}
```

### 2.3 memoryFlushBeforeCompaction

```typescript
async function memoryFlushBeforeCompaction(provider, droppedMessages, memoryStore, model) {
    const serialized = serializeMessages(droppedMessages).slice(0, 8000)
    const response = await provider.chat({
        messages: [{ role: 'system', content: MEMORY_FLUSH_PROMPT }, ...],
        maxTokens: 500,
    })
    if (text !== 'NO_REPLY') {
        await memoryStore.store(text, ['auto-flush', 'compaction'])
    }
}
```

## 3. 差距分析

| 维度 | Claude Code | LuminClaw | 差距 |
|------|------------|-----------|------|
| **计量单位** | Tokens（精确估算） | Chars（粗略） | ⚠️ 中 |
| **分层** | 3 层递进 | 1.5 层（截断 + 可选摘要） | ⚠️ 高 |
| **增量压缩** | Microcompact（零 LLM 调用） | 无 | ⚠️ 高 |
| **摘要质量** | 9 段结构化 + 20K tokens | 通用提示 + 2K tokens | ⚠️ 高 |
| **代码保留** | 摘要中保留完整代码片段 | 每条消息截断到 3K chars | ⚠️ 高 |
| **附件重注入** | 5 类附件 post-compact 重注入 | 无 | ⚠️ 中 |
| **PTL 自愈** | 摘要请求本身 PTL 时自动重试 | 无 | ⚠️ 中 |
| **Memory flush** | ✅ 有 | ✅ 有 | 无差距 |
| **Orphan repair** | ✅ 有 | ✅ 有 | 无差距 |

## 4. 建议改进

### 4.1 Phase 1：引入 Microcompact（零成本优化）

在每次 LLM 调用前，机械清除旧的工具结果：

```typescript
function microcompact(messages: Message[], keepRecent = 5): Message[] {
    const toolResultMessages = messages.filter(m => m.role === 'tool')
    if (toolResultMessages.length <= keepRecent) return messages
    
    const toClean = toolResultMessages.slice(0, -keepRecent)
    const cleanIds = new Set(toClean.map(m => m.toolCallId))
    
    return messages.map(m => {
        if (m.role === 'tool' && m.toolCallId && cleanIds.has(m.toolCallId)) {
            return { ...m, content: '[Old tool result cleared]' }
        }
        return m
    })
}
```

**收益**：在不调用 LLM 的情况下减少 30-60% 的上下文占用（工具结果通常是上下文中最大的部分）。

### 4.2 Phase 2：结构化摘要提示

替换当前的通用摘要提示为 CC 风格的结构化提示：

```typescript
const STRUCTURED_COMPACT_PROMPT = `You are a conversation summarizer. Produce a summary with these sections:

1. **Primary Request**: The user's original goal (1-2 sentences)
2. **Key Files**: File paths discussed with relevant code snippets (preserve exact code)
3. **Decisions Made**: Technical decisions and their rationale
4. **Current State**: What was last being worked on (precise, with file names)
5. **Pending Work**: Tasks not yet completed

CRITICAL: Preserve exact code snippets and file paths. Do NOT paraphrase code.
Respond with TEXT ONLY. Do NOT call any tools.`
```

并增加 `maxTokens` 到至少 4000（当前 2000 严重不足）。

### 4.3 Phase 3：Token 估算

```typescript
function estimateTokens(text: string): number {
    // 粗略估算：~4 chars per token for English, ~2 for CJK
    const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length
    const nonCjkChars = text.length - cjkCount
    return Math.ceil((nonCjkChars / 4 + cjkCount / 2) * 1.33)  // 1.33x padding
}
```

将 `MAX_CONTEXT_CHARS` 替换为基于 token 的阈值：
```typescript
const MAX_CONTEXT_TOKENS = 167_000  // 200K - 20K output - 13K buffer
```

### 4.4 Phase 4：Post-compact 附件重注入

Compaction 后重新注入关键上下文：

```typescript
async function buildPostCompactMessages(
    compactionSummary: string,
    recentFiles: FileAttachment[],  // 最近编辑的文件
    activeSkills: string[],          // 当前激活的 skill
): Message[] {
    return [
        { role: 'user', content: `[Conversation Summary]\n${compactionSummary}` },
        { role: 'assistant', content: 'Understood.' },
        // 重注入最近文件内容
        ...recentFiles.map(f => ({
            role: 'user' as const,
            content: `[File context: ${f.path}]\n${f.content.slice(0, 5000)}`,
        })),
    ]
}
```

## 5. Compaction 触发时机对比

```
CC 时间线：
  0K ──────────── 100K ──────────── 167K ──── 180K ──── 200K
  │                │                  │          │         │
  │                │  microcompact    │  auto    │  API    │ hard limit
  │                │  (continuous)    │ compact  │ native  │
  │                │                  │          │         │

LuminClaw 时间线：
  0 ──────────── 300K chars (~75K tokens?) ──── 600K chars ────
  │                    │                           │
  │                    │ truncate starts           │ MAX_CONTEXT_CHARS
  │                    │ (no compaction layer      │ (hard truncate)
  │                    │  before this)             │
```

**问题**：LuminClaw 的 `MAX_CONTEXT_CHARS = 600K` (约 150K tokens) 看似保守，但没有在达到阈值之前的增量压缩，意味着会突然从满载跳到截断，丢失大量上下文。CC 的分层方式是逐渐释放压力。

## 6. Boundary Marker 设计

CC 在每次 compaction 时插入一个边界标记：

```typescript
interface CompactBoundaryMessage {
    compactMetadata: {
        compactType: 'auto' | 'manual'
        preCompactTokenCount: number
        lastMessageUuidBeforeCompact?: string
        preservedSegment?: {
            headUuid: string
            anchorUuid: string
            tailUuid: string
        }
    }
}
```

**用途**：
- 会话回放/审计：知道 compaction 发生的位置
- 增量 compact：知道哪些消息已经被压缩过
- 调试：了解压缩前后的 token 数量变化

LuminClaw 可以用 `Session.compactionSummary` 的时间戳实现类似功能。

## 7. 总结

CC 的上下文管理是一个**渐进式压力释放系统**：
1. **Microcompact** 像空调——持续低成本运行，保持温度稳定
2. **Full compaction** 像开窗通风——成本较高但效果显著
3. **API-native** 像中央空调——基础设施级别，零客户端成本

LuminClaw 当前是**二元模式**：要么满载要么截断，没有中间状态。建议优先引入 Microcompact（Phase 1），这是零 LLM 成本的即时优化。
