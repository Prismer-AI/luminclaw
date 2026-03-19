//! Session management — mirrors TypeScript `session.ts`.

use crate::provider::Message;
use dashmap::DashMap;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub parent_id: Option<String>,
    pub messages: Vec<Message>,
    pub compaction_summary: Option<String>,
    pub last_activity: u64,
}

impl Session {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            parent_id: None,
            messages: Vec::new(),
            compaction_summary: None,
            last_activity: now_ms(),
        }
    }

    pub fn add_message(&mut self, msg: Message) {
        self.messages.push(msg);
        self.last_activity = now_ms();
    }

    /// Build the full message list for an LLM call.
    pub fn build_messages(&self, user_input: &str, system_prompt: &str) -> Vec<Message> {
        let mut msgs = Vec::new();

        // System prompt
        msgs.push(Message::system(system_prompt));

        // Compaction summary (if any)
        if let Some(summary) = &self.compaction_summary {
            msgs.push(Message::user(&format!("[Previous conversation summary]\n{summary}")));
            msgs.push(Message::assistant("Understood. I have the context from the previous conversation."));
        }

        // History
        msgs.extend(self.messages.iter().cloned());

        // Current input
        msgs.push(Message::user(user_input));

        msgs
    }

    /// Create a child session for sub-agent delegation.
    pub fn create_child(&self, sub_agent_id: &str) -> Session {
        let child_id = format!("{}:{}:{}", self.id, sub_agent_id, now_ms());
        let mut child = Session::new(&child_id);
        child.parent_id = Some(self.id.clone());

        // Inherit last 4 messages for continuity
        let start = self.messages.len().saturating_sub(4);
        child.messages = self.messages[start..].to_vec();

        child
    }
}

pub struct SessionStore {
    sessions: Arc<DashMap<String, Session>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self { sessions: Arc::new(DashMap::new()) }
    }

    pub fn get_or_create(&self, id: &str) -> Session {
        self.sessions
            .entry(id.to_string())
            .or_insert_with(|| Session::new(id))
            .clone()
    }

    pub fn update(&self, session: Session) {
        self.sessions.insert(session.id.clone(), session);
    }
}

impl Default for SessionStore {
    fn default() -> Self { Self::new() }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
