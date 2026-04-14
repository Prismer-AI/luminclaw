import { describe, it, expect } from 'vitest';
import {
  PermissionMode,
  type ToolPermissionContext,
  type PermissionResult,
  defaultPermissionContext,
  enterPlanMode,
  exitPlanMode,
  isHeadless,
} from '../src/permissions.js';

describe('permissions module', () => {
  describe('PermissionMode', () => {
    it('exposes the four modes', () => {
      expect(PermissionMode.Default).toBe('default');
      expect(PermissionMode.Plan).toBe('plan');
      expect(PermissionMode.Auto).toBe('auto');
      expect(PermissionMode.Bypass).toBe('bypass');
    });
  });

  describe('defaultPermissionContext', () => {
    it('starts in default mode', () => {
      const ctx = defaultPermissionContext();
      expect(ctx.mode).toBe('default');
      expect(ctx.prePlanMode).toBeUndefined();
    });
  });

  describe('enterPlanMode / exitPlanMode', () => {
    it('enterPlanMode stores prior mode and switches to plan', () => {
      const ctx: ToolPermissionContext = { mode: 'default' };
      const next = enterPlanMode(ctx);
      expect(next.mode).toBe('plan');
      expect(next.prePlanMode).toBe('default');
    });

    it('exitPlanMode restores prior mode', () => {
      const ctx: ToolPermissionContext = { mode: 'plan', prePlanMode: 'auto' };
      const next = exitPlanMode(ctx);
      expect(next.mode).toBe('auto');
      expect(next.prePlanMode).toBeUndefined();
    });

    it('exitPlanMode falls back to default if prePlanMode unset', () => {
      const ctx: ToolPermissionContext = { mode: 'plan' };
      const next = exitPlanMode(ctx);
      expect(next.mode).toBe('default');
    });
  });

  describe('isHeadless', () => {
    it('true when context indicates dual-loop or no UI subscriber', () => {
      expect(isHeadless({ mode: 'auto' })).toBe(true);
      expect(isHeadless({ mode: 'bypass' })).toBe(true);
    });
    it('false in default + plan modes', () => {
      expect(isHeadless({ mode: 'default' })).toBe(false);
      expect(isHeadless({ mode: 'plan' })).toBe(false);
    });
  });

  describe('PermissionResult discriminated union', () => {
    it('supports allow / ask / deny behaviors', () => {
      const allow: PermissionResult = { behavior: 'allow' };
      const ask: PermissionResult = { behavior: 'ask', message: 'Confirm?' };
      const deny: PermissionResult = { behavior: 'deny', message: 'no', reason: 'r' };
      expect(allow.behavior).toBe('allow');
      expect(ask.behavior).toBe('ask');
      expect(deny.behavior).toBe('deny');
    });
  });
});
