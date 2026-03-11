# Prismer Agent Core — 自研设计文档

> **Status:** 实现完成 — 方案 G 的详细技术设计 (4,665 LOC 已交付，Phase 1-4.5 全部完成)
> **前置:** `docker/agent/FRAMEWORK_ANALYSIS.md` (五框架对比), `ROADMAP.md` (路线图)
> **Cloud SDK:** `@prismer/sdk` v1.7 — IM/Context/Parse 基础设施
>
> **2026-03-12 更新:** 所有设计目标已实现。实际交付 4,665 LOC（超出初始估算的 1,080 LOC，
> 主要因为增加了 compaction/memory/hooks/channels/directive-scanner 等当初未预见的能力）。
> 平台集成层（directive 投递、tool ID 配对、K8s warm pool）已验证通过。

---

## 1. 设计目标

从 nanoclaw (~160 LOC)、nanobot (~160 LOC)、zeroclaw (~240 LOC)、OpenCode (~730 LOC) 四个框架的核心 Agent Loop 中提取最佳模式，构建 Prismer Agent Core。初始估算 ~1,080 LOC，实际交付 **4,665 LOC**（包含完整的生产级能力）。

| 目标 | 优先级 | 来源框架 | 状态 |
|------|--------|---------|------|
| 最小可审计的 Agent Loop | P0 | nanobot | ✅ agent.ts |
| Provider 可插拔 (OpenAI-compatible) | P0 | zeroclaw trait | ✅ provider.ts |
| MCP 标准工具注册 | P0 | nanoclaw/zeroclaw | ✅ tools.ts + loader.ts |
| 可观测性内置 (Observer) | P0 | zeroclaw | ✅ observer.ts |
| Directive 协议原生 | P0 | Prismer 自有 | ✅ directives.ts + scanner |
| **Sub-Agent 编排 (primary/subagent/hidden)** | **P0** | **OpenCode** | ✅ agents.ts |
| **Per-agent Permission Model** | **P0** | **OpenCode** | ✅ agents.ts |
| 文件系统 IPC | P1 | nanoclaw | ✅ ipc.ts |
| Memory (keyword recall) | P1 | nanobot | ✅ memory.ts |
| Cloud SDK IM 集成 | P1 | @prismer/sdk v1.7 | ✅ channels/cloud-im.ts |
| 流式输出 (on_delta) | P1 | zeroclaw | ✅ sse.ts + server.ts |
| Session 管理 + child sessions | P1 | nanobot + OpenCode | ✅ session.ts |
| **Doom-loop 检测** | **P1** | **OpenCode** | ✅ agent.ts |
| **Context compaction + memory flush** | **P1** | **OpenCode** | ✅ compaction.ts |
| **Lifecycle hooks** | **P1** | **OpenCode** | ✅ hooks.ts |
| **Tool ID/Args 配对 (前端状态)** | **P1** | Prismer 自有 | ✅ agent.ts + sse.ts |
| **Directive 文件扫描** | **P1** | Prismer 自有 | ✅ agent.ts |
| **Channel Plugin (Cloud IM + Telegram)** | **P1** | nanoclaw | ✅ channels/ |
| **Skill 自安装 (ClawHub)** | **P1** | nanoclaw | ✅ tools/clawhub.ts |
| 云端 Context 检索 | P2 | Cloud SDK context API | 待定 |
| Approval Gates | P2 | zeroclaw | 待定 |
| Prompt Guard | P2 | zeroclaw | 待定 |

---

## 2. 架构

> **实际交付结构** (4,665 LOC, 26 个源文件):

```
docker/agent/
├── src/
│   ├── agent.ts          # Agent Loop + Sub-Agent + doom-loop + context guard + compaction + directive scanner (592)
│   ├── agents.ts         # AgentRegistry + 6 内置 Agent + Permission (149)
│   ├── provider.ts       # Provider + FallbackProvider + thinking control (378)
│   ├── tools.ts          # Tool Registry + 分发 (96)
│   ├── tools/
│   │   ├── loader.ts     # prismer-workspace 工具适配器 + Cloud IM 凭证注入 (159)
│   │   ├── clawhub.ts    # ClawHub CLI 工具包装 (240)
│   │   └── index.ts      # 导出索引 (16)
│   ├── prompt.ts         # PromptBuilder — 动态 system prompt (SOUL/TOOLS/Skills) (235)
│   ├── skills.ts         # SKILL.md 加载 + YAML frontmatter + 缓存 (178)
│   ├── workspace.ts      # 文件安全中间件 (154)
│   ├── directives.ts     # UI 指令 Zod schemas (70)
│   ├── compaction.ts     # 上下文压缩 + memory flush + orphaned tool repair (141)
│   ├── memory.ts         # 关键词记忆存储 (/workspace/.prismer/memory/) (118)
│   ├── hooks.ts          # 生命周期钩子 (before_prompt, before_tool, after_tool, agent_end) (99)
│   ├── session.ts        # 会话管理 + 子会话 + directive 累积 (138)
│   ├── sse.ts            # EventBus + SSE writer (Zod schema, 含 toolId/args) (144)
│   ├── server.ts         # HTTP + WebSocket 网关 (tool event 转发含 toolId/args) (492)
│   ├── cli.ts            # CLI 入口 + 子命令路由 (193)
│   ├── ipc.ts            # stdin/stdout JSON 协议 (109)
│   ├── observer.ts       # 可观测性 (事件 + 指标) (115)
│   ├── channels/
│   │   ├── manager.ts    # Channel 管理器 (发现 + 启停) (87)
│   │   ├── cloud-im.ts   # Cloud IM channel (Prismer Cloud SSE) (177)
│   │   ├── telegram.ts   # Telegram Bot channel (171)
│   │   └── types.ts      # Channel 接口定义 (34)
│   ├── schemas.ts        # 前端类型导出 (14)
│   └── index.ts          # runAgent() 核心 + PromptBuilder 集成 + 模块导出 (366)
├── tests/                # 113 test cases, 1,788 LOC
├── package.json
├── tsconfig.json
└── Dockerfile.lumin      # 容器构建 (基于 C1 学术镜像)
```

**实际依赖:**
```json
{
  "dependencies": {
    "zod": "^3.24"
  },
  "devDependencies": {
    "typescript": "^5.8",
    "vitest": "^3.0"
  }
}
```

> **注:** 学术工具（LaTeX、Jupyter、PDF 等 40+ 工具）不在 agent-core 中，
> 而是通过 `loadWorkspaceToolsFromPlugin()` 从 `prismer-workspace` 插件动态加载。
> Cloud SDK 集成在 host 侧（`workspaceIM.ts`），容器内通过环境变量注入凭证。

**Cloud SDK 提供的免维护能力 (不计入 Agent Core LOC):**

| 能力 | SDK 方法 | 替代什么 |
|------|---------|---------|
| Agent 注册 | `im.account.register()` | OpenClaw Device Auth + auto-pair |
| 实时消息 | `im.realtime.connectWS()` | OpenClaw Gateway Protocol v3 |
| 消息收发 | `im.messages.send/getHistory()` | prismer-im Channel Plugin |
| Workspace 绑定 | `im.workspace.init()` | OpenClaw Session 绑定 |
| 文件传输 | `im.files.upload/sendFile()` | 自建文件传输 |
| Agent 发现 | `im.contacts.discover()` | 无 (新能力) |
| 内容检索 | `context.load/search()` | 无 (新能力) |
| PDF 解析 | `parse.parsePdf()` | 容器内 PDF 服务 (部分) |
| 离线队列 | `OfflineManager` | 无 (新能力) |
| E2E 加密 | `E2EEncryption` | 无 (新能力) |

---

## 3. 核心接口

### 3.1 Provider

```typescript
// Cherry-picked from: zeroclaw Provider trait + nanobot LLMProvider

interface ChatRequest {
  messages: Message[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

interface ChatResponse {
  text: string;
  toolCalls?: ToolCall[];
  thinking?: string;          // reasoning content (Kimi K2.5, Claude, etc.)
  usage?: { promptTokens: number; completionTokens: number };
}

interface Provider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  supportsNativeTools(): boolean;
  name(): string;
}
```

**实现:** `OpenAICompatibleProvider` — 覆盖 Prismer Gateway、OpenRouter、Ollama 等所有 OpenAI-compatible API。

### 3.2 Tool

```typescript
// Cherry-picked from: nanobot ToolRegistry + zeroclaw Tool trait

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema
  execute(args: Record<string, unknown>): Promise<string>;
}

class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getSpecs(): ToolSpec[];               // For LLM tool calling
  async execute(name: string, args: Record<string, unknown>): Promise<string>;
}
```

### 3.3 Observer

```typescript
// Cherry-picked from: zeroclaw Observer trait

type EventType =
  | 'agent_start' | 'agent_end'
  | 'subagent_start' | 'subagent_end'   // Sub-Agent 编排 (from OpenCode)
  | 'llm_request' | 'llm_response'
  | 'tool_call_start' | 'tool_call_end'
  | 'directive_emit'
  | 'doom_loop'                          // Doom-loop 检测 (from OpenCode)
  | 'error';

interface ObserverEvent {
  type: EventType;
  timestamp: number;
  data: Record<string, unknown>;
}

interface Observer {
  recordEvent(event: ObserverEvent): void;
  recordMetric(name: string, value: number): void;
  flush(): Promise<void>;
}
```

### 3.4 Memory (四层架构)

```typescript
// Cherry-picked from: nanobot two-layer memory + Cloud SDK context API

interface MemoryStore {
  // L1: 工作记忆 — session.messages，当前对话上下文
  // (由 Session 管理，不在此接口)

  // L2+L3: 本地记忆
  recall(query: string, limit?: number): Promise<string>;
  save(userInput: string, agentResponse: string): Promise<void>;
  saveDirective(directive: Directive): Promise<void>;
  consolidate(): Promise<void>;  // LLM-driven fact extraction (L2→L3)

  // L4: 云端记忆 (Cloud SDK)
  cloudRecall(query: string, topK?: number): Promise<ContextResult[]>;
  cloudSave(facts: string, meta: Record<string, string>): Promise<void>;
}
```

**四层实现:**

```
Memory 层级:
  ├── L1: 工作记忆 (session.messages) — 当前对话上下文，随 session 生存
  ├── L2: 短期记忆 (HISTORY.md) — 原始对话日志，grep 可搜索
  ├── L3: 长期记忆 (MEMORY.md) — LLM 周期性 consolidation 的事实
  └── L4: 云端记忆 (sdk.context) — 跨会话持久化，语义搜索
```

- `HISTORY.md` — L2 原始对话日志 (grep-searchable)
- `MEMORY.md` — L3 长期事实 (LLM 周期性 consolidation)
- `sdk.context.save/search` — L4 云端语义检索 (跨 workspace 持久化)

```typescript
// L4 Cloud Memory 实现
class CloudMemoryAdapter {
  constructor(private sdk: PrismerClient, private agentId: string) {}

  async save(facts: string, meta: Record<string, string>): Promise<void> {
    await this.sdk.context.save({
      url: `prismer://agent/${this.agentId}/memory/${Date.now()}`,
      hqcc: facts,
      visibility: 'private',
      meta: { agentId: this.agentId, ...meta },
    });
  }

  async recall(query: string, topK = 5): Promise<ContextResult[]> {
    const result = await this.sdk.context.search(query, {
      topK,
      ranking: { preset: 'relevance_first' },
    });
    return result.data?.results ?? [];
  }
}
```

### 3.5 Directive (Prismer 原生)

```typescript
// Prismer 自有协议 — 无需任何框架桥接

type DirectiveType =
  | 'switch_component'
  | 'update_content'
  | 'compile_complete'
  | 'jupyter_cell'
  | 'add_gallery_image'
  | 'notification'
  | 'update_task';

interface Directive {
  type: DirectiveType;
  payload: Record<string, unknown>;
  timestamp: string;
}

// Agent 直接写 JSON 文件到 /workspace/.prismer/directives/
function emitDirective(directive: Directive): void {
  const filename = `${Date.now()}-${directive.type}.json`;
  fs.writeFileSync(
    path.join('/workspace/.prismer/directives', filename),
    JSON.stringify(directive)
  );
}
```

### 3.6 Cloud SDK 集成 (cloud.ts)

```typescript
// Cloud SDK wrapper — Agent 注册 + IM 通信 + Context 检索

import { PrismerClient } from '@prismer/sdk';

interface CloudConfig {
  agentId: string;
  workspaceId: string;
  userId: string;
  userDisplayName: string;
  capabilities: string[];          // ['latex', 'jupyter', 'pdf', 'arxiv']
}

class CloudAgent {
  private sdk: PrismerClient;
  private token: string | null = null;

  async register(config: CloudConfig): Promise<void> {
    const reg = await this.sdk.im.account.register({
      type: 'agent',
      username: `agent-${config.agentId}`,
      displayName: `Prismer Agent ${config.agentId}`,
      agentType: 'specialist',
      capabilities: config.capabilities,
    });
    this.token = reg.data!.token;
    this.sdk.setToken(this.token);

    // 绑定到 workspace
    await this.sdk.im.workspace.init({
      workspaceId: config.workspaceId,
      userId: config.userId,
      userDisplayName: config.userDisplayName,
    });
  }

  async connectRealtime(onMessage: (msg: IMMessage) => void): Promise<void> {
    const ws = this.sdk.im.realtime.connectWS({ token: this.token! });
    ws.on('message.new', onMessage);
    ws.on('disconnect', () => {
      // 自动重连由 SDK 处理 (OfflineManager)
    });
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    await this.sdk.im.messages.send(conversationId, text);
  }

  async sendFile(conversationId: string, filePath: string): Promise<void> {
    const uploaded = await this.sdk.im.files.upload(filePath);
    await this.sdk.im.files.sendFile(conversationId, uploaded.data!.fileId);
  }

  // Context API — 内容检索 + 缓存
  async loadContext(url: string): Promise<string> {
    const result = await this.sdk.context.load({ url });
    return result.data?.content ?? '';
  }

  async searchContext(query: string, topK = 5): Promise<ContextResult[]> {
    const result = await this.sdk.context.search(query, {
      topK,
      ranking: { preset: 'relevance_first' },
    });
    return result.data?.results ?? [];
  }
}
```

### 3.7 IM ↔ Agent Bridge (bridge.ts)

```typescript
// 桥接 Cloud IM 消息与 Agent Loop

interface BridgeConfig {
  cloud: CloudAgent;
  agent: PrismerAgent;
  observer: Observer;
}

class IMAgentBridge {
  private sessions = new Map<string, Session>();

  async start(config: BridgeConfig): Promise<void> {
    await config.cloud.connectRealtime(async (msg) => {
      const { conversationId, content, sender } = msg;

      config.observer.recordEvent({
        type: 'agent_start',
        timestamp: Date.now(),
        data: { source: 'im', conversationId, sender: sender.username },
      });

      // 获取或创建 session
      let session = this.sessions.get(conversationId);
      if (!session) {
        session = new Session(conversationId);
        this.sessions.set(conversationId, session);
      }

      // Agent Loop 处理
      const result = await config.agent.processMessage(content, session);

      // 回复消息
      await config.cloud.sendMessage(conversationId, result.text);

      // 发送 directives (通过文件系统 — 兼容现有 Bridge API)
      for (const directive of result.directives) {
        emitDirective(directive);
      }

      config.observer.recordEvent({
        type: 'agent_end',
        timestamp: Date.now(),
        data: { conversationId, toolsUsed: result.toolsUsed },
      });
    });
  }

  // Session 清理 — 5 分钟无活动则移除
  startSessionCleanup(intervalMs = 300_000): void {
    setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastActivity > intervalMs) {
          this.sessions.delete(id);
        }
      }
    }, intervalMs);
  }
}
```

**通信模式对比:**

| | OpenClaw (当前) | Cloud SDK (目标) |
|--|----------------|-----------------|
| Agent → Cloud | Plugin registerChannel → Gateway WS | `sdk.im.messages.send()` |
| Cloud → Agent | Gateway WS → Plugin onMessage | `sdk.im.realtime.connectWS()` |
| 认证 | Ed25519 Device Auth | JWT Token (`im.account.register()`) |
| 状态 | Gateway session (stateful WS) | Stateless REST + WS events |
| 离线 | 无 | OfflineManager 自动队列 |
| 文件 | 手动 base64 编码 | `im.files.upload()` (最大 50MB) |
| Agent 发现 | 无 | `im.contacts.discover()` |
| 加密 | 无 | E2E Encryption (可选) |

### 3.8 Sub-Agent 架构 (agents.ts)

```typescript
// Cherry-picked from: OpenCode multi-agent architecture

type AgentMode = 'primary' | 'subagent' | 'hidden';

interface AgentConfig {
  id: string;
  name: string;
  mode: AgentMode;
  systemPrompt: string;
  model?: string;                              // 可覆盖默认模型
  tools?: string[];                            // 允许使用的工具列表 (null = 全部)
  permissions?: AgentPermission[];             // per-tool 权限
  maxIterations?: number;                      // 覆盖默认 40
}

interface AgentPermission {
  permission: 'read' | 'write' | 'execute' | 'bash';
  pattern: string;                             // glob pattern (e.g. "*.env", "npm run *")
  action: 'allow' | 'deny' | 'ask';
}

class AgentRegistry {
  private agents = new Map<string, AgentConfig>();

  register(config: AgentConfig): void;
  get(id: string): AgentConfig | undefined;
  list(mode?: AgentMode): AgentConfig[];

  // @-mention 路由: "@latex-expert 编译这个项目"
  resolveFromMention(content: string): { agentId: string; message: string } | null;
}
```

**Prismer 学术 Sub-Agent 设计:**

| Agent | Mode | 模型 | 工具权限 | 用途 |
|-------|------|------|---------|------|
| **researcher** | Primary | us-kimi-k2.5 | 全部 | 默认研究助手，协调其他 Agent |
| **latex-expert** | Subagent | us-kimi-k2.5 | latex_compile, latex_project, switch_component | LaTeX 文档编写和编译 |
| **data-analyst** | Subagent | us-kimi-k2.5 | jupyter_execute, jupyter_notebook, ag_grid | 数据分析和可视化 |
| **literature-scout** | Subagent | us-kimi-k2.5 | arxiv_search, load_pdf, context_search | 文献检索和摘要 |
| **compaction** | Hidden | — (内部) | 无 | 会话摘要和压缩 |
| **summarizer** | Hidden | — (内部) | 无 | 生成会话标题 |

**Sub-Agent 编排模式:**

```typescript
// 1. Primary Agent 路由: 识别用户意图，调度 Sub-Agent
class PrismerAgent {
  async processMessage(input: string, session: Session): Promise<AgentResult> {
    // 检查 @-mention 显式调用
    const mention = this.agents.resolveFromMention(input);
    if (mention) {
      return this.delegateToSubAgent(mention.agentId, mention.message, session);
    }

    // 正常 Agent Loop (可能通过 tool call 触发 sub-agent)
    // ... 见 Section 4
  }

  // 2. Sub-Agent 并行执行
  async delegateToSubAgent(
    agentId: string,
    message: string,
    parentSession: Session
  ): Promise<AgentResult> {
    const config = this.agents.get(agentId);
    if (!config || config.mode === 'hidden') throw new Error(`Agent not found: ${agentId}`);

    // 创建子 session — 继承父 session 上下文但独立消息历史
    const subSession = parentSession.createChild(agentId);

    // 过滤工具 — 只保留该 Agent 允许的工具
    const filteredTools = this.filterToolsByPermission(config);

    // 用 sub-agent 的 system prompt + 模型运行
    const subAgent = new PrismerAgent({
      provider: this.provider,
      tools: filteredTools,
      memory: this.memory,
      observer: this.observer,
      systemPrompt: config.systemPrompt,
      model: config.model ?? this.model,
      maxIterations: config.maxIterations ?? 20,  // sub-agent 限制更严
    });

    this.observer.recordEvent({
      type: 'subagent_start',
      timestamp: Date.now(),
      data: { parentAgent: this.config.id, subAgent: agentId },
    });

    const result = await subAgent.processMessage(message, subSession);

    this.observer.recordEvent({
      type: 'subagent_end',
      timestamp: Date.now(),
      data: { subAgent: agentId, toolsUsed: result.toolsUsed },
    });

    return result;
  }

  // 3. Doom-loop 检测 (from OpenCode)
  private checkDoomLoop(toolsUsed: string[], results: ToolResult[]): boolean {
    const recentFailures = results.slice(-3).filter(r => r.error);
    return recentFailures.length >= 3;
  }
}
```

**内置 `delegate` 工具 — Primary Agent 可以通过 tool call 调度 Sub-Agent:**

```typescript
// 注册为 Agent 的内置工具
const delegateTool: Tool = {
  name: 'delegate',
  description: 'Delegate a task to a specialized sub-agent. Available agents: latex-expert (LaTeX writing/compilation), data-analyst (Jupyter/data analysis), literature-scout (paper search/PDF reading).',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', enum: ['latex-expert', 'data-analyst', 'literature-scout'] },
      task: { type: 'string', description: 'The task to delegate' },
    },
    required: ['agent', 'task'],
  },
  async execute(args, context) {
    return context.delegateToSubAgent(args.agent, args.task, context.session);
  },
};
```

---

## 4. Agent Loop 详细设计

```typescript
// Cherry-picked from: nanobot (清晰分层) + zeroclaw (并行执行 + Observer) + OpenCode (doom-loop)

class PrismerAgent {
  private readonly maxIterations = 40;

  async processMessage(input: string, session: Session): Promise<AgentResult> {
    this.observer.recordEvent({ type: 'agent_start', timestamp: Date.now(), data: { input } });

    // 1. 构建上下文 (from nanobot pattern)
    const memoryContext = await this.memory.recall(input, 5);
    const messages = session.buildMessages(input, memoryContext, this.systemPrompt);
    const toolSpecs = this.tools.getSpecs();

    let iteration = 0;
    const toolsUsed: string[] = [];

    while (iteration++ < this.maxIterations) {
      // 2. 调用 LLM (from zeroclaw pattern — observer 包裹)
      const startMs = Date.now();
      this.observer.recordEvent({ type: 'llm_request', timestamp: startMs, data: { iteration, model: this.model } });

      const response = await this.provider.chat({ messages, tools: toolSpecs, model: this.model });

      this.observer.recordEvent({ type: 'llm_response', timestamp: Date.now(), data: {
        duration_ms: Date.now() - startMs,
        hasToolCalls: !!response.toolCalls?.length,
        usage: response.usage,
      }});

      // 保留 thinking content (from zeroclaw pattern)
      messages.push({
        role: 'assistant',
        content: response.text,
        thinking: response.thinking,
        toolCalls: response.toolCalls,
      });

      // 3. 无 tool call → 最终响应
      if (!response.toolCalls?.length) {
        await this.memory.save(input, response.text);
        this.observer.recordEvent({ type: 'agent_end', timestamp: Date.now(), data: { iterations: iteration, toolsUsed } });
        return { text: response.text, directives: session.pendingDirectives, toolsUsed };
      }

      // 4. 执行工具 — 并行 (from zeroclaw pattern)
      const results = await Promise.all(
        response.toolCalls.map(async (call) => {
          this.observer.recordEvent({ type: 'tool_call_start', timestamp: Date.now(), data: { name: call.name } });
          const result = await this.tools.execute(call.name, call.arguments);
          this.observer.recordEvent({ type: 'tool_call_end', timestamp: Date.now(), data: { name: call.name, resultLength: result.length } });
          toolsUsed.push(call.name);

          // Directive 检测 — Prismer 原生
          if (call.name.startsWith('switch_') || call.name.startsWith('update_') || call.name === 'send_ui_directive') {
            session.addPendingDirective(this.parseDirective(call, result));
          }

          return { id: call.id, output: result };
        })
      );

      // 5. 追加 tool results (from nanobot pattern)
      for (const r of results) {
        messages.push({ role: 'tool', toolCallId: r.id, content: r.output });
      }

      // 6. Doom-loop 检测 (from OpenCode pattern)
      const recentErrors = results.slice(-3).filter(r => r.error);
      if (recentErrors.length >= 3) {
        this.observer.recordEvent({ type: 'error', timestamp: Date.now(), data: { reason: 'doom_loop', recentErrors } });
        return { text: '[doom loop detected — 3+ consecutive tool failures]', directives: session.pendingDirectives, toolsUsed };
      }

      // 7. Sub-Agent 路由 — delegate 工具触发 (from OpenCode pattern)
      const delegateCall = response.toolCalls?.find(c => c.name === 'delegate');
      if (delegateCall) {
        const subResult = await this.delegateToSubAgent(
          delegateCall.arguments.agent,
          delegateCall.arguments.task,
          session
        );
        messages.push({ role: 'tool', toolCallId: delegateCall.id, content: subResult.text });
      }
    }

    return { text: '[max iterations reached]', directives: session.pendingDirectives, toolsUsed };
  }
}
```

---

## 5. IPC 协议

### 5.1 Host → Container (stdin)

```json
{
  "type": "message",
  "content": "用户消息 + workspace context",
  "sessionId": "session-xxx",
  "config": {
    "model": "us-kimi-k2.5",
    "agentId": "agent-xxx",
    "workspaceId": "ws-xxx",
    "tools": ["latex_compile", "jupyter_execute", "switch_component"]
  }
}
```

### 5.2 Container → Host (stdout)

```
---PRISMER_OUTPUT_START---
{
  "status": "success",
  "response": "Agent 回复文本",
  "thinking": "可选 — reasoning content",
  "directives": [
    { "type": "switch_component", "payload": { "component": "latex-editor" } }
  ],
  "toolsUsed": ["latex_compile", "switch_component"],
  "usage": { "promptTokens": 1234, "completionTokens": 567 },
  "sessionId": "session-xxx"
}
---PRISMER_OUTPUT_END---
```

### 5.3 Container → Host (filesystem IPC — 实时)

```
/workspace/.prismer/
├── directives/            # UI 指令 (Agent 写，Host 读后清除)
│   ├── 1709123456-switch_component.json
│   └── 1709123457-update_content.json
├── messages/              # 中间消息 (进度更新)
│   └── 1709123458-progress.json
└── memory/                # 持久化记忆
    ├── MEMORY.md
    └── HISTORY.md
```

---

## 6. 与五框架的对比

| 维度 | Prismer Agent Core | OpenClaw | nanoclaw | nanobot | zeroclaw | OpenCode |
|------|-------------------|----------|----------|---------|----------|----------|
| 语言 | TypeScript | TypeScript | TypeScript | Python | Rust | TypeScript (Bun) |
| 核心 LOC | **4,665** | ~892K | ~7,600 | ~3,922 | ~217,000 | ~233,000 |
| 依赖 | **1** (zod) | 200+ | 11 | 15+ | 40+ | 200+ |
| Provider | OpenAI-compatible | 自有 | Claude SDK | LiteLLM | 12+ 内置 | @ai-sdk 20+ |
| 工具 | MCP + 内置学术 | 60+ 内置 | MCP | Registry | 60+ 内置 + MCP | 30+ 内置 + MCP |
| **Sub-Agent** | **学术专家 Agent** | 无 | 无 | 无 | 无 | **5+ 内置** |
| Memory | **四层** (file+cloud) | 无 (外部) | SQLite | 两层文件 + LLM | SQLite/MD/PG | SQLite (Drizzle) |
| IM 通信 | **Cloud SDK** (免维护) | Gateway WS v3 | 无 | 无 | 25+ channels | 无 |
| 可观测性 | **Observer Day 1** | 部分 | 无 | loguru | Observer trait | 部分 |
| Directive | **原生** | 无 | 无 | 无 | 无 | 无 |
| Permission | **Per-agent + per-tool** | Device Auth | Mount allowlist | 无 | Pairing + Autonomy | **Per-agent + per-tool** |
| 离线支持 | **SDK OfflineManager** | 无 | 无 | 无 | 无 | 无 |
| 社区 | **无** ⚠️ | OpenClaw 上游 | nanoclaw 上游 | nanobot 上游 | zeroclaw 上游 | **MIT 4.6M+ DL** |

**LOC 拆分 (4,665 自研):**

| 模块 | LOC | 来源 | Phase |
|------|-----|------|-------|
| `agent.ts` | 592 | nanobot + zeroclaw + OpenCode | P1 + P3 + P4.5 |
| `server.ts` | 492 | Hono HTTP/WS pattern | P1.5 + P4.5 |
| `provider.ts` | 378 | zeroclaw trait + FallbackProvider | P1 + P2 |
| `index.ts` | 366 | — | P1 + P2 |
| `tools/clawhub.ts` | 240 | nanoclaw Skills | P4 |
| `prompt.ts` | 235 | OpenCode composable prompt | P2 |
| `cli.ts` | 193 | — | P1.5 |
| `skills.ts` | 178 | nanoclaw SKILL.md | P2 |
| `channels/cloud-im.ts` | 177 | Cloud SDK IM | P4 |
| `channels/telegram.ts` | 171 | Bot API | P4 |
| `tools/loader.ts` | 159 | prismer-workspace adapter | P2 |
| `workspace.ts` | 154 | OpenCode + nanoclaw | P2 |
| `agents.ts` | 149 | **OpenCode** multi-agent | P1 |
| `sse.ts` | 144 | **OpenCode** Bus + Zod | P1 + P4.5 |
| `compaction.ts` | 141 | **OpenCode** compaction agent | P3 |
| `session.ts` | 138 | nanobot + OpenCode | P1 + P3 |
| `memory.ts` | 118 | nanobot | P3 |
| `observer.ts` | 115 | zeroclaw Observer | P1 |
| `ipc.ts` | 109 | nanoclaw | P1 |
| `hooks.ts` | 99 | **OpenCode** Plugin hooks | P3 |
| `tools.ts` | 96 | nanobot | P1 |
| `channels/manager.ts` | 87 | nanoclaw | P4 |
| `directives.ts` | 70 | Prismer 独有 | P2 |
| `channels/types.ts` | 34 | — | P4 |
| `tools/index.ts` | 16 | — | P1 |
| `schemas.ts` | 14 | — | P1 |
| **合计** | **4,665** | **五框架 + Cloud SDK** | **P1-P4.5** |

> **对比初始估算:** 从 ~1,050 LOC 增长到 4,665 LOC，主要因为增加了：
> HTTP/WS 网关 (server.ts 492)、FallbackProvider 链 (provider.ts 378)、
> PromptBuilder 动态提示词 (prompt.ts 235)、Channel Plugin 系统 (channels/ 469)、
> ClawHub Skill 安装 (clawhub.ts 240)、上下文压缩 (compaction.ts 141)、
> 生命周期钩子 (hooks.ts 99)、Directive 文件扫描 (agent.ts 中)。
> 这些在原始设计时未预见，但都是生产环境必需的能力。

---

## 7. 实施路径

> 详细路线图参见 `ROADMAP.md`。**所有核心 Phase 已完成。**

### Phase 0: AgentTransport 适配层 — ✅ 跳过

后续集成时再做。Lumin 通过 `luminGatewayClient.ts` 在 host 侧直接通信。

### Phase 1 + 1.5: Agent Loop + SSE + CLI + HTTP/WS 网关 — ✅ 完成 (2,635 LOC)

- [x] `agent.ts` — Agent Loop + Sub-Agent + doom-loop + context guard
- [x] `agents.ts` — AgentRegistry + 6 内置学术 Agent + Permission
- [x] `sse.ts` — EventBus + SSE writer (Zod schema)
- [x] `provider.ts` — OpenAI-compatible Provider + FallbackProvider
- [x] `tools.ts` — Tool Registry + 分发
- [x] `observer.ts` — Observer interface
- [x] `ipc.ts` — stdin/stdout JSON 协议
- [x] `session.ts` — Session + child sessions
- [x] `server.ts` — HTTP + WebSocket 网关
- [x] `cli.ts` — CLI 入口 + 子命令路由
- [x] 测试: 8 个 LLM 集成测试通过

### Phase 2: OpenClaw 能力集成 — ✅ 完成 (3,349 LOC)

- [x] `prompt.ts` — PromptBuilder 动态 system prompt (SOUL.md/TOOLS.md/Skills)
- [x] `skills.ts` — SKILL.md 加载 + YAML frontmatter + 缓存
- [x] `workspace.ts` — 文件安全中间件
- [x] `directives.ts` — Zod schema directive
- [x] `tools/loader.ts` — prismer-workspace 插件工具加载 + Cloud IM 凭证注入
- [x] 集成测试: PromptBuilder + Skills + Config flow

> **注:** 学术工具 (LaTeX/Jupyter/PDF 等) 不在 agent-core 中实现，
> 已由 `prismer-workspace` 插件模块化覆盖，通过 `loadWorkspaceToolsFromPlugin()` 动态加载。

### Phase 3: Context Engineering + Memory + Hooks — ✅ 完成 (3,873 LOC)

- [x] `compaction.ts` — 上下文压缩 + memory flush + orphaned tool result repair
- [x] `memory.ts` — 关键词记忆存储 (/workspace/.prismer/memory/YYYY-MM-DD.md)
- [x] `hooks.ts` — 生命周期钩子 (before_prompt, before_tool, after_tool, agent_end)

### Phase 4: Cloud SDK + Skills + Channels — ✅ 完成 (4,665 LOC)

- [x] `tools/clawhub.ts` — ClawHub CLI Skill 自安装
- [x] `channels/cloud-im.ts` — Cloud IM channel (Prismer Cloud SSE)
- [x] `channels/telegram.ts` — Telegram Bot channel
- [x] `channels/manager.ts` — Channel 管理器

### Phase 4.5: 平台集成层 — ✅ 完成 (+130 LOC host 侧)

- [x] Directive 文件扫描 — `agent.ts` 工具执行后扫描 `/workspace/.openclaw/directives/`
- [x] Tool ID/Args 配对 — `bus.publish` / WS 转发含 toolId/args
- [x] Bridge directive 提取 — 拦截 `__directive` → 重发为原生 directive SSE
- [x] 前端 directive handler — `useContainerChat.ts` case 'directive'
- [x] K8s Warm Pool — runtime label/过滤/端口/淘汰逻辑
- [x] 验证: Tool ID `update_notes:0` 配对 ✓, Directive `SWITCH_COMPONENT` + `UPDATE_NOTES` 实时到达 ✓

### Phase 5 (Week 7-8): PrismerAgentTransport + npm 包

- [ ] `PrismerAgentTransport` 实现 AgentTransport 接口
- [ ] `@prismer/agent-core` npm 包打包 + exports map
- [ ] 验证矩阵: T0-T3 + SSE + Sub-Agent + Skill + Scheduler

### Phase 6 (Week 8-10): 生产加固

- [ ] 重试 + circuit breaker (~50 LOC)
- [ ] Streaming + on_delta (~60 LOC)
- [ ] Approval Gate (~40 LOC)
- [ ] 错误恢复 (~60 LOC)
- [ ] SSE 背压控制 (~30 LOC)

### Phase 7 (Week 10+): 清理 OpenClaw

- [ ] 移除 OpenClaw runtime + plugins
- [ ] 更新容器镜像
- [ ] 更新文档

---

## 8. 失去与获得

### 失去

| 能力 | 影响 | 缓解 |
|------|------|------|
| 社区 LLM 新特性跟进 | 中 | OpenAI-compatible 覆盖 90%+，新特性按需添加 |
| 多 Provider 原生支持 | 低 | Prismer Gateway 统一入口，Agent Core 只需一个 Provider |
| 内置安全加固 | 中 | Cloud SDK JWT + 容器隔离已足够，Autonomy 按需后加 |
| Channel 生态 | 低 | Cloud SDK `im.bindings` 按需开启社交桥接 |
| MCP 协议演进 | 低 | 使用 `@modelcontextprotocol/sdk` 官方包自动跟进 |

### 获得

| 能力 | 价值 |
|------|------|
| **100% 源码掌控** | 每行代码可审计，出问题不需要深入 892K LOC 黑盒 |
| **零版本耦合** | 不再受 OpenClaw/nanoclaw/zeroclaw 的 breaking change 影响 |
| **可观测性原生** | Observer 从 Day 1 设计，而非后补 — 更好的生产调试体验 |
| **Directive 原生** | SWITCH_COMPONENT 等指令不需要任何桥接层 |
| **Cloud SDK 免维护** | IM、文件、Agent 发现、离线同步、E2E 加密 — 全部零维护成本 |
| **四层记忆系统** | 本地 + 云端语义检索，比任何单一框架的 Memory 都更完整 |
| **极致可维护** | ~1650 LOC 自研 + SDK 免维护能力 — 一个人可以完全理解 |
| **学术场景优化** | 工具和协议为学术研究场景定制，不是通用框架的插件 |
| **容器镜像精简** | Node.js + ~1650 LOC + 学术服务 = 比 OpenClaw 小 60%+ |

---

## 9. Cloud SDK 集成架构

```
                    ┌─────────────────────────┐
                    │  Prismer Cloud           │
                    │  ┌───────────────────┐   │
                    │  │ IM Service        │   │
                    │  │ (WebSocket/SSE)   │   │
                    │  └────────┬──────────┘   │
                    │           │              │
                    │  ┌────────┴──────────┐   │
                    │  │ Context Service   │   │
                    │  │ (HQCC + Search)   │   │
                    │  └───────────────────┘   │
                    └───────────┬──────────────┘
                                │
            ┌───────────────────┼────────────────────┐
            │                   │                    │
    ┌───────┴────────┐  ┌──────┴───────┐  ┌────────┴──────┐
    │ Frontend       │  │ Agent Core    │  │ Other Agents  │
    │ (Workspace)    │  │ (Container)   │  │ (可选)        │
    │                │  │               │  │               │
    │ SDK.im.send()  │  │ cloud.ts      │  │ SDK.im.send() │
    │                │  │ bridge.ts     │  │               │
    │                │  │   ↕           │  │               │
    │                │  │ agent.ts      │  │               │
    │                │  │ memory.ts L4  │  │               │
    └────────────────┘  └──────────────┘  └───────────────┘
```

**数据流:**
1. 用户在 Frontend 发消息 → `sdk.im.messages.send()` → Cloud IM Service
2. Cloud IM → WebSocket 推送 → Agent `cloud.ts` 接收
3. `bridge.ts` 路由到 `agent.ts` 的 `processMessage()`
4. Agent Loop 执行工具 → 生成 directives → **SSE 实时推送** → Frontend
5. Agent 回复 → `cloud.ts` → `sdk.im.messages.send()` → Cloud IM → Frontend
6. 重要发现 → `memory.ts` L4 → `sdk.context.save()` → 云端持久化

---

## 10. 七大核心能力深度设计

> 以下七个维度是 Prismer Agent Core 的真正核心诉求，从五个框架中提取最佳模式。
> 目标: 独立 npm 包 `@prismer/agent-core`，schema-driven (Zod)，TypeScript 原生。

### 10.1 文件系统中间件 (workspace.ts ~80 LOC)

**框架对比:**
| | OpenCode | nanoclaw | zeroclaw | 我们的设计 |
|--|---------|----------|----------|-----------|
| 文件监听 | @parcel/watcher | Docker mount | 无 | **chokidar + debounce** |
| 沙箱 | 词法路径检查 | 容器级隔离 | Landlock/Firejail | **容器级 + 路径白名单** |
| Ignore | .gitignore + 硬编码 | 无 | 无 | **.gitignore + 配置** |
| 差异生成 | structuredPatch | 无 | 无 | **简化 diff** |

```typescript
// @prismer/agent-core/src/workspace.ts

import { z } from 'zod';

export const WorkspaceConfig = z.object({
  root: z.string(),                          // /workspace
  allowedPaths: z.array(z.string()),         // 白名单目录
  ignorePaths: z.array(z.string()),          // .git, node_modules, ...
  watchEnabled: z.boolean().default(false),
});

export interface WorkspaceMiddleware {
  // 安全读写 — 所有文件操作必须经过这层
  read(path: string): Promise<{ content: string; mime: string }>;
  write(path: string, content: string): Promise<void>;
  list(dir: string, pattern?: string): Promise<string[]>;

  // 路径安全检查 (from OpenCode)
  validatePath(path: string): boolean;       // 拒绝 ../ 和白名单外路径

  // 文件变更事件 (from OpenCode @parcel/watcher)
  watch(callback: (event: FileEvent) => void): () => void;

  // 差异追踪 — 用于 Timeline
  getDiff(path: string): Promise<FileDiff | null>;
}

type FileEvent = { type: 'create' | 'update' | 'delete'; path: string };
type FileDiff = { path: string; hunks: DiffHunk[] };
```

**设计决策:**
- 所有 Tool 的文件操作必须经过 WorkspaceMiddleware — 不允许直接 fs 调用
- 路径白名单 + 容器隔离双重防护 (from nanoclaw mount allowlist)
- 文件变更事件驱动 Timeline 更新 (from OpenCode file watcher)

---

### 10.2 UI Directive 能力 (directives.ts ~100 LOC)

**框架对比:** 五个框架中**没有任何一个**有类似 Prismer 的 Directive 协议 — 这是我们的独有优势。

**增强设计 — 从文件轮询到 SSE 推送:**

```typescript
// @prismer/agent-core/src/directives.ts

import { z } from 'zod';

// Schema-driven Directive 类型 — Zod 验证确保类型安全
export const DirectiveSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('switch_component'), payload: z.object({
    component: z.enum(['latex-editor', 'jupyter-notebook', 'pdf-reader', 'ai-editor', 'code-playground', 'ag-grid', 'bento-gallery', 'three-viewer']),
    config: z.record(z.unknown()).optional(),
  })}),
  z.object({ type: z.literal('update_content'), payload: z.object({
    component: z.string(),
    content: z.string(),
    append: z.boolean().default(false),
  })}),
  z.object({ type: z.literal('compile_complete'), payload: z.object({
    success: z.boolean(),
    output: z.string().optional(),
    pdfUrl: z.string().optional(),
    errors: z.array(z.string()).optional(),
  })}),
  z.object({ type: z.literal('jupyter_cell'), payload: z.object({
    cellId: z.string(),
    source: z.string(),
    outputs: z.array(z.unknown()),
  })}),
  z.object({ type: z.literal('add_gallery_image'), payload: z.object({
    url: z.string(),
    caption: z.string().optional(),
  })}),
  z.object({ type: z.literal('notification'), payload: z.object({
    level: z.enum(['info', 'warning', 'error']),
    message: z.string(),
  })}),
  z.object({ type: z.literal('update_task'), payload: z.object({
    taskId: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    progress: z.number().min(0).max(100).optional(),
  })}),
]);

export type Directive = z.infer<typeof DirectiveSchema>;

// 双通道输出 — SSE 实时 + 文件系统兼容
export class DirectiveEmitter {
  private sseClients = new Set<(directive: Directive) => void>();
  private fileDir: string;

  constructor(config: { fileDir: string }) {
    this.fileDir = config.fileDir;
  }

  emit(directive: Directive): void {
    // 1. Zod 验证
    DirectiveSchema.parse(directive);

    // 2. SSE 实时推送 (主通道)
    for (const client of this.sseClients) {
      client(directive);
    }

    // 3. 文件系统写入 (兼容通道 — Bridge API 回读)
    const filename = `${Date.now()}-${directive.type}.json`;
    fs.writeFileSync(
      path.join(this.fileDir, filename),
      JSON.stringify({ ...directive, timestamp: new Date().toISOString() })
    );

    this.observer?.recordEvent({ type: 'directive_emit', timestamp: Date.now(), data: directive });
  }

  // SSE 订阅接口
  subscribe(callback: (directive: Directive) => void): () => void {
    this.sseClients.add(callback);
    return () => this.sseClients.delete(callback);
  }
}
```

**npm 包导出 — schema-driven 的价值:**
```typescript
// 前端可以直接 import Directive schema 做类型安全的消费
import { DirectiveSchema, type Directive } from '@prismer/agent-core';

// 验证从 SSE 收到的数据
const parsed = DirectiveSchema.safeParse(sseEvent.data);
if (parsed.success) {
  handleDirective(parsed.data); // 完全类型安全
}
```

---

### 10.3 Skill 扩展和自进化 (skills.ts ~120 LOC)

**框架对比:**
| | nanoclaw | OpenCode | zeroclaw | 我们的设计 |
|--|---------|----------|----------|-----------|
| 加载方式 | git merge-file 3 向合并 | Markdown + Plugin hooks | template + audit | **声明式 YAML + 运行时注入** |
| 工具注入 | Skill 修改 index.ts 注入 MCP | Plugin.tool{} | symlink | **Skill 注册 MCP Server** |
| 自进化 | rebase + customize session | 无 | 无 | **LLM-driven skill generation** |
| 分发 | git repo | npm package | registry | **npm 包 + workspace 本地** |

```typescript
// @prismer/agent-core/src/skills.ts

import { z } from 'zod';

export const SkillManifest = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  // 工具注入 — Skill 声明它提供的 MCP 工具
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    handler: z.string(),            // 相对路径: './tools/custom-analysis.ts'
  })).optional(),
  // Agent 注入 — Skill 可以声明新的 Sub-Agent
  agents: z.array(z.object({
    id: z.string(),
    mode: z.enum(['subagent', 'hidden']),
    prompt: z.string(),
    tools: z.array(z.string()),
  })).optional(),
  // Context 注入 — Skill 提供的 system prompt 片段
  context: z.string().optional(),    // 注入到 Agent system prompt
  // 依赖声明
  dependencies: z.record(z.string()).optional(),
});

export type SkillManifest = z.infer<typeof SkillManifest>;

export class SkillLoader {
  // 发现 + 加载 Skills
  async discover(paths: string[]): Promise<SkillManifest[]> {
    // 扫描 .prismer/skills/**/manifest.yaml
    // 支持: workspace 本地、npm 包、全局目录
  }

  // 运行时注入 — 将 Skill 的工具/Agent/Context 注入到 Agent Core
  async inject(skill: SkillManifest, registry: {
    tools: ToolRegistry;
    agents: AgentRegistry;
    systemPrompt: string[];
  }): Promise<void> {
    // 1. 注册 Skill 提供的工具
    for (const tool of skill.tools ?? []) {
      const handler = await import(tool.handler);
      registry.tools.register(handler.default);
    }
    // 2. 注册 Skill 提供的 Sub-Agent
    for (const agent of skill.agents ?? []) {
      registry.agents.register(agent);
    }
    // 3. 注入 Skill 的 context 到 system prompt
    if (skill.context) {
      registry.systemPrompt.push(skill.context);
    }
  }
}
```

**自进化能力 — LLM 驱动的 Skill 生成:**
```typescript
// Agent 可以在运行时创建新 Skill
const createSkillTool: Tool = {
  name: 'create_skill',
  description: 'Create a new skill manifest with tools and context for future sessions',
  parameters: { /* skill manifest schema */ },
  async execute(args) {
    // 1. LLM 生成 manifest.yaml + tool handlers
    // 2. 写入 /workspace/.prismer/skills/<name>/
    // 3. 下次 Agent 启动时自动加载
    // 4. 实现"自进化" — Agent 学会新技能后永久保留
  }
};
```

---

### 10.4 Context Engineering (context.ts ~100 LOC)

**框架对比:**
| | OpenCode | nanoclaw | zeroclaw | 我们的设计 |
|--|---------|----------|----------|-----------|
| System Prompt | Provider-specific + 动态 | CLAUDE.md | Policy constraints | **可组合 + Plugin 拦截** |
| 工具描述注入 | AI SDK auto | Claude SDK | trait | **手动精选 + 权限过滤** |
| 上下文窗口管理 | Compaction agent | 无 | auto_compact | **Compaction Agent + 摘要** |
| 缓存优化 | 前缀不变 → cache hit | 无 | 无 | **稳定前缀 + 可变尾部** |

```typescript
// @prismer/agent-core/src/context.ts

import { z } from 'zod';

export const ContextConfig = z.object({
  // 系统提示词组合策略 (from OpenCode composable prompts)
  systemPrompt: z.object({
    base: z.string(),                 // 稳定基础提示 (cache-friendly)
    agentSpecific: z.string(),        // 当前 Agent 的角色定义
    skills: z.array(z.string()),      // Skill 注入的 context 片段
    workspace: z.string().optional(), // 工作区上下文 (项目结构等)
    custom: z.string().optional(),    // 用户自定义 (per-request)
  }),
  // 上下文窗口管理
  maxContextTokens: z.number().default(128000),
  compactionThreshold: z.number().default(0.8),  // 80% 时触发
  reservedOutputTokens: z.number().default(8192),
});

export class ContextBuilder {
  // 组合系统提示词 — 分层拼接，保持前缀稳定 (缓存友好)
  buildSystemPrompt(config: ContextConfig, agent: AgentConfig): string[] {
    return [
      // Layer 1: 稳定基础 (几乎不变 → LLM cache hit)
      config.systemPrompt.base,
      // Layer 2: Agent 角色定义
      config.systemPrompt.agentSpecific || agent.systemPrompt,
      // Layer 3: Skill 注入
      ...config.systemPrompt.skills,
      // Layer 4: 工作区上下文 (可变)
      config.systemPrompt.workspace,
      // Layer 5: 用户自定义 (最易变)
      config.systemPrompt.custom,
    ].filter(Boolean) as string[];
  }

  // 工具描述注入 — 只注入当前 Agent 有权限的工具
  buildToolSpecs(tools: ToolRegistry, agent: AgentConfig): ToolSpec[] {
    return tools.getSpecs()
      .filter(t => !agent.tools || agent.tools.includes(t.name));
  }

  // 上下文溢出检测 + 自动 Compaction (from OpenCode)
  async checkAndCompact(
    messages: Message[],
    tokenCount: number,
    config: ContextConfig,
    compactionAgent: PrismerAgent
  ): Promise<Message[]> {
    const threshold = config.maxContextTokens * config.compactionThreshold;
    if (tokenCount < threshold) return messages;

    // 使用 hidden compaction agent 摘要旧消息
    const oldMessages = messages.slice(0, -4); // 保留最近 4 条
    const summary = await compactionAgent.processMessage(
      `Summarize this conversation for context continuity:\n${JSON.stringify(oldMessages)}`,
      new Session('compaction')
    );

    return [
      { role: 'system', content: `[Previous conversation summary]\n${summary.text}` },
      ...messages.slice(-4),
    ];
  }
}
```

---

### 10.5 Memory Recall (memory.ts ~150 LOC, 扩展)

**框架对比:**
| | OpenCode | nanoclaw | zeroclaw | 我们的设计 |
|--|---------|----------|----------|-----------|
| 存储后端 | SQLite (Drizzle) | SQLite | 5+ (含向量) | **SQLite 本地 + Cloud SDK L4** |
| 搜索方式 | 全文 | timestamp range | **向量 + BM25 混合** | **关键词 + Cloud 语义** |
| Compaction | LLM agent 摘要 | 无 | 周期清理 | **LLM consolidation (L2→L3)** |
| 跨会话 | Session 隔离 | Group 隔离 | session_id 可选 | **Cloud SDK 跨 workspace** |

```typescript
// @prismer/agent-core/src/memory.ts — 增强版

export class FourLayerMemory implements MemoryStore {
  constructor(
    private workspaceDir: string,
    private cloudAdapter?: CloudMemoryAdapter,
    private provider?: Provider,  // 用于 L3 consolidation
  ) {}

  // L2+L3: 本地召回 — 关键词搜索 HISTORY.md + MEMORY.md
  async recall(query: string, limit = 5): Promise<string> {
    const facts = await this.recallFacts(query, limit);
    const history = await this.recallHistory(query, limit);
    const cloud = this.cloudAdapter
      ? await this.cloudAdapter.recall(query, limit)
      : [];

    return this.mergeRecalls(facts, history, cloud);
  }

  // L2: 保存对话到 HISTORY.md
  async save(userInput: string, agentResponse: string): Promise<void> {
    const entry = `## ${new Date().toISOString()}\n**User:** ${userInput}\n**Agent:** ${agentResponse}\n\n`;
    await fs.appendFile(path.join(this.workspaceDir, 'memory/HISTORY.md'), entry);
  }

  // L3: LLM-driven consolidation — 从 HISTORY.md 提取事实到 MEMORY.md
  async consolidate(): Promise<void> {
    if (!this.provider) return;
    const history = await fs.readFile(path.join(this.workspaceDir, 'memory/HISTORY.md'), 'utf-8');
    const existingFacts = await fs.readFile(path.join(this.workspaceDir, 'memory/MEMORY.md'), 'utf-8').catch(() => '');

    const response = await this.provider.chat({
      messages: [{
        role: 'user',
        content: `Extract key facts from recent conversation history. Merge with existing facts, remove duplicates, keep concise.\n\nExisting facts:\n${existingFacts}\n\nRecent history:\n${history.slice(-10000)}`,
      }],
    });

    await fs.writeFile(path.join(this.workspaceDir, 'memory/MEMORY.md'), response.text);
  }

  // L4: 云端持久化 — 重要发现跨 workspace 保留
  async cloudSave(facts: string, meta: Record<string, string>): Promise<void> {
    await this.cloudAdapter?.save(facts, meta);
  }
}
```

---

### 10.6 后端持久化 + 主动运行 (scheduler.ts ~80 LOC)

**框架对比:**
| | OpenCode | nanoclaw | zeroclaw | 我们的设计 |
|--|---------|----------|----------|-----------|
| 调度方式 | setInterval (内存) | Cron (SQLite) | Cron + 事件 + 目标 | **事件驱动 + 后端持久化** |
| 持久化 | 无 (内存) | SQLite 表 | 多后端 | **Prisma DB (已有)** |
| 主动运行 | 无 | Cron 轮询 | Webhook + 定时 | **Webhook + 数据库事件** |
| 不依赖 Cron | ❌ | ❌ | ✅ (event-driven) | ✅ |

```typescript
// @prismer/agent-core/src/scheduler.ts

import { z } from 'zod';

// 任务定义 — schema-driven
export const ScheduledTask = z.object({
  id: z.string(),
  type: z.enum(['once', 'interval', 'event']),
  // 'once': 一次性执行 (指定��间)
  // 'interval': 周期执行 (毫秒间隔)
  // 'event': 事件触发 (数据库变更、文件变更、Webhook)
  trigger: z.union([
    z.object({ type: z.literal('at'), time: z.date() }),
    z.object({ type: z.literal('every'), intervalMs: z.number() }),
    z.object({ type: z.literal('on'), event: z.string() }),  // 'file:change', 'db:task:created', 'webhook:incoming'
  ]),
  action: z.object({
    agentId: z.string().optional(),    // 调度给哪个 Agent
    message: z.string(),               // 发送给 Agent 的消息
    context: z.record(z.unknown()).optional(),
  }),
  status: z.enum(['pending', 'running', 'completed', 'failed']).default('pending'),
  createdAt: z.date(),
  lastRunAt: z.date().optional(),
});

export interface TaskStore {
  // 后端持久化 — 不在内存，重启不丢失
  create(task: z.infer<typeof ScheduledTask>): Promise<string>;
  update(id: string, data: Partial<z.infer<typeof ScheduledTask>>): Promise<void>;
  getDue(): Promise<z.infer<typeof ScheduledTask>[]>;
  getByEvent(event: string): Promise<z.infer<typeof ScheduledTask>[]>;
}

export class AgentScheduler {
  private eventHandlers = new Map<string, Set<string>>();

  constructor(
    private store: TaskStore,
    private agent: PrismerAgent,
    private observer: Observer,
  ) {}

  // 启动时从 DB 重建运行状态 — 不依赖 cron
  async start(): Promise<void> {
    // 1. 加载所有 interval 任务，启动 setInterval
    const intervalTasks = await this.store.getDue();
    for (const task of intervalTasks) {
      if (task.trigger.type === 'every') {
        this.scheduleInterval(task);
      }
    }

    // 2. 注册所有 event 任务到事件映射
    const eventTasks = await this.store.getByEvent('*');
    for (const task of eventTasks) {
      if (task.trigger.type === 'on') {
        this.registerEventHandler(task.trigger.event, task.id);
      }
    }
  }

  // 事件触发 — 文件变更、Webhook、数据库变更
  async onEvent(event: string, data: unknown): Promise<void> {
    const taskIds = this.eventHandlers.get(event);
    if (!taskIds) return;

    for (const taskId of taskIds) {
      const task = await this.store.getDue(); // simplified
      // 调度 Agent 处理
      await this.executeTask(task[0]);
    }
  }

  // 创建定时任务的 Tool — Agent 可以自己安排后续工作
  static createScheduleTool(): Tool {
    return {
      name: 'schedule_task',
      description: 'Schedule a future task for the agent to execute later. Supports one-time, interval, or event-triggered tasks.',
      parameters: ScheduledTask.omit({ status: true, createdAt: true, lastRunAt: true }),
      async execute(args, context) {
        const id = await context.scheduler.store.create({
          ...args,
          status: 'pending',
          createdAt: new Date(),
        });
        return `Task scheduled: ${id}`;
      },
    };
  }
}
```

**核心创新: Agent 自主安排工作**
```
用户: "每天帮我检查 arXiv 上 quantum computing 的新论文"
  ↓
Agent 调用 schedule_task:
  { type: 'interval', trigger: { type: 'every', intervalMs: 86400000 },
    action: { agentId: 'literature-scout', message: 'Search arXiv for recent quantum computing papers...' } }
  ↓
Scheduler 持久化到数据库，每 24 小时触发 literature-scout Sub-Agent
  ↓
结果通过 Cloud SDK IM 推送给用户 (即使用户不在线，OfflineManager 队列等待)
```

---

### 10.7 Agent Loop SSE 实时推送 (sse.ts ~100 LOC)

**框架对比:**
| | OpenCode | nanoclaw | zeroclaw | 我们的设计 |
|--|---------|----------|----------|-----------|
| 协议 | SSE (Hono) | 文件轮询 + stdout sentinel | SSE + WS (Axum) | **SSE (Hono 兼容)** |
| 事件总线 | Bus (内存 pub/sub) | 无 | tokio broadcast | **EventBus (Zod 类型安全)** |
| 心跳 | 10s | 无 | KeepAlive | **15s** |
| 背压 | 无 | 无 | Drop lagged | **队列 + overflow 检测** |

```typescript
// @prismer/agent-core/src/sse.ts

import { z } from 'zod';

// Schema-driven 事件定义 — npm 包导出给前端消费
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent.start'), data: z.object({ sessionId: z.string(), agentId: z.string() }) }),
  z.object({ type: z.literal('agent.end'), data: z.object({ sessionId: z.string(), toolsUsed: z.array(z.string()) }) }),
  z.object({ type: z.literal('text.delta'), data: z.object({ sessionId: z.string(), delta: z.string() }) }),
  z.object({ type: z.literal('thinking.delta'), data: z.object({ sessionId: z.string(), delta: z.string() }) }),
  z.object({ type: z.literal('tool.start'), data: z.object({ sessionId: z.string(), tool: z.string(), args: z.record(z.unknown()) }) }),
  z.object({ type: z.literal('tool.end'), data: z.object({ sessionId: z.string(), tool: z.string(), result: z.string() }) }),
  z.object({ type: z.literal('directive'), data: DirectiveSchema }),
  z.object({ type: z.literal('subagent.start'), data: z.object({ parentAgent: z.string(), subAgent: z.string() }) }),
  z.object({ type: z.literal('subagent.end'), data: z.object({ subAgent: z.string() }) }),
  z.object({ type: z.literal('error'), data: z.object({ message: z.string(), code: z.string().optional() }) }),
  z.object({ type: z.literal('heartbeat'), data: z.object({ timestamp: z.number() }) }),
]);

export type AgentEvent = z.infer<typeof AgentEvent>;

// 类型安全的事件总线 (from OpenCode Bus pattern)
export class EventBus {
  private subscribers = new Map<string, Set<(event: AgentEvent) => void>>();
  private wildcardSubs = new Set<(event: AgentEvent) => void>();

  publish(event: AgentEvent): void {
    AgentEvent.parse(event); // 运行时验证
    // 通知特定类型订阅者
    const subs = this.subscribers.get(event.type);
    if (subs) for (const sub of subs) sub(event);
    // 通知通配订阅者 (SSE 端点使用)
    for (const sub of this.wildcardSubs) sub(event);
  }

  subscribe(type: string, callback: (event: AgentEvent) => void): () => void {
    const subs = this.subscribers.get(type) ?? new Set();
    subs.add(callback);
    this.subscribers.set(type, subs);
    return () => subs.delete(callback);
  }

  subscribeAll(callback: (event: AgentEvent) => void): () => void {
    this.wildcardSubs.add(callback);
    return () => this.wildcardSubs.delete(callback);
  }
}

// SSE 端点 — 直接集成到 Agent Loop
export function createSSEHandler(bus: EventBus) {
  return async (req: Request): Promise<Response> => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // 连接确认
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`));

        // 订阅所有事件
        const unsub = bus.subscribeAll((event) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        });

        // 心跳 15s
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'heartbeat', data: { timestamp: Date.now() } })}\n\n`));
        }, 15_000);

        // 清理
        req.signal.addEventListener('abort', () => {
          clearInterval(heartbeat);
          unsub();
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',  // 防止 Nginx 缓冲
      },
    });
  };
}
```

**Agent Loop 集成 — 每一步都实时推送:**
```typescript
// agent.ts 中集成 EventBus
class PrismerAgent {
  constructor(private bus: EventBus, /* ... */) {}

  async processMessage(input: string, session: Session): Promise<AgentResult> {
    this.bus.publish({ type: 'agent.start', data: { sessionId: session.id, agentId: this.config.id } });

    while (iteration++ < this.maxIterations) {
      const response = await this.provider.chat({ messages, tools: toolSpecs });

      // 流式文本推送
      if (response.text) {
        this.bus.publish({ type: 'text.delta', data: { sessionId: session.id, delta: response.text } });
      }
      if (response.thinking) {
        this.bus.publish({ type: 'thinking.delta', data: { sessionId: session.id, delta: response.thinking } });
      }

      // 工具执行实时推送
      for (const call of response.toolCalls ?? []) {
        this.bus.publish({ type: 'tool.start', data: { sessionId: session.id, tool: call.name, args: call.arguments } });
        const result = await this.tools.execute(call.name, call.arguments);
        this.bus.publish({ type: 'tool.end', data: { sessionId: session.id, tool: call.name, result } });
      }

      // Directive 实时推送
      for (const directive of session.pendingDirectives) {
        this.bus.publish({ type: 'directive', data: directive });
      }
    }

    this.bus.publish({ type: 'agent.end', data: { sessionId: session.id, toolsUsed } });
  }
}
```

---

### 10.8 npm 包架构

```
@prismer/agent-core/
├── src/
│   ├── index.ts            # 主入口 — export 所有公共 API
│   ├── agent.ts            # Agent Loop + Sub-Agent
│   ├── agents.ts           # AgentRegistry + 内置定义
│   ├── provider.ts         # Provider 接口
│   ├── tools.ts            # ToolRegistry + delegate
│   ├── mcp.ts              # MCP Client
│   ├── workspace.ts        # 文件系统中间件        ← 10.1
│   ├── directives.ts       # UI Directive + schema  ← 10.2
│   ├── skills.ts           # Skill 加载 + 进化      ← 10.3
│   ├── context.ts          # Context Engineering    ← 10.4
│   ├── memory.ts           # 四层 Memory            ← 10.5
│   ├── scheduler.ts        # 主动运行 + 持久化      ← 10.6
│   ├── sse.ts              # SSE 实时推送 + EventBus ← 10.7
│   ├── cloud.ts            # Cloud SDK wrapper
│   ├── bridge.ts           # IM ↔ Agent 桥接
│   ├── session.ts          # Session + child
│   ├── observer.ts         # Observer 接口
│   └── ipc.ts              # stdin/stdout IPC
├── package.json
│   {
│     "name": "@prismer/agent-core",
│     "version": "0.1.0",
│     "exports": {
│       ".": "./dist/index.js",
│       "./schemas": "./dist/schemas.js",    // 纯 schema 导出 — 前端用
│       "./sse": "./dist/sse.js",            // SSE handler 独立导出
│       "./directives": "./dist/directives.js"
│     },
│     "dependencies": {
│       "@prismer/sdk": "^1.7",
│       "@modelcontextprotocol/sdk": "^1.12",
│       "zod": "^4.0",
│       "pino": "^9.0",
│       "chokidar": "^4.0"
│     },
│     "peerDependencies": {
│       "typescript": ">=5.0"
│     }
│   }
├── tsconfig.json
└── vitest.config.ts
```

**Schema-driven 的核心优势:**

```typescript
// 前端 (Next.js) 直接消费 schema — 零 runtime 依赖
import type { Directive, AgentEvent } from '@prismer/agent-core/schemas';

// 后端 (容器内) 完整运行
import { PrismerAgent, AgentRegistry, EventBus } from '@prismer/agent-core';

// 测试 — mock 完全基于 schema
import { DirectiveSchema, AgentEvent } from '@prismer/agent-core/schemas';
const mockDirective = DirectiveSchema.parse({ type: 'switch_component', payload: { component: 'latex-editor' } });
```

**总 LOC 估算 (含七大能力):**

| 模块 | LOC | 能力维度 |
|------|-----|---------|
| agent.ts + agents.ts | ~270 | Agent Loop + Sub-Agent |
| workspace.ts | ~80 | 10.1 文件系统中间件 |
| directives.ts | ~100 | 10.2 UI Directive |
| skills.ts | ~120 | 10.3 Skill 扩展 |
| context.ts | ~100 | 10.4 Context Engineering |
| memory.ts | ~150 | 10.5 Memory Recall |
| scheduler.ts | ~80 | 10.6 主动运行 |
| sse.ts | ~100 | 10.7 SSE 实时推送 |
| provider.ts + tools.ts + mcp.ts | ~220 | LLM + 工具 |
| cloud.ts + bridge.ts | ~180 | Cloud SDK |
| session.ts + observer.ts + ipc.ts | ~200 | 基础设施 |
| index.ts | ~50 | 入口 |
| **合计** | **~1650** | **完整能力** |
