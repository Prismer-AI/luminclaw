/**
 * Telegram Channel Adapter — long-polling Bot API integration.
 *
 * Uses native `fetch` (no dependencies). Connects to the Telegram Bot API
 * via `getUpdates` long polling, forwards messages to the agent handler,
 * and sends responses back via `sendMessage`.
 *
 * **Environment:**
 * - `TELEGRAM_BOT_TOKEN` — Bot API token from \@BotFather
 * - `TELEGRAM_ALLOWED_CHATS` — Optional comma-separated chat IDs to restrict access
 *
 * @module channels/telegram
 */

import type { ChannelAdapter, IncomingMessage } from './types.js';
import { createLogger } from '../log.js';

const log = createLogger('telegram');

const API_BASE = 'https://api.telegram.org/bot';

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private token = '';
  private allowedChats = new Set<string>();
  private handler: ((msg: IncomingMessage) => Promise<string>) | null = null;
  private running = false;
  private offset = 0;
  private abortController: AbortController | null = null;

  async init(config: Record<string, string>): Promise<void> {
    this.token = config.TELEGRAM_BOT_TOKEN || '';
    if (!this.token) throw new Error('TELEGRAM_BOT_TOKEN is required');

    // Optional: restrict to specific chats
    const allowed = config.TELEGRAM_ALLOWED_CHATS || '';
    if (allowed) {
      for (const id of allowed.split(',')) {
        this.allowedChats.add(id.trim());
      }
    }

    // Verify token with getMe
    const me = await this.apiCall('getMe') as Record<string, unknown>;
    log.info('bot connected', { username: me.username, name: me.first_name });

    // Start polling
    this.running = true;
    this.poll();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<string>): void {
    this.handler = handler;
  }

  async send(chatId: string, text: string): Promise<void> {
    // Split long messages (Telegram limit: 4096 chars)
    const chunks = this.splitMessage(text, 4096);
    for (const chunk of chunks) {
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    log.info('stopped');
  }

  // ── Internal ──────────────────────────────────────

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const updates = await this.apiCall('getUpdates', {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ['message'],
        }, this.abortController.signal);

        if (!Array.isArray(updates)) continue;

        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('abort')) {
          log.warn('poll error', { error: msg });
          // Back off on error
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  private async handleUpdate(update: Record<string, unknown>): Promise<void> {
    const message = update.message as Record<string, unknown> | undefined;
    if (!message?.text) return;

    const chat = message.chat as Record<string, unknown>;
    const chatId = String(chat.id);
    const from = message.from as Record<string, unknown> | undefined;
    const sender = from?.username ? String(from.username) : String(from?.id ?? 'unknown');
    const text = String(message.text);

    // Access control
    if (this.allowedChats.size > 0 && !this.allowedChats.has(chatId)) {
      log.debug('ignored unauthorized chat', { chatId });
      return;
    }

    log.debug('incoming message', { sender, chatId, preview: text.slice(0, 50) });

    if (!this.handler) {
      await this.send(chatId, 'Agent not ready.');
      return;
    }

    // Send typing indicator
    this.apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    try {
      const response = await this.handler({ chatId, text, sender, raw: update });
      await this.send(chatId, response);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('handler error', { error: errMsg });
      await this.send(chatId, `Error: ${errMsg.slice(0, 200)}`);
    }
  }

  private async apiCall(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${API_BASE}${this.token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
      signal,
    });

    const data = await res.json() as { ok: boolean; result: unknown; description?: string };
    if (!data.ok) throw new Error(`Telegram API error: ${data.description || 'unknown'}`);
    return data.result;
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt < maxLen * 0.5) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    return chunks;
  }
}
