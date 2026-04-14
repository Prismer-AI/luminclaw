import { describe, it, expect } from 'vitest';
import { createTool, ToolRegistry } from '../src/tools.js';

describe('ToolContext.abortSignal', () => {
  it('exposes abortSignal to tools', async () => {
    const ctrl = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const reg = new ToolRegistry();
    reg.register(createTool(
      'peek',
      'peek at ctx',
      { type: 'object', properties: {} },
      async (_args, ctx) => {
        seenSignal = ctx.abortSignal;
        return '';
      },
    ));
    await reg.execute('peek', {}, { workspaceDir: '/tmp', sessionId: 's', agentId: 'a', abortSignal: ctrl.signal });
    expect(seenSignal).toBe(ctrl.signal);
  });
});
