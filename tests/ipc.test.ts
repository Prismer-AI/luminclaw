/**
 * Tests for IPC — protocol markers, schemas, writeOutput, parseOutput
 */

import { describe, it, expect, vi } from 'vitest';
import {
  OUTPUT_START,
  OUTPUT_END,
  InputMessageSchema,
  OutputMessageSchema,
  writeOutput,
  parseOutput,
  type OutputMessage,
} from '../src/ipc.js';

// ── Protocol Markers ─────────────────────────────────────

describe('Protocol Markers', () => {
  it('OUTPUT_START is defined', () => {
    expect(OUTPUT_START).toBe('---LUMIN_OUTPUT_START---');
  });

  it('OUTPUT_END is defined', () => {
    expect(OUTPUT_END).toBe('---LUMIN_OUTPUT_END---');
  });
});

// ── InputMessageSchema ───────────────────────────────────

describe('InputMessageSchema', () => {
  it('validates message type', () => {
    const input = { type: 'message', content: 'hello', sessionId: 's1' };
    expect(InputMessageSchema.parse(input)).toEqual(input);
  });

  it('validates health type', () => {
    const input = { type: 'health' };
    expect(InputMessageSchema.parse(input)).toEqual(input);
  });

  it('validates shutdown type', () => {
    const input = { type: 'shutdown' };
    expect(InputMessageSchema.parse(input)).toEqual(input);
  });

  it('validates with config', () => {
    const input = {
      type: 'message',
      content: 'test',
      config: {
        model: 'gpt-4',
        baseUrl: 'http://localhost',
        apiKey: 'key',
        maxIterations: 10,
        temperature: 0.7,
        tools: ['bash', 'latex'],
      },
    };
    const result = InputMessageSchema.parse(input);
    expect(result.config!.model).toBe('gpt-4');
    expect(result.config!.tools).toEqual(['bash', 'latex']);
  });

  it('rejects invalid type', () => {
    expect(() => InputMessageSchema.parse({ type: 'invalid' })).toThrow();
  });

  it('accepts optional fields as undefined', () => {
    const input = { type: 'message' };
    const result = InputMessageSchema.parse(input);
    expect(result.content).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.config).toBeUndefined();
  });
});

// ── OutputMessageSchema ──────────────────────────────────

describe('OutputMessageSchema', () => {
  it('validates success response', () => {
    const output = {
      status: 'success',
      response: 'Hello!',
      toolsUsed: ['bash'],
      iterations: 1,
    };
    expect(OutputMessageSchema.parse(output)).toEqual(output);
  });

  it('validates error response', () => {
    const output = { status: 'error', error: 'Something went wrong' };
    expect(OutputMessageSchema.parse(output)).toEqual(output);
  });

  it('validates health_ok response', () => {
    const output = { status: 'health_ok' };
    expect(OutputMessageSchema.parse(output)).toEqual(output);
  });

  it('validates with directives', () => {
    const output = {
      status: 'success',
      response: 'Done',
      directives: [
        { type: 'SWITCH_COMPONENT', payload: { component: 'latex-editor' }, timestamp: '12345' },
      ],
    };
    const result = OutputMessageSchema.parse(output);
    expect(result.directives).toHaveLength(1);
  });

  it('validates with usage', () => {
    const output = {
      status: 'success',
      usage: { promptTokens: 100, completionTokens: 50 },
    };
    const result = OutputMessageSchema.parse(output);
    expect(result.usage!.promptTokens).toBe(100);
  });

  it('rejects invalid status', () => {
    expect(() => OutputMessageSchema.parse({ status: 'unknown' })).toThrow();
  });
});

// ── writeOutput ──────────────────────────────────────────

describe('writeOutput', () => {
  it('writes JSON wrapped with markers', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const output: OutputMessage = { status: 'success', response: 'ok' };
    writeOutput(output);

    const written = writeSpy.mock.calls[0][0] as string;
    expect(written).toContain(OUTPUT_START);
    expect(written).toContain(OUTPUT_END);
    expect(written).toContain('"status":"success"');
    expect(written).toContain('"response":"ok"');

    writeSpy.mockRestore();
  });
});

// ── parseOutput ──────────────────────────────────────────

describe('parseOutput', () => {
  it('parses valid output buffer', () => {
    const json = JSON.stringify({ status: 'success', response: 'hello' });
    const buffer = `some noise\n${OUTPUT_START}\n${json}\n${OUTPUT_END}\nmore noise`;

    const result = parseOutput(buffer);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('success');
    expect(result!.response).toBe('hello');
  });

  it('returns null when no markers found', () => {
    expect(parseOutput('just regular stdout output')).toBeNull();
  });

  it('returns null when only start marker found', () => {
    expect(parseOutput(`${OUTPUT_START}\n{"status":"success"}`)).toBeNull();
  });

  it('returns null when end before start', () => {
    expect(parseOutput(`${OUTPUT_END}\n{"status":"success"}\n${OUTPUT_START}`)).toBeNull();
  });

  it('returns null for malformed JSON between markers', () => {
    const buffer = `${OUTPUT_START}\nnot-valid-json\n${OUTPUT_END}`;
    expect(parseOutput(buffer)).toBeNull();
  });

  it('returns null for JSON that does not match schema', () => {
    const json = JSON.stringify({ invalid: 'data' });
    const buffer = `${OUTPUT_START}\n${json}\n${OUTPUT_END}`;
    expect(parseOutput(buffer)).toBeNull();
  });

  it('handles large JSON output', () => {
    const largeResponse = 'x'.repeat(100_000);
    const json = JSON.stringify({ status: 'success', response: largeResponse });
    const buffer = `${OUTPUT_START}\n${json}\n${OUTPUT_END}`;

    const result = parseOutput(buffer);
    expect(result).not.toBeNull();
    expect(result!.response!.length).toBe(100_000);
  });
});
