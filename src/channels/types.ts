/**
 * Channel Plugin types — lightweight adapter interface for messaging channels.
 *
 * Each {@link ChannelAdapter} bridges a messaging platform
 * (Telegram, Cloud IM, etc.) to the Lumin agent runtime via a
 * simple `onMessage` handler pattern.
 *
 * @module channels/types
 */

export interface IncomingMessage {
  /** Platform-specific chat/conversation ID */
  chatId: string;
  /** Message text content */
  text: string;
  /** Sender identifier */
  sender: string;
  /** Optional: raw platform-specific message object */
  raw?: unknown;
}

export interface ChannelAdapter {
  /** Unique channel name (e.g., 'telegram', 'cloud-im') */
  readonly name: string;

  /** Initialize the adapter with configuration */
  init(config: Record<string, string>): Promise<void>;

  /** Register a message handler — called when a message arrives from the channel */
  onMessage(handler: (msg: IncomingMessage) => Promise<string>): void;

  /** Send a text message to a specific chat */
  send(chatId: string, text: string): Promise<void>;

  /** Gracefully shut down the adapter */
  stop(): Promise<void>;
}
