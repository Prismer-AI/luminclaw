//! Channel adapters — mirrors TypeScript `channels/`.
//! Telegram bot (long-polling) and Cloud IM (SSE) adapters.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Incoming message from any channel.
#[derive(Debug, Clone)]
pub struct IncomingMessage {
    pub chat_id: String,
    pub text: String,
    pub sender_id: String,
    pub channel: String,
}

/// Message handler callback type.
pub type MessageHandler = Arc<
    dyn Fn(IncomingMessage) -> Pin<Box<dyn Future<Output = String> + Send>> + Send + Sync
>;

/// Channel adapter trait — all messaging channels implement this.
#[async_trait::async_trait]
pub trait ChannelAdapter: Send + Sync {
    fn name(&self) -> &str;
    async fn start(&self, handler: MessageHandler) -> Result<(), String>;
    async fn stop(&self);
}

/// Channel manager — auto-detects available channels from env vars.
pub struct ChannelManager {
    channels: Vec<Box<dyn ChannelAdapter>>,
    handler: Option<MessageHandler>,
}

impl ChannelManager {
    pub fn new() -> Self {
        Self { channels: Vec::new(), handler: None }
    }

    /// Set the message handler that channels forward messages to.
    pub fn set_handler(&mut self, handler: MessageHandler) {
        self.handler = Some(handler);
    }

    /// Register a channel adapter.
    pub fn register(&mut self, channel: Box<dyn ChannelAdapter>) {
        self.channels.push(channel);
    }

    /// Auto-detect channels from env vars and register them.
    pub fn auto_detect(&mut self) {
        // Telegram: TELEGRAM_BOT_TOKEN
        if std::env::var("TELEGRAM_BOT_TOKEN").is_ok() {
            tracing::info!("telegram channel detected");
            // Would register TelegramAdapter here
        }
        // Cloud IM: PRISMER_IM_BASE_URL
        if std::env::var("PRISMER_IM_BASE_URL").is_ok() {
            tracing::info!("cloud-im channel detected");
            // Would register CloudIMAdapter here
        }
        if self.channels.is_empty() {
            tracing::info!("no channels configured");
        }
    }

    /// Start all registered channels.
    pub async fn start_all(&self) -> Result<(), String> {
        let handler = self.handler.as_ref().ok_or("no handler set")?;
        for ch in &self.channels {
            ch.start(handler.clone()).await?;
        }
        Ok(())
    }

    /// Stop all channels.
    pub async fn stop_all(&self) {
        for ch in &self.channels {
            ch.stop().await;
        }
    }
}

impl Default for ChannelManager {
    fn default() -> Self { Self::new() }
}
