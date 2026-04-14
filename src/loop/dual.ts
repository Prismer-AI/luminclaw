/**
 * DualLoopAgent — HIL (outer) + ExecutionLoop (inner) architecture.
 *
 * `processMessage()` resolves quickly after creating a task (< 100 ms).
 * The actual result arrives via SSE `task.checkpoint` / `task.completed` events.
 *
 * @module loop/dual
 */

import { randomUUID } from 'node:crypto';
import { PrismerAgent } from '../agent.js';
import { EventBus } from '../sse.js';
import { SessionStore, Session } from '../session.js';
import { ConsoleObserver } from '../observer.js';
import { ToolRegistry } from '../tools.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../agents.js';
import {
  loadWorkspaceToolsFromPlugin,
  createBashTool,
  createTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
} from '../tools/index.js';
import { OpenAICompatibleProvider, FallbackProvider, type Provider } from '../provider.js';
import { InMemoryArtifactStore } from '../artifacts/memory.js';
import { InMemoryTaskStore } from '../task/store.js';
import { MessageQueue } from '../task/message-queue.js';
import { TaskStateMachine } from '../task/machine.js';
import { DirectiveRouter } from './directive-router.js';
import { AgentViewStack } from './view-stack.js';
import { createWorldModel, buildHandoffContext, extractStructuredFacts, recordCompletion, serializeKnowledgeBaseForMemory } from '../world-model/builder.js';
import { MemoryStore } from '../memory.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../log.js';
import type { IAgentLoop, LoopMode, AgentLoopInput, AgentLoopResult, AgentLoopCallOpts, Artifact } from './types.js';
import type { WorldModel } from '../world-model/types.js';
import type { Task } from '../task/types.js';
import { appendTurn, writeMeta, readTranscript, enumerateSessionTasks, type TaskMetadata } from '../task/disk.js';
import { AbortReason, createAbortError, type AbortReasonValue } from '../abort.js';
import type { TaskStatus } from '../task/types.js';

const log = createLogger('loop:dual');

/** Planning timeout — skip planning on slow LLM responses. */
const PLANNING_TIMEOUT_MS = 5_000;

/** Default eviction interval and max-age: 1 hour. */
const DEFAULT_EVICTION_MS = 60 * 60 * 1_000;

export interface DualLoopAgentOptions {
  /** How often to run the eviction sweep (ms). Default: 3_600_000 (1h). */
  evictionIntervalMs?: number;
  /** Evict terminal tasks older than this age (ms). Default: 3_600_000 (1h). */
  evictionMaxAgeMs?: number;
}

export class DualLoopAgent implements IAgentLoop {
  readonly mode: LoopMode = 'dual';

  readonly artifacts = new InMemoryArtifactStore();
  readonly tasks = new InMemoryTaskStore();
  readonly messageQueue = new MessageQueue();
  readonly sessions = new SessionStore();
  readonly stateMachine = new TaskStateMachine();
  directiveRouter: DirectiveRouter;
  readonly viewStack = new AgentViewStack();
  readonly memStore: MemoryStore;

  private worldModel: WorldModel | null = null;
  /**
   * Per-task runtime context. Keyed by taskId.
   *
   * Each concurrent task gets its own AbortController (so `cancel(taskId)`
   * only interrupts the intended task) and its own EventBus reference (so
   * messages queued against a running task can still reach the original
   * WebSocket subscriber even when the enqueuing request supplied no bus).
   */
  private taskContexts = new Map<string, { abortController: AbortController; bus: EventBus }>();

  /** Timer handle for the periodic eviction sweep. Null after shutdown. */
  private evictionTimer: NodeJS.Timeout | null = null;

  constructor(options: DualLoopAgentOptions = {}) {
    const cfg = loadConfig();
    this.memStore = new MemoryStore(cfg.workspace.dir);
    this.directiveRouter = new DirectiveRouter();

    const intervalMs = options.evictionIntervalMs ?? DEFAULT_EVICTION_MS;
    const maxAgeMs = options.evictionMaxAgeMs ?? DEFAULT_EVICTION_MS;
    this.evictionTimer = setInterval(() => {
      try {
        const evicted = this.tasks.evictCompleted(maxAgeMs);
        if (evicted > 0) log.info('evicted terminal tasks', { count: evicted });
      } catch (err) {
        log.warn('eviction tick failed', { error: String(err) });
      }
    }, intervalMs);
    // Allow process to exit even if this timer is the only pending handle.
    this.evictionTimer.unref?.();
  }

  /**
   * Create a task and dispatch to the inner loop.
   * Resolves quickly with task metadata — result arrives via SSE events.
   */
  async processMessage(input: AgentLoopInput, opts?: AgentLoopCallOpts): Promise<AgentLoopResult> {
    const sessionId = input.sessionId ?? `dual-${Date.now()}`;

    // A3: If this session has an active task, enqueue to it and return early.
    const existing = this.tasks.getActiveForSession(sessionId);
    if (existing) {
      // Prefer the caller-supplied bus, but fall back to the bus the active
      // task was created with so enqueue events still reach the original
      // WebSocket subscriber when the enqueuing HTTP request supplies none.
      const activeCtx = this.taskContexts.get(existing.id);
      const bus = opts?.bus ?? activeCtx?.bus ?? new EventBus();

      const queued = this.messageQueue.enqueue(existing.id, input.content);
      bus.publish({
        type: 'task.message.enqueued' as const,
        data: { taskId: existing.id, messageId: queued.id, content: input.content.slice(0, 500) },
      });
      return {
        text: `Message queued for task ${existing.id}.`,
        directives: [],
        toolsUsed: [],
        iterations: 0,
        sessionId,
        taskId: existing.id,
        queued: true,
      };
    }

    // No active task — create one as before.
    const bus = opts?.bus ?? new EventBus();
    const abortController = new AbortController();
    const session = this.sessions.getOrCreate(sessionId);
    // D3: Dual-loop runs headless — no human present to approve interactive
    // tools. Setting `auto` mode makes the agent auto-deny any tool flagged
    // with requiresUserInteraction(). Plan-mode tools can still flip this.
    session.permissionContext = { mode: 'auto' };
    const taskId = randomUUID();
    this.taskContexts.set(taskId, { abortController, bus });

    // Create task
    const task = this.tasks.create({
      id: taskId,
      sessionId,
      instruction: input.content,
      artifactIds: this.artifacts.getUnassigned().map(a => a.id),
      status: 'pending',
    });

    // Assign unassigned artifacts to this task
    for (const a of this.artifacts.getUnassigned()) {
      this.artifacts.assignToTask(a.id, taskId);
    }

    // B3: Persist initial metadata + initial user turn (fire-and-forget).
    const persistWorkspaceDir = loadConfig().workspace.dir;
    const initMeta: TaskMetadata = {
      id: taskId,
      sessionId,
      instruction: input.content,
      status: 'pending',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      lastPersistedTurnOffset: 0,
      version: 1,
    };
    void writeMeta(persistWorkspaceDir, sessionId, taskId, initMeta)
      .catch(e => log.warn('writeMeta failed', { taskId, error: String(e) }));
    void appendTurn(persistWorkspaceDir, sessionId, taskId, {
      kind: 'user', content: input.content, timestamp: task.createdAt,
    }).catch(e => log.warn('appendTurn failed', { taskId, error: String(e) }));

    // Recall previous world model facts from MemoryStore and seed knowledgeBase
    const newWorldModel = createWorldModel(taskId, input.content);
    try {
      const previousFacts = await this.memStore.recall('world-model', 4000);
      if (previousFacts) {
        // Parse recalled facts back into knowledgeBase entries
        for (const line of previousFacts.split('\n')) {
          const match = line.match(/^(.+?):\s*(.+)$/);
          if (match && match[1] && match[2]) {
            newWorldModel.knowledgeBase.push({
              key: match[1].trim(),
              value: match[2].trim(),
              sourceAgentId: 'memory',
              confidence: 'medium',
            });
          }
        }
      }
    } catch {
      // Non-fatal — memory recall failure should not block task creation
    }

    // Create world model for this task
    this.worldModel = newWorldModel;

    // Emit task.created event (frontend can use taskId for status polling)
    bus.publish({ type: 'task.created' as const, data: { taskId, sessionId, instruction: input.content.slice(0, 500) } });
    bus.publish({ type: 'agent.start' as const, data: { sessionId, agentId: 'dual-loop' } });

    // Dispatch inner loop in background (fire-and-forget from caller's perspective)
    this.runInnerLoop(task, input, session, bus, abortController.signal).catch(err => {
      log.error('inner loop crashed', { taskId, error: err instanceof Error ? err.message : String(err) });
      try { this.stateMachine.fail(task, err instanceof Error ? err.message : String(err)); } catch { /* already terminal */ }
      void this.persistState(task, err instanceof Error ? err.message : String(err));
      // Drain any queued messages so callers see them surface as orphaned
      // rather than silently disappearing when the inner loop crashes.
      this.drainQueueOnTermination(task.id, 'task_aborted');
      this.taskContexts.delete(task.id);
      bus.publish({ type: 'error' as const, data: { message: `Task failed: ${err instanceof Error ? err.message : String(err)}` } });
    });

    // Return immediately with task info
    return {
      text: `Task ${taskId} created and executing.`,
      directives: [],
      toolsUsed: [],
      iterations: 0,
      sessionId,
      taskId,
    };
  }

  /** The inner execution loop — runs independently of the caller. */
  private async runInnerLoop(
    task: Task,
    input: AgentLoopInput,
    session: Session,
    outerBus: EventBus,
    signal: AbortSignal,
  ): Promise<void> {
    const cfg = loadConfig();
    const inputCfg = input.config ?? {};
    const baseUrl = (inputCfg.baseUrl as string) || cfg.llm.baseUrl;
    const apiKey = (inputCfg.apiKey as string) || cfg.llm.apiKey;
    const rawModel = (inputCfg.model as string) || cfg.llm.model;
    const model = rawModel.startsWith('prismer-gateway/') ? rawModel.slice('prismer-gateway/'.length) : rawModel;

    const baseProvider = new OpenAICompatibleProvider({ baseUrl, apiKey, defaultModel: model });
    const fallbacks = cfg.llm.fallbackModels;
    const provider: Provider = fallbacks.length > 0
      ? new FallbackProvider(baseProvider, [model, ...fallbacks])
      : baseProvider;

    // ── Planning phase (optional, with timeout) ──
    // Skip planning when the task is already in 'executing' status — this
    // happens on resume (resumeTask transitions interrupted → executing before
    // dispatching runInnerLoop). Attempting to transition executing → planning
    // is an invalid state-machine move and would throw InvalidTransitionError.
    const isResume = task.status === 'executing';

    let planSteps: string[] = [];
    if (!isResume) {
      this.stateMachine.transition(task, 'planning');
      outerBus.publish({ type: 'task.planning' as const, data: { taskId: task.id, goal: input.content.slice(0, 500) } });

      try {
        const planResult = await Promise.race([
          provider.chat({
            messages: [
              { role: 'system', content: 'You are a planning assistant. Create a brief execution plan (3-5 steps) as a JSON array of strings. Return ONLY the JSON array, no other text.' },
              { role: 'user', content: input.content },
            ],
            model,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), PLANNING_TIMEOUT_MS)),
        ]);

        if (planResult && planResult.text) {
          try {
            const parsed = JSON.parse(planResult.text.replace(/```json\n?|\n?```/g, '').trim());
            if (Array.isArray(parsed)) planSteps = parsed.map(String).slice(0, 5);
          } catch {
            // LLM returned non-JSON — extract lines as steps
            planSteps = planResult.text.split('\n').filter(l => l.trim()).slice(0, 5);
          }
        }
      } catch (err) {
        log.warn('planning failed, skipping to execution', { error: err instanceof Error ? err.message : String(err) });
      }

      if (planSteps.length > 0) {
        task.plan = planSteps;
        outerBus.publish({ type: 'task.planned' as const, data: { taskId: task.id, steps: planSteps } });
      }

      // Transition to executing
      this.stateMachine.transition(task, 'executing');
      void this.persistState(task);

      // Emit progress checkpoint (first run only)
      this.tasks.addCheckpoint(task.id, {
        id: randomUUID(),
        type: 'progress',
        message: planSteps.length > 0 ? `Planning complete: ${planSteps.length} steps identified` : 'Starting execution...',
        requiresUserAction: false,
        emittedAt: Date.now(),
      });
    }

    // Build system prompt with handoff context
    let systemPrompt = `You are a research assistant executing a task.\n\nTask: ${input.content}`;
    if (this.worldModel) {
      const handoff = buildHandoffContext(this.worldModel, 'researcher');
      if (handoff) systemPrompt += `\n\n## Task Context\n${handoff}`;
    }
    if (planSteps.length > 0) {
      systemPrompt += `\n\n## Execution Plan\n${planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    }

    // Initialize tools
    const tools = new ToolRegistry();
    try {
      const { tools: workspaceTools } = await loadWorkspaceToolsFromPlugin(cfg.workspace.pluginPath);
      tools.registerMany(workspaceTools);
    } catch { /* plugin not available locally */ }

    // Bash tool — canonical factory from tools/builtins.ts so the dual-loop
    // runtime shares the same abort-signal semantics as runAgent().
    const workspaceDir = cfg.workspace.dir;
    tools.register(createBashTool(workspaceDir));

    // Memory tools — required for cross-task knowledge continuity (Phase E).
    // Mirror the registrations in src/index.ts::ensureInitialized() so that
    // the dual-loop inner executor has the same tool surface as runAgent().
    const memStoreInstance = this.memStore;
    tools.register(createTool(
      'memory_store',
      'Store a memory entry for later recall. Use to save important facts, decisions, code snippets, or action items.',
      {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content to store' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        },
        required: ['content'],
      },
      async (args) => {
        const content = args.content as string;
        const tags = (args.tags as string[] | undefined) ?? [];
        await memStoreInstance.store(content, tags);
        return 'Memory stored successfully.';
      },
    ));
    tools.register(createTool(
      'memory_recall',
      'Search stored memories by keywords. Returns relevant past entries sorted by relevance.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search for in memories' },
          maxChars: { type: 'number', description: 'Max characters to return (default: 4000)' },
        },
        required: ['query'],
      },
      async (args) => {
        const query = args.query as string;
        const result = await memStoreInstance.recall(query, (args.maxChars as number) ?? 4000);
        return result || 'No matching memories found.';
      },
    ));

    // Plan mode tools (D4) — mirror registrations in src/index.ts::ensureInitialized.
    tools.register(createEnterPlanModeTool());
    tools.register(createExitPlanModeTool());

    const agents = new AgentRegistry();
    agents.registerMany(BUILTIN_AGENTS);
    const observer = new ConsoleObserver();

    // ── Inner bus with DirectiveRouter ──
    // Create a separate inner bus. Subscribe and route events through
    // DirectiveRouter before forwarding to the outer bus.
    const innerBus = new EventBus();
    this.directiveRouter = new DirectiveRouter(outerBus);

    innerBus.subscribe((event) => {
      if (event.type === 'directive') {
        // Route through DirectiveRouter (realtime/checkpoint/hil-only)
        this.directiveRouter.route(event.data as any);
        // Track SWITCH_COMPONENT for ViewStack
        const directiveType = (event.data as any).type;
        if (directiveType === 'SWITCH_COMPONENT') {
          const component = (event.data as any).payload?.component ?? '';
          this.viewStack.recordSwitch('researcher', component);
        }
      } else {
        // Non-directive events forward directly to outer bus
        outerBus.publish(event);
      }
    });

    const agent = new PrismerAgent({
      provider,
      tools,
      observer,
      agents,
      bus: innerBus,
      systemPrompt,
      model,
      maxIterations: (inputCfg.maxIterations as number) ?? cfg.agent.maxIterations,
      agentId: 'researcher',
      workspaceDir,
      onIterationStart: async (iteration, sessionArg) => {
        // A5: Drain MessageQueue for this task and inject as user messages.
        const drained = this.messageQueue.drainForTask(task.id);
        for (const m of drained) {
          sessionArg.addMessage({ role: 'user', content: m.content });
        }
        // Update progress and emit task.progress event.
        const current = this.tasks.get(task.id);
        const prev = current?.progress ?? { iterations: 0, toolsUsed: [], lastActivity: 0 };
        const lastActivity = Date.now();
        this.tasks.updateProgress(task.id, {
          iterations: iteration,
          toolsUsed: prev.toolsUsed,
          lastActivity,
        });
        outerBus.publish({
          type: 'task.progress' as const,
          data: { taskId: task.id, iteration, toolsUsed: prev.toolsUsed, lastActivity },
        });
      },
    });

    try {
      // Consume the AsyncGenerator — events are published to bus internally
      const gen = agent.processMessage(input.content, session);
      let iterResult = await gen.next();
      while (!iterResult.done) iterResult = await gen.next();
      const result = iterResult.value;

      // Drain checkpoint buffer on completion
      const buffered = this.directiveRouter.drainCheckpointBuffer();
      for (const d of buffered) {
        outerBus.publish({ type: 'directive', data: d as unknown as Record<string, unknown> });
      }

      // Record completion in WorldModel
      if (this.worldModel) {
        recordCompletion(this.worldModel, {
          agentId: 'researcher',
          task: input.content.slice(0, 200),
          resultSummary: result.text.slice(0, 200),
          toolsUsed: result.toolsUsed,
          artifactsProduced: [],
          completedAt: Date.now(),
        });

        // Background knowledge extraction (fast path only)
        const facts = extractStructuredFacts(result.text, 'researcher');
        facts.forEach(f => this.worldModel!.knowledgeBase.push(f));

        // Persist facts to MemoryStore (Phase C)
        if (facts.length > 0) {
          const factsStr = `[WorldModel Facts] task=${task.id}\n${facts.map(f => `${f.key}: ${f.value}`).join('\n')}`;
          this.memStore.store(factsStr, ['world-model', task.id]).catch(err => {
            log.warn('failed to persist world model facts', { error: err instanceof Error ? err.message : String(err) });
          });
        }
      }

      // Complete the task
      this.stateMachine.complete(task, result.text);
      void this.persistState(task);

      // E2: Persist knowledgeBase to MemoryStore for cross-task recall.
      void this.persistKnowledgeBase(task.id).catch(() => { /* logged in helper */ });

      // Drain any messages that arrived while the task was finishing — they
      // are orphaned because there is no active task to receive them.
      this.drainQueueOnTermination(task.id, 'task_completed');

      // Emit result checkpoint
      this.tasks.addCheckpoint(task.id, {
        id: randomUUID(),
        type: 'result',
        message: result.text,
        requiresUserAction: false,
        data: {
          thinking: result.thinking,
          directives: result.directives,
          toolsUsed: result.toolsUsed,
          usage: result.usage,
          iterations: result.iterations,
        },
        emittedAt: Date.now(),
      });

      outerBus.publish({ type: 'task.completed' as const, data: { taskId: task.id, sessionId: session.id, result: result.text.slice(0, 1000), toolsUsed: result.toolsUsed } });
      outerBus.publish({ type: 'agent.end' as const, data: { sessionId: session.id, toolsUsed: result.toolsUsed } });

      // Emit chat.final with enriched data for state recovery
      outerBus.publish({ type: 'chat.final' as const, data: {
        content: result.text,
        thinking: result.thinking,
        toolsUsed: result.toolsUsed,
        directives: result.directives,
        iterations: result.iterations,
        usage: result.usage,
        sessionId: session.id,
        taskId: task.id,
      }});
    } catch (err) {
      try { this.stateMachine.fail(task, err instanceof Error ? err.message : String(err)); } catch { /* already terminal */ }
      void this.persistState(task, err instanceof Error ? err.message : String(err));
      // Drain queued messages BEFORE emitting the error so subscribers see
      // orphan events alongside the failure.
      this.drainQueueOnTermination(task.id, 'task_aborted');
      outerBus.publish({ type: 'error' as const, data: { message: err instanceof Error ? err.message : String(err) } });
    } finally {
      // Always release the per-task context, regardless of success/failure,
      // so the map doesn't grow unbounded across runs.
      this.taskContexts.delete(task.id);
      await observer.flush();
    }
  }

  /**
   * E2: Persist this task's WorldModel.knowledgeBase to MemoryStore so it can
   * be recalled at the start of the next task. Best-effort — all errors are
   * logged, nothing thrown.
   */
  private async persistKnowledgeBase(taskId: string): Promise<void> {
    const wm = this.worldModel;
    if (!wm || wm.taskId !== taskId || wm.knowledgeBase.length === 0) return;
    const serialized = serializeKnowledgeBaseForMemory(wm.knowledgeBase);
    if (!serialized) return;
    try {
      await this.memStore.store(serialized, ['world-model', `task:${taskId}`]);
      log.info('persisted knowledgeBase to memory', { taskId, factCount: wm.knowledgeBase.length });
    } catch (err) {
      log.warn('persistKnowledgeBase failed', { taskId, error: String(err) });
    }
  }

  /**
   * B3: Persist current task state to disk (status turn + metadata rewrite).
   * Fire-and-forget — errors are logged, never thrown, never awaited by caller.
   */
  private async persistState(task: Task, reason?: string): Promise<void> {
    const workspaceDir = loadConfig().workspace.dir;
    const ts = Date.now();
    try {
      await appendTurn(workspaceDir, task.sessionId, task.id, {
        kind: 'status', status: task.status, reason, timestamp: ts,
      });
      const meta: TaskMetadata = {
        id: task.id,
        sessionId: task.sessionId,
        instruction: task.instruction,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: ts,
        endedAt: ['completed', 'failed', 'interrupted', 'killed'].includes(task.status) ? ts : undefined,
        iterations: task.progress?.iterations,
        toolsUsed: task.progress?.toolsUsed,
        error: task.error,
        lastPersistedTurnOffset: 0,
        version: 1,
      };
      await writeMeta(workspaceDir, task.sessionId, task.id, meta);
    } catch (err) {
      log.warn('persistState failed', { taskId: task.id, error: String(err) });
    }
  }

  /**
   * B4: Enumerate tasks persisted to disk from previous server runs and
   * re-register them in the in-memory store.
   *
   * Non-terminal tasks (executing / paused / planning / pending) are marked
   * `interrupted` — they cannot be automatically resumed without an explicit
   * client action.  Terminal tasks (completed / failed / killed) are restored
   * as-is so their results remain queryable.
   */
  async loadPersistedTasks(): Promise<void> {
    const workspaceDir = loadConfig().workspace.dir;
    const metas = await enumerateSessionTasks(workspaceDir);
    for (const meta of metas) {
      const restoredStatus: TaskStatus =
        (['executing', 'paused', 'planning', 'pending'] as TaskStatus[]).includes(meta.status)
          ? 'interrupted'
          : meta.status;
      this.tasks.create({
        id: meta.id,
        sessionId: meta.sessionId,
        instruction: meta.instruction,
        artifactIds: [],
        status: restoredStatus,
      });
      this.tasks.update(meta.id, { status: restoredStatus, error: meta.error });
      if (meta.iterations !== undefined) {
        this.tasks.updateProgress(meta.id, {
          iterations: meta.iterations,
          toolsUsed: meta.toolsUsed ?? [],
          lastActivity: meta.updatedAt,
        });
      }
    }
    log.info('loaded persisted tasks', { count: metas.length });
  }

  /**
   * B5: Resume an interrupted task by replaying its persisted transcript
   * into a fresh session and re-dispatching the inner loop.
   *
   * Only tasks in status `interrupted` (as re-registered by
   * {@link loadPersistedTasks}) are resumable.  After a successful resume the
   * task transitions to `executing` and the inner loop runs fire-and-forget
   * on a new AbortController + EventBus.
   */
  async resumeTask(taskId: string): Promise<{ taskId: string; sessionId: string }> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'interrupted') {
      throw new Error(`Cannot resume task in status '${task.status}' — only 'interrupted' is resumable`);
    }

    // Load transcript from disk and replay into a fresh session.
    const workspaceDir = loadConfig().workspace.dir;
    const turns = await readTranscript(workspaceDir, task.sessionId, taskId);

    const session = this.sessions.getOrCreate(task.sessionId);
    // Reset — we'll replay from disk. Session.messages is readonly in the
    // type but array mutation (length reset) is permitted.
    session.messages.length = 0;
    for (const turn of turns) {
      if (turn.kind === 'user') {
        session.addMessage({ role: 'user', content: turn.content });
      } else if (turn.kind === 'assistant') {
        // Convert TurnEntry toolCalls ({id,name,arguments}) to Message shape
        // ({id,type:'function',function:{name,arguments:string}}).
        const msgToolCalls = turn.toolCalls?.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
          },
        }));
        session.addMessage({
          role: 'assistant',
          content: turn.content,
          toolCalls: msgToolCalls,
        });
      } else if (turn.kind === 'tool') {
        session.addMessage({
          role: 'tool',
          content: turn.content,
          toolCallId: turn.toolCallId,
        });
      }
      // 'status' turns are lifecycle markers, not session messages.
    }

    // Transition back to executing.
    this.stateMachine.transition(task, 'executing');
    void this.persistState(task);

    // Create new abortController + bus for the resumed task.
    const abortController = new AbortController();
    const bus = new EventBus();
    this.taskContexts.set(taskId, { abortController, bus });

    // Re-dispatch inner loop (fire-and-forget).
    void this.runInnerLoop(
      task,
      { content: task.instruction, sessionId: task.sessionId },
      session,
      bus,
      abortController.signal,
    )
      .catch(err => {
        log.error('resumed inner loop crashed', { taskId, error: String(err) });
        try { this.stateMachine.fail(task, String(err)); } catch { /* already terminal */ }
        void this.persistState(task, String(err));
        this.drainQueueOnTermination(taskId, 'task_aborted');
        this.taskContexts.delete(taskId);
      });

    return { taskId, sessionId: task.sessionId };
  }

  getTasks() {
    return this.tasks.list().map(t => ({
      id: t.id,
      sessionId: t.sessionId,
      instruction: t.instruction,
      status: t.status,
      result: t.result,
      error: t.error,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
  }

  getTask(id: string) {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    return {
      id: t.id,
      sessionId: t.sessionId,
      instruction: t.instruction,
      status: t.status,
      artifactIds: t.artifactIds,
      checkpoints: t.checkpoints,
      progress: t.progress,
      result: t.result,
      error: t.error,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  addArtifact(artifact: Artifact): void {
    this.artifacts.add({
      url: artifact.url,
      mimeType: artifact.mimeType,
      type: artifact.type,
      addedBy: artifact.addedBy,
      taskId: artifact.taskId,
    });
  }

  resume(clarification: string): void {
    const active = this.tasks.getActive();
    if (active && active.status === 'paused') {
      this.stateMachine.transition(active, 'executing');
      log.info('task resumed', { taskId: active.id, clarification: clarification.slice(0, 100) });
    }
  }

  /**
   * Cancel a specific task (or the sole active task when taskId is omitted).
   *
   * Backwards-compat: callers that predate the multi-task model invoke
   * `cancel(reason)` with no taskId. If exactly one task context exists, we
   * cancel that. If multiple are active and no taskId is supplied, we log a
   * warning and cancel ALL — surfacing the ambiguity rather than silently
   * cancelling the "wrong" one.
   */
  cancel(taskId?: string, reason: AbortReasonValue = AbortReason.UserExplicitCancel): void {
    // Resolve which contexts to cancel.
    const targets: string[] = [];
    if (taskId) {
      if (this.taskContexts.has(taskId)) {
        targets.push(taskId);
      } else {
        log.warn('cancel: taskId not found in taskContexts', { taskId });
      }
    } else if (this.taskContexts.size === 1) {
      targets.push(this.taskContexts.keys().next().value as string);
    } else if (this.taskContexts.size > 1) {
      log.warn('cancel: no taskId supplied but multiple tasks are active; cancelling all', { count: this.taskContexts.size });
      for (const id of this.taskContexts.keys()) targets.push(id);
    }

    for (const id of targets) {
      const ctx = this.taskContexts.get(id);
      if (!ctx) continue;
      // Abort the inner loop via AbortSignal with structured reason.
      ctx.abortController.abort(createAbortError(reason));
      const task = this.tasks.get(id);
      if (task) {
        try { this.stateMachine.fail(task, `cancelled: ${reason}`); } catch { /* already terminal */ }
        void this.persistState(task, `cancelled: ${reason}`);
        log.info('task cancelled', { taskId: id, reason });
        this.drainQueueOnTermination(id, 'task_aborted');
      }
      // NOTE: we intentionally do NOT delete the taskContexts entry here;
      // the runInnerLoop finally-block deletes it. Leaving it in place
      // lets callers (and tests) still inspect signal.reason after cancel.
    }
  }

  /**
   * Drain any queued messages for a task that is terminating and emit
   * `task.message.orphaned` events for each so callers can surface them to
   * the user (and not silently lose them).  Fires on both completion and
   * cancellation paths.
   */
  private drainQueueOnTermination(taskId: string, reason: 'task_completed' | 'task_aborted'): void {
    const drained = this.messageQueue.drainForTask(taskId);
    if (drained.length === 0) return;
    const bus = this.taskContexts.get(taskId)?.bus;
    if (!bus) return;
    for (const m of drained) {
      bus.publish({
        type: 'task.message.orphaned' as const,
        data: { taskId, messageId: m.id, content: m.content, reason },
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.cancel();
    this.viewStack.clear();
    this.worldModel = null;
  }
}
