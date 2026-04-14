import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { AbortReason, isAbortError, getAbortReason, createAbortError } from '../src/abort.js';

describe('Provider — abort propagation', () => {
  it('rejects with structured AbortError when signal aborts mid-request', async () => {
    // Use an endpoint we won't actually reach — the abort fires before fetch resolves.
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://10.255.255.1',  // unroutable (TEST-NET / blackhole)
      apiKey: 'test',
      defaultModel: 'test-model',
    });

    const ctrl = new AbortController();
    // Abort ~20ms in — the fetch() will be outstanding
    setTimeout(() => ctrl.abort(createAbortError(AbortReason.UserExplicitCancel)), 20);

    await expect(
      provider.chat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'test-model',
        signal: ctrl.signal,
      }),
    ).rejects.toSatisfy((e: unknown) => {
      return isAbortError(e) && getAbortReason(e) === AbortReason.UserExplicitCancel;
    });
  }, 5000);
});
