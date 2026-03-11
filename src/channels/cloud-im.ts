/**
 * Cloud IM Channel Adapter — bridges Prismer Cloud IM to the Lumin agent.
 *
 * Subscribes to Cloud IM conversation events via SSE,
 * forwards incoming messages to the agent handler,
 * and sends responses back through the IM REST API.
 *
 * **Environment:**
 * - `PRISMER_IM_BASE_URL` — Cloud IM API base URL
 * - `PRISMER_IM_CONVERSATION_ID` — Conversation to listen on
 * - `PRISMER_IM_TOKEN` — Agent authentication token
 *
 * @module channels/cloud-im
 */

import type { ChannelAdapter, IncomingMessage } from './types.js';
import { createLogger } from '../log.js';

const log = createLogger('cloud-im');

export class CloudIMAdapter implements ChannelAdapter {
  readonly name = 'cloud-im';
  private baseUrl = '';
  private conversationId = '';
  private token = '';
  private handler: ((msg: IncomingMessage) => Promise<string>) | null = null;
  private running = false;
  private abortController: AbortController | null = null;

  async init(config: Record<string, string>): Promise<void> {
    this.baseUrl = config.PRISMER_IM_BASE_URL || '';
    this.conversationId = config.PRISMER_IM_CONVERSATION_ID || '';
    this.token = config.PRISMER_IM_TOKEN || '';

    if (!this.baseUrl) throw new Error('PRISMER_IM_BASE_URL is required');
    if (!this.conversationId) throw new Error('PRISMER_IM_CONVERSATION_ID is required');
    if (!this.token) throw new Error('PRISMER_IM_TOKEN is required');

    log.info('connecting', { baseUrl: this.baseUrl, conversationId: this.conversationId });

    // Start SSE listener
    this.running = true;
    this.listenSSE();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<string>): void {
    this.handler = handler;
  }

  async send(chatId: string, text: string): Promise<void> {
    const url = `${this.baseUrl}/api/im/messages/${chatId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        content: text,
        type: 'text',
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.warn('send failed', { status: res.status, body: errText.slice(0, 200) });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    log.info('stopped');
  }

  // ── Internal ──────────────────────────────────────

  private async listenSSE(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const url = `${this.baseUrl}/api/im/conversations/${this.conversationId}/events`;

        const res = await fetch(url, {
          headers: {
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${this.token}`,
          },
          signal: this.abortController.signal,
        });

        if (!res.ok) {
          log.warn('SSE connect failed', { status: res.status });
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        log.info('SSE connected');

        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';

        while (this.running) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events
          const events = buffer.split('\n\n');
          buffer = events.pop() || ''; // Last chunk may be incomplete

          for (const event of events) {
            if (!event.trim()) continue;
            await this.handleSSEEvent(event);
          }
        }
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('abort')) {
          log.warn('SSE error', { error: msg });
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  private async handleSSEEvent(raw: string): Promise<void> {
    // Parse SSE format: data: {...}
    const lines = raw.split('\n');
    let data = '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        data += line.slice(6);
      }
    }

    if (!data) return;

    try {
      const event = JSON.parse(data) as Record<string, unknown>;

      // Handle message.new events
      const type = event.type as string;
      if (type !== 'message.new') return;

      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      // Skip messages from self (agent)
      const senderType = (payload.sender as Record<string, unknown>)?.type;
      if (senderType === 'agent') return;

      const content = payload.content as string;
      if (!content) return;

      const sender = (payload.sender as Record<string, unknown>)?.id as string || 'user';
      log.debug('incoming message', { sender, preview: content.slice(0, 50) });

      if (!this.handler) return;

      try {
        const response = await this.handler({
          chatId: this.conversationId,
          text: content,
          sender,
          raw: event,
        });
        await this.send(this.conversationId, response);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('handler error', { error: errMsg });
      }
    } catch {
      // Not valid JSON — skip
    }
  }
}
