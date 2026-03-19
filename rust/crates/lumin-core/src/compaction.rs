//! Context compaction — mirrors TypeScript `compaction.ts`.
//! When context exceeds budget, flush to memory and LLM-summarize.

use crate::provider::{Provider, ChatRequest, Message};
use crate::memory::MemoryStore;
use tracing::{info, warn};

/// Truncate oldest messages to fit within budget, keeping system + recent N.
pub fn truncate_oldest_turns(messages: &mut Vec<Message>, max_chars: usize, keep_recent: usize) -> usize {
    let total: usize = messages.iter()
        .map(|m| m.content.as_deref().unwrap_or("").len())
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
pub fn memory_flush_before_compaction(messages: &[Message], memory: &MemoryStore) {
    for msg in messages {
        let content = msg.content.as_deref().unwrap_or("");
        // Extract file paths
        for cap in content.match_indices("/workspace/") {
            let start = cap.0;
            let end = content[start..].find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')')
                .map(|e| start + e)
                .unwrap_or(content.len().min(start + 100));
            let path = &content[start..end];
            let _ = memory.store(&format!("File referenced: {path}"), &["file", "compaction"]);
        }
    }
}

/// LLM-summarize dropped messages into a compact summary.
pub async fn summarize_dropped(
    dropped: &[Message],
    provider: &dyn Provider,
) -> Result<String, String> {
    if dropped.is_empty() { return Ok(String::new()); }

    let content: String = dropped.iter()
        .filter_map(|m| m.content.as_deref())
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
