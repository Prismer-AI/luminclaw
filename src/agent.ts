/**
 * Agent — core agentic loop with tool execution, sub-agent delegation,
 * approval gating, and doom-loop detection.
 *
 * The {@link PrismerAgent} class orchestrates:
 *   1. LLM chat requests (streaming or batch)
 *   2. Partitioned tool execution (read-only concurrent, write serial)
 *   3. Sub-agent delegation via `@mention` or the `delegate` tool
 *   4. Approval gates for sensitive tool calls (bash rm, mv, etc.)
 *   5. Doom-loop detection (consecutive errors + repetitive tool calls)
 *   6. Three-layer context management (microcompact → truncate → compaction)
 *   7. Recovery paths (reactive compact, output truncation recovery)
 *   8. AbortController chain (parent→child cancellation propagation)
 *   9. AsyncGenerator event stream (yield events + EventBus dual output)
 *
 * @module agent
 */

import type { Provider, ChatResponse, Message, ToolSpec, ThinkingLevel, ToolCall, ContentBlock } from './provider.js';
import type { ToolRegistry, ToolContext } from './tools.js';
import type { Observer } from './observer.js';
import type { AgentConfig, AgentRegistry } from './agents.js';
import type { EventBus, AgentEvent } from './sse.js';
import type { HookRegistry, HookContext } from './hooks.js';
import { Session, type Directive } from './session.js';
import { getAbortReason, AbortReason } from './abort.js';
import { compactConversation, repairOrphanedToolResults, memoryFlushBeforeCompaction } from './compaction.js';
import { microcompact } from './microcompact.js';
import { estimateMessageTokens } from './tokens.js';
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
 */
export interface AgentOptions {
  provider: Provider;
  tools: ToolRegistry;
  observer: Observer;
  agents: AgentRegistry;
  bus?: EventBus;
  hooks?: HookRegistry;
  memoryStore?: MemoryStore;
  systemPrompt: string;
  model?: string;
  maxIterations?: number;
  agentId?: string;
  workspaceDir?: string;
  thinkingLevel?: ThinkingLevel;
  /** AbortSignal for external cancellation. */
  abortSignal?: AbortSignal;
  /** Recursion depth — prevents infinite sub-agent delegation. */
  _depth?: number;
  /**
   * Fires at the start of each iteration, before the LLM call.
   * DualLoopAgent uses this to drain its MessageQueue and inject queued
   * user messages into the session history. Errors are caught and logged;
   * they do not halt the iteration.
   */
  onIterationStart?: (iteration: number, session: Session) => Promise<void>;
}

// ── LoopState ───────────────────────────────────────────

interface Transition {
  reason: 'next_turn' | 'reactive_compact' | 'output_recovery' | 'model_fallback';
  detail?: unknown;
}

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

// ── Config Constants ─────────────────────────────────────

const cfg = loadConfig();
const DOOM_LOOP_THRESHOLD = cfg.agent.doomLoopThreshold;
const MAX_TOOL_RESULT_CHARS = cfg.agent.maxToolResultChars;
const MAX_CONTEXT_CHARS = cfg.agent.maxContextChars;
const REPETITION_THRESHOLD = cfg.agent.repetitionThreshold;
const APPROVAL_TIMEOUT_MS = cfg.approval.timeoutMs;
const SENSITIVE_TOOLS = new Set(cfg.approval.sensitiveTools);
const SENSITIVE_BASH_PATTERNS = cfg.approval.bashPatterns.map(p => new RegExp(p));
const MAX_OUTPUT_RECOVERY = 3;
const MAX_SUBAGENT_DEPTH = 5;

// ── Helpers ─────────────────────────────────────────────

/** Get approximate char length of message content (handles multimodal). */
function contentLength(content: string | ContentBlock[] | null | undefined): number {
  if (!content) return 0;
  if (typeof content === 'string') return content.length;
  return content.reduce((s, b) => s + ('text' in b ? b.text.length : 200), 0);
}

function compactToolResult(output: string): string {
  if (output.length <= MAX_TOOL_RESULT_CHARS) return output;
  const head = output.slice(0, 90_000);
  const tail = output.slice(-50_000);
  const omitted = output.length - 140_000;
  return `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`;
}

function truncateOldestTurns(messages: Message[], maxChars: number): Message[] {
  const total = messages.reduce((s, m) => s + contentLength(m.content) + 50, 0);
  if (total <= maxChars) return messages;
  const system = messages[0];
  const recentCount = Math.min(6, messages.length - 1);
  const tail = messages.slice(-recentCount);
  const middle = messages.slice(1, -recentCount);
  let currentSize = [system, ...tail].reduce((s, m) => s + contentLength(m.content) + 50, 0);
  const kept: Message[] = [];
  for (let i = middle.length - 1; i >= 0; i--) {
    const size = (middle[i].content?.length ?? 0) + 50;
    if (currentSize + size > maxChars) break;
    currentSize += size;
    kept.unshift(middle[i]);
  }
  return [system, ...kept, ...tail];
}

function partitionToolCalls(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  tools: ToolRegistry,
): Array<{ concurrent: boolean; calls: typeof calls }> {
  const batches: Array<{ concurrent: boolean; calls: typeof calls }> = [];
  for (const call of calls) {
    const tool = tools.get(call.name);
    const safe = tool?.isConcurrencySafe?.(call.arguments) ?? false;
    const last = batches[batches.length - 1];
    if (last && safe && last.concurrent) { last.calls.push(call); }
    else { batches.push({ concurrent: safe, calls: [call] }); }
  }
  return batches;
}

function isPromptTooLong(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /prompt.?too.?long|context.?length|token.?limit|413/i.test(msg);
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
  private readonly depth: number;
  private readonly abortSignal?: AbortSignal;
  private readonly onIterationStart?: (iteration: number, session: Session) => Promise<void>;
  private thinkingLevel?: ThinkingLevel;
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
    this.depth = options._depth ?? 0;
    this.abortSignal = options.abortSignal;
    this.onIterationStart = options.onIterationStart;
  }

  needsApproval(toolName: string, args: Record<string, unknown>): boolean {
    if (!SENSITIVE_TOOLS.has(toolName)) return false;
    if (toolName === 'bash') {
      const cmd = String(args.command || args.cmd || '');
      return SENSITIVE_BASH_PATTERNS.some(p => p.test(cmd));
    }
    return true;
  }

  resolveApproval(toolId: string, approved: boolean): void {
    const resolver = this.approvalResolvers.get(toolId);
    if (resolver) { resolver(approved); this.approvalResolvers.delete(toolId); }
  }

  private waitForApproval(toolId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.approvalResolvers.set(toolId, resolve);
      setTimeout(() => {
        if (this.approvalResolvers.has(toolId)) { this.approvalResolvers.delete(toolId); resolve(false); }
      }, APPROVAL_TIMEOUT_MS);
    });
  }

  private buildSignal(): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(300_000);
    return this.abortSignal ? AbortSignal.any([this.abortSignal, timeoutSignal]) : timeoutSignal;
  }

  private scanDirectiveFiles(session: Session, knownFiles?: Set<string>): void {
    const dirPath = `${this.workspaceDir}/.openclaw/directives`;
    let files: string[];
    try { files = readdirSync(dirPath).filter(f => f.endsWith('.json')); } catch { return; }
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
      } catch { /* skip */ }
    }
  }

  private snapshotDirectiveFiles(): Set<string> {
    const dirPath = `${this.workspaceDir}/.openclaw/directives`;
    try { return new Set(readdirSync(dirPath).filter(f => f.endsWith('.json'))); } catch { return new Set(); }
  }

  /**
   * C4: For the latest assistant message with toolCalls, push synthetic
   * `[Aborted: <reason>]` tool_result messages for any call without a matching
   * tool_result already present in `state.messages`. Idempotent — calls that
   * already have a result (including abort-rewritten results from
   * {@link executeToolCall}) are left alone.
   */
  private synthesizeAbortedToolResults(messages: Message[], session: Session): void {
    const reason = getAbortReason(this.abortSignal?.reason) ?? AbortReason.UserInterrupted;
    // Find the last assistant message with toolCalls.
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].toolCalls?.length) {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx < 0) return;
    const assistant = messages[lastAssistantIdx];
    const calls = assistant.toolCalls ?? [];
    // Collect tool_call_ids already satisfied by subsequent tool messages.
    const satisfied = new Set<string>();
    for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'tool' && m.toolCallId) satisfied.add(m.toolCallId);
    }
    for (const call of calls) {
      if (satisfied.has(call.id)) continue;
      const toolMsg: Message = {
        role: 'tool',
        content: `[Aborted: ${reason}]`,
        toolCallId: call.id,
      };
      messages.push(toolMsg);
      session.addMessage(toolMsg);
    }
  }

  /** Execute a single tool call, collecting events for later yielding. */
  private async executeToolCall(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    session: Session, toolsUsed: string[], hookCtx: HookContext,
  ): Promise<{ result: { id: string; output: string; error: boolean }; events: AgentEvent[] }> {
    const events: AgentEvent[] = [];
    if (this.abortSignal?.aborted) {
      const reason = getAbortReason(this.abortSignal.reason) ?? AbortReason.UserInterrupted;
      return { result: { id: call.id, output: `[Aborted: ${reason}]`, error: false }, events };
    }
    if (call.name === 'delegate') {
      return this.handleDelegateCall(call, session, toolsUsed);
    }
    if (this.hooks) {
      const hookResult = await this.hooks.runBeforeTool(hookCtx, call.name, call.arguments);
      if (!hookResult.proceed) return { result: { id: call.id, output: '[Tool blocked by hook]', error: false }, events };
      Object.assign(call.arguments, hookResult.args);
    }
    if (this.needsApproval(call.name, call.arguments)) {
      const reason = `Tool "${call.name}" requires approval`;
      events.push({ type: 'tool.approval_required', data: { sessionId: session.id, tool: call.name, toolId: call.id, args: call.arguments, reason } });
      this.observer.recordEvent({ type: 'tool_call_start', timestamp: Date.now(), data: { name: call.name, approval: 'required' } });
      const approved = await this.waitForApproval(call.id);
      events.push({ type: 'tool.approval_response', data: { toolId: call.id, approved, reason: approved ? 'approved' : 'rejected/timeout' } });
      if (!approved) return { result: { id: call.id, output: '[Tool blocked: approval denied or timed out]', error: false }, events };
    }
    this.observer.recordEvent({ type: 'tool_call_start', timestamp: Date.now(), data: { name: call.name, args: call.arguments } });
    events.push({ type: 'tool.start', data: { sessionId: session.id, tool: call.name, toolId: call.id, args: call.arguments } });
    const ctx: ToolContext = {
      workspaceDir: this.workspaceDir, sessionId: session.id, agentId: this.agentId,
      abortSignal: this.abortSignal,
      emit: (event) => {
        if (event.type === 'directive') {
          session.addPendingDirective(event.data as unknown as Directive);
          events.push({ type: 'directive', data: event.data });
          this.observer.recordEvent({ type: 'directive_emit', timestamp: Date.now(), data: event.data });
        }
      },
    };
    const result = await this.tools.execute(call.name, call.arguments, ctx);
    toolsUsed.push(call.name);
    this.observer.recordEvent({ type: 'tool_call_end', timestamp: Date.now(), data: { name: call.name, success: !result.error, outputLength: result.output.length } });
    events.push({ type: 'tool.end', data: { sessionId: session.id, tool: call.name, toolId: call.id, result: (result.output || result.error || '').slice(0, 500) } });
    if (this.hooks) await this.hooks.runAfterTool(hookCtx, call.name, result.output || result.error || '', !!result.error);
    // If the tool's error was caused by abort (in-flight cancellation), replace
    // with a structured [Aborted: <reason>] marker so history is well-formed.
    if (result.error && this.abortSignal?.aborted) {
      const reason = getAbortReason(this.abortSignal.reason) ?? AbortReason.UserInterrupted;
      return { result: { id: call.id, output: `[Aborted: ${reason}]`, error: false }, events };
    }
    return { result: { id: call.id, output: result.error ? `Error: ${result.error}` : result.output, error: !!result.error }, events };
  }

  /** Execute tools with read/write partitioning, returning results + events. */
  private async executeToolsPartitioned(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    session: Session, toolsUsed: string[], hookCtx: HookContext,
  ): Promise<{ results: Array<{ id: string; output: string; error: boolean }>; events: AgentEvent[] }> {
    const batches = partitionToolCalls(toolCalls, this.tools);
    const allResults: Array<{ id: string; output: string; error: boolean }> = [];
    const allEvents: AgentEvent[] = [];
    for (const batch of batches) {
      if (batch.concurrent && batch.calls.length > 1) {
        const executions = await Promise.all(batch.calls.map(c => this.executeToolCall(c, session, toolsUsed, hookCtx)));
        for (const exec of executions) { allEvents.push(...exec.events); allResults.push(exec.result); }
      } else {
        for (const call of batch.calls) {
          const exec = await this.executeToolCall(call, session, toolsUsed, hookCtx);
          allEvents.push(...exec.events); allResults.push(exec.result);
        }
      }
    }
    return { results: allResults, events: allEvents };
  }

  /** Main entry point — AsyncGenerator yielding AgentEvents, returning AgentResult. */
  async *processMessage(input: string, session: Session, memoryContext?: string): AsyncGenerator<AgentEvent, AgentResult> {
    const startMs = Date.now();
    let cleanInput = input;
    const thinkMatch = input.match(/^\/(think|t)\b\s*/i);
    const nothinkMatch = input.match(/^\/nothink\b\s*/i);
    if (thinkMatch) { this.thinkingLevel = 'high'; cleanInput = input.slice(thinkMatch[0].length).trim() || input; }
    else if (nothinkMatch) { this.thinkingLevel = 'off'; cleanInput = input.slice(nothinkMatch[0].length).trim() || input; }

    const hookCtx: HookContext = { sessionId: session.id, agentId: this.agentId };
    this.observer.recordEvent({ type: 'agent_start', timestamp: startMs, data: { agentId: this.agentId, sessionId: session.id, input: cleanInput.slice(0, 200) } });
    const startEvent: AgentEvent = { type: 'agent.start', data: { sessionId: session.id, agentId: this.agentId } };
    this.bus?.publish(startEvent); yield startEvent;

    const mention = this.agents.resolveFromMention(cleanInput);
    if (mention) {
      const result = yield* this.delegateToSubAgent(mention.agentId, mention.message, session);
      const endEvent: AgentEvent = { type: 'agent.end', data: { sessionId: session.id, toolsUsed: result.toolsUsed } };
      this.bus?.publish(endEvent); yield endEvent;
      return result;
    }

    // Persist user input to session before buildMessages
    session.addMessage({ role: 'user', content: cleanInput });
    const messages = session.buildMessages(this.systemPrompt, memoryContext);
    const agentConfig = this.agents.get(this.agentId);
    const toolSpecs = this.tools.getSpecs(agentConfig?.tools ?? undefined);
    if ((!agentConfig || agentConfig.mode === 'primary') && this.agents.getDelegatableAgents().length > 0 && this.depth < MAX_SUBAGENT_DEPTH) {
      toolSpecs.push(this.getDelegateToolSpec());
    }

    const toolsUsed: string[] = [];
    let state: LoopState = {
      messages, iteration: 0, consecutiveErrors: 0, recentToolSigs: [],
      totalUsage: { promptTokens: 0, completionTokens: 0 },
      lastText: '', lastThinking: undefined,
      hasAttemptedReactiveCompact: false, outputRecoveryCount: 0,
    };

    while (state.iteration++ < this.maxIterations) {
      if (this.abortSignal?.aborted) {
        // C4: synthesize [Aborted: <reason>] tool_result for any in-flight tool_calls
        // from the most recent assistant message that didn't get a matching result.
        this.synthesizeAbortedToolResults(state.messages, session);
        state.lastText = '[Aborted by user]';
        break;
      }

      // A4: fire onIterationStart callback (DualLoopAgent uses this to drain MessageQueue)
      if (this.onIterationStart) {
        try { await this.onIterationStart(state.iteration, session); }
        catch (err) { log.warn('onIterationStart threw', { error: err instanceof Error ? err.message : String(err) }); }
      }

      microcompact(state.messages, 5);

      const beforeCount = state.messages.length;
      const truncated = truncateOldestTurns(state.messages, MAX_CONTEXT_CHARS);
      if (truncated.length < beforeCount) {
        const dropped = state.messages.slice(1, beforeCount - truncated.length + 1);
        if (dropped.length > 2 && !session.compactionSummary) {
          try {
            if (this.memoryStore) { try { await memoryFlushBeforeCompaction(this.provider, dropped, this.memoryStore, this.model); } catch { /* */ } }
            const r = await compactConversation(this.provider, dropped, this.model);
            session.compactionSummary = r.summary;
            this.observer.recordEvent({ type: 'compaction', timestamp: Date.now(), data: { droppedCount: r.droppedCount, summaryChars: r.summaryChars } });
            const ev: AgentEvent = { type: 'compaction', data: { summary: r.summary.slice(0, 200), droppedCount: r.droppedCount } };
            this.bus?.publish(ev); yield ev;
          } catch { /* */ }
        }
        state.messages.length = 0;
        state.messages.push(...repairOrphanedToolResults(truncated));
      }

      if (this.hooks && state.iteration === 1) {
        const sysIdx = state.messages.findIndex(m => m.role === 'system');
        if (sysIdx >= 0 && typeof state.messages[sysIdx].content === 'string') {
          state.messages[sysIdx].content = await this.hooks.runBeforePrompt(hookCtx, state.messages[sysIdx].content as string);
        }
      }

      const llmStart = Date.now();
      const signal = this.buildSignal();
      this.observer.recordEvent({ type: 'llm_request', timestamp: llmStart, data: { iteration: state.iteration, model: this.model, messageCount: state.messages.length, toolCount: toolSpecs.length, estimatedTokens: estimateMessageTokens(state.messages) } });

      let response: ChatResponse;
      try {
        if (this.provider.chatStream && this.bus) {
          const streamEvents: AgentEvent[] = [];
          response = await this.provider.chatStream(
            { messages: state.messages, tools: toolSpecs.length > 0 ? toolSpecs : undefined, model: this.model, thinkingLevel: this.thinkingLevel, signal },
            (delta) => { const ev: AgentEvent = { type: 'text.delta', data: { sessionId: session.id, delta } }; this.bus!.publish(ev); streamEvents.push(ev); },
          );
          for (const ev of streamEvents) yield ev;
        } else {
          response = await this.provider.chat({ messages: state.messages, tools: toolSpecs.length > 0 ? toolSpecs : undefined, model: this.model, thinkingLevel: this.thinkingLevel, signal });
        }
      } catch (err) {
        if (isPromptTooLong(err) && !state.hasAttemptedReactiveCompact) {
          log.warn('prompt too long — attempting reactive compaction');
          try {
            const allButSystem = state.messages.slice(1);
            const halfIdx = Math.floor(allButSystem.length / 2);
            const toCompact = allButSystem.slice(0, halfIdx);
            const toKeep = allButSystem.slice(halfIdx);
            if (this.memoryStore) { try { await memoryFlushBeforeCompaction(this.provider, toCompact, this.memoryStore, this.model); } catch { /* */ } }
            const compacted = await compactConversation(this.provider, toCompact, this.model);
            session.compactionSummary = compacted.summary;
            const ev: AgentEvent = { type: 'compaction', data: { summary: compacted.summary.slice(0, 200), droppedCount: toCompact.length } };
            this.bus?.publish(ev); yield ev;
            state = { ...state, messages: [state.messages[0], { role: 'user', content: `[Earlier Conversation Summary]\n${compacted.summary}` }, { role: 'assistant', content: 'Understood, I have the context from our earlier conversation.' }, ...repairOrphanedToolResults(toKeep)], hasAttemptedReactiveCompact: true, transition: { reason: 'reactive_compact', detail: { dropped: toCompact.length } } };
            continue;
          } catch { /* fall through */ }
        }
        const message = err instanceof Error ? err.message : String(err);
        this.observer.recordEvent({ type: 'error', timestamp: Date.now(), data: { error: message, iteration: state.iteration } });
        const errEv: AgentEvent = { type: 'error', data: { message } };
        this.bus?.publish(errEv); yield errEv;
        return this.buildResult(`Error: ${message}`, undefined, session, toolsUsed, state.totalUsage, state.iteration);
      }

      this.observer.recordEvent({ type: 'llm_response', timestamp: Date.now(), data: { duration_ms: Date.now() - llmStart, hasToolCalls: !!response.toolCalls?.length, textLength: response.text.length, usage: response.usage } });
      this.observer.recordMetric('llm_latency_ms', Date.now() - llmStart);
      if (response.usage) { state.totalUsage.promptTokens += response.usage.promptTokens; state.totalUsage.completionTokens += response.usage.completionTokens; }
      state.lastText = response.text;
      state.lastThinking = response.thinking;

      const assistantMsg: Message = { role: 'assistant', content: response.text || null };
      if (response.thinking) assistantMsg.reasoningContent = response.thinking;
      if (response.toolCalls?.length) {
        assistantMsg.toolCalls = response.toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }));
      }
      state.messages.push(assistantMsg);
      session.addMessage(assistantMsg);

      if (!response.toolCalls?.length) {
        if (response.finishReason === 'length' && state.outputRecoveryCount < MAX_OUTPUT_RECOVERY) {
          const contMsg: Message = { role: 'user', content: 'Please continue from where you left off.' };
          state.messages.push(contMsg); session.addMessage(contMsg);
          state = { ...state, outputRecoveryCount: state.outputRecoveryCount + 1, transition: { reason: 'output_recovery' } };
          continue;
        }
        if (!this.provider.chatStream || !this.bus) {
          const ev: AgentEvent = { type: 'text.delta', data: { sessionId: session.id, delta: response.text } };
          this.bus?.publish(ev); yield ev;
        }
        break;
      }

      const preToolDirectiveFiles = this.snapshotDirectiveFiles();
      const { results: toolResults, events: toolEvents } = await this.executeToolsPartitioned(response.toolCalls, session, toolsUsed, hookCtx);
      for (const ev of toolEvents) { this.bus?.publish(ev); yield ev; }
      this.scanDirectiveFiles(session, preToolDirectiveFiles);

      for (const r of toolResults) {
        const toolMsg: Message = { role: 'tool', content: compactToolResult(r.output), toolCallId: r.id };
        state.messages.push(toolMsg); session.addMessage(toolMsg);
      }
      for (const call of response.toolCalls) { state.recentToolSigs.push(`${call.name}:${JSON.stringify(call.arguments).slice(0, 80)}`); }

      const errorsThisRound = toolResults.filter(r => r.error).length;
      if (errorsThisRound === toolResults.length && toolResults.length > 0) { state.consecutiveErrors++; } else { state.consecutiveErrors = 0; }
      if (state.consecutiveErrors >= DOOM_LOOP_THRESHOLD) {
        this.observer.recordEvent({ type: 'doom_loop', timestamp: Date.now(), data: { consecutiveErrors: state.consecutiveErrors, lastTools: toolResults.map(r => r.id) } });
        const ev: AgentEvent = { type: 'error', data: { message: 'Doom loop detected — stopping after 3 consecutive all-tool-error rounds' } };
        this.bus?.publish(ev); yield ev;
        state.lastText = '[Stopped: repeated tool failures detected. Please try a different approach.]';
        break;
      }
      if (state.recentToolSigs.length >= REPETITION_THRESHOLD) {
        const lastN = state.recentToolSigs.slice(-REPETITION_THRESHOLD);
        if (lastN.every(s => s === lastN[0])) {
          this.observer.recordEvent({ type: 'doom_loop', timestamp: Date.now(), data: { type: 'repetition', signature: lastN[0] } });
          const ev: AgentEvent = { type: 'error', data: { message: 'Repetitive tool calls detected — stopping' } };
          this.bus?.publish(ev); yield ev;
          state.lastText = '[Stopped: repetitive tool calls detected. Please try a different approach.]';
          break;
        }
      }
      state.transition = { reason: 'next_turn' };
    }

    if (state.iteration > this.maxIterations) state.lastText = state.lastText || '[Max iterations reached]';
    const result = this.buildResult(state.lastText, state.lastThinking, session, toolsUsed, state.totalUsage, state.iteration);
    if (this.hooks) await this.hooks.runAgentEnd(hookCtx, result);
    this.observer.recordEvent({ type: 'agent_end', timestamp: Date.now(), data: { agentId: this.agentId, iterations: state.iteration, toolsUsed, duration_ms: Date.now() - startMs } });
    const endEvent: AgentEvent = { type: 'agent.end', data: { sessionId: session.id, toolsUsed } };
    this.bus?.publish(endEvent); yield endEvent;
    return result;
  }

  /** Delegate to sub-agent with recursion protection + tool filtering + abort propagation */
  private async *delegateToSubAgent(agentId: string, message: string, parentSession: Session): AsyncGenerator<AgentEvent, AgentResult> {
    const config = this.agents.get(agentId);
    if (!config || config.mode === 'hidden') return this.buildResult(`Unknown sub-agent: ${agentId}`, undefined, parentSession, [], { promptTokens: 0, completionTokens: 0 }, 0);
    if (this.depth >= MAX_SUBAGENT_DEPTH) return this.buildResult(`[Stopped: maximum sub-agent depth (${MAX_SUBAGENT_DEPTH}) reached]`, undefined, parentSession, [], { promptTokens: 0, completionTokens: 0 }, 0);

    this.observer.recordEvent({ type: 'subagent_start', timestamp: Date.now(), data: { parentAgent: this.agentId, subAgent: agentId, depth: this.depth + 1 } });
    const subStartEvent: AgentEvent = { type: 'subagent.start', data: { parentAgent: this.agentId, subAgent: agentId } };
    this.bus?.publish(subStartEvent); yield subStartEvent;

    const childSession = parentSession.createChild(agentId);
    const filteredTools = this.tools.withFilter(name => name !== 'delegate');
    const childAbort = new AbortController();
    const onParentAbort = () => childAbort.abort();
    this.abortSignal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      const subAgent = new PrismerAgent({
        provider: this.provider, tools: filteredTools, observer: this.observer, agents: this.agents, bus: this.bus,
        systemPrompt: config.systemPrompt, model: config.model ?? this.model, maxIterations: config.maxIterations ?? 20,
        agentId: config.id, workspaceDir: this.workspaceDir, _depth: this.depth + 1, abortSignal: childAbort.signal,
      });
      const gen = subAgent.processMessage(message, childSession);
      let iterResult = await gen.next();
      while (!iterResult.done) { yield iterResult.value; iterResult = await gen.next(); }
      const result = iterResult.value;
      for (const d of result.directives) parentSession.addPendingDirective(d);
      this.observer.recordEvent({ type: 'subagent_end', timestamp: Date.now(), data: { subAgent: agentId, toolsUsed: result.toolsUsed, iterations: result.iterations } });
      const subEndEvent: AgentEvent = { type: 'subagent.end', data: { parentAgent: this.agentId, subAgent: agentId } };
      this.bus?.publish(subEndEvent); yield subEndEvent;
      return result;
    } finally {
      this.abortSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  private async handleDelegateCall(
    call: { id: string; name: string; arguments: Record<string, unknown> }, session: Session, toolsUsed: string[],
  ): Promise<{ result: { id: string; output: string; error: boolean }; events: AgentEvent[] }> {
    const targetAgent = call.arguments.agent as string;
    const task = call.arguments.task as string;
    if (!targetAgent || !task) return { result: { id: call.id, output: 'Error: delegate requires "agent" and "task" arguments', error: true }, events: [] };
    toolsUsed.push(`delegate:${targetAgent}`);
    try {
      const events: AgentEvent[] = [];
      const gen = this.delegateToSubAgent(targetAgent, task, session);
      let iterResult = await gen.next();
      while (!iterResult.done) { events.push(iterResult.value); iterResult = await gen.next(); }
      return { result: { id: call.id, output: iterResult.value.text, error: false }, events };
    } catch (err) {
      return { result: { id: call.id, output: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`, error: true }, events: [] };
    }
  }

  private getDelegateToolSpec(): ToolSpec {
    const delegatable = this.agents.getDelegatableAgents();
    return { type: 'function', function: { name: 'delegate', description: `Delegate a task to a specialized sub-agent. Available: ${delegatable.join(', ')}`, parameters: { type: 'object', properties: { agent: { type: 'string', enum: delegatable, description: 'The sub-agent to delegate to' }, task: { type: 'string', description: 'The task description for the sub-agent' } }, required: ['agent', 'task'] } } };
  }

  private buildResult(text: string, thinking: string | undefined, session: Session, toolsUsed: string[], usage: { promptTokens: number; completionTokens: number }, iterations: number): AgentResult {
    return { text, thinking, directives: session.drainDirectives(), toolsUsed: [...new Set(toolsUsed)], usage: usage.promptTokens > 0 ? usage : undefined, iterations };
  }
}
