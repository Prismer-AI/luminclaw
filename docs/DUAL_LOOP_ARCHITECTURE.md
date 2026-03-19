# Agent Architecture Abstraction & Dual-Loop Execution Mode
## Lumin — Runtime Mode Switching: Single-Loop / Dual-Loop / OpenClaw

> **Status**: Design / Pre-implementation
> **Target**: Dual-loop execution mode (experimental, `LUMIN_LOOP_MODE=dual`)
> **Constraint**: Zero regression on OpenClaw runtime and Lumin single-loop mode
> **Rev**: 3 — Corrects naming: no "Lumin v2"; Lumin is one runtime with switchable execution modes

---

## 1. Problem Statement

### 1.1 The Cognitive Gap in Single-Loop Agents

Both OpenClaw and Lumin (in its current single-loop mode) share the same fundamental execution model: **receive message → LLM → tools → stream back → done**. This design, while correct for a chatbot, creates three irreconcilable cognitive mismatches when the agent has a real workspace behind it:

| Gap | What user expects | What actually happens |
|-----|-------------------|-----------------------|
| **Mental model** | ChatGPT-style: each message is a self-contained exchange | Agent has a persistent workspace, files, and history across all messages |
| **Input completeness** | "I can add more context mid-task" | New messages are new turns; agent can't tell if image #3 is a correction or a new request |
| **Attention model** | "Fire and forget, come back to verify" | Agent streams raw tool events at user; implies must supervise |

The multi-image upload problem is a direct symptom of gap #2: there is nowhere to put "supplementary artifacts for the current task" because the only input channel is the chat message itself.

### 1.2 Why Devin's Dual-Loop Is The Correct Shape

```
┌─────────────────────────────────────────────┐
│           Outer Loop (Human Interface)       │
│  user input → task queue → checkpoint out   │
│  artifact store (images, files)             │
│  task state machine                         │
│  clarification / approval gates             │
└────────────────┬────────────────────────────┘
                 │  Task + Artifacts
                 ▼
┌─────────────────────────────────────────────┐
│           Inner Loop (Execution Engine)      │
│  LLM → tools → LLM → tools → ...           │
│  self-contained, no direct user access      │
│  reports checkpoints to outer loop          │
│  can request clarification (pause)          │
└─────────────────────────────────────────────┘
```

The two loops have **different clocks**: the outer loop is human-paced (seconds to hours between inputs), the inner loop is compute-paced (milliseconds between tool calls). Conflating them is the root cause of all three cognitive gaps.

---

## 2. Current Architecture Analysis

### 2.1 Lumin — Single-Loop Mode (Current Default)

**Entry**: `server.ts` WebSocket `chat.send` → `runAgent()` in `index.ts`

```
chat.send(content, sessionId, images)
    │
    ▼
PrismerAgent.processMessage(input, session, memory, images)
    │
    └── for iteration in [1..maxIterations]:
          ├── LLM call (streaming) → bus.publish('text.delta')
          ├── IF no tool calls → DONE, return AgentResult
          └── tool calls (parallel Promise.all)
                ├── hook: before_tool
                ├── execute tool → ctx.emit(directive)
                ├── hook: after_tool
                └── scanDirectiveFiles() — filesystem fallback
              add assistant + tool messages to session
              doom-loop detection
    │
    ▼
bus.emit('agent.end') → chat.final WS event
```

**Session object** holds the entire conversation history + pending directives. There is no concept of a "task" separate from the conversation. Images are injected directly into the current user message as `image_url` content blocks — no artifact store, images live in the message that sent them and are forgotten after compaction.

### 2.2 OpenClaw — Single-Loop with Auth Layer

OpenClaw (~913K LOC vs Lumin's ~4,900 LOC) is architecturally the same loop, wrapped in:
- Ed25519 device authentication (challenge-response, port 18900)
- Multi-layer sessions (device + operator + workspace)
- Richer approval gating (interactive, not timeout-based)
- Separate gateway process vs Lumin's inline gateway (port 3001)

The agent execution model remains: receive message → LLM → tools → respond. No task abstraction or outer/inner loop separation.

### 2.3 PISA-OS Bridge — Runtime Abstraction (Partial)

`src/app/api/v2/im/bridge/[workspaceId]/route.ts` already resolves runtime per-workspace and normalizes both runtimes to the same `StreamEvent` format. This is the correct location for the three-way switch.

**Current shared StreamEvent types** (this contract must be preserved):
```
thinking | tool_start | tool_result | message_delta | message_complete
```

---

## 3. Dual-Loop Design

### 3.1 Core Abstractions

#### TaskStatus

```typescript
type TaskStatus =
  | 'pending'     // created, not yet started
  | 'planning'    // outer loop building execution plan
  | 'executing'   // inner loop running
  | 'paused'      // inner loop paused, awaiting clarification
  | 'completed'   // inner loop finished, result available
  | 'failed';     // unrecoverable error

interface Task {
  id: string;
  workspaceId: string;
  sessionId: string;
  instruction: string;         // original user intent
  artifactIds: string[];       // references to ArtifactStore
  status: TaskStatus;
  checkpoints: Checkpoint[];
  result?: string;
  createdAt: number;
  updatedAt: number;
}
```

#### ArtifactStore

```typescript
interface Artifact {
  id: string;
  taskId: string | null;   // null = workspace-level
  type: 'image' | 'file' | 'url';
  url: string;
  mimeType: string;
  addedAt: number;
  addedBy: 'user' | 'agent';
}
```

Images uploaded before or during a task are stored here. The inner loop receives artifact IDs and resolves them at execution time. Adding a new image does not restart the inner loop.

#### Checkpoint

```typescript
interface Checkpoint {
  id: string;
  taskId: string;
  type: 'progress' | 'question' | 'approval' | 'result';
  message: string;
  requiresUserAction: boolean;
  data?: Record<string, unknown>;
  emittedAt: number;
}
```

### 3.2 Outer Loop — Human Interface Loop (HIL)

**Decision logic on new user input:**

```
User sends message (possibly with images)
    │
    ├── IF no active task → create new Task, add artifacts to store
    │         → enqueue Task to inner loop
    │         → artifacts: taskId assigned to new task at this moment
    │
    ├── IF active task in 'executing' state:
    │     ├── IF images only → add to ArtifactStore (non-interrupting)
    │     │     taskId = null (workspace-level); HIL assigns to active task
    │     │     at next TaskInstruction build (before next inner-loop dispatch)
    │     │
    │     ├── IF text starts with "/" or matches cancel intent:
    │     │     → HIL calls cancel() → task.failed { reason: 'cancelled' }
    │     │     → create new Task from the message
    │     │
    │     └── IF text (non-cancel) → create clarification note
    │           queued for injection at next inner-loop checkpoint
    │
    └── IF active task in 'paused' (awaiting clarification):
              → resume with user's response
              → transition task back to 'executing'
              → notify inner loop to continue
```

**Artifact `taskId` assignment timing**: workspace-level artifacts (`taskId: null`) are promoted to a specific task when HIL builds the next `TaskInstruction`. This happens either at task creation (images uploaded before sending instruction) or at the next inner-loop dispatch after the image arrives. HIL is the sole authority for this promotion — no other component writes `taskId` to an artifact.

### 3.3 Inner Loop — Execution Loop (EL)

```typescript
interface TaskInstruction {
  taskId: string;
  instruction: string;
  artifacts: Artifact[];
  // In dual-loop mode, workspaceContext is filled by WorldModel.buildHandoffContext()
  // (see §9.3). sessionHistory is NOT raw messages — it's the WorldModel view.
  workspaceContext: string;
}

interface ExecutionResult {
  taskId: string;
  status: 'completed' | 'paused' | 'failed';
  text: string;
  pauseReason?: string;
  directives: Directive[];
  toolsUsed: string[];
  checkpoints: Checkpoint[];
  usage?: { promptTokens: number; completionTokens: number };
}
```

### 3.4 Communication Between Loops

```
Outer Loop                        Inner Loop
    │── TaskInstruction ─────────>│
    │                             │ (executing tools...)
    │<── Checkpoint(progress) ────│ (HIL decides: forward to user or not)
    │<── Checkpoint(question) ────│ PAUSE inner loop
    │    Show question to user    │
    │    Await user response      │
    │── Resume(userResponse) ────>│
    │<── Checkpoint(result) ──────│ Forward final result to user
```

Implementation: single-process model, `EventEmitter` between HIL coordinator and `PrismerAgent` instance. No new processes required in Phase 1.

---

## 4. Runtime Abstraction Layer

### 4.1 IAgentLoop Interface

```typescript
interface IAgentLoop {
  readonly mode: 'single' | 'dual';

  /**
   * Process a user message.
   *
   * SINGLE-LOOP: Promise resolves when the agent's full response is complete.
   *   AgentLoopResult.text contains the final answer.
   *
   * DUAL-LOOP: Promise resolves immediately when the task is *created and
   *   dispatched* to the inner loop (TaskStatus='executing'). The actual
   *   result arrives later via SSE event `task.completed`. Callers MUST
   *   NOT rely on AgentLoopResult.text for the task outcome in dual-loop mode;
   *   they should listen for the `task.completed` SSE event instead.
   *   AgentLoopResult.taskId identifies which task was created.
   */
  processMessage(params: AgentLoopInput): Promise<AgentLoopResult>;

  // Required (not optional) — SingleLoopAgent provides empty body
  addArtifact(artifact: Artifact): void;

  // Resume paused execution (dual-loop only, no-op body in single)
  resume(clarification: string): void;

  // Cancel the active task (dual-loop only, no-op in single)
  // Emits task.failed with { reason: 'cancelled' } and cleans up inner loop.
  cancel(): void;

  shutdown(): Promise<void>;
}

interface AgentLoopInput {
  content: string;
  sessionId: string;
  images?: ImageRef[];
  config?: Partial<AgentOptions>;
}

interface AgentLoopResult {
  text: string;             // Final answer (single-loop) or empty string (dual-loop, see above)
  directives: Directive[];
  toolsUsed: string[];
  usage?: { promptTokens: number; completionTokens: number };
  taskId?: string;          // dual-loop: the created task's ID
  taskStatus?: TaskStatus;  // dual-loop: always 'executing' at resolve time
}
```

> `addArtifact` is required, not optional (`?`). `SingleLoopAgent` provides an empty body. This removes silent-failure risk when caller omits the `?.` guard.

### 4.2 SingleLoopAgent (single-loop mode — zero behavior change)

```typescript
class SingleLoopAgent implements IAgentLoop {
  readonly mode = 'single';

  constructor(
    private agent: PrismerAgent,
    private sessions: SessionStore,
    private bus: EventBus,
  ) {}

  async processMessage(params: AgentLoopInput): Promise<AgentLoopResult> {
    const session = this.sessions.getOrCreate(params.sessionId);
    const result = await this.agent.processMessage(
      params.content, session, undefined, params.images,
    );
    return { text: result.text, directives: result.directives, toolsUsed: result.toolsUsed, usage: result.usage };
  }

  addArtifact(_: Artifact): void { /* no-op in single-loop mode */ }
  resume(_: string): void { /* no-op */ }
  cancel(): void { /* no-op */ }
  async shutdown(): Promise<void> { /* no-op */ }
}
```

### 4.3 DualLoopAgent (dual-loop mode)

```typescript
class DualLoopAgent implements IAgentLoop {
  readonly mode = 'dual';

  private artifactStore: ArtifactStore;
  private outerLoop: HumanInterfaceLoop;
  private innerLoop: ExecutionLoop;

  async processMessage(params: AgentLoopInput): Promise<AgentLoopResult> {
    if (params.images?.length) {
      for (const img of params.images) {
        this.artifactStore.add({
          type: 'image',
          url: img.url,
          mimeType: img.mimeType ?? 'image/jpeg',
          addedBy: 'user',
          taskId: null,   // workspace-level until HIL assigns to task
        });
      }
    }
    return this.outerLoop.handle(params.content, params.sessionId);
  }

  addArtifact(artifact: Artifact): void {
    this.artifactStore.add(artifact);
  }

  resume(clarification: string): void {
    this.outerLoop.resume(clarification);
  }

  async shutdown(): Promise<void> {
    await this.outerLoop.shutdown();
  }
}
```

### 4.4 Factory & Configuration

```typescript
type LoopMode = 'single' | 'dual';

function createAgentLoop(mode: LoopMode, agent: PrismerAgent, sessions: SessionStore, bus: EventBus): IAgentLoop {
  switch (mode) {
    case 'single': return new SingleLoopAgent(agent, sessions, bus);
    case 'dual':   return new DualLoopAgent(agent, sessions, bus);
  }
}
```

**Environment variable**: `LUMIN_LOOP_MODE=single` (default) | `dual`
**Per-workspace DB field**: `loopMode: 'single' | 'dual'` (extends existing `Container` model)

---

## 5. Event Protocol Extensions

Current `StreamEvent` types (preserved, never changed):
```
thinking | tool_start | tool_result | message_delta | message_complete
```

New additive types for dual-loop (frontend ignores unknown types — no breaking change):
```typescript
{ type: 'task.created',    data: { taskId, instruction, artifactCount } }
{ type: 'task.checkpoint', data: { taskId, type, message, requiresUserAction } }
{ type: 'task.completed',  data: { taskId, result } }
{ type: 'task.failed',     data: { taskId, error } }
{ type: 'artifact.added',  data: { artifactId, type } }
```

---

## 6. Three-Way Runtime Switch

| `AGENT_RUNTIME` | `LUMIN_LOOP_MODE` | Effective Architecture |
|-----------------|-------------------|------------------------|
| `openclaw` | any | OpenClaw runtime (external, unchanged) |
| `lumin` | `single` | Lumin — single-loop mode (current default) |
| `lumin` | `dual` | Lumin — dual-loop mode (experimental) |

> **Naming clarification**: "Lumin" is one runtime. `LUMIN_LOOP_MODE` switches its internal execution architecture. There is no "Lumin v1" or "Lumin v2" — only Lumin running in different modes. OpenClaw is a separate external runtime, not a Lumin variant.

```typescript
// src/lib/container/runtime.ts (additive only)
export type LoopMode = 'single' | 'dual';

/**
 * Priority: DB field > LUMIN_LOOP_MODE env var > 'single' default.
 *
 * DB-first is intentional for multi-tenant deployments: an operator can
 * set LUMIN_LOOP_MODE=dual globally but a specific workspace may override
 * to 'single' in the DB for stability. If DB is null/missing, env var wins.
 * This means: env var 'dual' + DB 'single' → resolves to 'single'.
 */
export function resolveLoopMode(dbLoopMode?: string | null): LoopMode {
  if (dbLoopMode === 'dual') return 'dual';
  if (dbLoopMode === 'single') return 'single';   // DB explicitly forces single
  return (process.env.LUMIN_LOOP_MODE as LoopMode) ?? 'single';
}
```

---

## 7. UI Directive — The Control Plane of Agent-Native Software

### 7.1 From Notification to Control Plane

**Current directive model (v1):**
A directive is a one-way notification: agent tool executes → emits directive → frontend renders. The human is a passive consumer of agent actions.

**The new model:**
A directive is a message in a **bidirectional control protocol**. Both agent (via tools) and human (via UI interaction) produce the same kinds of state changes on the same components. Neither is "in control" — both are co-operators of a shared component state.

```
        ┌──────────────────────────────────────────┐
        │            Component State               │
        │  (owned by Component Spec, not by        │
        │   either agent or human)                 │
        └──────┬───────────────────┬───────────────┘
               │                  │
     Agent writes               Human writes
  (via tool call)          (via UI interaction)
               │                  │
    ┌──────────▼───────┐  ┌───────▼──────────┐
    │  Agent Mutation  │  │  Human Interaction│
    │  (structured,    │  │  (gesture, click, │
    │   validated by   │  │   keyboard, voice)│
    │   tool schema)   │  │                  │
    └──────────────────┘  └──────────────────┘
               │                  │
               └────────┬─────────┘
                        │
              Both produce the same
              kind of state change,
              validated against the
              same Component Spec
```

This is the core insight: **the Component Spec is the single source of truth for what valid states exist**, and both the agent tool definition and the UI interaction model are derived from it.

### 7.2 The Shared State Model

Every workspace component (LaTeX editor, Jupyter notebook, AG Grid, Bento Gallery, etc.) exposes a typed contract:

```typescript
interface ComponentSpec<State, AgentView, HumanEvent> {
  // The component's identity
  type: ComponentType;
  version: string;

  // State → what the human sees (rich, rendered)
  render(state: State): ReactElement;

  // State → what the agent processes (compact, text-serializable)
  // Three levels for progressive disclosure (see §7.6)
  serialize(state: State, level: 'brief' | 'structured' | 'full'): string;

  // Agent tool schema — JSON Schema compatible
  // This IS the tool parameter definition for update_content, update_latex, etc.
  agentSchema: JSONSchema;

  // Apply agent mutation to state (validated against agentSchema)
  applyAgentMutation(state: State, mutation: AgentView): State;

  // Apply human interaction to state
  applyHumanInteraction(state: State, event: HumanEvent): State;

  // Produce a directive from a state change (for broadcasting to other clients)
  toDirective(prev: State, next: State, source: 'agent' | 'human'): Directive | null;
}
```

**Key property**: `applyAgentMutation` and `applyHumanInteraction` both produce a new `State`. That state is then broadcast as a `Directive` to all connected clients (other browser tabs, agent WebSocket sessions, etc.). **The source of the state change (agent vs human) is metadata, not architecture.**

### 7.2a Conflict Resolution — The Edit Granularity Problem

`DirectiveV2.stateVersion` (§7.5) is a monotonic counter for ordering concurrent state changes. This alone is insufficient for fine-grained text editing. Two distinct conflict classes require different resolution strategies:

**Class A: Coarse mutations (agent replaces whole content)**

Agent calls `update_latex({ content: entireFileContent })` while human has made edits. Strategy: **agent yields to human during active editing windows**.

```
Definition: "active editing" = human has emitted a HumanEvent in the last 3 seconds
  AND their edits have not been acked by the agent yet.

Resolution:
  IF directive.source === 'agent' AND component is in active-editing state:
    → Defer directive: buffer for 1s, then re-apply on top of human's current state
    (agent's content becomes a rebase target, not a hard override)
  ELSE:
    → Apply immediately (last-write-wins on stateVersion)
```

**Class B: Fine-grained concurrent text editing (human and agent edit same file simultaneously)**

This is the full OT/CRDT problem. For Phase 1, we **avoid** this class by design:
- Agent mutations on files humans are actively editing are deferred (Class A rule above)
- Agent is notified via `HUMAN_CURSOR` directive of where the human is editing
- Agent avoids editing at the human cursor position in its tool calls

**Phase 3 (if needed): Operational Transformation for shared editing**

If concurrent editing is required (e.g., agent and human co-authoring the same paragraph), introduce OT at the `LatexAgentMutation.patch` level:

```typescript
interface TextPatch {
  type: 'insert' | 'delete' | 'retain';
  position: number;   // offset in document
  length?: number;    // for delete/retain
  text?: string;      // for insert
  // OT-compatible: patches commute if positions don't overlap
}
```

OT transform: given agent patch A and concurrent human patch B, compute `A' = transform(A, B)` such that applying `B then A'` or `A then B'` produces the same final state. Libraries: `ot.js`, `ShareDB`. Full CRDT (e.g., Yjs) is the eventual target for real-time multi-cursor collaboration.

**Phase 1 constraint**: only `content` (full replacement) and `patch` (non-overlapping OT-compatible patches) are supported. The agent is responsible for not patching at positions the human is actively editing — enforced via `HUMAN_CURSOR` directive context.

### 7.3 Dual Data Representations

Each component maintains two parallel representations of its content:

```
┌─────────────────────────────────────────────────────────┐
│                   Component State                        │
├──────────────────────┬──────────────────────────────────┤
│  Display Layer       │  Semantic Layer                  │
│  (human-facing)      │  (agent-facing)                  │
├──────────────────────┼──────────────────────────────────┤
│ LaTeX: rendered PDF  │ LaTeX: source text + AST         │
│ Jupyter: rich output │ Jupyter: cells + output text     │
│ AG Grid: formatted   │ AG Grid: JSON rows + schema      │
│ Gallery: thumbnails  │ Gallery: metadata + file paths   │
│ AI Editor: styled    │ AI Editor: markdown + structure  │
└──────────────────────┴──────────────────────────────────┘
```

**Display Layer** is optimized for human cognition: visual hierarchy, color, whitespace, interactivity, spatial organization.

**Semantic Layer** is optimized for agent processing: structured, flat, token-efficient, unambiguous. This is what gets serialized into the LLM context.

These two representations **must be kept in sync**. A human edit to the display layer propagates through `applyHumanInteraction` → new State → `serialize()` → updated semantic layer → if agent is active, injected into its next context window.

### 7.4 Concrete Component Specs (Examples)

#### LatexEditorSpec

```typescript
interface LatexEditorState {
  projectId: string;
  files: Map<string, string>;    // filename → content
  mainFile: string;
  compilationResult?: {
    pdfUrl: string;
    errors: string[];
    warnings: string[];
  };
  activeFile: string;
}

// AgentView (what the agent can mutate)
interface LatexAgentMutation {
  file?: string;           // target file (defaults to mainFile)
  content?: string;        // full content replacement
  patch?: TextPatch[];     // line-level patches (preferred for large files)
  compile?: boolean;       // trigger compilation after content change
}

// HumanEvent (what the human can do in the editor)
type LatexHumanEvent =
  | { type: 'edit'; file: string; changes: CodeMirrorChange[] }
  | { type: 'compile' }
  | { type: 'switch-file'; file: string }
  | { type: 'create-file'; name: string; template?: string };

// Serialization (for LLM context)
serialize(state, 'brief')      → "LaTeX project: survey.tex (3 files, 8 sections, compiles OK)"
serialize(state, 'structured') → "{ mainFile: 'survey.tex', sections: [...], citations: 47, status: 'compiled' }"
serialize(state, 'full')       → full LaTeX source of active file (for latex-expert)
```

#### JupyterNotebookSpec

```typescript
interface JupyterState {
  notebookId: string;
  cells: JupyterCell[];
  kernelStatus: 'idle' | 'busy' | 'dead';
  outputs: Map<string, CellOutput[]>;  // cellId → outputs
}

serialize(state, 'brief')      → "Jupyter: 12 cells, kernel idle, last output: [matplotlib figure]"
serialize(state, 'structured') → "{ cellCount: 12, executedCount: 8, errorCount: 0, imports: ['numpy', 'matplotlib'] }"
serialize(state, 'full')       → full notebook JSON (for data-analyst)
```

#### BentoGallerySpec

```typescript
interface GalleryState {
  items: GalleryItem[];    // { id, type, url, title, metadata }
  layout: 'grid' | 'masonry' | 'carousel';
  selectedId?: string;
}

serialize(state, 'brief')      → "Gallery: 6 images (3 plots, 2 diagrams, 1 PDF preview)"
serialize(state, 'structured') → "[{ id, title, type, path }...]"
serialize(state, 'full')       → full item list with metadata
```

### 7.5 Directive Protocol v2

**Extended directive schema** (additive — existing `type`, `payload`, `timestamp` unchanged):

```typescript
interface DirectiveV2 {
  // Existing fields (never change)
  type: DirectiveType;
  payload: Record<string, unknown>;
  timestamp: string;

  // New optional fields (v2)
  emittedBy?: string;          // agentId that produced this
  taskId?: string;             // associated Task
  source?: 'agent' | 'human'; // who triggered the state change

  /**
   * Monotonic per-component version counter for conflict resolution.
   *
   * Algorithm: LAST-WRITE-WINS on stateVersion for coarse mutations.
   *
   * Frontend rule:
   *   IF incoming directive.stateVersion <= component.currentVersion:
   *     AND directive.source === 'agent':
   *       → apply Class A deferral (see §7.2a) — may be stale
   *     AND directive.source === 'human':
   *       → apply immediately (human input always wins over stale agent output)
   *   ELSE (incoming version > current):
   *     → apply immediately, update component.currentVersion
   *
   * For fine-grained text patches (patch: TextPatch[]):
   *   → use OT transform before applying (see §7.2a Class B)
   *   → stateVersion still increments on each patch application
   */
  stateVersion?: number;
}
```

**All directive types** (current 17 + additions):

| Directive | Category | Delivery | Description |
|-----------|----------|----------|-------------|
| `SWITCH_COMPONENT` | Navigation | realtime | Switch active WindowView component |
| `TIMELINE_EVENT` | Observability | realtime | Add event marker to timeline |
| `THINKING_UPDATE` | State | realtime | Agent thinking phase indicator |
| `OPERATION_STATUS` | State | realtime | Long-running operation progress |
| `UPDATE_CONTENT` | Content | realtime | Generic content update (ai-editor, plate-editor) |
| `UPDATE_LATEX` | Content | realtime | LaTeX source update |
| `UPDATE_CODE` | Content | realtime | Code editor update |
| `UPDATE_DATA_GRID` | Content | realtime | AG Grid data update |
| `UPDATE_GALLERY` | Content | realtime | Bento Gallery item update |
| `JUPYTER_ADD_CELL` | Content | realtime | Add notebook cell |
| `JUPYTER_CELL_OUTPUT` | Content | realtime | Cell execution output |
| `COMPILE_COMPLETE` | Event | checkpoint | LaTeX compilation result |
| `NOTIFICATION` | Event | checkpoint | User-facing notification |
| `TASK_UPDATE` | Control | hil-only | HIL intercepts, not forwarded |
| `UPDATE_TASKS` | Control | hil-only | HIL intercepts, not forwarded |
| `ACTION_REQUEST` | Control | hil-only | HIL: pause inner loop + ask user |
| `REQUEST_CONFIRMATION` | Control | hil-only | HIL: pause inner loop + ask user |
| `EXTENSION_UPDATE` | Extension | realtime | PEP: push data to extension iframe |
| `COMPONENT_STATE_SYNC` | Sync | checkpoint | Full component state snapshot (for new clients) |
| `AGENT_CURSOR` | Presence | realtime | Show agent's active edit position in editor |
| `HUMAN_CURSOR` | Presence | realtime | Broadcast human cursor to agent context |

**Delivery routing** (HIL's `DirectiveRouter`, never touches inner loop):

```
realtime   → forward immediately to WS + record in AgentViewStack
checkpoint → buffer, include in next Checkpoint event
hil-only   → consume at HIL level, produce HIL action instead
```

### 7.6 Progressive Disclosure: Context Engineering Meets HCI

Progressive disclosure is both a **HCI principle** (show users only what they need at each level of detail) and a **context engineering principle** (give agents only the context they need for their current task).

They map to the same three-level serialization:

```
Level 1: BRIEF — for chat summaries and secondary agents
  "LaTeX project: survey.tex, 8 sections, compiles OK"
  Used by: HIL WorldModel.workspaceState, chat panel status, primary agent routing

Level 2: STRUCTURED — for agent decision-making and handoff context
  { mainFile, sections, citationCount, compilationStatus, openFiles }
  Used by: WorldModel.buildHandoffContext(), primary agent planning,
           sub-agent initialization via handoff context

Level 3: FULL — for actual content manipulation
  Full source text, complete cell output, entire dataset
  Used by: specialized sub-agents (latex-expert, data-analyst) during execution
```

**HCI application:**
- Chat panel shows Level 1 (brief) → user sees what the agent is working on at a glance
- Timeline shows Level 2 (structured) → user can expand to see details
- Component viewer shows Level 3 (full) → user sees the actual work product

**Context engineering application:**
- HIL injects Level 1 into brief status updates to user
- HIL injects Level 2 into `buildHandoffContext()` for new sub-agents
- Sub-agent's execution context contains Level 3 of only the component it's working on

The result: **the amount of context an agent receives is proportional to the specificity of its task**. A primary agent routing between sub-agents gets Level 1 summaries of everything. A `latex-expert` working on one document gets Level 3 of that document and Level 1 of everything else.

### 7.7 Bidirectional Control Flow

**Direction 1: Agent → UI**

```
Agent tool call: update_latex({ file: 'survey.tex', content: '...' })
    ↓
Tool executes → ctx.emit({ type: 'directive', data: { type: 'UPDATE_LATEX', ... } })
    ↓
DirectiveRouter: delivery = 'realtime'
    ↓
WS → Bridge SSE → Frontend useDirectiveStream
    ↓
syncActions.executeDirective({ type: 'UPDATE_LATEX', payload })
    ↓
LatexEditorSpec.applyAgentMutation(currentState, mutation) → newState
    ↓
Component re-renders with newState
    ↓
LatexEditorSpec.serialize(newState, 'brief') → WorldModel.workspaceState update
```

**Direction 2: Human → UI → Agent**

```
Human types in LaTeX editor
    ↓
LatexEditorSpec.applyHumanInteraction(state, editEvent) → newState
    ↓
LatexEditorSpec.toDirective(prevState, newState, 'human')
    → { type: 'UPDATE_LATEX', payload, source: 'human' }
    ↓
If agent is active: inject into agent's next context window as:
    "[Human is editing survey.tex — sections 3-4 modified]"
    (this is the Level 1/2 representation of the human's edit)
    ↓
Agent acknowledges in next tool call
```

**Direction 3: Approval Protocol (Agent asks Human)**

```
Agent inner loop encounters ambiguous decision
    ↓
Tool emits REQUEST_CONFIRMATION directive
    ↓
DirectiveRouter: delivery = 'hil-only'
    ↓
HIL: pause inner loop (suspend Promise)
HIL: emit task.checkpoint(type='question', requiresUserAction=true)
    ↓
Frontend: show clarification prompt to user
    ↓
User responds → HIL.resume(userResponse)
    ↓
Inner loop resumes with user's answer in context
```

### 7.8 Multi-Agent UI State Ownership (AgentViewStack)

When multiple agents work sequentially or in parallel, they may emit conflicting `SWITCH_COMPONENT` directives. The HIL maintains an **AgentViewStack** to track UI state ownership:

```typescript
interface AgentViewState {
  agentId: string;
  activeComponent: ComponentType;
  lastSwitchAt: number;
}

class AgentViewStack {
  private stack: AgentViewState[] = [];

  push(agentId: string): void           // HIL calls this on delegate
  pop(): AgentViewState | undefined     // HIL calls this on sub-agent complete
  current(): AgentViewState | undefined
  recordSwitch(agentId: string, component: ComponentType): void
}
```

**Restoration strategy** (when sub-agent completes):

```
IF parent agent has more tool calls pending:
  → Do NOT restore now. Wait for parent's next LLM response:
      IF it contains tool calls → no restore (parent will emit its own SWITCH_COMPONENT)
      IF it's final text → restore parent's activeComponent (see timeout below)

IF parent agent is done (final text response):
  IF parent's activeComponent ≠ sub-agent's last component:
    → Emit SWITCH_COMPONENT to restore parent's activeComponent
  ELSE:
    → Leave sub-agent's final UI state (it's a natural continuation)

IF parent agent is paused (awaiting user input, no pending LLM call):
  → TIMEOUT FALLBACK: if parent has not produced a new LLM response
    within 30 seconds of sub-agent completion, HIL restores parent's
    activeComponent immediately. Prevents indefinite UI state lock in
    parent-paused scenarios.
```

### 7.9 Prismer Extension Protocol (PEP) — Dynamic Components

PEP (`luminapp/`) is the **ad-hoc component spec** system — it lets the agent create custom components at runtime without modifying the PISA-OS codebase.

**PEP maps to the Component Spec model:**

| Component Spec concept | PEP equivalent |
|------------------------|----------------|
| `ComponentSpec` | `extension.json` manifest |
| `agentSchema` | `extension_call` tool + handler endpoints |
| `applyAgentMutation` | `extension_call(path, body)` + handler logic |
| `applyHumanInteraction` | postMessage `type: 'prismer:event'` |
| `render(state)` | `index.html` in srcdoc iframe |
| `serialize(state)` | `extension_call('/api/summary')` endpoint convention |
| `toDirective(change)` | `extension_update` tool → `EXTENSION_UPDATE` directive |

**Full PEP cycle:**

```
User: "Build me a real-time citation tracker"
    ↓
Agent (using build-extension SKILL.md):
  writes /workspace/extensions/citation-tracker/
    ├── extension.json
    ├── server.mjs     (citations API, in-memory store)
    └── index.html     (table + add/remove UI)
    ↓
Extension Host (port 3001) detects → hot-loads server.mjs
    ↓
Agent verifies: extension_call("citation-tracker", "/health")
    ↓
Agent renders: reads index.html → sends SWITCH_COMPONENT + EXTENSION_UPDATE directive
    ↓
Frontend: iframe renders citation-tracker UI
    ↓
Human clicks "Add citation" → postMessage { type: 'prismer:event', event: 'add-citation', payload: {...} }
    ↓
HtmlPreview bridge → CustomEvent 'extension:user-event'
    ↓
useExtensionEvents hook → injects into chat as:
    "[Extension: citation-tracker] User event: add-citation
     {"doi":"10.1234/example"}"
    ↓
Agent calls: extension_call("citation-tracker", "/api/citations", "POST", {doi})
           → extension_update("citation-tracker", { citations: updatedList })
    ↓
postMessage { type: 'prismer:data', payload: { citations: [...] } } → iframe re-renders
```

**The key property**: the agent built this entire interaction loop — UI, API, state management — from scratch. No frontend deploy, no npm, no build step. Pure files + hot reload.

### 7.9a PEP Security Model — Extension Sandboxing

**Risk**: The agent writes `server.mjs` and `index.html`, and the extension host hot-loads `server.mjs` via `import()`. An LLM-generated backend running in the same Node.js process as Lumin can:
- Access the filesystem without restriction (same process, same FS permissions)
- Allocate unbounded memory
- Spawn child processes
- Crash the host process via unhandled exceptions or infinite loops

**Mitigation layers (Phase 1 → Phase 3):**

**Phase 1 (current): Process isolation via separate fork**

`extension-host.mjs` runs as a **child process** of the container entrypoint, not imported into the Lumin server process. This means:
- A crashing extension kills the extension host, not Lumin
- Lumin continues serving after extension host restarts
- The extension host is restarted by the container supervisor on crash

```bash
# Container entrypoint: separate processes
node /app/dist/cli.js serve --port 3001 &   # Lumin (main)
node /app/gateway/extension-host.mjs &       # Extension Host (separate process)
```

Lumin talks to extension host via HTTP (`localhost:3001/api/v1/ext/...`), not via `import()`. An extension crash is a network error from Lumin's perspective, not a process crash.

**Phase 1 additional limits** (implemented in extension-host.mjs):
- Per-handler request timeout: 10 seconds (hard kill via `AbortController`)
- Memory RSS check: if extension host exceeds 512MB, restart and notify agent
- No `child_process.exec/spawn` allowed inside handler (blocked via `--disallow-code-generation` or handler wrapper)

**Phase 3: VM sandbox (if required)**

For higher-assurance environments, replace `import()` with Node.js `vm.Module` or `isolated-vm`:

```javascript
// Extension handler runs in isolated context
const context = vm.createContext({
  // Controlled allowlist: no fs, no child_process, no net
  console, fetch: sandboxedFetch, setTimeout, clearTimeout,
});
vm.runInContext(handlerCode, context, { timeout: 10_000 });
```

`isolated-vm` provides V8 isolate-level isolation (similar to Cloudflare Workers), preventing memory sharing between extensions and the host. Full WASM sandbox is a future consideration.

**`index.html` (frontend):** runs in a sandboxed iframe with `sandbox="allow-scripts"` (no `allow-same-origin`). This prevents the iframe from accessing the parent window's DOM or cookies. The postMessage bridge is the only communication channel — this is already secure by design.

### 7.10 Hot Reload Architecture

Three tiers of hot reload, each serving a different development loop:

#### Tier 1: Extension Hot Reload (seconds, PEP)

```
Agent or developer edits /workspace/extensions/{id}/server.mjs or index.html
    ↓
extension-host.mjs: fs.watch() detects change
    ↓
Server: import() with cache-busting URL → new handler registered
Frontend: agent sends EXTENSION_UPDATE with new HTML → iframe srcdoc updated
    ↓
New behavior live in < 500ms, no restart, no build
```

#### Tier 2: Tool Definition Hot Reload (minutes, development)

```
Developer edits plugin tool spec (prismer-workspace/src/tools.ts)
    ↓
Plugin hot-reload: ToolRegistry.clear() + loadWorkspaceToolsFromPlugin()
    ↓
Next agent tool call uses updated parameter schema
    ↓
No container restart required (plugin is loaded via dynamic import)
```

**Planned**: Add `POST /v1/admin/reload-tools` endpoint for agent-triggered tool reload during development.

#### Tier 3: Component Spec Hot Reload (development mode only)

```
Developer edits ComponentSpec type definition
    ↓
Next.js HMR in PISA-OS frontend reloads component
    ↓
New render/serialize behavior live without page refresh
    ↓
Directive handler in syncActions auto-adopts new spec
```

### 7.11 Spec-Driven Collaborative Programming

The **Component Spec** as a single source of truth drives a code generation pipeline:

```
ComponentSpec (TypeScript interface)
    │
    ├── → Tool JSON Schema (used in PrismerAgent tool specs)
    ├── → React component props (used in WindowView editor components)
    ├── → Directive payload types (used in syncActions.ts type guards)
    ├── → OpenAPI schema (used in extension HTTP API contracts)
    └── → Serialization prompts (used in system prompt TOOLS.md section)
```

**Example: Adding a new field to LatexEditorSpec**

Developer adds `cursor: { line: number; col: number }` to `LatexEditorState`:

1. TypeScript compiler catches all usages that need updating
2. `agentSchema` automatically includes `cursor` in `update_latex` tool params
3. `render()` shows cursor position indicator in editor UI
4. `serialize('structured')` includes `"cursor: line 47"` in agent context
5. `AGENT_CURSOR` directive now carries cursor position for real-time presence

**Vibe coding workflow:**

The spec file is the **conversation point** between developer, agent, and UI:

```bash
# Developer says to claude code / opencode / gemini cli:
"Add a 'word count' field to LatexEditorSpec and update the serialize() method"

# AI CLI reads ComponentSpec file
# Makes targeted edit to interface + serialize()
# TypeScript compiler validates
# HMR reloads frontend
# Spec change live in ~5 seconds
```

### 7.12 Vibe Coding Native Design

The architecture is designed so that **AI CLI tools** (opencode, claude code, gemini cli) are first-class contributors to the system, not afterthoughts.

**Design principles for AI CLI friendliness:**

**1. Flat, self-describing file structures**

```
/workspace/extensions/{id}/
├── extension.json   ← manifest (one page, self-explanatory)
├── server.mjs       ← backend (one exported function)
└── index.html       ← frontend (self-contained, no build)
```

No hidden config, no generated files, no build artifacts. An AI CLI can read these 3 files and understand the entire extension in one context window.

**2. Zero build step**

Hot reload means the AI CLI's edit-verify loop is: `edit file → call extension_call(/health) → verify behavior`. No compile, no bundle, no restart. Iteration speed matches the AI's generation speed.

**3. Agent-readable tool definitions**

Every tool available to Lumin agents is defined in TypeScript with JSDoc that is both human-readable and token-efficient for the AI CLI's context:

```typescript
/**
 * Create or update a workspace extension.
 * The extension runs as a hot-reloaded HTTP microservice.
 *
 * @example extension_call("tracker", "/api/citations", "POST", {doi:"..."})
 */
extension_call(extensionId: string, path: string, method?: string, body?: object): ToolResult
```

**4. Scaffolding tools for new component specs**

The `build-extension` SKILL.md is a worked example. The pattern extends to:

```
spawn_agent({
  systemPrompt: 'You follow the Component Spec pattern...',
  task: 'Create a ComponentSpec for a 3D molecule viewer'
})
```

The spawned agent reads existing ComponentSpec examples, generates the new spec, creates the React component, writes the tool schema, updates `syncActions.ts`, all in one autonomous loop. Developer reviews the diff.

**5. Spec-to-implementation generation**

Given a `ComponentSpec` interface, the AI CLI can generate:
- `server.mjs` for PEP extensions
- React component implementing `render(state)`
- `serialize()` for all three levels
- Test cases for `applyAgentMutation` and `applyHumanInteraction`

This is the **inner product of spec-driven development and vibe coding**: the spec is the spec, the AI writes the code, the hot reload validates it. Human approves.

---

## 8. Multi-Agent Orchestration

### 8.1 Current v1 Delegation Model Limitations

| Capability | v1 Status |
|------------|-----------|
| Delegation targets | Only 6 built-in BUILTIN_AGENTS |
| Agent creation | Static registration at startup |
| Lifecycle | Always ephemeral (created → runs → destroyed) |
| Parallel execution | Serial (parent waits for child) |
| Status queries | Not supported |
| Context inheritance | Hardcoded last-4-messages |

### 8.2 SubAgentManager (HIL component)

```typescript
interface SubAgentSpec {
  id: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  maxIterations?: number;
  mode: 'ephemeral' | 'persistent';
}

type SubAgentStatus = 'idle' | 'running' | 'paused' | 'awaiting_user' | 'completed' | 'failed' | 'terminated';

interface SubAgentHandle {
  agentId: string;
  status: SubAgentStatus;
  taskId?: string;
  sessionId: string;
  spec: SubAgentSpec;
  startedAt: number;
  lastActivity: number;
  lastCheckpoint?: Pick<Checkpoint, 'type' | 'message'>; // not raw string
  result?: string;
}

class SubAgentManager {
  spawn(spec: SubAgentSpec, task: string): SubAgentHandle
  sendMessage(agentId: string, message: string): void
  getStatus(agentId: string): SubAgentHandle | undefined
  awaitCompletion(agentId: string): Promise<AgentResult>
  awaitAll(agentIds: string[]): Promise<Map<string, AgentResult>>
  terminate(agentId: string): void
  listActive(): SubAgentHandle[]
}
```

### 8.3 Primary Agent Lifecycle Tools

Available only to `mode: 'primary'` agents (no sub-sub-agent recursion in Phase 1):

| Tool | Purpose |
|------|---------|
| `spawn_agent` | Create + start agent, returns `SubAgentHandle` immediately |
| `agent_status` | Query current status + `lastCheckpoint: { type, message }` |
| `agent_message` | Send follow-up to persistent agent |
| `await_agent` | Block current iteration until agent completes (returns result) |
| `terminate_agent` | Force stop |

### 8.4 Agent Lifecycle States

```
spawn_agent() → [idle] → [running] ←── agent_message() (persistent only)
                             │
               ┌─────────────┼─────────────┐
            [paused]  [awaiting_user]  [completed]
               │             │              │
           resume()     HIL.resume()   [terminated] ← terminate() / timeout
               │                       [failed]     ← doom-loop / max iter
               └─────────────┘
                    back to [running]
```

### 8.5 Parallel Execution Model

**Primary agent spawns multiple sub-agents, awaits in parallel:**

```
Primary iteration N:
  Promise.all([
    spawn_agent({ id:'latex-writer', task:'写 intro' }),  → immediately running
    spawn_agent({ id:'data-analyst', task:'跑 notebook' }),→ immediately running
    spawn_agent({ id:'lit-scout',    task:'搜索论文' }),   → immediately running
  ])

Primary iteration N+1:
  Promise.all([
    await_agent({ agentId:'latex-writer' }),   → blocks until complete
    await_agent({ agentId:'data-analyst' }),   → blocks until complete
    await_agent({ agentId:'lit-scout' }),      → blocks until complete
  ])
  // All three run concurrently — Node.js event loop handles all their tool calls
  // primary's Promise.all is suspended inside tool execution, not blocking event loop
  // HIL continues processing directives from all three agents concurrently
```

**Key**: `await_agent` is inside `Promise.all(toolCalls)`. The primary agent's iteration is suspended while waiting, but the Node.js event loop is not blocked — all three sub-agents' tool calls, directive emissions, and checkpoint events continue to be processed by HIL. There is no dead-lock risk.

### 8.6 Directive Attribution and Merge

Sub-agent directives carry `emittedBy: agentId`. HIL's DirectiveRouter:
- Routes `realtime` directives immediately (with AgentViewStack update)
- Routes `hil-only` directives to TaskStateMachine (not forwarded to WS)
- On sub-agent completion: HIL runs `extractKnowledge()` → WorldModel update → AgentViewStack pop → optional SWITCH_COMPONENT restore

`@mention` and `delegate` tool are preserved for backward compatibility — internally they become `spawn_agent(ephemeral) + awaitCompletion`.

---

## 9. Context Engineering

### 9.1 The Shared Context Problem

v1's only cross-agent context mechanism: `Session.createChild()` inherits the parent's last 4 messages. Three fatal flaws:
1. **Hardcoded count (4)**: may cover only 1 LLM iteration after tool calls
2. **Raw message format**: includes tool_result noise; sub-agent must extract useful information manually
3. **Parallel failure**: two concurrent sub-agents see the same last-4 snapshot, invisible to each other

**Solution**: HIL maintains a structured `WorldModel`. Each agent receives a compact `handoffContext` string (≤ 3,000 chars), not raw message history.

### 9.2 WorldModel (HIL-owned)

```typescript
interface WorldModel {
  taskId: string;
  goal: string;

  completedWork: AgentCompletionRecord[];

  workspaceState: {
    activeComponent: string;
    openFiles: string[];
    recentArtifacts: ArtifactRef[];
    // Level 1 (brief) summaries from each component's serialize()
    componentSummaries: Map<ComponentType, string>;
  };

  knowledgeBase: KnowledgeFact[];
  agentHandoffNotes: Map<string, string>;
}

interface AgentCompletionRecord {
  agentId: string;
  task: string;
  resultSummary: string;   // LLM-extracted, not raw output
  toolsUsed: string[];
  artifactsProduced: ArtifactRef[];
  completedAt: number;
}

interface KnowledgeFact {
  key: string;
  value: string;
  sourceAgentId: string;
  confidence: 'high' | 'medium' | 'low';
}
```

`worldModel.workspaceState.componentSummaries` is updated by each `realtime` directive that carries a state change — using `ComponentSpec.serialize(state, 'brief')`.

### 9.3 Handoff Context Building

```typescript
const HANDOFF_BUDGET = 3_000; // chars

function buildHandoffContext(model: WorldModel, targetAgentId: string): string {
  const parts: string[] = [];

  parts.push(`## Task Goal\n${model.goal.slice(0, 300)}`);

  if (model.completedWork.length > 0) {
    parts.push('## Completed Work');
    const recent = model.completedWork.slice(-10);
    const older  = model.completedWork.slice(0, -10);

    // Older entries (> 10) collapsed into one line to stay within budget
    if (older.length > 0) {
      parts.push(`- [${older.length} earlier steps — see MemoryStore for details]`);
    }
    recent.forEach(w =>
      parts.push(`- [${w.agentId}] ${w.task.slice(0, 80)} → ${w.resultSummary.slice(0, 120)}`)
    );
  }

  if (model.knowledgeBase.length > 0) {
    parts.push('## Known Facts');
    model.knowledgeBase
      .filter(f => f.confidence !== 'low')
      .slice(0, 20)
      .forEach(f => parts.push(`- ${f.key}: ${String(f.value).slice(0, 100)}`));
  }

  parts.push('## Workspace State');
  parts.push(`- Active: ${model.workspaceState.activeComponent}`);
  model.workspaceState.componentSummaries.forEach((summary, type) =>
    parts.push(`- ${type}: ${summary}`)  // Level 1 brief
  );

  const note = model.agentHandoffNotes.get(targetAgentId);
  if (note) parts.push(`## Your Context\n${note.slice(0, 500)}`);

  // Hard truncate to budget: if we're over, trim the last parts
  let result = parts.join('\n\n');
  if (result.length > HANDOFF_BUDGET) {
    result = result.slice(0, HANDOFF_BUDGET);
    const lastNewline = result.lastIndexOf('\n');
    result = result.slice(0, lastNewline) + '\n[... truncated to context budget]';
  }
  return result;
}
```

This string is injected into the sub-agent's system prompt as a `## Task Context` block, **replacing** the `last-4-messages` inheritance. `SessionV2.createChild()` in dual-loop mode returns an **empty session** — the handoff context is the only shared state.

### 9.4 Knowledge Extraction (After Agent Completion)

**Critical design constraint**: `extractKnowledge` is an LLM call. It MUST NOT be on the critical path between sub-agent completion and parent agent continuation. Placing it inline would add one full LLM round-trip of latency before the parent can receive the sub-agent's result.

**Solution: fire-and-forget with callback**

```typescript
async function extractKnowledge(
  result: AgentResult,
  task: string,
  provider: Provider,
  model?: string,
): Promise<KnowledgeFact[]>

// HIL usage — non-blocking:
subAgent.awaitCompletion(agentId).then(result => {
  // 1. Immediately signal parent agent with result (unblocked)
  parentAgent.receiveDelegationResult(agentId, result);

  // 2. Background: update WorldModel after extraction completes
  //    This does NOT block the parent from continuing.
  extractKnowledgeBackground(result, task, worldModel, provider);
});

async function extractKnowledgeBackground(
  result: AgentResult,
  task: string,
  worldModel: WorldModel,
  provider: Provider,
): Promise<void> {
  // Fast path: regex-extract structured facts before calling LLM
  const fastFacts = extractStructuredFacts(result.text);
  // Push fast facts immediately (no LLM call)
  fastFacts.forEach(f => worldModel.knowledgeBase.push(f));

  // Only call LLM if agent did substantial work (> 3 tools used)
  if (result.toolsUsed.length > 3) {
    try {
      const llmFacts = await extractKnowledgeWithLLM(result, task, provider);
      llmFacts.forEach(f => worldModel.knowledgeBase.push(f));
    } catch (err) {
      // LLM extraction failure is non-fatal — log and record minimal fact
      log.warn('extractKnowledge failed (non-fatal)', { error: err });
      worldModel.knowledgeBase.push({
        key: `agent_${agentId}_status`,
        value: `completed task "${task.slice(0, 80)}" (extraction failed: ${err.message})`,
        sourceAgentId: agentId,
        confidence: 'low',
      });
    }
  }
}

// Fast regex extraction — runs synchronously, zero LLM cost
function extractStructuredFacts(text: string): KnowledgeFact[] {
  const facts: KnowledgeFact[] = [];
  // File paths: /workspace/foo/bar.ext
  const paths = text.match(/\/workspace\/[\w./-]+/g) ?? [];
  paths.slice(0, 5).forEach(p => facts.push({ key: 'file_path', value: p, confidence: 'high' }));
  // Numbers with units: "47 citations", "3.2MB", "8 sections"
  const counts = text.match(/\b(\d+(?:\.\d+)?)\s*(citations?|sections?|cells?|rows?|MB|KB|GB)\b/gi) ?? [];
  counts.slice(0, 5).forEach(m => facts.push({ key: 'measurement', value: m, confidence: 'medium' }));
  return facts;
}
```

**WorldModel write safety**: append-only `push` operations are atomic from V8's event loop perspective. Two concurrent background extractions produce two sequential pushes — no mutex required, no lost-update possible.

### 9.5 Context Layer Architecture

```
L4: MemoryStore (filesystem: /workspace/.prismer/memory/YYYY-MM-DD.md)
    Format: free-text + keyword recall
    Lifetime: indefinite (cross-restart, cross-task)
    Updated: Task completion → knowledgeBase written to disk
    Read: Task start → recall by goal keywords → injected into first agent's system prompt
         │
L3: WorldModel (HIL in-process Map)
    Format: structured KnowledgeFact[], AgentCompletionRecord[]
    Lifetime: current Task
    Updated: after each sub-agent completion (extractKnowledge)
             after each realtime directive (componentSummaries)
    Read: buildHandoffContext() → injected into each new sub-agent's system prompt
         │
L2: Session (per-agent, per-instance)
    Format: Message[] (raw LLM conversation)
    Lifetime: agent instance lifetime
    Managed: PrismerAgent loop (compaction on overflow → feeds L4)
         │
L1: Compaction (in-session overflow handling)
    Format: LLM-generated summary injected as message pair
    Also: memoryFlushBeforeCompaction → L4 facts
    Note: compactionSummary included in extractKnowledge input at agent completion
```

### 9.6 Context Budget per Agent

```
Single-loop (v1):
  researcher: accumulates across all iterations → hits 600k limit → compaction overhead

Dual-loop (v2):
  Task start:
    researcher: fresh Session
      context = system(2k) + handoff(3k) + memory(3k) ≈ 8k chars used
      budget: ~592k chars remaining

    spawn latex-expert: fresh Session
      context = system(1k) + handoff(3k) ≈ 4k chars used
      budget: ~596k chars remaining — completely independent from researcher

    spawn data-analyst: fresh Session (concurrent)
      budget: ~596k chars remaining — independent from both
```

Each sub-agent has a full independent context window. This is why the dual-loop model scales to arbitrarily complex tasks: context budget is per-agent, not per-task.

---

## 10. Implementation Plan

> Single definitive plan. Phases 0-4 are container-side (Lumin). Phase 5 is frontend (PISA-OS, separate PR). All phases are strictly additive — existing tests pass at every checkpoint.

### Phase 0 — Abstraction Layer (no behavior change)

1. `src/loop/types.ts` — `IAgentLoop`, `AgentLoopInput`, `AgentLoopResult`
2. `src/loop/single.ts` — `SingleLoopAgent` wrapping existing `runAgent()`, `addArtifact` with empty body
3. `src/loop/factory.ts` — `createAgentLoop()` factory
4. `src/config.ts` — add `agent.loopMode: 'single' | 'dual'` from `LUMIN_LOOP_MODE`
5. `src/server.ts` — use `createAgentLoop()`, defaults to `single`

✅ **Verification**: all existing v1 tests pass unchanged.

### Phase 1a — ArtifactStore (low risk, independent)

1. `src/artifacts/types.ts` — `Artifact`, `ArtifactStore` interface
2. `src/artifacts/memory.ts` — `InMemoryArtifactStore`
3. `POST /v1/artifacts` endpoint — accepts image URL, returns `{ artifactId }`
4. `IAgentLoop.addArtifact()` wired in `DualLoopAgent` (placeholder — HIL not yet active)

✅ **Verification**: unit test for ArtifactStore CRUD; image upload round-trip test.

### Phase 1b — PEP Integration (higher risk, independent rollback boundary)

1. `docker/gateway/extension-host.mjs` — copied from luminapp, runs as separate process
2. Container gateway routes `/api/v1/ext/{id}/*` to extension host (port 3001)
3. **Security**: extension host runs as child process (not imported into Lumin) — crash-isolated
4. `extension_call` + `extension_update` tools registered in `prismer-workspace`
5. `EXTENSION_UPDATE` directive case added to `syncActions.ts`
6. `useExtensionEvents` hook integrated in WorkspaceView
7. iframe `sandbox="allow-scripts"` attribute enforced (no `allow-same-origin`)

✅ **Verification**: extension cycle test (create → verify → render → interact → hot-reload).
🔄 **Rollback**: remove extension host from entrypoint + remove tool registrations — zero impact on Lumin core.

### Phase 2 — Task Model + ComponentSpec Serialization

1. `src/task/types.ts` — `Task`, `TaskStatus`, `Checkpoint`, `CheckpointType`
2. `src/task/store.ts` — `InMemoryTaskStore`
3. `src/task/machine.ts` — `TaskStateMachine` with transition validation
4. **ComponentSpec serialization stubs**:
   - `src/spec/types.ts` — `ComponentSpec<State, AgentView, HumanEvent>` interface
   - `src/spec/latex.ts`, `src/spec/jupyter.ts`, `src/spec/gallery.ts` — Level 1/2/3 `serialize()` implementations
5. Extended EventBus schemas — add dual-loop event types (`task.*`, `artifact.added`)

✅ **Verification**: task state machine unit tests; ComponentSpec serialization unit tests.

### Phase 3 — Directive Protocol v2 + DirectiveRouter

1. `src/directives.ts` — extend with `emittedBy?`, `taskId?`, `source?`, `stateVersion?`
2. `src/loop/directive-router.ts` — `DirectiveDelivery` routing table, `AgentViewStack`, `DirectiveRouter`
3. `src/loop/execution.ts` — `ExecutionLoop` wrapping `PrismerAgent`:
   - All `bus.publish('directive')` calls go through `DirectiveRouter`
   - `ACTION_REQUEST` / `REQUEST_CONFIRMATION`: ExecutionLoop emits → HIL intercepts → pause/resume
   - Checkpoint emission after each tool group
4. New directive types: `EXTENSION_UPDATE` (already from Phase 1), `COMPONENT_STATE_SYNC`, `AGENT_CURSOR`, `HUMAN_CURSOR`

✅ **Verification**: directive routing integration test; ACTION_REQUEST pause/resume test.

### Phase 4 — WorldModel + SubAgentManager + HIL

1. `src/world-model/types.ts` — `WorldModel`, `AgentCompletionRecord`, `KnowledgeFact`
2. `src/world-model/builder.ts` — `buildHandoffContext()`, `extractKnowledgeBackground()`, `extractStructuredFacts()`
3. `src/multi-agent/manager.ts` — `SubAgentManager`
4. `src/multi-agent/tools.ts` — `spawn_agent`, `agent_status`, `agent_message`, `await_agent`, `terminate_agent`
5. `src/loop/hil.ts` — `HumanInterfaceLoop` (input routing + DirectiveRouter + SubAgentManager + WorldModel)
6. `src/loop/dual.ts` — `DualLoopAgent` implementing `IAgentLoop` (includes `cancel()`)
7. `src/session.ts` — `SessionV2.createChild()`: dual-loop mode returns empty session (handoff context injected by HIL into PrismerAgent system prompt at construction time, not inside `createChild`)
8. **File-level read-write locks in SubAgentManager**: when two parallel sub-agents call tools that write to the same file path, `SubAgentManager` serializes their file operations via a per-path async mutex (`Map<string, Promise<void>>`). The lock is held for the duration of one tool call group, then released. This prevents physical filesystem corruption without changing tool API.
9. **HIL task-level doom-loop protection**: max 50 total iterations across all sub-agents, 10-minute task timeout → emit `task.failed` if exceeded
10. **Process restart degradation**: on Lumin restart while task was active, HIL sends `task.checkpoint(type='result', message='Task interrupted — container restarted. Please resubmit.')`

✅ **Verification**: parallel sub-agent test; WorldModel context propagation test; file lock contention test; restart degradation test.

### Phase 5 — Frontend Integration (PISA-OS, separate PR)

1. Bridge route — pass `loopMode` from DB to gateway client
2. `useContainerChat.ts` — handle `task.*` SSE events
3. ChatPanel — conditional rendering: task view (progress) vs chat view (streaming)
4. TaskPanel — bind to real task events from dual-loop HIL
5. `ComponentSpec.serialize('brief')` — feed into chat panel component status line
6. Human cursor events: CodeMirror → `HUMAN_CURSOR` directive → agent context injection
7. `HumanCursor` component — shows agent cursor position in editors

✅ **Constraint**: all changes behind `LUMIN_LOOP_MODE=dual` flag. v1 path entirely unchanged.

---

## 11. Compatibility Matrix

| Scenario | Ph 0 | Ph 1a | Ph 1b | Ph 2-4 | Ph 5 |
|----------|------|-------|-------|--------|------|
| OpenClaw mode | ✅ | ✅ | ✅ | ✅ | ✅ |
| Lumin v1 (`single`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Lumin v2 (`dual`) | ❌ | ❌ | ❌ | ✅ container | ✅ full UI |
| Existing Playwright tests | ✅ pass | ✅ pass | ✅ pass | ✅ pass | ✅ pass |
| Bridge SSE format | ✅ unchanged | ✅ additive | ✅ additive | ✅ additive | ✅ additive |
| PEP extensions | ❌ | ❌ | ✅ | ✅ | ✅ full UI |
| 1b rollback path | — | — | ✅ clean | — | — |

**Image handling across modes:**

| Mode | Image goes to | Inner loop sees it | User adds 2nd image |
|------|---------------|-------------------|---------------------|
| OpenClaw | message `image_url` block | yes, that turn only | new message, may interrupt |
| Lumin v1 | message `image_url` block | yes, that turn only | new message, may interrupt |
| Lumin v2 | `ArtifactStore` | via `TaskInstruction.artifacts` | added to store, available at next planning step, no interruption |

---

## 12. Key Design Decisions

**Why keep v1 unchanged?**
v1 is production. Dual-loop is unvalidated at scale. Running both modes allows A/B comparison and a safe rollback.

**Why in-process for Phase 1?**
No IPC complexity. `InMemoryArtifactStore` and `WorldModel` are easy to replace with Redis + a message queue without changing the `IAgentLoop` interface.

**Why additive SSE events?**
Old frontend clients ignore unknown event types. New events can be adopted incrementally. No coordination required between container release and frontend release.

**Why ComponentSpec serialization levels (not just one format)?**
LLM context is expensive. A primary agent routing between sub-agents doesn't need the full LaTeX source — it needs "compiles OK". A `latex-expert` needs the full source. Paying for Level 3 in every context is wasteful; paying for Level 1 everywhere is lossy.

**Why append-only WorldModel writes?**
JavaScript's async model guarantees that two concurrent `extractKnowledge` calls produce sequential `push` operations at the event loop level. No mutex needed. Lost-update is not possible because each push is atomic from V8's perspective.

**Why PEP (luminapp) in Phase 1 not later?**
PEP is the practical proof-of-concept for the ComponentSpec bidirectionality model. Having it working early validates the directive delivery path before we build the more complex dual-loop machinery on top.

---

## Appendix: Open Questions

### Core Architecture

1. **Checkpoint granularity**: which tool completions produce user-visible checkpoints? Proposal: configurable per-tool in `prismer-workspace` tool definitions via `{ checkpoint: true | false }` metadata field.

2. **Task cancellation**: `POST /v1/tasks/:id/cancel` → inner loop checks cancellation flag at tool boundaries. On cancel, emit `task.failed` with `{ reason: 'cancelled' }`.

3. **Multi-task support**: one active task per session in Phase 1. Multiple concurrent tasks in a later phase (requires task-scoped WebSocket multiplexing).

4. **Checkpoint persistence + restart degradation**: Phase 1 in-memory only. On restart: HIL detects no active task state → sends `task.checkpoint(type='result', message='Task interrupted — please resubmit.')`. User receives notification within 15s of reconnect.

5. **Planning phase**: HIL dispatches directly to inner loop in Phase 1. A lightweight "planning LLM call" (1 iteration, no tools) before dispatch is a v3 feature.

### Directive Architecture

6. **`UPDATE_CONTENT` debounce**: if a tool emits `UPDATE_CONTENT` on every streamed token (streaming write to editor), HIL should debounce at 50ms before forwarding. This is a HIL-side optimization; the inner loop doesn't change.

7. **AgentViewStack restoration timing**: HIL cannot know if parent agent will call more tools before seeing the LLM response. Solution: HIL waits for primary agent's next LLM response — if it contains tool calls, no restore; if it's final text, restore.

8. **`ACTION_REQUEST` timeout**: if user doesn't respond in 10 minutes, HIL resumes inner loop with `"User did not respond — proceed with best judgment"` injected as clarification.

### Multi-Agent

9. **`spawn_agent` recursion**: Phase 1 — only primary agents can call `spawn_agent`. Detected by checking `agentConfig.mode === 'primary'`; tool registration is gated on mode.

10. **Persistent sub-agent WorldModel refresh**: on each `agent_message`, HIL injects the latest `buildHandoffContext()` as a new user message prefixed with `[Context Update]`.

11. **Parallel agent file write conflicts** *(resolved in Phase 4)*: file-level async mutex in `SubAgentManager` serializes per-path writes. The `/workspace` filesystem is physically shared between all sub-agents — even though Node.js doesn't block the event loop, concurrent `fs.writeFile` calls to the same path race at the OS level and corrupt content. The per-path mutex gates each tool call group. Open question: what is the right mutex granularity — file path, directory, or project?

### Context Engineering

12. **Knowledge extraction LLM cost** *(resolved in §9.4)*: `extractStructuredFacts()` (regex, zero cost) runs synchronously; LLM extraction runs only when `toolsUsed.length > 3`, fire-and-forget in background. No impact on critical path.

13. **WorldModel on task failure** *(resolved)*: `extractKnowledgeBackground` runs even on `task.failed`. All facts written with `confidence: 'low'` and prefixed `"This approach failed: {error}"`.

14. **compactionSummary in knowledge extraction** *(resolved)*: if `session.compactionSummary` is non-null at agent completion, include it as additional context in `extractKnowledgeBackground` input so compacted facts are not lost.

### OT / CRDT (new)

15. **Phase 1 OT gap**: the `patch: TextPatch[]` mechanism in `LatexAgentMutation` is described as "OT-compatible" but no OT transform is implemented. Phase 1 relies on the agent avoiding patches at human-cursor positions (enforced via `HUMAN_CURSOR` context injection). This is a best-effort heuristic, not a correctness guarantee. Full OT (or Yjs CRDT) is required before the feature can be considered production-safe for simultaneous editing.

16. **HUMAN_CURSOR injection frequency**: if the frontend sends a `HUMAN_CURSOR` directive on every keystroke, it could flood the agent's context. Proposed: debounce at 2s; agent sees cursor position as of 2s ago, which is sufficient for conflict avoidance without noise.

### PEP Security (new)

17. **Extension host resource limits**: Phase 1 per-request timeout (10s) and RSS check (512MB) are process-level. If an extension leaks memory slowly, RSS may not spike until many requests later. Consider adding per-extension memory baseline tracking (compare RSS before and after each handler call).

18. **Extension capability model**: current proposal is all-or-nothing (extension can call any Node.js built-in). A capability allowlist (e.g., `{ fs: true, net: false }`) would be more principled. This is a Phase 3 design question.
