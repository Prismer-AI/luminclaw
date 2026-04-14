import { describe, it, expect } from 'vitest';

describe('Tool permissions interface', () => {
  it('Tool.requiresUserInteraction is optional', async () => {
    const { createBashTool } = await import('../src/tools/builtins.js');
    const bash = createBashTool('/tmp');
    expect(typeof bash.requiresUserInteraction === 'function').toBe(true);
    expect(bash.requiresUserInteraction!()).toBe(true);
  });

  it('Tool without requiresUserInteraction defaults to false (safe)', async () => {
    // think tool is non-destructive
    const builtins = await import('../src/tools/builtins.js');
    const tools = builtins.getBuiltinTools?.() ?? [];
    const think = tools.find((t: any) => t.name === 'think');
    if (think) {
      expect(think.requiresUserInteraction?.() ?? false).toBe(false);
    }
  });
});
