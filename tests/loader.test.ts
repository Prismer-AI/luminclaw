/**
 * Tests for Tool Loader — workspace plugin loading, setConfig injection
 */

import { describe, it, expect } from 'vitest';
import { loadWorkspaceTools, createTool, type WorkspaceToolDef } from '../src/tools/loader.js';
import type { ToolContext } from '../src/tools.js';

describe('loadWorkspaceTools', () => {
  const mockDefs: WorkspaceToolDef[] = [
    { name: 'tool_a', description: 'Tool A', parameters: { type: 'object', properties: {} } },
    { name: 'tool_b', description: 'Tool B', parameters: { type: 'object', properties: {} } },
    { name: 'tool_c', description: 'Tool C', parameters: { type: 'object', properties: {} } },
  ];

  const mockExecutor = async (name: string, _params: unknown) => {
    return { success: true, data: { tool: name, executed: true } };
  };

  it('converts all definitions to Tool objects', () => {
    const tools = loadWorkspaceTools(mockDefs, mockExecutor);
    expect(tools).toHaveLength(3);
    expect(tools[0].name).toBe('tool_a');
    expect(tools[1].name).toBe('tool_b');
    expect(tools[2].name).toBe('tool_c');
  });

  it('filters tools by allowed set', () => {
    const filter = new Set(['tool_a', 'tool_c']);
    const tools = loadWorkspaceTools(mockDefs, mockExecutor, filter);
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toEqual(['tool_a', 'tool_c']);
  });

  it('tool.execute calls executor and returns JSON result', async () => {
    const tools = loadWorkspaceTools(mockDefs, mockExecutor);
    const ctx: ToolContext = {
      workspaceDir: '/test',
      sessionId: 'session-1',
      agentId: 'researcher',
      emit: () => {},
    };
    const result = await tools[0].execute({}, ctx);
    const parsed = JSON.parse(result);
    expect(parsed.tool).toBe('tool_a');
    expect(parsed.executed).toBe(true);
  });

  it('tool.execute returns error JSON on executor failure', async () => {
    const failExecutor = async () => ({ success: false, error: 'Something broke' });
    const tools = loadWorkspaceTools(mockDefs, failExecutor);
    const ctx: ToolContext = {
      workspaceDir: '/test',
      sessionId: 'session-1',
      agentId: 'researcher',
      emit: () => {},
    };
    const result = await tools[0].execute({}, ctx);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('Something broke');
  });
});

describe('createTool', () => {
  it('creates a valid Tool object', () => {
    const tool = createTool(
      'test_tool',
      'A test tool',
      { type: 'object', properties: { x: { type: 'number' } } },
      async (args) => `Result: ${args.x}`,
    );
    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('A test tool');
    expect(tool.parameters).toHaveProperty('properties');
  });

  it('executes correctly', async () => {
    const tool = createTool(
      'adder',
      'Add two numbers',
      { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      async (args) => `${Number(args.a) + Number(args.b)}`,
    );
    const ctx: ToolContext = {
      workspaceDir: '/test',
      sessionId: 'session-1',
      agentId: 'researcher',
      emit: () => {},
    };
    const result = await tool.execute({ a: 3, b: 4 }, ctx);
    expect(result).toBe('7');
  });
});
