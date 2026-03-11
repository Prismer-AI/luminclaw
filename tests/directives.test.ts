/**
 * Tests for Directives — Zod schemas for the UI directive protocol
 */

import { describe, it, expect } from 'vitest';
import {
  DirectiveTypeSchema,
  DirectiveSchema,
  SwitchComponentPayload,
  TaskUpdatePayload,
  TimelineEventPayload,
} from '../src/directives.js';

// ── DirectiveTypeSchema ──────────────────────────────────

describe('DirectiveTypeSchema', () => {
  const allTypes = [
    'SWITCH_COMPONENT', 'UPDATE_CONTENT', 'UPDATE_LATEX', 'COMPILE_COMPLETE',
    'JUPYTER_ADD_CELL', 'JUPYTER_CELL_OUTPUT', 'UPDATE_GALLERY', 'UPDATE_CODE',
    'UPDATE_DATA_GRID', 'TASK_UPDATE', 'UPDATE_TASKS', 'TIMELINE_EVENT',
    'THINKING_UPDATE', 'OPERATION_STATUS', 'ACTION_REQUEST', 'REQUEST_CONFIRMATION',
    'NOTIFICATION',
  ];

  it('has 17 directive types', () => {
    expect(allTypes).toHaveLength(17);
  });

  it.each(allTypes)('validates %s', (type) => {
    expect(DirectiveTypeSchema.parse(type)).toBe(type);
  });

  it('rejects unknown type', () => {
    expect(() => DirectiveTypeSchema.parse('UNKNOWN_TYPE')).toThrow();
  });

  it('rejects lowercase variant', () => {
    expect(() => DirectiveTypeSchema.parse('switch_component')).toThrow();
  });
});

// ── DirectiveSchema ──────────────────────────────────────

describe('DirectiveSchema', () => {
  it('validates basic directive', () => {
    const directive = {
      type: 'SWITCH_COMPONENT',
      payload: { component: 'pdf-reader' },
    };
    const result = DirectiveSchema.parse(directive);
    expect(result.type).toBe('SWITCH_COMPONENT');
    expect(result.payload.component).toBe('pdf-reader');
  });

  it('validates directive with timestamp', () => {
    const directive = {
      type: 'NOTIFICATION',
      payload: { message: 'hello' },
      timestamp: '2026-03-12T00:00:00Z',
    };
    const result = DirectiveSchema.parse(directive);
    expect(result.timestamp).toBe('2026-03-12T00:00:00Z');
  });

  it('timestamp is optional', () => {
    const directive = {
      type: 'UPDATE_CONTENT',
      payload: { content: 'abc' },
    };
    const result = DirectiveSchema.parse(directive);
    expect(result.timestamp).toBeUndefined();
  });

  it('rejects directive with invalid type', () => {
    expect(() => DirectiveSchema.parse({
      type: 'INVALID',
      payload: {},
    })).toThrow();
  });

  it('rejects directive without payload', () => {
    expect(() => DirectiveSchema.parse({
      type: 'NOTIFICATION',
    })).toThrow();
  });
});

// ── SwitchComponentPayload ───────────────────────────────

describe('SwitchComponentPayload', () => {
  const validComponents = [
    'pdf-reader', 'latex-editor', 'jupyter-notebook', 'ai-editor',
    'code-playground', 'ag-grid', 'bento-gallery', 'three-viewer',
  ];

  it.each(validComponents)('validates component %s', (component) => {
    expect(SwitchComponentPayload.parse({ component })).toEqual({ component });
  });

  it('rejects unknown component', () => {
    expect(() => SwitchComponentPayload.parse({ component: 'unknown-component' })).toThrow();
  });

  it('accepts optional title and data', () => {
    const payload = {
      component: 'latex-editor',
      title: 'My Paper',
      data: { template: 'cvpr' },
    };
    const result = SwitchComponentPayload.parse(payload);
    expect(result.title).toBe('My Paper');
    expect(result.data).toEqual({ template: 'cvpr' });
  });
});

// ── TaskUpdatePayload ────────────────────────────────────

describe('TaskUpdatePayload', () => {
  it('validates with required fields', () => {
    const payload = { id: 'task-1', title: 'Compile paper' };
    const result = TaskUpdatePayload.parse(payload);
    expect(result.id).toBe('task-1');
    expect(result.status).toBe('pending'); // default
  });

  it('validates with all fields', () => {
    const payload = {
      id: 'task-2',
      title: 'Run analysis',
      status: 'running',
      description: 'Analyzing dataset',
      progress: 0.5,
    };
    const result = TaskUpdatePayload.parse(payload);
    expect(result.status).toBe('running');
    expect(result.progress).toBe(0.5);
  });

  it('validates all status values', () => {
    for (const status of ['pending', 'running', 'completed', 'failed']) {
      const result = TaskUpdatePayload.parse({ id: '1', title: 't', status });
      expect(result.status).toBe(status);
    }
  });

  it('rejects invalid status', () => {
    expect(() => TaskUpdatePayload.parse({
      id: '1', title: 't', status: 'unknown',
    })).toThrow();
  });
});

// ── TimelineEventPayload ─────────────────────────────────

describe('TimelineEventPayload', () => {
  it('validates full event', () => {
    const payload = {
      id: 'evt-1',
      componentType: 'latex-editor',
      action: 'compile',
      description: 'Compiled CVPR paper',
      actorId: 'researcher',
      actorType: 'agent',
      duration: 3500,
    };
    const result = TimelineEventPayload.parse(payload);
    expect(result.actorType).toBe('agent');
    expect(result.duration).toBe(3500);
  });

  it('duration is optional', () => {
    const payload = {
      id: 'evt-2',
      componentType: 'jupyter-notebook',
      action: 'execute',
      description: 'Ran cell',
      actorId: 'user-1',
      actorType: 'user',
    };
    const result = TimelineEventPayload.parse(payload);
    expect(result.duration).toBeUndefined();
  });

  it('rejects invalid actorType', () => {
    expect(() => TimelineEventPayload.parse({
      id: 'e1', componentType: 'x', action: 'y',
      description: 'z', actorId: 'a', actorType: 'bot',
    })).toThrow();
  });
});
