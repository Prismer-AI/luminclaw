/**
 * Tests for provider onToolUse callback — verifies that tool_use blocks
 * are detected and emitted during streaming.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider, type ToolCall } from '../src/provider.js';

/**
 * Helper: create a mock SSE stream from an array of SSE chunk objects.
 * Each chunk is a partial OpenAI streaming response.
 */
function createSSEStream(chunks: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  const fullText = lines.join('');

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(fullText));
      controller.close();
    },
  });
}

/** Build a streaming delta chunk with tool_calls */
function toolCallDelta(index: number, opts: { id?: string; name?: string; args?: string }) {
  const fn: Record<string, string> = {};
  if (opts.name !== undefined) fn.name = opts.name;
  if (opts.args !== undefined) fn.arguments = opts.args;

  const tc: Record<string, unknown> = { index };
  if (opts.id) tc.id = opts.id;
  if (Object.keys(fn).length > 0) tc.function = fn;

  return {
    choices: [{
      delta: { tool_calls: [tc] },
    }],
  };
}

/** Build a text delta chunk */
function textDelta(content: string) {
  return {
    choices: [{
      delta: { content },
    }],
  };
}

describe('OpenAICompatibleProvider.chatStream onToolUse', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('calls onToolUse for a single tool at stream end', async () => {
    const chunks = [
      toolCallDelta(0, { id: 'call_1', name: 'read_file' }),
      toolCallDelta(0, { args: '{"path":' }),
      toolCallDelta(0, { args: '"/tmp/a"}' }),
    ];

    fetchSpy.mockResolvedValueOnce(new Response(createSSEStream(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://mock:3000/v1',
      apiKey: 'test',
      defaultModel: 'test-model',
    });

    const onDelta = vi.fn();
    const onToolUse = vi.fn();

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'test' }] },
      onDelta,
      onToolUse,
    );

    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: '/tmp/a' },
    });

    // Response should also contain the tool call
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('read_file');
  });

  it('calls onToolUse early when a new tool_call index appears', async () => {
    const chunks = [
      // First tool call
      toolCallDelta(0, { id: 'call_1', name: 'read_file' }),
      toolCallDelta(0, { args: '{"path":"/a"}' }),
      // Second tool call starts — triggers finalization of first
      toolCallDelta(1, { id: 'call_2', name: 'search' }),
      toolCallDelta(1, { args: '{"query":"foo"}' }),
    ];

    fetchSpy.mockResolvedValueOnce(new Response(createSSEStream(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://mock:3000/v1',
      apiKey: 'test',
      defaultModel: 'test-model',
    });

    const onDelta = vi.fn();
    const callOrder: ToolCall[] = [];
    const onToolUse = vi.fn((tc: ToolCall) => {
      callOrder.push(tc);
    });

    await provider.chatStream(
      { messages: [{ role: 'user', content: 'test' }] },
      onDelta,
      onToolUse,
    );

    expect(onToolUse).toHaveBeenCalledTimes(2);
    // First tool was emitted before second was fully parsed
    expect(callOrder[0].name).toBe('read_file');
    expect(callOrder[0].arguments).toEqual({ path: '/a' });
    expect(callOrder[1].name).toBe('search');
    expect(callOrder[1].arguments).toEqual({ query: 'foo' });
  });

  it('does not call onToolUse when callback is not provided', async () => {
    const chunks = [
      toolCallDelta(0, { id: 'call_1', name: 'read_file' }),
      toolCallDelta(0, { args: '{"path":"/a"}' }),
    ];

    fetchSpy.mockResolvedValueOnce(new Response(createSSEStream(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://mock:3000/v1',
      apiKey: 'test',
      defaultModel: 'test-model',
    });

    // Should work fine without onToolUse (backward compat)
    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'test' }] },
      vi.fn(),
    );

    expect(response.toolCalls).toHaveLength(1);
  });

  it('handles text + tool calls mixed stream', async () => {
    const chunks = [
      textDelta('Here is '),
      textDelta('the result.'),
      toolCallDelta(0, { id: 'call_1', name: 'bash' }),
      toolCallDelta(0, { args: '{"command":"ls"}' }),
    ];

    fetchSpy.mockResolvedValueOnce(new Response(createSSEStream(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://mock:3000/v1',
      apiKey: 'test',
      defaultModel: 'test-model',
    });

    const deltas: string[] = [];
    const onDelta = vi.fn((d: string) => deltas.push(d));
    const onToolUse = vi.fn();

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'test' }] },
      onDelta,
      onToolUse,
    );

    expect(response.text).toBe('Here is the result.');
    expect(deltas.join('')).toBe('Here is the result.');
    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith({
      id: 'call_1',
      name: 'bash',
      arguments: { command: 'ls' },
    });
  });

  it('handles malformed tool args gracefully', async () => {
    const chunks = [
      toolCallDelta(0, { id: 'call_1', name: 'broken' }),
      toolCallDelta(0, { args: '{invalid json' }),
    ];

    fetchSpy.mockResolvedValueOnce(new Response(createSSEStream(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://mock:3000/v1',
      apiKey: 'test',
      defaultModel: 'test-model',
    });

    const onToolUse = vi.fn();

    await provider.chatStream(
      { messages: [{ role: 'user', content: 'test' }] },
      vi.fn(),
      onToolUse,
    );

    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith({
      id: 'call_1',
      name: 'broken',
      arguments: {},
    });
  });
});
