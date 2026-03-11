/**
 * Tests for Approval Gate — needsApproval, waitForApproval, resolveApproval
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismerAgent, type AgentOptions } from '../src/agent.js';
import { EventBus, type AgentEvent } from '../src/sse.js';
import { ConsoleObserver } from '../src/observer.js';
import { AgentRegistry, BUILTIN_AGENTS } from '../src/agents.js';
import { ToolRegistry } from '../src/tools.js';

// Minimal mock provider (never actually called in these tests)
const mockProvider = {
  chat: vi.fn(),
} as unknown as AgentOptions['provider'];

function createAgent(bus?: EventBus): PrismerAgent {
  const agents = new AgentRegistry();
  agents.registerMany(BUILTIN_AGENTS);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  const agent = new PrismerAgent({
    provider: mockProvider,
    tools: new ToolRegistry(),
    observer: new ConsoleObserver(),
    agents,
    bus,
    systemPrompt: 'test',
    agentId: 'researcher',
  });

  stderrSpy.mockRestore();
  return agent;
}

describe('needsApproval', () => {
  let agent: PrismerAgent;

  beforeEach(() => {
    agent = createAgent();
  });

  it('returns true for bash rm command', () => {
    expect(agent.needsApproval('bash', { command: 'rm -rf /tmp/test' })).toBe(true);
  });

  it('returns true for bash rmdir command', () => {
    expect(agent.needsApproval('bash', { command: 'rmdir old-folder' })).toBe(true);
  });

  it('returns true for bash mv command', () => {
    expect(agent.needsApproval('bash', { command: 'mv file.txt /tmp/' })).toBe(true);
  });

  it('returns true for bash chmod command', () => {
    expect(agent.needsApproval('bash', { command: 'chmod 777 script.sh' })).toBe(true);
  });

  it('returns true for bash chown command', () => {
    expect(agent.needsApproval('bash', { command: 'chown root:root file' })).toBe(true);
  });

  it('returns true for bash kill command', () => {
    expect(agent.needsApproval('bash', { command: 'kill -9 12345' })).toBe(true);
  });

  it('returns false for safe bash commands', () => {
    expect(agent.needsApproval('bash', { command: 'ls -la' })).toBe(false);
    expect(agent.needsApproval('bash', { command: 'cat file.txt' })).toBe(false);
    expect(agent.needsApproval('bash', { command: 'echo hello' })).toBe(false);
    expect(agent.needsApproval('bash', { command: 'grep pattern file' })).toBe(false);
    expect(agent.needsApproval('bash', { command: 'npm install' })).toBe(false);
  });

  it('returns false for non-sensitive tools', () => {
    expect(agent.needsApproval('latex_compile', { file: 'main.tex' })).toBe(false);
    expect(agent.needsApproval('jupyter_execute', { cell: 1 })).toBe(false);
    expect(agent.needsApproval('switch_component', { component: 'pdf-reader' })).toBe(false);
  });

  it('handles bash with cmd arg (alternative key)', () => {
    expect(agent.needsApproval('bash', { cmd: 'rm file.txt' })).toBe(true);
  });

  it('handles empty command gracefully', () => {
    expect(agent.needsApproval('bash', {})).toBe(false);
    expect(agent.needsApproval('bash', { command: '' })).toBe(false);
  });
});

describe('resolveApproval', () => {
  it('resolves a pending approval', async () => {
    const agent = createAgent();

    // Access the private waitForApproval via the public interface
    const approvalPromise = (agent as unknown as { waitForApproval: (id: string) => Promise<boolean> }).waitForApproval('tool-1');

    // Resolve immediately
    agent.resolveApproval('tool-1', true);

    const result = await approvalPromise;
    expect(result).toBe(true);
  });

  it('resolves as rejected', async () => {
    const agent = createAgent();

    const approvalPromise = (agent as unknown as { waitForApproval: (id: string) => Promise<boolean> }).waitForApproval('tool-2');
    agent.resolveApproval('tool-2', false);

    const result = await approvalPromise;
    expect(result).toBe(false);
  });

  it('ignores unknown toolId', () => {
    const agent = createAgent();
    // Should not throw
    expect(() => agent.resolveApproval('nonexistent', true)).not.toThrow();
  });
});

describe('approval timeout', () => {
  it('defaults to false (reject) on timeout', async () => {
    vi.useFakeTimers();
    const agent = createAgent();

    const approvalPromise = (agent as unknown as { waitForApproval: (id: string) => Promise<boolean> }).waitForApproval('timeout-tool');

    // Advance past the 30s timeout
    vi.advanceTimersByTime(31_000);

    const result = await approvalPromise;
    expect(result).toBe(false);

    vi.useRealTimers();
  });
});

describe('approval EventBus integration', () => {
  it('publishes approval_required event when tool needs approval', () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe((e) => events.push(e));

    // Directly test that the bus can carry approval events
    bus.publish({
      type: 'tool.approval_required',
      data: {
        sessionId: 's1',
        tool: 'bash',
        toolId: 'call-1',
        args: { command: 'rm -rf /tmp/test' },
        reason: 'Tool "bash" requires approval',
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool.approval_required');
  });

  it('publishes approval_response event', () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe((e) => events.push(e));

    bus.publish({
      type: 'tool.approval_response',
      data: { toolId: 'call-1', approved: true, reason: 'approved' },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool.approval_response');
  });
});
