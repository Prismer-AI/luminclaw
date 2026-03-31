/**
 * Tokens — lightweight token estimation without external tokenizers.
 *
 * Provides {@link estimateTokens} for rough token counting (sufficient
 * for context-window budgeting) and {@link estimateMessageTokens} for
 * an entire conversation array.
 *
 * Rules of thumb:
 *   - English/Latin text: ~4 characters per token
 *   - CJK (Chinese/Japanese/Korean): ~2 characters per token
 *   - Overhead per message: ~4 tokens (role, delimiters)
 *   - Final estimate padded by 1.33× for safety
 *
 * @module tokens
 */

/** Estimate token count for a text string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf\uac00-\ud7af]/g) || []).length;
  const nonCjk = text.length - cjkCount;
  return Math.ceil((nonCjk / 4 + cjkCount / 2) * 1.33);
}

/** Estimate total tokens for a conversation message array. */
export function estimateMessageTokens(messages: Array<{ role: string; content?: string | unknown[] | null }>): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // role + delimiters overhead
    if (msg.content) {
      if (typeof msg.content === 'string') {
        total += estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === 'object' && block && 'text' in block) {
            total += estimateTokens((block as { text: string }).text);
          } else {
            total += 200; // image/other blocks
          }
        }
      }
    }
  }
  return total;
}
