/**
 * Agent — core agentic loop with tool execution, sub-agent delegation,
 * approval gating, and doom-loop detection.
 *
 * The {@link PrismerAgent} class orchestrates:
 *   1. LLM chat requests (streaming or batch)
 *   2. Parallel tool execution with context injection
 *   3. Sub-agent delegation via `@mention` or the `delegate` tool
 *   4. Approval gates for sensitive tool calls (bash rm, mv, etc.)
 *   5. Doom-loop detection (consecutive errors + repetitive tool calls)
 *   6. Automatic context compaction when the window overflows
 *
 * @module agent
 */

import type { Provider, ChatResponse, Message, ToolSpec, ThinkingLevel } from './provider.js';
import type { ToolRegistry, ToolContext } from './tools.js';
import type { Observer } from './observer.js';
import type { AgentConfig, AgentRegistry } from './agents.js';
import type { EventBus } from './sse.js';
import type { HookRegistry, HookContext } from './hooks.js';
import { Session, type Directive } from './session.js';
import { compactConversation, repairOrphanedToolResults, memoryFlushBeforeCompaction } from './compaction.js';
import type { MemoryStore } from './memory.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';

const log = createLogger('agent');

// ── Types ────────────────────────────────────────────────

/** The result returned after a full agent loop completes. */
export interface AgentResult {
  /** Final assistant text response. */
  text: string;
  /** Model thinking/reasoning content (for thinking-capable models). */
  thinking?: string;
  /** UI directives emitted during tool execution. */
  directives: Directive[];
  /** Unique tool names used during the loop. */
  toolsUsed: string[];
  /** Token usage (prompt + completion), if reported by the provider. */
  usage?: { promptTokens: number; completionTokens: number };
  /** Number of LLM iterations executed. */
  iterations: number;
}

/**
 * Options for constructing a {@link PrismerAgent}.
 *
 * Most fields have sensible defaults from the unified config ({@link loadConfig}).
 */
export interface AgentOptions {
  /** LLM provider for chat completions. */
  provider: Provider;
  /** Registry of available tools. */
  tools: ToolRegistry;
  /** Observability backend for lifecycle events and metrics. */
  observer: Observer;
  /** Registry of agent personalities (primary + sub-agents). */
  agents: AgentRegistry;
  /** Optional event bus for real-time streaming. */
  bus?: EventBus;
  /** Optional hook registry for lifecycle extension points. */
  hooks?: HookRegistry;
  /** Optional persistent memory store. */
  memoryStore?: MemoryStore;
  /** System prompt injected as the first message. */
  systemPrompt: string;
  /** LLM model identifier (overrides config default). */
  model?: string;
  /** Maximum tool-calling iterations per request. */
  maxIterations?: number;
  /** Agent identity key (e.g., `'researcher'`, `'latex-expert'`). */
  agentId?: string;
  /** Workspace root directory inside the container. */
  workspaceDir?: string;
  /** Thinking/reasoning level control. */
  thinkingLevel?: ThinkingLevel;
}

// ── Config-driven Constants ──────────────────────────────

const cfg = loadConfig();
const DOOM_LOOP_THRESHOLD = cfg.agent.doomLoopThreshold;
const MAX_TOOL_RESULT_CHARS = cfg.agent.maxToolResultChars;
const MAX_CONTEXT_CHARS = cfg.agent.maxContextChars;
const REPETITION_THRESHOLD = cfg.agent.repetitionThreshold;
const APPROVAL_TIMEOUT_MS = cfg.approval.timeoutMs;
const SENSITIVE_TOOLS = new Set(cfg.approval.sensitiveTools);
const SENSITIVE_BASH_PATTERNS = cfg.approval.bashPatterns.map(p => new RegExp(p));

// ── Helpers ─────────────────────────────────────────────

/** Compact oversized tool results (head + tail with gap marker) */
function compactToolResult(output: string): string {
  if (output.length <= MAX_TOOL_RESULT_CHARS) return output;
  const head = output.slice(0, 90_000);
  const tail = output.slice(-50_000);
  const omitted = output.length - 140_000;
  return `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`;
}

/** Truncate oldest conversation turns to fit context budget */
function truncateOldestTurns(messages: Message[], maxChars: number): Message[] {
  const total = messages.reduce((s, m) => s + (m.content?.length ?? 0) + 50, 0);
  if (total <= maxChars) return messages;

  const system = messages[0]; // Always keep system prompt
  const recentCount = Math.min(6, messages.length - 1);
  const tail = messages.slice(-recentCount);
  const middle = messages.slice(1, -recentCount);

  let currentSize = [system, ...tail].reduce((s, m) => s + (m.content?.length ?? 0) + 50, 0);
  const kept: Message[] = [];

  // Keep from newest to oldest
  for (let i = middle.length - 1; i >= 0; i--) {
    const size = (middle[i].content?.length ?? 0) + 50;
    if (currentSize + size > maxChars) break;
    currentSize += size;
    kept.unshift(middle[i]);
  }

  const truncated = messages.length - 1 - recentCount - kept.length;
  if (truncated > 0) {
    log.debug('context-guard truncated oldest messages', { truncated, budget: maxChars });
  }

  return [system, ...kept, ...tail];
}

// ── Agent ────────────────────────────────────────────────

export class PrismerAgent {
  private readonly provider: Provider;
  private readonly tools: ToolRegistry;
  private readonly observer: Observer;
  private readonly agents: AgentRegistry;
  private readonly bus?: EventBus;
  private readonly hooks?: HookRegistry;
  private readonly memoryStore?: MemoryStore;
  private readonly systemPrompt: string;
  private readonly model?: string;
  private readonly maxIterations: number;
  private readonly agentId: string;
  private readonly workspaceDir: string;
  private thinkingLevel?: ThinkingLevel;

  /** Pending approval resolvers — keyed by toolId, resolved by external approval response */
  private approvalResolvers = new Map<string, (approved: boolean) => void>();

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.observer = options.observer;
    this.agents = options.agents;
    this.bus = options.bus;
    this.hooks = options.hooks;
    this.memoryStore = options.memoryStore;
    this.systemPrompt = options.systemPrompt;
    this.model = options.model;
    this.maxIterations = options.maxIterations ?? cfg.agent.maxIterations;
    this.agentId = options.agentId ?? 'researcher';
    this.workspaceDir = options.workspaceDir ?? '/workspace';
    this.thinkingLevel = options.thinkingLevel;
  }

  /** Check if a tool call needs human approval before execution */
  needsApproval(toolName: string, args: Record<string, unknown>): boolean {
    if (!SENSITIVE_TOOLS.has(toolName)) return false;
    // bash: only flag destructive commands
    if (toolName === 'bash') {
      const cmd = String(args.command || args.cmd || '');
      return SENSITIVE_BASH_PATTERNS.some(p => p.test(cmd));
    }
    return true;
  }

  /** Resolve a pending approval request (called from WS handler) */
  resolveApproval(toolId: string, approved: boolean): void {
    const resolver = this.approvalResolvers.get(toolId);
    if (resolver) {
      resolver(approved);
      this.approvalResolvers.delete(toolId);
    }
  }

  /** Wait for external approval with timeout */
  private waitForApproval(toolId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.approvalResolvers.set(toolId, resolve);
      setTimeout(() => {
        if (this.approvalResolvers.has(toolId)) {
          this.approvalResolvers.delete(toolId);
          resolve(false); // Timeout → reject (safe default)
        }
      }, APPROVAL_TIMEOUT_MS);
    });
  }

  /**
   * Scan /workspace/.openclaw/directives/ for directive files written by plugin tools.
   * Emits them on the EventBus and accumulates in session, then deletes processed files.
   */
  private scanDirectiveFiles(session: Session, knownFiles?: Set<string>): void {
    const dirPath = `${this.workspaceDir}/.openclaw/directives`;
    let files: string[];
    try {
      files = readdirSync(dirPath).filter(f => f.endsWith('.json'));
    } catch {
      return; // Directory doesn't exist yet
    }

    for (const file of files) {
      if (knownFiles && knownFiles.has(file)) continue;
      try {
        const raw = readFileSync(`${dirPath}/${file}`, 'utf-8');
        const parsed = JSON.parse(raw);
        const directive: Directive = { type: parsed.type, payload: parsed.payload || {}, timestamp: parsed.timestamp || String(Date.now()) };
        session.addPendingDirective(directive);
        this.bus?.publish({ type: 'directive', data: { type: directive.type, payload: directive.payload, timestamp: directive.timestamp } });
        this.observer.recordEvent({ type: 'directive_emit', timestamp: Date.now(), data: { type: directive.type, payload: directive.payload } });
        unlinkSync(`${dirPath}/${file}`);
      } catch {
        // Skip malformed files
      }
    }
  }

  /** Snapshot current directive files (before tool execution) */
  private snapshotDirectiveFiles(): Set<string> {
    const dirPath = `${this.workspaceDir}/.openclaw/directives`;
    try {
      return new Set(readdirSync(dirPath).filter(f => f.endsWith('.json')));
    } catch {
      return new Set();
    }
  }

  /** Main entry point — process a user message through the agent loop */
  async processMessage(input: string, session: Session, memoryContext?: string, images?: import('./ipc.js').ImageRef[]): Promise<AgentResult> {
    const startMs = Date.now();

    // Parse /think, /t, /nothink directives
    let cleanInput = input;
    const thinkMatch = input.match(/^\/(think|t)\b\s*/i);
    const nothinkMatch = input.match(/^\/nothink\b\s*/i);
    if (thinkMatch) {
      this.thinkingLevel = 'high';
      cleanInput = input.slice(thinkMatch[0].length).trim() || input;
    } else if (nothinkMatch) {
      this.thinkingLevel = 'off';
      cleanInput = input.slice(nothinkMatch[0].length).trim() || input;
    }

    const hookCtx: HookContext = { sessionId: session.id, agentId: this.agentId };

    this.observer.recordEvent({
      type: 'agent_start',
      timestamp: startMs,
      data: { agentId: this.agentId, sessionId: session.id, input: cleanInput.slice(0, 200) },
    });
    this.bus?.publish({ type: 'agent.start', data: { sessionId: session.id, agentId: this.agentId } });

    // Check @-mention for explicit sub-agent delegation
    const mention = this.agents.resolveFromMention(cleanInput);
    if (mention) {
      const result = await this.delegateToSubAgent(mention.agentId, mention.message, session);
      this.bus?.publish({ type: 'agent.end', data: { sessionId: session.id, toolsUsed: result.toolsUsed } });
      return result;
    }

    // Build messages with system prompt + memory + history + optional images
    const messages = session.buildMessages(cleanInput, this.systemPrompt, memoryContext, images);

    // Get tool specs (filter by agent config if sub-agent)
    const agentConfig = this.agents.get(this.agentId);
    const allowedTools = agentConfig?.tools ?? undefined;
    const toolSpecs = this.tools.getSpecs(allowedTools ?? undefined);

    // Add delegate tool if this is the primary agent and sub-agents exist
    if ((!agentConfig || agentConfig.mode === 'primary') && this.agents.getDelegatableAgents().length > 0) {
      toolSpecs.push(this.getDelegateToolSpec());
    }

    let iteration = 0;
    const toolsUsed: string[] = [];
    let totalUsage = { promptTokens: 0, completionTokens: 0 };
    let lastText = '';
    let lastThinking: string | undefined;
    let consecutiveErrors = 0;
    const recentToolSigs: string[] = [];  // For repetition detection

    while (iteration++ < this.maxIterations) {
      // ── Context window guard with auto-compaction ──
      const beforeCount = messages.length;
      const truncated = truncateOldestTurns(messages, MAX_CONTEXT_CHARS);
      if (truncated.length < beforeCount) {
        // Extract dropped messages (skip system prompt at index 0)
        const dropped = messages.slice(1, beforeCount - truncated.length + 1);
        if (dropped.length > 2 && !session.compactionSummary) {
          try {
            // Flush important facts to memory before compaction
            if (this.memoryStore) {
              try { await memoryFlushBeforeCompaction(this.provider, dropped, this.memoryStore, this.model); } catch { /* non-fatal */ }
            }
            const result = await compactConversation(this.provider, dropped, this.model);
            session.compactionSummary = result.summary;
            this.observer.recordEvent({
              type: 'compaction',
              timestamp: Date.now(),
              data: { droppedCount: result.droppedCount, summaryChars: result.summaryChars },
            });
            this.bus?.publish({ type: 'compaction', data: { summary: result.summary.slice(0, 200), droppedCount: result.droppedCount } });
          } catch { /* compaction failure is non-fatal */ }
        }
        messages.length = 0;
        messages.push(...repairOrphanedToolResults(truncated));
      }

      // ── Hook: before_prompt ──
      if (this.hooks && iteration === 1) {
        const sysIdx = messages.findIndex(m => m.role === 'system');
        if (sysIdx >= 0 && messages[sysIdx].content) {
          messages[sysIdx].content = await this.hooks.runBeforePrompt(hookCtx, messages[sysIdx].content as string);
        }
      }

      // ── LLM Call ──
      const llmStart = Date.now();
      this.observer.recordEvent({
        type: 'llm_request',
        timestamp: llmStart,
        data: { iteration, model: this.model, messageCount: messages.length, toolCount: toolSpecs.length },
      });

      let response: ChatResponse;
      try {
        if (this.provider.chatStream && this.bus) {
          // Streaming mode — emit text deltas
          response = await this.provider.chatStream(
            { messages, tools: toolSpecs.length > 0 ? toolSpecs : undefined, model: this.model, thinkingLevel: this.thinkingLevel },
            (delta) => this.bus!.publish({ type: 'text.delta', data: { sessionId: session.id, delta } }),
          );
        } else {
          response = await this.provider.chat({
            messages,
            tools: toolSpecs.length > 0 ? toolSpecs : undefined,
            model: this.model,
            thinkingLevel: this.thinkingLevel,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.observer.recordEvent({ type: 'error', timestamp: Date.now(), data: { error: message, iteration } });
        this.bus?.publish({ type: 'error', data: { message } });
        return this.buildResult(`Error: ${message}`, undefined, session, toolsUsed, totalUsage, iteration);
      }

      this.observer.recordEvent({
        type: 'llm_response',
        timestamp: Date.now(),
        data: {
          duration_ms: Date.now() - llmStart,
          hasToolCalls: !!response.toolCalls?.length,
          textLength: response.text.length,
          usage: response.usage,
        },
      });
      this.observer.recordMetric('llm_latency_ms', Date.now() - llmStart);

      if (response.usage) {
        totalUsage.promptTokens += response.usage.promptTokens;
        totalUsage.completionTokens += response.usage.completionTokens;
      }

      lastText = response.text;
      lastThinking = response.thinking;

      // Append assistant message to conversation
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.text || null,
      };
      // Preserve reasoning_content for thinking models (e.g., kimi-k2.5)
      if (response.thinking) {
        assistantMsg.reasoningContent = response.thinking;
      }
      if (response.toolCalls?.length) {
        assistantMsg.toolCalls = response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }
      messages.push(assistantMsg);
      session.addMessage(assistantMsg);

      // ── No tool calls → final response ──
      if (!response.toolCalls?.length) {
        // Emit non-streaming text if we didn't stream
        if (!this.provider.chatStream || !this.bus) {
          this.bus?.publish({ type: 'text.delta', data: { sessionId: session.id, delta: response.text } });
        }
        break;
      }

      // ── Execute tools ──
      const preToolDirectiveFiles = this.snapshotDirectiveFiles();
      const toolResults = await Promise.all(
        response.toolCalls.map(async (call) => {
          // Handle delegate tool specially
          if (call.name === 'delegate') {
            return this.handleDelegateCall(call, session, toolsUsed);
          }

          // Hook: before_tool
          if (this.hooks) {
            const hookResult = await this.hooks.runBeforeTool(hookCtx, call.name, call.arguments);
            if (!hookResult.proceed) {
              return { id: call.id, output: '[Tool blocked by hook]', error: false };
            }
            Object.assign(call.arguments, hookResult.args);
          }

          // Approval gate: sensitive tools require human confirmation
          if (this.needsApproval(call.name, call.arguments)) {
            const reason = `Tool "${call.name}" requires approval`;
            this.bus?.publish({
              type: 'tool.approval_required',
              data: { sessionId: session.id, tool: call.name, toolId: call.id, args: call.arguments, reason },
            });
            this.observer.recordEvent({ type: 'tool_call_start', timestamp: Date.now(), data: { name: call.name, approval: 'required' } });
            const approved = await this.waitForApproval(call.id);
            this.bus?.publish({
              type: 'tool.approval_response',
              data: { toolId: call.id, approved, reason: approved ? 'approved' : 'rejected/timeout' },
            });
            if (!approved) {
              return { id: call.id, output: '[Tool blocked: approval denied or timed out]', error: false };
            }
          }

          this.observer.recordEvent({
            type: 'tool_call_start',
            timestamp: Date.now(),
            data: { name: call.name, args: call.arguments },
          });
          this.bus?.publish({ type: 'tool.start', data: { sessionId: session.id, tool: call.name, toolId: call.id, args: call.arguments } });

          const ctx: ToolContext = {
            workspaceDir: this.workspaceDir,
            sessionId: session.id,
            agentId: this.agentId,
            emit: (event) => {
              if (event.type === 'directive') {
                session.addPendingDirective(event.data as unknown as Directive);
                this.bus?.publish({ type: 'directive', data: event.data });
                this.observer.recordEvent({ type: 'directive_emit', timestamp: Date.now(), data: event.data });
              }
            },
          };

          const result = await this.tools.execute(call.name, call.arguments, ctx);
          toolsUsed.push(call.name);

          this.observer.recordEvent({
            type: 'tool_call_end',
            timestamp: Date.now(),
            data: { name: call.name, success: !result.error, outputLength: result.output.length },
          });
          this.bus?.publish({
            type: 'tool.end',
            data: { sessionId: session.id, tool: call.name, toolId: call.id, result: (result.output || result.error || '').slice(0, 500) },
          });

          // Hook: after_tool
          if (this.hooks) {
            await this.hooks.runAfterTool(hookCtx, call.name, result.output || result.error || '', !!result.error);
          }

          return { id: call.id, output: result.error ? `Error: ${result.error}` : result.output, error: !!result.error };
        })
      );

      // Scan for directive files written by plugin tools (filesystem fallback)
      this.scanDirectiveFiles(session, preToolDirectiveFiles);

      // Append tool results to messages (with compaction)
      for (const r of toolResults) {
        const content = compactToolResult(r.output);
        const toolMsg: Message = { role: 'tool', content, toolCallId: r.id };
        messages.push(toolMsg);
        session.addMessage(toolMsg);
      }

      // Track tool call signatures for repetition detection
      for (const call of response.toolCalls) {
        recentToolSigs.push(`${call.name}:${JSON.stringify(call.arguments).slice(0, 80)}`);
      }

      // ── Doom-loop detection (errors) ──
      const errorsThisRound = toolResults.filter(r => r.error).length;
      if (errorsThisRound === toolResults.length && toolResults.length > 0) {
        consecutiveErrors++;
      } else {
        consecutiveErrors = 0;
      }

      if (consecutiveErrors >= DOOM_LOOP_THRESHOLD) {
        this.observer.recordEvent({
          type: 'doom_loop',
          timestamp: Date.now(),
          data: { consecutiveErrors, lastTools: toolResults.map(r => r.id) },
        });
        this.bus?.publish({ type: 'error', data: { message: 'Doom loop detected — stopping after 3 consecutive all-tool-error rounds' } });
        lastText = '[Stopped: repeated tool failures detected. Please try a different approach.]';
        break;
      }

      // ── Doom-loop detection (repetition) ──
      if (recentToolSigs.length >= REPETITION_THRESHOLD) {
        const lastN = recentToolSigs.slice(-REPETITION_THRESHOLD);
        if (lastN.every(s => s === lastN[0])) {
          this.observer.recordEvent({
            type: 'doom_loop',
            timestamp: Date.now(),
            data: { type: 'repetition', signature: lastN[0] },
          });
          this.bus?.publish({ type: 'error', data: { message: 'Repetitive tool calls detected — stopping' } });
          lastText = '[Stopped: repetitive tool calls detected. Please try a different approach.]';
          break;
        }
      }
    }

    if (iteration > this.maxIterations) {
      lastText = lastText || '[Max iterations reached]';
    }

    const result = this.buildResult(lastText, lastThinking, session, toolsUsed, totalUsage, iteration);

    // Hook: agent_end
    if (this.hooks) {
      await this.hooks.runAgentEnd(hookCtx, result);
    }

    this.observer.recordEvent({
      type: 'agent_end',
      timestamp: Date.now(),
      data: { agentId: this.agentId, iterations: iteration, toolsUsed, duration_ms: Date.now() - startMs },
    });
    this.bus?.publish({ type: 'agent.end', data: { sessionId: session.id, toolsUsed } });

    return result;
  }

  /** Delegate to a sub-agent */
  private async delegateToSubAgent(
    agentId: string,
    message: string,
    parentSession: Session,
  ): Promise<AgentResult> {
    const config = this.agents.get(agentId);
    if (!config || config.mode === 'hidden') {
      return this.buildResult(
        `Unknown sub-agent: ${agentId}`,
        undefined,
        parentSession,
        [],
        { promptTokens: 0, completionTokens: 0 },
        0,
      );
    }

    this.observer.recordEvent({
      type: 'subagent_start',
      timestamp: Date.now(),
      data: { parentAgent: this.agentId, subAgent: agentId },
    });
    this.bus?.publish({ type: 'subagent.start', data: { parentAgent: this.agentId, subAgent: agentId } });

    const childSession = parentSession.createChild(agentId);

    const subAgent = new PrismerAgent({
      provider: this.provider,
      tools: this.tools,
      observer: this.observer,
      agents: this.agents,
      bus: this.bus,
      systemPrompt: config.systemPrompt,
      model: config.model ?? this.model,
      maxIterations: config.maxIterations ?? 20,
      agentId: config.id,
      workspaceDir: this.workspaceDir,
    });

    const result = await subAgent.processMessage(message, childSession);

    // Merge child directives into parent
    for (const d of result.directives) {
      parentSession.addPendingDirective(d);
    }

    this.observer.recordEvent({
      type: 'subagent_end',
      timestamp: Date.now(),
      data: { subAgent: agentId, toolsUsed: result.toolsUsed, iterations: result.iterations },
    });
    this.bus?.publish({ type: 'subagent.end', data: { parentAgent: this.agentId, subAgent: agentId } });

    return result;
  }

  /** Handle the "delegate" tool call */
  private async handleDelegateCall(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    session: Session,
    toolsUsed: string[],
  ): Promise<{ id: string; output: string; error: boolean }> {
    const targetAgent = call.arguments.agent as string;
    const task = call.arguments.task as string;

    if (!targetAgent || !task) {
      return { id: call.id, output: 'Error: delegate requires "agent" and "task" arguments', error: true };
    }

    toolsUsed.push(`delegate:${targetAgent}`);

    try {
      const result = await this.delegateToSubAgent(targetAgent, task, session);
      return { id: call.id, output: result.text, error: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: call.id, output: `Delegation failed: ${message}`, error: true };
    }
  }

  /** Build the delegate tool spec */
  private getDelegateToolSpec(): ToolSpec {
    const delegatable = this.agents.getDelegatableAgents();
    return {
      type: 'function',
      function: {
        name: 'delegate',
        description: `Delegate a task to a specialized sub-agent. Available: ${delegatable.join(', ')}`,
        parameters: {
          type: 'object',
          properties: {
            agent: {
              type: 'string',
              enum: delegatable,
              description: 'The sub-agent to delegate to',
            },
            task: {
              type: 'string',
              description: 'The task description for the sub-agent',
            },
          },
          required: ['agent', 'task'],
        },
      },
    };
  }

  private buildResult(
    text: string,
    thinking: string | undefined,
    session: Session,
    toolsUsed: string[],
    usage: { promptTokens: number; completionTokens: number },
    iterations: number,
  ): AgentResult {
    return {
      text,
      thinking,
      directives: session.drainDirectives(),
      toolsUsed: [...new Set(toolsUsed)],
      usage: usage.promptTokens > 0 ? usage : undefined,
      iterations,
    };
  }
}
