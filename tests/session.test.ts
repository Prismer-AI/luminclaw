/**
 * Tests for Session and SessionStore
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Session, SessionStore } from '../src/session.js';

describe('Session', () => {
  it('creates with id and null parentId', () => {
    const s = new Session('sess-1');
    expect(s.id).toBe('sess-1');
    expect(s.parentId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.pendingDirectives).toEqual([]);
    expect(s.compactionSummary).toBeNull();
  });

  it('creates with parentId', () => {
    const s = new Session('child-1', 'parent-1');
    expect(s.parentId).toBe('parent-1');
  });

  it('addMessage appends and updates lastActivity', () => {
    const s = new Session('s1');
    const before = s.lastActivity;

    // Small delay to ensure time difference
    s.addMessage({ role: 'user', content: 'hello' });

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(s.lastActivity).toBeGreaterThanOrEqual(before);
  });

  it('buildMessages includes system prompt + user input from history', () => {
    const s = new Session('s1');
    s.addMessage({ role: 'user', content: 'what is AI?' });
    const msgs = s.buildMessages('You are an assistant.');

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are an assistant.' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'what is AI?' });
  });

  it('buildMessages includes memory context in system prompt', () => {
    const s = new Session('s1');
    s.addMessage({ role: 'user', content: 'hello' });
    const msgs = s.buildMessages('Base prompt', 'User prefers concise answers');

    expect(msgs[0].content).toContain('Base prompt');
    expect(msgs[0].content).toContain('## Relevant Memory');
    expect(msgs[0].content).toContain('User prefers concise answers');
  });

  it('buildMessages includes conversation history', () => {
    const s = new Session('s1');
    s.addMessage({ role: 'user', content: 'first question' });
    s.addMessage({ role: 'assistant', content: 'first answer' });
    s.addMessage({ role: 'user', content: 'second question' });

    const msgs = s.buildMessages('System prompt');

    expect(msgs).toHaveLength(4); // system + 3 history
    expect(msgs[1]).toEqual({ role: 'user', content: 'first question' });
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'first answer' });
    expect(msgs[3]).toEqual({ role: 'user', content: 'second question' });
  });

  it('buildMessages includes compaction summary', () => {
    const s = new Session('s1');
    s.compactionSummary = 'Previous discussion about machine learning.';
    s.addMessage({ role: 'user', content: 'continue' });

    const msgs = s.buildMessages('System');

    expect(msgs).toHaveLength(4); // system + summary pair + user
    expect(msgs[1].content).toContain('[Earlier Conversation Summary]');
    expect(msgs[1].content).toContain('Previous discussion about machine learning.');
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'Understood, I have the context from our earlier conversation.' });
  });

  it('addPendingDirective accumulates directives', () => {
    const s = new Session('s1');
    s.addPendingDirective({ type: 'SWITCH_COMPONENT', payload: { component: 'pdf-reader' }, timestamp: '123' });
    s.addPendingDirective({ type: 'UPDATE_CONTENT', payload: { content: 'abc' }, timestamp: '124' });

    expect(s.pendingDirectives).toHaveLength(2);
  });

  it('drainDirectives returns and clears pending', () => {
    const s = new Session('s1');
    s.addPendingDirective({ type: 'NOTIFICATION', payload: {}, timestamp: '1' });
    s.addPendingDirective({ type: 'TASK_UPDATE', payload: {}, timestamp: '2' });

    const drained = s.drainDirectives();
    expect(drained).toHaveLength(2);
    expect(s.pendingDirectives).toHaveLength(0);

    // Drain again → empty
    expect(s.drainDirectives()).toHaveLength(0);
  });

  it('createChild produces child with inherited context', () => {
    const parent = new Session('parent');
    parent.addMessage({ role: 'user', content: 'msg1' });
    parent.addMessage({ role: 'assistant', content: 'resp1' });
    parent.addMessage({ role: 'user', content: 'msg2' });
    parent.addMessage({ role: 'assistant', content: 'resp2' });
    parent.addMessage({ role: 'user', content: 'msg3' });

    const child = parent.createChild('latex-expert');

    // Child ID includes parent + sub-agent
    expect(child.id).toContain('parent');
    expect(child.id).toContain('latex-expert');
    expect(child.parentId).toBe('parent');

    // Child gets last 4 messages of parent
    expect(child.messages).toHaveLength(4);
    expect(child.messages[0].content).toBe('resp1');
  });

  it('child session has independent message history', () => {
    const parent = new Session('parent');
    parent.addMessage({ role: 'user', content: 'hello' });

    const child = parent.createChild('data-analyst');
    child.addMessage({ role: 'user', content: 'child-only message' });

    // Parent should not see child's message
    expect(parent.messages).toHaveLength(1);
    expect(child.messages).toHaveLength(2); // 1 inherited + 1 new
  });

  it('session IDs are unique', () => {
    const s1 = new Session('a');
    const s2 = new Session('b');
    expect(s1.id).not.toBe(s2.id);
  });
});

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  afterEach(() => {
    store.stopCleanup();
  });

  it('getOrCreate creates new session', () => {
    const s = store.getOrCreate('new-session');
    expect(s.id).toBe('new-session');
    expect(store.size).toBe(1);
  });

  it('getOrCreate returns existing session', () => {
    const s1 = store.getOrCreate('s1');
    s1.addMessage({ role: 'user', content: 'hello' });

    const s2 = store.getOrCreate('s1');
    expect(s2.messages).toHaveLength(1);
    expect(s2.messages[0].content).toBe('hello');
  });

  it('get returns undefined for unknown session', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('delete removes session', () => {
    store.getOrCreate('s1');
    expect(store.size).toBe(1);

    store.delete('s1');
    expect(store.size).toBe(0);
    expect(store.get('s1')).toBeUndefined();
  });

  it('size tracks session count', () => {
    expect(store.size).toBe(0);
    store.getOrCreate('a');
    store.getOrCreate('b');
    expect(store.size).toBe(2);
  });

  it('startCleanup removes idle sessions', async () => {
    vi.useFakeTimers();

    const s = store.getOrCreate('idle-session');
    // Set lastActivity to 31 minutes ago
    s.lastActivity = Date.now() - 31 * 60_000;

    store.startCleanup(30 * 60_000);

    // Advance timer past cleanup interval (60s)
    vi.advanceTimersByTime(61_000);

    expect(store.get('idle-session')).toBeUndefined();
    expect(store.size).toBe(0);

    store.stopCleanup();
    vi.useRealTimers();
  });

  it('startCleanup keeps active sessions', async () => {
    vi.useFakeTimers();

    store.getOrCreate('active-session');
    store.startCleanup(30 * 60_000);

    vi.advanceTimersByTime(61_000);

    expect(store.get('active-session')).toBeDefined();

    store.stopCleanup();
    vi.useRealTimers();
  });

  it('stopCleanup stops the interval', () => {
    store.startCleanup();
    store.stopCleanup();
    // Double stop should not throw
    expect(() => store.stopCleanup()).not.toThrow();
  });
});
