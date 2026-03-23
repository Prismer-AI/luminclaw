//! Session management — mirrors TypeScript `session.ts`.

use crate::provider::Message;
use dashmap::DashMap;
use serde::{Serialize, Deserialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directive {
    pub r#type: String,
    pub payload: serde_json::Value,
    pub timestamp: String,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub parent_id: Option<String>,
    pub messages: Vec<Message>,
    pub pending_directives: Vec<Directive>,
    pub compaction_summary: Option<String>,
    pub last_activity: u64,
}

impl Session {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            parent_id: None,
            messages: Vec::new(),
            pending_directives: Vec::new(),
            compaction_summary: None,
            last_activity: now_ms(),
        }
    }

    pub fn add_message(&mut self, msg: Message) {
        self.messages.push(msg);
        self.last_activity = now_ms();
    }

    /// Track a directive emitted during this session.
    pub fn add_pending_directive(&mut self, directive: Directive) {
        self.pending_directives.push(directive);
    }

    /// Drain all pending directives (returns and clears).
    pub fn drain_directives(&mut self) -> Vec<Directive> {
        std::mem::take(&mut self.pending_directives)
    }

    /// Build the full message list for an LLM call.
    /// User input should already be in `self.messages` (added by agent before calling this).
    pub fn build_messages(&self, system_prompt: &str) -> Vec<Message> {
        self.build_messages_with_memory(system_prompt, None)
    }

    /// Build messages with optional memory context appended to system prompt.
    pub fn build_messages_with_memory(&self, system_prompt: &str, memory_context: Option<&str>) -> Vec<Message> {
        let mut msgs = Vec::new();

        // System prompt (with memory context if present)
        let mut system = system_prompt.to_string();
        if let Some(mem) = memory_context {
            system.push_str(&format!("\n\n## Relevant Memory\n{mem}"));
        }
        msgs.push(Message::system(&system));

        // Compaction summary (if any)
        if let Some(summary) = &self.compaction_summary {
            msgs.push(Message::user(&format!("[Previous conversation summary]\n{summary}")));
            msgs.push(Message::assistant("Understood. I have the context from the previous conversation."));
        }

        // History (includes user input already)
        msgs.extend(self.messages.iter().cloned());

        msgs
    }

    /// Remove all messages from the session (for recovery after corruption).
    pub fn clear_history(&mut self) {
        self.messages.clear();
        self.compaction_summary = None;
        self.last_activity = now_ms();
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

    pub fn delete(&self, id: &str) {
        self.sessions.remove(id);
    }

    /// Remove sessions that have been idle longer than `max_idle_ms`.
    /// Returns the number of sessions removed.
    /// This can be called periodically (e.g. from a timer) to garbage-collect
    /// stale sessions — mirrors TS `SessionStore.startCleanup(maxIdleMs)`.
    pub fn cleanup_idle(&self, max_idle_ms: u64) -> usize {
        let now = now_ms();
        let mut removed = 0;
        self.sessions.retain(|_key, session| {
            let idle = now.saturating_sub(session.last_activity);
            if idle > max_idle_ms {
                removed += 1;
                false
            } else {
                true
            }
        });
        removed
    }

    pub fn size(&self) -> usize {
        self.sessions.len()
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── Session::new ──

    #[test]
    fn session_new_sets_fields_correctly() {
        let s = Session::new("sess-1");
        assert_eq!(s.id, "sess-1");
        assert!(s.parent_id.is_none());
        assert!(s.messages.is_empty());
        assert!(s.compaction_summary.is_none());
        assert!(s.last_activity > 0);
    }

    // ── add_message ──

    #[test]
    fn add_message_appends_and_updates_last_activity() {
        let mut s = Session::new("s1");
        let before = s.last_activity;

        s.add_message(Message::user("hello"));

        assert_eq!(s.messages.len(), 1);
        assert_eq!(s.messages[0].role, "user");
        assert_eq!(s.messages[0].text_content(), Some("hello"));
        assert!(s.last_activity >= before);
    }

    #[test]
    fn add_message_multiple() {
        let mut s = Session::new("s1");
        s.add_message(Message::user("first"));
        s.add_message(Message::assistant("second"));
        s.add_message(Message::user("third"));

        assert_eq!(s.messages.len(), 3);
        assert_eq!(s.messages[0].text_content(), Some("first"));
        assert_eq!(s.messages[1].text_content(), Some("second"));
        assert_eq!(s.messages[2].text_content(), Some("third"));
    }

    // ── build_messages ──

    #[test]
    fn build_messages_empty_session_just_system_prompt() {
        let s = Session::new("s1");
        let msgs = s.build_messages("You are an assistant.");

        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[0].text_content(), Some("You are an assistant."));
    }

    #[test]
    fn build_messages_with_history() {
        let mut s = Session::new("s1");
        s.add_message(Message::user("what is AI?"));
        s.add_message(Message::assistant("AI is artificial intelligence."));

        let msgs = s.build_messages("System prompt");

        assert_eq!(msgs.len(), 3); // system + 2 history
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[1].role, "user");
        assert_eq!(msgs[1].text_content(), Some("what is AI?"));
        assert_eq!(msgs[2].role, "assistant");
        assert_eq!(msgs[2].text_content(), Some("AI is artificial intelligence."));
    }

    #[test]
    fn build_messages_with_compaction_summary() {
        let mut s = Session::new("s1");
        s.compaction_summary = Some("Previous discussion about machine learning.".into());
        s.add_message(Message::user("continue"));

        let msgs = s.build_messages("System");

        // system + summary user + summary assistant + user
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[1].role, "user");
        assert!(msgs[1].text_content().unwrap().contains("[Previous conversation summary]"));
        assert!(msgs[1].text_content().unwrap().contains("Previous discussion about machine learning."));
        assert_eq!(msgs[2].role, "assistant");
        assert!(msgs[2].text_content().unwrap().contains("Understood"));
        assert_eq!(msgs[3].role, "user");
        assert_eq!(msgs[3].text_content(), Some("continue"));
    }

    #[test]
    fn build_messages_no_compaction_summary() {
        let mut s = Session::new("s1");
        s.add_message(Message::user("hello"));

        let msgs = s.build_messages("Prompt");
        // system + user, no compaction pair
        assert_eq!(msgs.len(), 2);
    }

    // ── create_child ──

    #[test]
    fn create_child_inherits_last_4_messages() {
        let mut parent = Session::new("parent");
        parent.add_message(Message::user("msg1"));
        parent.add_message(Message::assistant("resp1"));
        parent.add_message(Message::user("msg2"));
        parent.add_message(Message::assistant("resp2"));
        parent.add_message(Message::user("msg3"));

        let child = parent.create_child("latex-expert");

        // Should inherit last 4 of 5 messages
        assert_eq!(child.messages.len(), 4);
        assert_eq!(child.messages[0].text_content(), Some("resp1"));
        assert_eq!(child.messages[1].text_content(), Some("msg2"));
        assert_eq!(child.messages[2].text_content(), Some("resp2"));
        assert_eq!(child.messages[3].text_content(), Some("msg3"));
    }

    #[test]
    fn create_child_has_parent_id_set() {
        let parent = Session::new("parent-session");
        let child = parent.create_child("data-analyst");

        assert_eq!(child.parent_id.as_deref(), Some("parent-session"));
    }

    #[test]
    fn create_child_id_contains_parent_and_agent() {
        let parent = Session::new("parent");
        let child = parent.create_child("latex-expert");

        assert!(child.id.contains("parent"));
        assert!(child.id.contains("latex-expert"));
    }

    #[test]
    fn create_child_fewer_than_4_messages() {
        let mut parent = Session::new("parent");
        parent.add_message(Message::user("only one"));

        let child = parent.create_child("summarizer");
        assert_eq!(child.messages.len(), 1);
        assert_eq!(child.messages[0].text_content(), Some("only one"));
    }

    #[test]
    fn create_child_empty_parent() {
        let parent = Session::new("parent");
        let child = parent.create_child("compaction");
        assert!(child.messages.is_empty());
        assert_eq!(child.parent_id.as_deref(), Some("parent"));
    }

    // ── SessionStore ──

    #[test]
    fn session_store_get_or_create_creates_new() {
        let store = SessionStore::new();
        let s = store.get_or_create("new-session");
        assert_eq!(s.id, "new-session");
        assert!(s.messages.is_empty());
    }

    #[test]
    fn session_store_get_or_create_returns_existing() {
        let store = SessionStore::new();

        // Create and mutate
        let mut s1 = store.get_or_create("s1");
        s1.add_message(Message::user("hello"));
        store.update(s1);

        // Retrieve — should find the existing one with the message
        let s2 = store.get_or_create("s1");
        assert_eq!(s2.messages.len(), 1);
        assert_eq!(s2.messages[0].text_content(), Some("hello"));
    }

    #[test]
    fn session_store_update_persists_changes() {
        let store = SessionStore::new();

        let mut s = store.get_or_create("s1");
        s.add_message(Message::user("updated"));
        s.compaction_summary = Some("summary".into());
        store.update(s);

        let retrieved = store.get_or_create("s1");
        assert_eq!(retrieved.messages.len(), 1);
        assert_eq!(retrieved.compaction_summary.as_deref(), Some("summary"));
    }

    #[test]
    fn session_store_multiple_sessions() {
        let store = SessionStore::new();
        store.get_or_create("a");
        store.get_or_create("b");
        store.get_or_create("c");

        // All three should exist independently
        let a = store.get_or_create("a");
        let b = store.get_or_create("b");
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn session_store_default() {
        // SessionStore implements Default
        let store = SessionStore::default();
        let s = store.get_or_create("test");
        assert_eq!(s.id, "test");
    }

    // ── Additional tests for TS parity ──

    #[test]
    fn build_messages_orders_system_compaction_history() {
        let mut s = Session::new("s1");
        s.compaction_summary = Some("Summary of earlier conversation.".into());
        s.add_message(Message::user("question 1"));
        s.add_message(Message::assistant("answer 1"));
        s.add_message(Message::user("question 2"));

        let msgs = s.build_messages("You are a helpful assistant.");

        // Expected order: system, compaction user, compaction assistant, history...
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[0].text_content().unwrap(), "You are a helpful assistant.");

        assert_eq!(msgs[1].role, "user");
        assert!(msgs[1].text_content().unwrap().contains("[Previous conversation summary]"));
        assert!(msgs[1].text_content().unwrap().contains("Summary of earlier conversation."));

        assert_eq!(msgs[2].role, "assistant");
        assert!(msgs[2].text_content().unwrap().contains("Understood"));

        assert_eq!(msgs[3].role, "user");
        assert_eq!(msgs[3].text_content().unwrap(), "question 1");
        assert_eq!(msgs[4].role, "assistant");
        assert_eq!(msgs[4].text_content().unwrap(), "answer 1");
        assert_eq!(msgs[5].role, "user");
        assert_eq!(msgs[5].text_content().unwrap(), "question 2");

        // Total: system + 2 compaction + 3 history = 6
        assert_eq!(msgs.len(), 6);
    }

    #[test]
    fn session_stress_test_100_messages() {
        let mut s = Session::new("stress");
        for i in 0..100 {
            if i % 2 == 0 {
                s.add_message(Message::user(&format!("user message {i}")));
            } else {
                s.add_message(Message::assistant(&format!("assistant reply {i}")));
            }
        }
        assert_eq!(s.messages.len(), 100);

        let msgs = s.build_messages("System prompt");
        // system + 100 history
        assert_eq!(msgs.len(), 101);
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[1].role, "user");
        assert_eq!(msgs[1].text_content().unwrap(), "user message 0");
        assert_eq!(msgs[100].role, "assistant");
        assert_eq!(msgs[100].text_content().unwrap(), "assistant reply 99");
    }

    #[test]
    fn child_session_has_independent_message_history() {
        let mut parent = Session::new("parent");
        parent.add_message(Message::user("hello"));

        let mut child = parent.create_child("data-analyst");
        child.add_message(Message::user("child-only message"));

        // Parent should not see child's message
        assert_eq!(parent.messages.len(), 1);
        // Child has 1 inherited + 1 new
        assert_eq!(child.messages.len(), 2);
    }

    // ── clear_history ──

    #[test]
    fn clear_history_removes_all_messages() {
        let mut s = Session::new("s1");
        s.add_message(Message::user("hello"));
        s.add_message(Message::assistant("hi"));
        s.compaction_summary = Some("summary".into());

        s.clear_history();

        assert!(s.messages.is_empty());
        assert!(s.compaction_summary.is_none());
        assert!(s.last_activity > 0);
    }

    #[test]
    fn clear_history_on_empty_session() {
        let mut s = Session::new("s1");
        s.clear_history();
        assert!(s.messages.is_empty());
        assert!(s.compaction_summary.is_none());
    }

    // ── SessionStore::cleanup_idle ──

    #[test]
    fn cleanup_idle_removes_old_sessions() {
        let store = SessionStore::new();
        let mut s = store.get_or_create("old-session");
        // Set last_activity to 0 (far in the past)
        s.last_activity = 0;
        store.update(s);

        let _ = store.get_or_create("new-session");
        // new-session has current timestamp

        assert_eq!(store.size(), 2);
        let removed = store.cleanup_idle(1_000); // 1 second idle max
        // old-session should be removed, new-session kept
        assert_eq!(removed, 1);
        assert_eq!(store.size(), 1);
    }

    #[test]
    fn cleanup_idle_keeps_active_sessions() {
        let store = SessionStore::new();
        let _ = store.get_or_create("active-1");
        let _ = store.get_or_create("active-2");

        let removed = store.cleanup_idle(1_800_000); // 30 min
        assert_eq!(removed, 0);
        assert_eq!(store.size(), 2);
    }

    // ── SessionStore::delete + size ──

    #[test]
    fn session_store_delete() {
        let store = SessionStore::new();
        let _ = store.get_or_create("s1");
        let _ = store.get_or_create("s2");
        assert_eq!(store.size(), 2);
        store.delete("s1");
        assert_eq!(store.size(), 1);
    }
}
