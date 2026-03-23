/**
 * Provider — OpenAI-compatible LLM interface with streaming and fallback.
 *
 * Defines the {@link Provider} interface and two implementations:
 *   - {@link OpenAICompatibleProvider}: direct chat/stream against any
 *     OpenAI-compatible endpoint (e.g., vLLM, LiteLLM, OpenRouter).
 *   - {@link FallbackProvider}: wraps a base provider with an ordered
 *     model chain, retrying on transient errors (429, 5xx, timeout).
 *
 * Supports thinking-capable models (Kimi, Claude) via
 * {@link ThinkingLevel} — `'off'`, `'low'`, `'high'`.
 *
 * @module provider
 */

import { z } from 'zod';
import { createLogger } from './log.js';

const log = createLogger('provider');

// ── Schemas ──────────────────────────────────────────────

/**
 * Content block for multimodal messages (OpenAI-compatible format).
 * Used when a user message contains both text and images.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string(),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** Zod schema for a single conversation message (system, user, assistant, or tool). */
export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  /** Text content (string) or multimodal content blocks (array) */
  content: z.union([
    z.string(),
    z.array(ContentBlockSchema),
  ]).nullable(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  reasoningContent: z.string().optional(),
  toolCalls: z.array(z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })).optional(),
});

/** A single conversation message. */
export type Message = z.infer<typeof MessageSchema>;

/** OpenAI-compatible function tool specification passed to the LLM. */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Controls extended thinking / chain-of-thought behaviour.
 * - `'off'`  — no thinking (default)
 * - `'low'`  — moderate reasoning budget
 * - `'high'` — full reasoning budget
 */
export type ThinkingLevel = 'off' | 'low' | 'high';

/** Request payload for {@link Provider.chat}. */
export interface ChatRequest {
  messages: Message[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  thinkingLevel?: ThinkingLevel;
}

/** A parsed tool call from the LLM response. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Response from a single LLM chat turn. */
export interface ChatResponse {
  text: string;
  toolCalls?: ToolCall[];
  thinking?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

// ── Provider Interface ───────────────────────────────────

/**
 * Abstract LLM provider. Implementations must support at least
 * {@link chat}; {@link chatStream} is optional for real-time streaming.
 */
export interface Provider {
  /** Non-streaming chat completion. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Streaming chat completion — calls `onDelta` for each text token. */
  chatStream?(request: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse>;
  /** Human-readable provider identifier. */
  name(): string;
}

// ── OpenAI-Compatible Implementation ─────────────────────

/** Configuration for {@link OpenAICompatibleProvider}. */
export interface OpenAIProviderConfig {
  /** Base URL for the OpenAI-compatible API (e.g., `http://localhost:3000/v1`). */
  baseUrl: string;
  /** Bearer token for API authentication. */
  apiKey: string;
  /** Model identifier used when none is specified per-request. */
  defaultModel: string;
}

/**
 * LLM provider that talks to any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Supports both batch ({@link chat}) and streaming ({@link chatStream}) modes,
 * tool calling, and thinking-model parameters (Kimi, Claude).
 */
export class OpenAICompatibleProvider implements Provider {
  constructor(private config: OpenAIProviderConfig) {}

  name(): string {
    return `openai-compatible:${this.config.baseUrl}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model ?? this.config.defaultModel;

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(m => this.formatMessage(m)),
      max_tokens: request.maxTokens ?? 8192,
    };

    // Only send temperature if explicitly set (some models require specific values)
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    // Thinking control
    this.applyThinkingParams(body, model, request.thinkingLevel);

    const url = `${this.config.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Provider error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json() as Record<string, unknown>;
    return this.parseResponse(data);
  }

  async chatStream(request: ChatRequest, onDelta: (delta: string) => void): Promise<ChatResponse> {
    const model = request.model ?? this.config.defaultModel;

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(m => this.formatMessage(m)),
      max_tokens: request.maxTokens ?? 8192,
      stream: true,
    };

    // Only send temperature if explicitly set
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    // Thinking control
    this.applyThinkingParams(body, model, request.thinkingLevel);

    const url = `${this.config.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Provider error ${res.status}: ${text.slice(0, 200)}`);
    }

    // Parse SSE stream
    let fullText = '';
    let reasoningText = '';
    const toolCalls: ToolCall[] = [];
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    let usage: { promptTokens: number; completionTokens: number } | undefined;

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const chunk = JSON.parse(payload) as Record<string, unknown>;
          const delta = (chunk as any).choices?.[0]?.delta;
          if (!delta) continue;

          // Reasoning content (thinking models like kimi-k2.5)
          if (delta.reasoning_content) {
            reasoningText += delta.reasoning_content;
          } else if (delta.reasoning) {
            reasoningText += delta.reasoning;
          }

          // Text content
          if (delta.content) {
            fullText += delta.content;
            onDelta(delta.content);
          }

          // Tool calls (streamed incrementally)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls as any[]) {
              const idx = tc.index ?? 0;
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: tc.id ?? '', name: '', args: '' });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name += tc.function.name;
              if (tc.function?.arguments) buf.args += tc.function.arguments;
            }
          }

          // Usage
          if ((chunk as any).usage) {
            usage = {
              promptTokens: (chunk as any).usage.prompt_tokens ?? 0,
              completionTokens: (chunk as any).usage.completion_tokens ?? 0,
            };
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    // Finalize tool calls
    for (const [, buf] of toolCallBuffers) {
      try {
        toolCalls.push({
          id: buf.id,
          name: buf.name,
          arguments: JSON.parse(buf.args || '{}'),
        });
      } catch (err) {
        log.warn('tool call args parse failed, using empty object', { toolId: buf.id, toolName: buf.name, rawArgs: buf.args.slice(0, 200), error: err instanceof Error ? err.message : String(err) });
        toolCalls.push({ id: buf.id, name: buf.name, arguments: {} });
      }
    }

    return {
      text: fullText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      thinking: reasoningText || undefined,
      usage,
    };
  }

  /** Apply provider-specific thinking parameters */
  private applyThinkingParams(body: Record<string, unknown>, model: string, level?: ThinkingLevel): void {
    if (!level || level === 'off') return;

    const modelLower = model.toLowerCase();

    if (modelLower.includes('kimi') || modelLower.includes('k2')) {
      // Kimi: binary thinking toggle
      body.enable_thinking = true;
    } else if (modelLower.includes('claude')) {
      // Claude: adaptive budget
      body.thinking = { type: 'enabled', budget_tokens: level === 'high' ? 10000 : 4000 };
    } else {
      // Generic: lower temperature encourages more deliberate output
      if (body.temperature === undefined) {
        body.temperature = level === 'high' ? 0.3 : 0.5;
      }
    }
  }

  private formatMessage(msg: Message): Record<string, unknown> {
    const formatted: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.name) formatted.name = msg.name;
    if (msg.toolCallId) formatted.tool_call_id = msg.toolCallId;
    // NOTE: reasoning_content is stored internally but NOT sent back to the API
    // — many providers reject unknown properties on assistant messages.
    if (msg.toolCalls) formatted.tool_calls = msg.toolCalls;
    return formatted;
  }

  private parseResponse(data: Record<string, unknown>): ChatResponse {
    const choice = (data as any).choices?.[0];
    if (!choice) throw new Error('No choices in response');

    const message = choice.message;
    const toolCalls: ToolCall[] = [];

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        try {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || '{}'),
          });
        } catch (err) {
          log.warn('tool call args parse failed, using empty object', { toolId: tc.id, toolName: tc.function.name, rawArgs: (tc.function.arguments || '').slice(0, 200), error: err instanceof Error ? err.message : String(err) });
          toolCalls.push({ id: tc.id, name: tc.function.name, arguments: {} });
        }
      }
    }

    const usage = (data as any).usage;

    return {
      text: message.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      thinking: message.reasoning_content ?? message.reasoning ?? message.thinking ?? undefined,
      usage: usage ? {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      } : undefined,
    };
  }
}

// ── Fallback Provider ───────────────────────────────────

/**
 * Wraps a base {@link OpenAICompatibleProvider} with an ordered model
 * fallback chain. On retryable errors (429, 5xx, rate-limit, timeout),
 * automatically retries with the next model in the chain.
 *
 * @example
 * ```typescript
 * const base = new OpenAICompatibleProvider({ baseUrl, apiKey, defaultModel: 'kimi-k2.5' });
 * const provider = new FallbackProvider(base, ['kimi-k2.5', 'gpt-4o', 'claude-sonnet']);
 * ```
 */
export class FallbackProvider implements Provider {
  private retryablePatterns = [
    /\b(429|500|502|503|504)\b/,
    /rate.?limit/i,
    /capacity/i,
    /overloaded/i,
    /timeout/i,
  ];

  constructor(
    private base: OpenAICompatibleProvider,
    private models: string[],
  ) {}

  name(): string {
    return `fallback:${this.models.join(',')}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let lastError: Error | undefined;
    for (const model of this.models) {
      try {
        return await this.base.chat({ ...request, model });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!this.isRetryable(lastError)) throw lastError;
        log.warn('model failed, trying next', { model, error: lastError.message.slice(0, 100) });
      }
    }
    throw lastError!;
  }

  async chatStream(request: ChatRequest, onDelta: (d: string) => void): Promise<ChatResponse> {
    let lastError: Error | undefined;
    for (const model of this.models) {
      try {
        return await this.base.chatStream!({ ...request, model }, onDelta);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!this.isRetryable(lastError)) throw lastError;
        log.warn('stream failed, trying next', { model });
      }
    }
    throw lastError!;
  }

  private isRetryable(err: Error): boolean {
    return this.retryablePatterns.some(p => p.test(err.message));
  }
}
