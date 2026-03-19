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
import { TaskStateMachine } from '../task/machine.js';
import { DirectiveRouter } from './directive-router.js';
import { AgentViewStack } from './view-stack.js';
import { createWorldModel, buildHandoffContext, extractStructuredFacts, recordCompletion } from '../world-model/builder.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../log.js';
import type { IAgentLoop, LoopMode, AgentLoopInput, AgentLoopResult, AgentLoopCallOpts, Artifact } from './types.js';
import type { WorldModel } from '../world-model/types.js';
import type { Task } from '../task/types.js';

const log = createLogger('loop:dual');

export class DualLoopAgent implements IAgentLoop {
  readonly mode: LoopMode = 'dual';

  readonly artifacts = new InMemoryArtifactStore();
  readonly tasks = new InMemoryTaskStore();
  readonly sessions = new SessionStore();
  readonly stateMachine = new TaskStateMachine();
  readonly viewStack = new AgentViewStack();

  private worldModel: WorldModel | null = null;
  private activeBus: EventBus | null = null;
  private cancelFlag = false;

  /**
   * Create a task and dispatch to the inner loop.
   * Resolves quickly with task metadata — result arrives via SSE events.
   */
  async processMessage(input: AgentLoopInput, opts?: AgentLoopCallOpts): Promise<AgentLoopResult> {
    const bus = opts?.bus ?? new EventBus();
    this.activeBus = bus;
    this.cancelFlag = false;

    const sessionId = input.sessionId ?? `dual-${Date.now()}`;
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

    // Create world model for this task
    this.worldModel = createWorldModel(taskId, input.content);

    // Transition to executing
    this.stateMachine.transition(task, 'executing');

    // Emit task.created event
    bus.publish({ type: 'agent.start' as const, data: { sessionId, agentId: 'dual-loop' } });

    // Dispatch inner loop in background (fire-and-forget from caller's perspective)
    this.runInnerLoop(task, input, session, bus).catch(err => {
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
    };
  }

  /** The inner execution loop — runs independently of the caller. */
  private async runInnerLoop(
    task: Task,
    input: AgentLoopInput,
    session: Session,
    bus: EventBus,
  ): Promise<void> {
    const cfg = loadConfig();
    const inputCfg = input.config ?? {};
    const baseUrl = (inputCfg.baseUrl as string) || cfg.llm.baseUrl;
    const apiKey = (inputCfg.apiKey as string) || cfg.llm.apiKey;
    const rawModel = (inputCfg.model as string) || cfg.llm.model;
    const model = rawModel.includes('/') ? rawModel.split('/').pop()! : rawModel;

    const baseProvider = new OpenAICompatibleProvider({ baseUrl, apiKey, defaultModel: model });
    const fallbacks = cfg.llm.fallbackModels;
    const provider: Provider = fallbacks.length > 0
      ? new FallbackProvider(baseProvider, [model, ...fallbacks])
      : baseProvider;

    // Emit progress checkpoint
    this.tasks.addCheckpoint(task.id, {
      id: randomUUID(),
      type: 'progress',
      message: 'Starting execution...',
      requiresUserAction: false,
      emittedAt: Date.now(),
    });

    // Build system prompt with handoff context
    let systemPrompt = `You are a research assistant executing a task.\n\nTask: ${input.content}`;
    if (this.worldModel) {
      const handoff = buildHandoffContext(this.worldModel, 'researcher');
      if (handoff) systemPrompt += `\n\n## Task Context\n${handoff}`;
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

    const agent = new PrismerAgent({
      provider,
      tools,
      observer,
      agents,
      bus,
      systemPrompt,
      model,
      maxIterations: (inputCfg.maxIterations as number) ?? cfg.agent.maxIterations,
      agentId: 'researcher',
      workspaceDir,
    });

    try {
      const result = await agent.processMessage(input.content, session, undefined, input.images);

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

      bus.publish({ type: 'agent.end' as const, data: { sessionId: session.id, toolsUsed: result.toolsUsed } });
    } catch (err) {
      this.stateMachine.fail(task, err instanceof Error ? err.message : String(err));
      bus.publish({ type: 'error' as const, data: { message: err instanceof Error ? err.message : String(err) } });
    } finally {
      await observer.flush();
    }
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
    this.cancelFlag = true;
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
