/**
 * Tests for Hooks — lifecycle hook registry
 */

import { describe, it, expect, vi } from 'vitest';
import { HookRegistry, type HookContext } from '../src/hooks.js';
import type { AgentResult } from '../src/agent.js';

const ctx: HookContext = { sessionId: 'test-session', agentId: 'researcher' };

describe('HookRegistry', () => {
  describe('before_prompt', () => {
    it('modifies prompt through hook chain', async () => {
      const hooks = new HookRegistry();
      hooks.register({
        type: 'before_prompt',
        fn: (_ctx, prompt) => prompt + '\nAlways be concise.',
      });
      hooks.register({
        type: 'before_prompt',
        fn: (_ctx, prompt) => prompt + '\nUse markdown.',
      });

      const result = await hooks.runBeforePrompt(ctx, 'You are an assistant.');
      expect(result).toBe('You are an assistant.\nAlways be concise.\nUse markdown.');
    });

    it('returns original prompt when no hooks registered', async () => {
      const hooks = new HookRegistry();
      const result = await hooks.runBeforePrompt(ctx, 'Original prompt');
      expect(result).toBe('Original prompt');
    });

    it('supports async hooks', async () => {
      const hooks = new HookRegistry();
      hooks.register({
        type: 'before_prompt',
        fn: async (_ctx, prompt) => {
          await new Promise(r => setTimeout(r, 10));
          return prompt + ' [async]';
        },
      });
      const result = await hooks.runBeforePrompt(ctx, 'Test');
      expect(result).toBe('Test [async]');
    });
  });

  describe('before_tool', () => {
    it('allows tool execution by default', async () => {
      const hooks = new HookRegistry();
      const result = await hooks.runBeforeTool(ctx, 'echo', { text: 'hi' });
      expect(result.proceed).toBe(true);
      expect(result.args).toEqual({ text: 'hi' });
    });

    it('can block tool execution', async () => {
      const hooks = new HookRegistry();
      hooks.register({
        type: 'before_tool',
        fn: async (_ctx, tool) => {
          if (tool === 'dangerous_tool') return { proceed: false };
          return { proceed: true };
        },
      });

      const blocked = await hooks.runBeforeTool(ctx, 'dangerous_tool', {});
      expect(blocked.proceed).toBe(false);

      const allowed = await hooks.runBeforeTool(ctx, 'safe_tool', {});
      expect(allowed.proceed).toBe(true);
    });

    it('can modify tool arguments', async () => {
      const hooks = new HookRegistry();
      hooks.register({
        type: 'before_tool',
        fn: async (_ctx, _tool, args) => ({
          proceed: true,
          args: { ...args, injected: true },
        }),
      });

      const result = await hooks.runBeforeTool(ctx, 'echo', { text: 'hi' });
      expect(result.proceed).toBe(true);
      expect(result.args).toEqual({ text: 'hi', injected: true });
    });
  });

  describe('after_tool', () => {
    it('calls registered hooks with tool result', async () => {
      const hooks = new HookRegistry();
      const fn = vi.fn();
      hooks.register({ type: 'after_tool', fn });

      await hooks.runAfterTool(ctx, 'echo', 'result text', false);
      expect(fn).toHaveBeenCalledWith(ctx, 'echo', 'result text', false);
    });

    it('swallows errors from hooks', async () => {
      const hooks = new HookRegistry();
      hooks.register({
        type: 'after_tool',
        fn: () => { throw new Error('hook error'); },
      });

      // Should not throw
      await expect(hooks.runAfterTool(ctx, 'echo', 'result', false)).resolves.toBeUndefined();
    });
  });

  describe('agent_end', () => {
    it('calls registered hooks with agent result', async () => {
      const hooks = new HookRegistry();
      const fn = vi.fn();
      hooks.register({ type: 'agent_end', fn });

      const result: AgentResult = {
        text: 'Done',
        directives: [],
        toolsUsed: ['echo'],
        iterations: 2,
      };
      await hooks.runAgentEnd(ctx, result);
      expect(fn).toHaveBeenCalledWith(ctx, result);
    });

    it('swallows errors from hooks', async () => {
      const hooks = new HookRegistry();
      hooks.register({
        type: 'agent_end',
        fn: () => { throw new Error('hook error'); },
      });

      await expect(hooks.runAgentEnd(ctx, {
        text: '', directives: [], toolsUsed: [], iterations: 0,
      })).resolves.toBeUndefined();
    });
  });

  describe('count', () => {
    it('tracks registered hook count', () => {
      const hooks = new HookRegistry();
      expect(hooks.count).toBe(0);
      hooks.register({ type: 'before_prompt', fn: (_ctx, p) => p });
      hooks.register({ type: 'after_tool', fn: vi.fn() });
      expect(hooks.count).toBe(2);
    });
  });
});
