/**
 * Tests for Phase 3 — DirectiveRouter + AgentViewStack.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DirectiveRouter, type ExtendedDirective } from '../src/loop/directive-router.js';
import { AgentViewStack } from '../src/loop/view-stack.js';

// ── DirectiveRouter ──────────────────────────────────────

describe('DirectiveRouter', () => {
  let router: DirectiveRouter;
  let published: unknown[];

  beforeEach(() => {
    published = [];
    const fakeBus = {
      publish: (event: unknown) => { published.push(event); },
      subscribe: () => () => {},
      getBuffer: () => [],
      clearBuffer: () => {},
      getStats: () => ({ bufferSize: 0, maxBuffer: 1000, droppedCount: 0, highWaterMark: 0 }),
    };
    router = new DirectiveRouter(fakeBus as any);
  });

  // Realtime directives
  const realtimeTypes = [
    'SWITCH_COMPONENT', 'TIMELINE_EVENT', 'THINKING_UPDATE', 'OPERATION_STATUS',
    'UPDATE_CONTENT', 'UPDATE_LATEX', 'UPDATE_CODE', 'UPDATE_DATA_GRID',
    'UPDATE_GALLERY', 'JUPYTER_ADD_CELL', 'JUPYTER_CELL_OUTPUT',
    'EXTENSION_UPDATE', 'AGENT_CURSOR', 'HUMAN_CURSOR',
  ];

  for (const type of realtimeTypes) {
    it(`routes ${type} as realtime`, () => {
      const result = router.route({ type, payload: {} });
      expect(result.delivery).toBe('realtime');
    });
  }

  it('realtime directives are published to EventBus', () => {
    router.route({ type: 'SWITCH_COMPONENT', payload: { component: 'latex-editor' } });
    expect(published).toHaveLength(1);
    expect((published[0] as any).type).toBe('directive');
  });

  // Checkpoint directives
  const checkpointTypes = ['COMPILE_COMPLETE', 'NOTIFICATION', 'COMPONENT_STATE_SYNC'];

  for (const type of checkpointTypes) {
    it(`routes ${type} as checkpoint`, () => {
      const result = router.route({ type, payload: {} });
      expect(result.delivery).toBe('checkpoint');
    });
  }

  it('checkpoint directives are buffered, not published', () => {
    router.route({ type: 'NOTIFICATION', payload: { message: 'hi' } });
    expect(published).toHaveLength(0);
    expect(router.checkpointBufferSize).toBe(1);
  });

  it('drainCheckpointBuffer returns and clears buffered directives', () => {
    router.route({ type: 'COMPILE_COMPLETE', payload: { status: 'ok' } });
    router.route({ type: 'NOTIFICATION', payload: { message: 'done' } });
    expect(router.checkpointBufferSize).toBe(2);

    const drained = router.drainCheckpointBuffer();
    expect(drained).toHaveLength(2);
    expect(drained[0].type).toBe('COMPILE_COMPLETE');
    expect(drained[1].type).toBe('NOTIFICATION');
    expect(router.checkpointBufferSize).toBe(0);
  });

  // HIL-only directives
  const hilOnlyTypes = ['TASK_UPDATE', 'UPDATE_TASKS', 'ACTION_REQUEST', 'REQUEST_CONFIRMATION'];

  for (const type of hilOnlyTypes) {
    it(`routes ${type} as hil-only`, () => {
      const result = router.route({ type, payload: {} });
      expect(result.delivery).toBe('hil-only');
    });
  }

  it('hil-only directives are not published or buffered', () => {
    router.route({ type: 'ACTION_REQUEST', payload: { question: 'proceed?' } });
    expect(published).toHaveLength(0);
    expect(router.checkpointBufferSize).toBe(0);
  });

  // Unknown types default to realtime
  it('unknown directive types default to realtime', () => {
    const result = router.route({ type: 'FUTURE_DIRECTIVE', payload: {} });
    expect(result.delivery).toBe('realtime');
    expect(published).toHaveLength(1);
  });

  // Extended fields preserved
  it('preserves extended fields through routing', () => {
    const directive: ExtendedDirective = {
      type: 'UPDATE_CONTENT',
      payload: { content: 'hello' },
      emittedBy: 'latex-expert',
      taskId: 'task-1',
      source: 'agent',
      stateVersion: 42,
    };
    const result = router.route(directive);
    expect(result.directive.emittedBy).toBe('latex-expert');
    expect(result.directive.taskId).toBe('task-1');
    expect(result.directive.source).toBe('agent');
    expect(result.directive.stateVersion).toBe(42);
  });

  // No bus
  it('works without an EventBus (realtime directives silently dropped)', () => {
    const noBusRouter = new DirectiveRouter();
    const result = noBusRouter.route({ type: 'SWITCH_COMPONENT', payload: {} });
    expect(result.delivery).toBe('realtime');
  });
});

// ── AgentViewStack ───────────────────────────────────────

describe('AgentViewStack', () => {
  let stack: AgentViewStack;

  beforeEach(() => {
    stack = new AgentViewStack();
  });

  it('empty stack returns undefined for current', () => {
    expect(stack.current()).toBeUndefined();
    expect(stack.depth).toBe(0);
  });

  it('push + current', () => {
    stack.push('researcher');
    expect(stack.current()!.agentId).toBe('researcher');
    expect(stack.depth).toBe(1);
  });

  it('push + pop', () => {
    stack.push('researcher');
    stack.push('latex-expert');
    expect(stack.depth).toBe(2);
    expect(stack.current()!.agentId).toBe('latex-expert');

    const popped = stack.pop();
    expect(popped!.agentId).toBe('latex-expert');
    expect(stack.current()!.agentId).toBe('researcher');
    expect(stack.depth).toBe(1);
  });

  it('pop on empty returns undefined', () => {
    expect(stack.pop()).toBeUndefined();
  });

  it('recordSwitch updates component for agent', () => {
    stack.push('researcher');
    stack.recordSwitch('researcher', 'jupyter-notebook');
    expect(stack.current()!.activeComponent).toBe('jupyter-notebook');
  });

  it('recordSwitch on unknown agent pushes new entry', () => {
    stack.recordSwitch('data-analyst', 'ag-grid');
    expect(stack.current()!.agentId).toBe('data-analyst');
    expect(stack.current()!.activeComponent).toBe('ag-grid');
  });

  it('previous returns the parent view', () => {
    stack.push('researcher');
    stack.recordSwitch('researcher', 'ai-editor');
    stack.push('latex-expert');
    stack.recordSwitch('latex-expert', 'latex-editor');

    expect(stack.previous()!.agentId).toBe('researcher');
    expect(stack.previous()!.activeComponent).toBe('ai-editor');
  });

  it('previous returns undefined with single entry', () => {
    stack.push('researcher');
    expect(stack.previous()).toBeUndefined();
  });

  it('clear empties the stack', () => {
    stack.push('a');
    stack.push('b');
    stack.clear();
    expect(stack.depth).toBe(0);
    expect(stack.current()).toBeUndefined();
  });
});
