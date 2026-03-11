/**
 * Directives — Zod schemas for the UI directive protocol.
 *
 * These are **type definitions only**. Actual directive emission is
 * handled by the prismer-workspace plugin's `sendUIDirective()`.
 *
 * Schemas are exported for frontend type validation via
 * `@prismer/agent-core/directives`.
 *
 * Supported directive types include component switching, content
 * updates, LaTeX compilation, Jupyter cells, gallery images, task
 * updates, timeline events, and notifications.
 *
 * @module directives
 */

import { z } from 'zod';

// ── Directive Types ──────────────────────────────────────

export const DirectiveTypeSchema = z.enum([
  'SWITCH_COMPONENT',
  'UPDATE_CONTENT',
  'UPDATE_LATEX',
  'COMPILE_COMPLETE',
  'JUPYTER_ADD_CELL',
  'JUPYTER_CELL_OUTPUT',
  'UPDATE_GALLERY',
  'UPDATE_CODE',
  'UPDATE_DATA_GRID',
  'TASK_UPDATE',
  'UPDATE_TASKS',
  'TIMELINE_EVENT',
  'THINKING_UPDATE',
  'OPERATION_STATUS',
  'ACTION_REQUEST',
  'REQUEST_CONFIRMATION',
  'NOTIFICATION',
]);

export type DirectiveType = z.infer<typeof DirectiveTypeSchema>;

export const DirectiveSchema = z.object({
  type: DirectiveTypeSchema,
  payload: z.record(z.unknown()),
  timestamp: z.string().optional(),
});

export type Directive = z.infer<typeof DirectiveSchema>;

// ── Specific Payloads (for type-safe construction) ───────

export const SwitchComponentPayload = z.object({
  component: z.enum([
    'pdf-reader', 'latex-editor', 'jupyter-notebook', 'ai-editor',
    'code-playground', 'ag-grid', 'bento-gallery', 'three-viewer',
  ]),
  title: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});

export const TaskUpdatePayload = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).default('pending'),
  description: z.string().optional(),
  progress: z.number().optional(),
});

export const TimelineEventPayload = z.object({
  id: z.string(),
  componentType: z.string(),
  action: z.string(),
  description: z.string(),
  actorId: z.string(),
  actorType: z.enum(['agent', 'user']),
  duration: z.number().optional(),
});
