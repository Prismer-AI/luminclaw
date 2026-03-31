//! Lightweight token estimation — mirrors TypeScript `tokens.ts`.
//!
//! Rules of thumb:
//!   - English/Latin text: ~4 characters per token
//!   - CJK (Chinese/Japanese/Korean): ~2 characters per token
//!   - Overhead per message: ~4 tokens (role, delimiters)
//!   - Final estimate padded by 1.33x for safety

/// Estimate token count for a text string.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() { return 0; }
    let cjk_count = text.chars().filter(|&c| {
        ('\u{4e00}'..='\u{9fff}').contains(&c)
            || ('\u{3040}'..='\u{30ff}').contains(&c)
            || ('\u{3400}'..='\u{4dbf}').contains(&c)
            || ('\u{ac00}'..='\u{d7af}').contains(&c)
    }).count();
    let non_cjk = text.len().saturating_sub(cjk_count);
    ((non_cjk as f64 / 4.0 + cjk_count as f64 / 2.0) * 1.33).ceil() as usize
}

/// Estimate total tokens for a conversation message array.
pub fn estimate_message_tokens(messages: &[crate::provider::Message]) -> usize {
    let mut total = 0usize;
    for msg in messages {
        total += 4; // role + delimiters overhead
        if let Some(ref content) = msg.content {
            total += estimate_tokens(content.as_text());
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_text() {
        let t = estimate_tokens("Hello, world!");
        assert!(t > 0 && t < 10, "got {t}");
    }

    #[test]
    fn cjk_text() {
        let t = estimate_tokens("你好世界");
        assert!(t >= 2, "got {t}");
    }

    #[test]
    fn empty_string() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn message_array_tokens() {
        let msgs = vec![
            crate::provider::Message::system("You are helpful."),
            crate::provider::Message::user("Hello!"),
        ];
        let t = estimate_message_tokens(&msgs);
        assert!(t > 8, "got {t}"); // at least 4+4 overhead per message
    }
}
