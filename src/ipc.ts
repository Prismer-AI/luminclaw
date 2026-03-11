/**
 * IPC — stdin/stdout JSON protocol for host ↔ container communication.
 *
 * Messages are wrapped between {@link OUTPUT_START} and {@link OUTPUT_END}
 * markers so the host process can reliably extract JSON from mixed stdout.
 *
 * Input is validated via {@link InputMessageSchema} (Zod).
 * Output is validated via {@link OutputMessageSchema} (Zod).
 *
 * @module ipc
 */

import { z } from 'zod';

// ── Protocol Markers ─────────────────────────────────────

export const OUTPUT_START = '---LUMIN_OUTPUT_START---';
export const OUTPUT_END = '---LUMIN_OUTPUT_END---';

// ── Input Schema (Host → Container via stdin) ────────────

export const InputMessageSchema = z.object({
  type: z.enum(['message', 'health', 'shutdown']),
  content: z.string().optional(),
  sessionId: z.string().optional(),
  config: z.object({
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    agentId: z.string().optional(),
    workspaceId: z.string().optional(),
    tools: z.array(z.string()).optional(),
    maxIterations: z.number().optional(),
    temperature: z.number().optional(),
  }).optional(),
});

export type InputMessage = z.infer<typeof InputMessageSchema>;

// ── Output Schema (Container → Host via stdout) ──────────

export const OutputMessageSchema = z.object({
  status: z.enum(['success', 'error', 'health_ok']),
  response: z.string().optional(),
  thinking: z.string().optional(),
  directives: z.array(z.object({
    type: z.string(),
    payload: z.record(z.unknown()),
    timestamp: z.string(),
  })).optional(),
  toolsUsed: z.array(z.string()).optional(),
  usage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
  }).optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  iterations: z.number().optional(),
});

export type OutputMessage = z.infer<typeof OutputMessageSchema>;

// ── Read stdin ───────────────────────────────────────────

export async function readStdin(): Promise<InputMessage> {
  return new Promise((resolve, reject) => {
    let data = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const validated = InputMessageSchema.parse(parsed);
        resolve(validated);
      } catch (err) {
        reject(new Error(`Invalid input: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    process.stdin.on('error', reject);

    // Timeout: if no input after 5s, reject
    setTimeout(() => {
      if (!data) reject(new Error('No input received on stdin after 5s'));
    }, 5000);
  });
}

// ── Write stdout ─────────────────────────────────────────

export function writeOutput(output: OutputMessage): void {
  const json = JSON.stringify(output);
  process.stdout.write(`${OUTPUT_START}\n${json}\n${OUTPUT_END}\n`);
}

// ── Parse output from stdout buffer ──────────────────────

export function parseOutput(buffer: string): OutputMessage | null {
  const startIdx = buffer.indexOf(OUTPUT_START);
  const endIdx = buffer.indexOf(OUTPUT_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const jsonStr = buffer.slice(startIdx + OUTPUT_START.length, endIdx).trim();
  try {
    return OutputMessageSchema.parse(JSON.parse(jsonStr));
  } catch {
    return null;
  }
}
