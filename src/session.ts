/**
 * Session — conversation state management with child session support.
 *
 * A {@link Session} holds the ordered list of conversation messages
 * (system + user + assistant + tool), any pending UI directives, and
 * optional compaction summaries from earlier truncated turns.
 *
 * The {@link SessionStore} manages multiple sessions with automatic
 * idle-timeout cleanup.
 *
 * @module session
 */

import type { Message } from './provider.js';

// ── Types ────────────────────────────────────────────────

/** A UI directive emitted by a tool during agent execution. */
export interface Directive {
  /** Directive type (e.g., `'SWITCH_COMPONENT'`, `'UPDATE_CONTENT'`). */
  type: string;
  /** Type-specific payload data. */
  payload: Record<string, unknown>;
  /** ISO or epoch timestamp string. */
  timestamp: string;
}

// ── Session ──────────────────────────────────────────────

/**
 * Conversation session — holds messages, directives, and compaction state.
 *
 * @example
 * ```typescript
 * const session = new Session('s1');
 * const messages = session.buildMessages('hello', systemPrompt);
 * ```
 */
export class Session {
  readonly id: string;
  readonly parentId: string | null;
  readonly messages: Message[] = [];
  readonly pendingDirectives: Directive[] = [];
  lastActivity: number = Date.now();
  compactionSummary: string | null = null;

  constructor(id: string, parentId: string | null = null) {
    this.id = id;
    this.parentId = parentId;
  }

  /** Build the message array for LLM call */
  buildMessages(
    userInput: string,
    systemPrompt: string,
    memoryContext?: string,
  ): Message[] {
    const msgs: Message[] = [];

    // System prompt (stable — cache-friendly)
    let system = systemPrompt;
    if (memoryContext) {
      system += `\n\n## Relevant Memory\n${memoryContext}`;
    }
    msgs.push({ role: 'system', content: system });

    // Inject compaction summary (from earlier truncated messages)
    if (this.compactionSummary) {
      msgs.push({ role: 'user', content: `[Earlier Conversation Summary]\n${this.compactionSummary}` });
      msgs.push({ role: 'assistant', content: 'Understood, I have the context from our earlier conversation.' });
    }

    // Previous conversation history
    msgs.push(...this.messages);

    // Current user input
    msgs.push({ role: 'user', content: userInput });

    return msgs;
  }

  /** Append messages to conversation history */
  addMessage(msg: Message): void {
    this.messages.push(msg);
    this.lastActivity = Date.now();
  }

  /** Track a directive emitted during this session */
  addPendingDirective(directive: Directive): void {
    this.pendingDirectives.push(directive);
  }

  /** Create a child session for sub-agent delegation */
  createChild(subAgentId: string): Session {
    const childId = `${this.id}:${subAgentId}:${Date.now()}`;
    const child = new Session(childId, this.id);
    // Child inherits recent context (last 4 messages) for continuity
    const recentContext = this.messages.slice(-4);
    for (const msg of recentContext) {
      child.messages.push({ ...msg });
    }
    return child;
  }

  /** Drain pending directives */
  drainDirectives(): Directive[] {
    const directives = [...this.pendingDirectives];
    this.pendingDirectives.length = 0;
    return directives;
  }
}

// ── Session Store ────────────────────────────────────────

/**
 * In-memory session store with automatic idle cleanup.
 *
 * Call {@link startCleanup} to begin periodic sweeps that remove
 * sessions idle longer than `maxIdleMs`.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = new Session(id);
      this.sessions.set(id, session);
    }
    session.lastActivity = Date.now();
    return session;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Start periodic cleanup of idle sessions */
  startCleanup(maxIdleMs: number = 30 * 60_000): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastActivity > maxIdleMs) {
          this.sessions.delete(id);
        }
      }
    }, 60_000);
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}
