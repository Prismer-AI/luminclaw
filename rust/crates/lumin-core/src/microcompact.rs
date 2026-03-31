//! Microcompact — zero-LLM-cost incremental context compression.
//! Mirrors TypeScript `microcompact.ts`.

use crate::provider::{Message, MessageContent};

/// Marker text replacing cleared tool results.
pub const CLEARED_MARKER: &str = "[Old tool result cleared]";

/// Clear old tool result contents, keeping the most recent `keep_recent` intact.
/// Mutates messages in-place for efficiency.
pub fn microcompact(messages: &mut [Message], keep_recent: usize) {
    let tool_indices: Vec<usize> = messages.iter().enumerate()
        .filter(|(_, m)| {
            m.role == "tool"
                && m.text_content().map_or(false, |c| c != CLEARED_MARKER && !c.is_empty())
        })
        .map(|(i, _)| i)
        .collect();

    if tool_indices.len() <= keep_recent {
        return;
    }

    let to_clear = &tool_indices[..tool_indices.len() - keep_recent];
    for &idx in to_clear {
        messages[idx].content = Some(MessageContent::Text(CLEARED_MARKER.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clears_old_tool_results_keeping_recent() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::user("q"),
            Message::tool_result("t1", "result-1-long-content"),
            Message::tool_result("t2", "result-2-long-content"),
            Message::tool_result("t3", "result-3-long-content"),
            Message::tool_result("t4", "result-4-long-content"),
            Message::tool_result("t5", "result-5-long-content"),
        ];
        microcompact(&mut msgs, 2);
        assert_eq!(msgs[2].text_content(), Some(CLEARED_MARKER));
        assert_eq!(msgs[3].text_content(), Some(CLEARED_MARKER));
        assert_eq!(msgs[4].text_content(), Some(CLEARED_MARKER));
        assert_eq!(msgs[5].text_content(), Some("result-4-long-content"));
        assert_eq!(msgs[6].text_content(), Some("result-5-long-content"));
    }

    #[test]
    fn no_op_when_fewer_than_keep_recent() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::tool_result("t1", "result-1"),
        ];
        microcompact(&mut msgs, 5);
        assert_eq!(msgs[1].text_content(), Some("result-1"));
    }

    #[test]
    fn skips_already_cleared() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::tool_result("t1", CLEARED_MARKER),
            Message::tool_result("t2", "result-2"),
            Message::tool_result("t3", "result-3"),
        ];
        microcompact(&mut msgs, 1);
        assert_eq!(msgs[2].text_content(), Some(CLEARED_MARKER));
        assert_eq!(msgs[3].text_content(), Some("result-3"));
    }
}
