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
import { loadWorkspaceToolsFromPlugin, createTool } from '../tools/index.js';
import { OpenAICompatibleProvider, FallbackProvider, type Provider } from '../provider.js';
import { InMemoryArtifactStore } from '../artifacts/memory.js';
import { InMemoryTaskStore } from '../task/store.js';
import { MessageQueue } from '../task/message-queue.js';
import { TaskStateMachine } from '../task/machine.js';
import { DirectiveRouter } from './directive-router.js';
import { AgentViewStack } from './view-stack.js';
import { createWorldModel, buildHandoffContext, extractStructuredFacts, recordCompletion } from '../world-model/builder.js';
import { MemoryStore } from '../memory.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../log.js';
import type { IAgentLoop, LoopMode, AgentLoopInput, AgentLoopResult, AgentLoopCallOpts, Artifact } from './types.js';
import type { WorldModel } from '../world-model/types.js';
import type { Task } from '../task/types.js';

const log = createLogger('loop:dual');

/** Planning timeout — skip planning on slow LLM responses. */
const PLANNING_TIMEOUT_MS = 5_000;

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
  private activeBus: EventBus | null = null;
  private abortController: AbortController | null = null;

  constructor() {
    const cfg = loadConfig();
    this.memStore = new MemoryStore(cfg.workspace.dir);
    this.directiveRouter = new DirectiveRouter();
  }

  /**
   * Create a task and dispatch to the inner loop.
   * Resolves quickly with task metadata — result arrives via SSE events.
   */
  async processMessage(input: AgentLoopInput, opts?: AgentLoopCallOpts): Promise<AgentLoopResult> {
    const bus = opts?.bus ?? new EventBus();
    this.activeBus = bus;

    const sessionId = input.sessionId ?? `dual-${Date.now()}`;

    // A3: If this session has an active task, enqueue to it and return early.
    const existing = this.tasks.getActiveForSession(sessionId);
    if (existing) {
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
    this.abortController = new AbortController();
    const session = this.sessions.getOrCreate(sessionId);
    const taskId = randomUUID();

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
    this.runInnerLoop(task, input, session, bus, this.abortController.signal).catch(err => {
      log.error('inner loop crashed', { taskId, error: err instanceof Error ? err.message : String(err) });
      try { this.stateMachine.fail(task, err instanceof Error ? err.message : String(err)); } catch { /* already terminal */ }
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
    this.stateMachine.transition(task, 'planning');
    outerBus.publish({ type: 'task.planning' as const, data: { taskId: task.id, goal: input.content.slice(0, 500) } });

    let planSteps: string[] = [];
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

    // Emit progress checkpoint
    this.tasks.addCheckpoint(task.id, {
      id: randomUUID(),
      type: 'progress',
      message: planSteps.length > 0 ? `Planning complete: ${planSteps.length} steps identified` : 'Starting execution...',
      requiresUserAction: false,
      emittedAt: Date.now(),
    });

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

    // Bash tool — container-sandboxed, uses execSync with explicit argv
    const workspaceDir = cfg.workspace.dir;
    tools.register(createTool(
      'bash', 'Execute a bash command in the container',
      { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      async (args) => {
        const { execFileSync } = await import('node:child_process');
        try {
          return execFileSync('/bin/sh', ['-c', args.command as string], {
            cwd: workspaceDir, timeout: 30_000, encoding: 'utf8', maxBuffer: 1024 * 1024,
          }).slice(0, 10_000);
        } catch (e: unknown) {
          const err = e as { stderr?: string; message?: string };
          return `Error: ${err.stderr || err.message || String(e)}`.slice(0, 5_000);
        }
      },
    ));

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
      this.stateMachine.fail(task, err instanceof Error ? err.message : String(err));
      outerBus.publish({ type: 'error' as const, data: { message: err instanceof Error ? err.message : String(err) } });
    } finally {
      await observer.flush();
    }
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

  cancel(): void {
    // Abort the inner loop via AbortSignal
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    const active = this.tasks.getActive();
    if (active) {
      try { this.stateMachine.fail(active, 'Cancelled by user'); } catch { /* already terminal */ }
      log.info('task cancelled', { taskId: active.id });
    }
  }

  async shutdown(): Promise<void> {
    this.cancel();
    this.viewStack.clear();
    this.worldModel = null;
  }
}
