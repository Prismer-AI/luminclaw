//! EventBus — mirrors TypeScript `sse.ts`.

use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Debug, Clone)]
pub struct AgentEvent {
    pub event_type: String,
    pub data: Value,
}

pub struct EventBus {
    tx: broadcast::Sender<AgentEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn publish(&self, event: AgentEvent) {
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self { Self::new(1000) }
}
