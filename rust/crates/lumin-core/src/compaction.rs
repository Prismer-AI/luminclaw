//! Context compaction — mirrors TypeScript `compaction.ts`.
//! When context exceeds budget, flush to memory and LLM-summarize.

use crate::provider::{Provider, ChatRequest, Message};
use crate::memory::MemoryStore;
use tracing::info;

/// Truncate oldest messages to fit within budget, keeping system + recent N.
pub fn truncate_oldest_turns(messages: &mut Vec<Message>, max_chars: usize, keep_recent: usize) -> usize {
    let total: usize = messages.iter()
        .map(|m| m.text_content().unwrap_or("").len())
        .sum();

    if total <= max_chars { return 0; }

    // Keep system (first) + last N messages
    if messages.len() <= keep_recent + 1 { return 0; }

    let to_remove = messages.len() - keep_recent - 1;
    let removed: Vec<Message> = messages.drain(1..=to_remove).collect();

    info!(removed = removed.len(), "truncated oldest turns");
    removed.len()
}

/// Flush extractable facts from messages to memory before compaction.
///
/// Mirrors TS `memoryFlushBeforeCompaction()`:
/// - Extracts file paths (already done)
/// - Extracts decisions/choices mentioned
/// - Writes to MemoryStore
pub fn memory_flush_before_compaction(messages: &[Message], memory: &MemoryStore) {
    for msg in messages {
        let content = msg.text_content().unwrap_or("");
        if content.is_empty() { continue; }

        // Extract file paths
        for cap in content.match_indices("/workspace/") {
            let start = cap.0;
            let end = content[start..].find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')')
                .map(|e| start + e)
                .unwrap_or(content.len().min(start + 100));
            let path = &content[start..end];
            let _ = memory.store(&format!("File referenced: {path}"), &["file", "compaction"]);
        }

        // Extract decisions/choices (lines starting with decision-like keywords)
        let lower = content.to_lowercase();
        let decision_markers = ["decided to ", "chose ", "decision:", "we'll use ", "going with ", "selected "];
        for marker in &decision_markers {
            if let Some(pos) = lower.find(marker) {
                // Extract the sentence containing the decision
                let start = content[..pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
                let end = content[pos..].find('\n').map(|e| pos + e).unwrap_or(content.len().min(pos + 200));
                let decision = content[start..end].trim();
                if !decision.is_empty() {
                    let _ = memory.store(&format!("Decision: {decision}"), &["decision", "compaction"]);
                }
            }
        }
    }
}

/// LLM-based memory flush — calls the provider to extract facts worth remembering.
/// Mirrors TS `memoryFlushBeforeCompaction()` with LLM extraction.
/// Silent, non-fatal.
pub async fn memory_flush_with_llm(
    provider: &dyn Provider,
    dropped_messages: &[Message],
    memory: &MemoryStore,
    model: Option<&str>,
) -> Result<(), String> {
    let serialized = serialize_messages(dropped_messages);
    let input = &serialized[..serialized.len().min(8000)];

    let response = provider.chat(ChatRequest {
        messages: vec![
            Message::system(MEMORY_FLUSH_PROMPT),
            Message::user(input),
        ],
        tools: None,
        model: model.map(|s| s.to_string()),
        max_tokens: Some(500),
        stream: false,
        temperature: None,
        thinking_level: None,
    }).await.map_err(|e| e.to_string())?;

    let text = response.text.trim().to_string();
    if !text.is_empty() && text != "NO_REPLY" {
        let _ = memory.store(&text, &["auto-flush", "compaction"]);
    }
    Ok(())
}

const MEMORY_FLUSH_PROMPT: &str = "You are a memory extraction agent. Given a conversation excerpt that is about to be discarded, \
extract ONLY facts worth remembering long-term: key decisions, important file paths, architecture choices, \
user preferences, and action items. If nothing is worth remembering, reply with exactly \"NO_REPLY\". \
Be extremely concise — bullet points only.";

/// Serialize messages into a human-readable format for compaction input.
fn serialize_messages(messages: &[Message]) -> String {
    let mut parts = Vec::new();
    for msg in messages {
        let role = msg.role.to_uppercase();
        let content = msg.text_content().unwrap_or("");
        let content = &content[..content.len().min(3000)];
        if msg.role == "tool" {
            parts.push(format!("[TOOL RESULT] {}", &content[..content.len().min(500)]));
        } else {
            parts.push(format!("[{role}] {content}"));
        }
    }
    parts.join("\n\n")
}

/// LLM-summarize dropped messages into a compact summary.
pub async fn summarize_dropped(
    dropped: &[Message],
    provider: &dyn Provider,
) -> Result<String, String> {
    if dropped.is_empty() { return Ok(String::new()); }

    let content: String = dropped.iter()
        .filter_map(|m| m.text_content())
        .take(20) // limit input
        .collect::<Vec<_>>()
        .join("\n---\n");

    let response = provider.chat(ChatRequest {
        messages: vec![
            Message::system("Summarize the following conversation excerpt into key facts, decisions, and action items. Be concise (max 500 chars). Preserve file paths and code snippets."),
            Message::user(&content[..content.len().min(8000)]),
        ],
        tools: None,
        model: None,
        max_tokens: Some(200),
        stream: false,
        temperature: None,
        thinking_level: None,
    }).await.map_err(|e| e.to_string())?;

    Ok(response.text)
}

/// Repair orphaned tool results after truncation.
/// If a tool message appears without its preceding assistant tool_call, remove it.
pub fn repair_orphaned_tool_results(messages: &mut Vec<Message>) {
    let mut i = 1; // skip system
    while i < messages.len() {
        if messages[i].role == "tool" {
            // Check if previous message is assistant with tool_calls
            let has_parent = i > 0 && messages[i - 1].role == "assistant"
                && messages[i - 1].tool_calls.is_some();
            if !has_parent {
                messages.remove(i);
                continue;
            }
        }
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_does_nothing_when_under_budget() {
        let mut msgs = vec![
            Message::system("system prompt"),
            Message::user("hello"),
            Message::assistant("hi there"),
        ];
        let removed = truncate_oldest_turns(&mut msgs, 10000, 2);
        assert_eq!(removed, 0);
        assert_eq!(msgs.len(), 3);
    }

    #[test]
    fn truncate_removes_oldest_messages_when_over_budget() {
        let mut msgs = vec![
            Message::system("sys"),                       // 3 chars
            Message::user(&"A".repeat(100)),              // 100 chars
            Message::user(&"B".repeat(100)),              // 100 chars
            Message::user(&"C".repeat(100)),              // 100 chars
            Message::assistant("latest"),                  // 6 chars
        ];
        // Total = 3 + 100 + 100 + 100 + 6 = 309 chars, budget = 200, keep_recent = 2
        let removed = truncate_oldest_turns(&mut msgs, 200, 2);
        assert_eq!(removed, 2);
        // Should keep: system, C(100), latest(6)
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "system");
        assert!(msgs[1].text_content().unwrap().starts_with("CCC"));
        assert_eq!(msgs[2].text_content().unwrap(), "latest");
    }

    #[test]
    fn truncate_always_keeps_system_message() {
        let mut msgs = vec![
            Message::system("important system prompt"),
            Message::user(&"X".repeat(500)),
            Message::user(&"Y".repeat(500)),
            Message::assistant("response"),
        ];
        let removed = truncate_oldest_turns(&mut msgs, 100, 1);
        assert!(removed > 0);
        // System message must always be first
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[0].text_content().unwrap(), "important system prompt");
    }

    #[test]
    fn truncate_keeps_recent_n_messages() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::user("old1"),
            Message::user("old2"),
            Message::user("recent1"),
            Message::assistant("recent2"),
            Message::user("recent3"),
        ];
        // Total > budget, keep_recent = 3
        let removed = truncate_oldest_turns(&mut msgs, 1, 3);
        assert_eq!(removed, 2);
        assert_eq!(msgs.len(), 4); // system + 3 recent
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[1].text_content().unwrap(), "recent1");
        assert_eq!(msgs[2].text_content().unwrap(), "recent2");
        assert_eq!(msgs[3].text_content().unwrap(), "recent3");
    }

    #[test]
    fn repair_removes_orphaned_tool_messages() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::user("hello"),
            // Orphaned tool result — no preceding assistant with tool_calls
            Message::tool_result("call_1", "tool output"),
            Message::assistant("response"),
        ];
        repair_orphaned_tool_results(&mut msgs);
        assert_eq!(msgs.len(), 3);
        // The tool message should be removed
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[1].role, "user");
        assert_eq!(msgs[2].role, "assistant");
    }

    #[test]
    fn repair_keeps_valid_tool_messages() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::user("run bash"),
            Message::assistant_with_tools(
                vec![serde_json::json!({"id": "call_1", "type": "function", "function": {"name": "bash", "arguments": "{\"cmd\":\"ls\"}"}})],
                None,
            ),
            Message::tool_result("call_1", "file1.txt\nfile2.txt"),
            Message::assistant("I found two files."),
        ];
        repair_orphaned_tool_results(&mut msgs);
        assert_eq!(msgs.len(), 5); // nothing removed
        assert_eq!(msgs[2].role, "assistant");
        assert!(msgs[2].tool_calls.is_some());
        assert_eq!(msgs[3].role, "tool");
        assert_eq!(msgs[3].text_content().unwrap(), "file1.txt\nfile2.txt");
    }

    // ── Additional tests for TS parity ──

    #[test]
    fn truncate_with_exactly_budget_chars_no_truncation() {
        let mut msgs = vec![
            Message::system("sys"),        // 3
            Message::user("hello"),         // 5
            Message::assistant("world"),    // 5
        ];
        // Total = 13, budget = 13 -> should not truncate
        let removed = truncate_oldest_turns(&mut msgs, 13, 2);
        assert_eq!(removed, 0);
        assert_eq!(msgs.len(), 3);
    }

    #[test]
    fn truncate_removes_middle_messages_keeps_system_and_recent() {
        let mut msgs = vec![
            Message::system("system prompt"),
            Message::user("old message 1"),
            Message::assistant("old reply 1"),
            Message::user("old message 2"),
            Message::assistant("old reply 2"),
            Message::user("recent question"),
            Message::assistant("recent answer"),
        ];
        // Force truncation: budget = 1 (very small), keep_recent = 2
        let removed = truncate_oldest_turns(&mut msgs, 1, 2);
        assert_eq!(removed, 4);
        assert_eq!(msgs.len(), 3); // system + 2 recent
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[0].text_content().unwrap(), "system prompt");
        assert_eq!(msgs[1].text_content().unwrap(), "recent question");
        assert_eq!(msgs[2].text_content().unwrap(), "recent answer");
    }

    #[test]
    fn repair_keeps_assistant_messages_without_tool_calls() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::user("hello"),
            Message::assistant("just a normal reply"),
            Message::user("another question"),
            Message::assistant("another reply"),
        ];
        repair_orphaned_tool_results(&mut msgs);
        // Nothing should be removed — no tool messages at all
        assert_eq!(msgs.len(), 5);
        assert_eq!(msgs[2].role, "assistant");
        assert_eq!(msgs[2].text_content().unwrap(), "just a normal reply");
    }

    #[test]
    fn repair_removes_multiple_orphaned_tool_results() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::tool_result("orphan-1", "result 1"),
            Message::user("hello"),
            Message::tool_result("orphan-2", "result 2"),
            Message::assistant("reply"),
        ];
        repair_orphaned_tool_results(&mut msgs);
        // Both orphans should be removed
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "system");
        assert_eq!(msgs[1].role, "user");
        assert_eq!(msgs[2].role, "assistant");
    }
}
