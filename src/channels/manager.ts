/**
 * Channel Manager — discovers and starts channel adapters from environment config.
 *
 * Auto-detects available channels based on environment variables:
 *   - `TELEGRAM_BOT_TOKEN` → starts {@link TelegramAdapter}
 *   - `PRISMER_IM_BASE_URL` + `PRISMER_IM_CONVERSATION_ID` + `PRISMER_IM_TOKEN`
 *     → starts {@link CloudIMAdapter}
 *
 * @module channels/manager
 */

import type { ChannelAdapter, IncomingMessage } from './types.js';
import { TelegramAdapter } from './telegram.js';
import { CloudIMAdapter } from './cloud-im.js';
import { createLogger } from '../log.js';

const log = createLogger('channels');

/**
 * Discovers and manages messaging channel adapters.
 * Call {@link startAll} to auto-detect channels from env vars,
 * and {@link stopAll} for graceful shutdown.
 */
export class ChannelManager {
  private adapters: ChannelAdapter[] = [];
  private handler: ((msg: IncomingMessage) => Promise<string>) | null = null;

  /** Set the message handler that all channels will use */
  setHandler(handler: (msg: IncomingMessage) => Promise<string>): void {
    this.handler = handler;
    // Apply to already-started adapters
    for (const adapter of this.adapters) {
      adapter.onMessage(handler);
    }
  }

  /** Discover and start all available channels from environment config */
  async startAll(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Promise<void> {
    // ── Telegram ──────────────────────────────────
    if (env.TELEGRAM_BOT_TOKEN) {
      try {
        const adapter = new TelegramAdapter();
        await adapter.init({
          TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
          TELEGRAM_ALLOWED_CHATS: env.TELEGRAM_ALLOWED_CHATS || '',
        });
        if (this.handler) adapter.onMessage(this.handler);
        this.adapters.push(adapter);
        log.info('Telegram channel started');
      } catch (err) {
        log.error('Telegram init failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Cloud IM ──────────────────────────────────
    if (env.PRISMER_IM_BASE_URL && env.PRISMER_IM_CONVERSATION_ID && env.PRISMER_IM_TOKEN) {
      try {
        const adapter = new CloudIMAdapter();
        await adapter.init({
          PRISMER_IM_BASE_URL: env.PRISMER_IM_BASE_URL,
          PRISMER_IM_CONVERSATION_ID: env.PRISMER_IM_CONVERSATION_ID,
          PRISMER_IM_TOKEN: env.PRISMER_IM_TOKEN,
        });
        if (this.handler) adapter.onMessage(this.handler);
        this.adapters.push(adapter);
        log.info('Cloud IM channel started');
      } catch (err) {
        log.error('Cloud IM init failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (this.adapters.length === 0) {
      log.info('no channels configured');
    } else {
      log.info('channels active', { count: this.adapters.length });
    }
  }

  /** Stop all channels */
  async stopAll(): Promise<void> {
    for (const adapter of this.adapters) {
      try {
        await adapter.stop();
      } catch (err) {
        log.error('error stopping channel', { channel: adapter.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.adapters = [];
  }

  /** Get list of active channel names */
  get activeChannels(): string[] {
    return this.adapters.map(a => a.name);
  }
}
