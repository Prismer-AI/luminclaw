/**
 * Tests for FallbackProvider — model fallback chain
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FallbackProvider, OpenAICompatibleProvider, type ChatRequest, type ChatResponse } from '../src/provider.js';

// Mock the base provider
function createMockProvider() {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://mock:3000/v1',
    apiKey: 'test-key',
    defaultModel: 'default-model',
  });
  return provider;
}

function mockSuccess(text: string): ChatResponse {
  return { text, toolCalls: undefined, thinking: undefined, usage: { promptTokens: 10, completionTokens: 20 } };
}

describe('FallbackProvider', () => {
  const dummyRequest: ChatRequest = {
    messages: [{ role: 'user', content: 'hello' }],
  };

  it('returns name with model chain', () => {
    const base = createMockProvider();
    const fb = new FallbackProvider(base, ['model-a', 'model-b']);
    expect(fb.name()).toBe('fallback:model-a,model-b');
  });

  it('uses first model when it succeeds', async () => {
    const base = createMockProvider();
    vi.spyOn(base, 'chat').mockResolvedValueOnce(mockSuccess('from model-a'));

    const fb = new FallbackProvider(base, ['model-a', 'model-b']);
    const result = await fb.chat(dummyRequest);
    expect(result.text).toBe('from model-a');
    expect(base.chat).toHaveBeenCalledTimes(1);
    // Verify model was overridden
    expect(base.chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-a' }));
  });

  it('falls back to second model on retryable error', async () => {
    const base = createMockProvider();
    vi.spyOn(base, 'chat')
      .mockRejectedValueOnce(new Error('Provider error 429: rate limit exceeded'))
      .mockResolvedValueOnce(mockSuccess('from model-b'));

    const fb = new FallbackProvider(base, ['model-a', 'model-b']);
    const result = await fb.chat(dummyRequest);
    expect(result.text).toBe('from model-b');
    expect(base.chat).toHaveBeenCalledTimes(2);
    expect(base.chat).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'model-b' }));
  });

  it('falls back through multiple models', async () => {
    const base = createMockProvider();
    vi.spyOn(base, 'chat')
      .mockRejectedValueOnce(new Error('Provider error 500: internal error'))
      .mockRejectedValueOnce(new Error('Provider error 502: bad gateway'))
      .mockResolvedValueOnce(mockSuccess('from model-c'));

    const fb = new FallbackProvider(base, ['model-a', 'model-b', 'model-c']);
    const result = await fb.chat(dummyRequest);
    expect(result.text).toBe('from model-c');
    expect(base.chat).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable error (401)', async () => {
    const base = createMockProvider();
    vi.spyOn(base, 'chat')
      .mockRejectedValueOnce(new Error('Provider error 401: unauthorized'));

    const fb = new FallbackProvider(base, ['model-a', 'model-b']);
    await expect(fb.chat(dummyRequest)).rejects.toThrow('401');
    expect(base.chat).toHaveBeenCalledTimes(1);
  });

  it('throws last error when all models fail', async () => {
    const base = createMockProvider();
    vi.spyOn(base, 'chat')
      .mockRejectedValueOnce(new Error('Provider error 503: unavailable'))
      .mockRejectedValueOnce(new Error('Provider error 503: still unavailable'));

    const fb = new FallbackProvider(base, ['model-a', 'model-b']);
    await expect(fb.chat(dummyRequest)).rejects.toThrow('still unavailable');
  });

  it('detects rate limit as retryable', async () => {
    const base = createMockProvider();
    vi.spyOn(base, 'chat')
      .mockRejectedValueOnce(new Error('rate_limit_exceeded'))
      .mockResolvedValueOnce(mockSuccess('ok'));

    const fb = new FallbackProvider(base, ['a', 'b']);
    const result = await fb.chat(dummyRequest);
    expect(result.text).toBe('ok');
  });

  it('detects overloaded as retryable', async () => {
    const base = createMockProvider();
    vi.spyOn(base, 'chat')
      .mockRejectedValueOnce(new Error('The server is overloaded'))
      .mockResolvedValueOnce(mockSuccess('ok'));

    const fb = new FallbackProvider(base, ['a', 'b']);
    const result = await fb.chat(dummyRequest);
    expect(result.text).toBe('ok');
  });

  it('detects timeout as retryable', async () => {
    const base = createMockProvider();
    vi.spyOn(base, 'chat')
      .mockRejectedValueOnce(new Error('Request timeout after 30s'))
      .mockResolvedValueOnce(mockSuccess('ok'));

    const fb = new FallbackProvider(base, ['a', 'b']);
    const result = await fb.chat(dummyRequest);
    expect(result.text).toBe('ok');
  });

  describe('chatStream', () => {
    it('falls back on stream failure', async () => {
      const base = createMockProvider();
      vi.spyOn(base, 'chatStream')
        .mockRejectedValueOnce(new Error('Provider error 503: unavailable'))
        .mockResolvedValueOnce(mockSuccess('stream ok'));

      const fb = new FallbackProvider(base, ['model-a', 'model-b']);
      const deltas: string[] = [];
      const result = await fb.chatStream(dummyRequest, (d) => deltas.push(d));
      expect(result.text).toBe('stream ok');
      expect(base.chatStream).toHaveBeenCalledTimes(2);
      // Verify model override in stream request
      expect(base.chatStream).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ model: 'model-b' }),
        expect.any(Function),
      );
    });
  });
});
