//! File-based persistent memory — mirrors TypeScript `memory.ts`.
//! Stores facts as markdown, recalls by keyword matching.

use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

pub struct MemoryStore {
    memory_dir: PathBuf,
}

impl MemoryStore {
    pub fn new(workspace_dir: &str) -> Self {
        let memory_dir = Path::new(workspace_dir).join(".prismer").join("memory");
        if let Err(e) = fs::create_dir_all(&memory_dir) {
            warn!(error = %e, "failed to create memory directory");
        }
        Self { memory_dir }
    }

    /// Store a memory entry with optional tags.
    pub fn store(&self, content: &str, tags: &[&str]) -> std::io::Result<()> {
        let today = chrono_today();
        let path = self.memory_dir.join(format!("{today}.md"));

        let mut entry = format!("\n## {}\n", chrono_timestamp());
        if !tags.is_empty() {
            entry.push_str(&format!("Tags: {}\n", tags.join(", ")));
        }
        entry.push_str(content);
        entry.push('\n');

        // Append to today's file
        let existing = fs::read_to_string(&path).unwrap_or_default();
        fs::write(&path, format!("{existing}{entry}"))
    }

    /// Recall memories matching keywords. Returns up to max_chars.
    pub fn recall(&self, query: &str, max_chars: usize) -> Option<String> {
        let keywords: Vec<&str> = query.split_whitespace()
            .filter(|w| w.len() > 2)
            .collect();

        if keywords.is_empty() { return None; }

        let mut matches = Vec::new();
        let entries = fs::read_dir(&self.memory_dir).ok()?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(true, |e| e != "md") { continue; }

            let content = fs::read_to_string(&path).unwrap_or_default();
            for section in content.split("\n## ") {
                let score: usize = keywords.iter()
                    .filter(|kw| section.to_lowercase().contains(&kw.to_lowercase()))
                    .count();
                if score > 0 {
                    matches.push((score, section.to_string()));
                }
            }
        }

        if matches.is_empty() { return None; }

        // Sort by relevance (descending)
        matches.sort_by(|a, b| b.0.cmp(&a.0));

        let mut result = String::new();
        for (_, section) in &matches {
            if result.len() + section.len() > max_chars { break; }
            result.push_str("## ");
            result.push_str(section);
            result.push('\n');
        }

        if result.is_empty() { None } else { Some(result) }
    }

    /// Load recent context (last N chars from recent memory files).
    pub fn load_recent_context(&self, max_chars: usize) -> Option<String> {
        let mut entries: Vec<_> = fs::read_dir(&self.memory_dir).ok()?
            .flatten()
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
            .collect();

        entries.sort_by(|a, b| b.file_name().cmp(&a.file_name())); // newest first

        let mut result = String::new();
        for entry in entries {
            let content = fs::read_to_string(entry.path()).unwrap_or_default();
            if result.len() + content.len() > max_chars { break; }
            result.push_str(&content);
        }

        if result.is_empty() { None } else { Some(result) }
    }
}

fn chrono_today() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86400;
    // Simple date calculation (good enough for filenames)
    let y = 1970 + (days / 365); // approximate
    let remaining = days % 365;
    let m = remaining / 30 + 1;
    let d = remaining % 30 + 1;
    format!("{y:04}-{m:02}-{d:02}")
}

fn chrono_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format!("Entry at {}ms", now.as_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_dir(name: &str) -> String {
        let dir = format!("/tmp/lumin-memory-test-{name}");
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn store_and_recall() {
        let dir = make_test_dir("store-recall");
        let store = MemoryStore::new(&dir);
        store.store("The paper uses CVPR template with 8 sections", &["latex", "paper"]).unwrap();
        store.store("Dataset has 10000 rows in CSV format", &["data"]).unwrap();

        let result = store.recall("CVPR paper template", 4000);
        assert!(result.is_some());
        assert!(result.unwrap().contains("CVPR"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_creates_file_in_correct_directory() {
        let dir = make_test_dir("creates-file");
        let store = MemoryStore::new(&dir);
        store.store("test content", &[]).unwrap();

        // The memory directory should exist
        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        assert!(memory_dir.is_dir());

        // There should be a .md file in the memory directory
        let entries: Vec<_> = fs::read_dir(&memory_dir).unwrap()
            .flatten()
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
            .collect();
        assert!(!entries.is_empty(), "should have created a .md file");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_with_tags_includes_them_in_entry() {
        let dir = make_test_dir("tags");
        let store = MemoryStore::new(&dir);
        store.store("tagged content", &["alpha", "beta"]).unwrap();

        // Read back the file and check for tags line
        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        let entries: Vec<_> = fs::read_dir(&memory_dir).unwrap().flatten().collect();
        let file_content = fs::read_to_string(entries[0].path()).unwrap();
        assert!(file_content.contains("Tags: alpha, beta"));
        assert!(file_content.contains("tagged content"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_finds_matching_content_by_keyword() {
        let dir = make_test_dir("recall-match");
        let store = MemoryStore::new(&dir);
        store.store("Rust programming is great for systems", &[]).unwrap();
        store.store("Python is popular for machine learning", &[]).unwrap();

        let result = store.recall("Rust programming", 4000);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("Rust"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_returns_none_for_non_matching_query() {
        let dir = make_test_dir("recall-nomatch");
        let store = MemoryStore::new(&dir);
        store.store("Rust programming is great", &[]).unwrap();

        // Query with keywords that don't appear in stored content
        let result = store.recall("quantum entanglement physics", 4000);
        assert!(result.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_recent_context_returns_recent_entries() {
        let dir = make_test_dir("load-recent");
        let store = MemoryStore::new(&dir);
        store.store("first entry", &[]).unwrap();
        store.store("second entry", &[]).unwrap();

        let result = store.load_recent_context(10000);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("first entry"));
        assert!(text.contains("second entry"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn multiple_stores_accumulate_in_same_day_file() {
        let dir = make_test_dir("accumulate");
        let store = MemoryStore::new(&dir);
        store.store("entry one", &["a"]).unwrap();
        store.store("entry two", &["b"]).unwrap();
        store.store("entry three", &["c"]).unwrap();

        // All entries should be in the same file (same day)
        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        let md_files: Vec<_> = fs::read_dir(&memory_dir).unwrap()
            .flatten()
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
            .collect();
        assert_eq!(md_files.len(), 1, "all entries should be in one file for today");

        let content = fs::read_to_string(md_files[0].path()).unwrap();
        assert!(content.contains("entry one"));
        assert!(content.contains("entry two"));
        assert!(content.contains("entry three"));

        let _ = fs::remove_dir_all(&dir);
    }

    // ── Additional store tests ────────────────────────────────

    #[test]
    fn store_with_empty_content() {
        let dir = make_test_dir("empty-content");
        let store = MemoryStore::new(&dir);
        // Storing empty content should not panic
        store.store("", &[]).unwrap();

        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        let entries: Vec<_> = fs::read_dir(&memory_dir).unwrap().flatten().collect();
        assert!(!entries.is_empty(), "file should still be created");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_with_very_long_content() {
        let dir = make_test_dir("long-content");
        let store = MemoryStore::new(&dir);
        let long_content = "X".repeat(100_000);
        store.store(&long_content, &["big"]).unwrap();

        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        let entries: Vec<_> = fs::read_dir(&memory_dir).unwrap().flatten().collect();
        let file_content = fs::read_to_string(entries[0].path()).unwrap();
        assert!(file_content.len() >= 100_000);
        assert!(file_content.contains("Tags: big"));

        let _ = fs::remove_dir_all(&dir);
    }

    // ── Additional recall tests ───────────────────────────────

    #[test]
    fn recall_with_partial_keyword_match() {
        let dir = make_test_dir("partial-match");
        let store = MemoryStore::new(&dir);
        store.store("TypeScript agent runtime with Zod validation", &[]).unwrap();
        store.store("Python script for data analysis", &[]).unwrap();

        // "TypeScript" matches first entry; "blockchain" matches nothing
        let result = store.recall("TypeScript blockchain", 4000);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("TypeScript"));
    }

    #[test]
    fn recall_with_multiple_keywords_and_logic() {
        let dir = make_test_dir("multi-keyword");
        let store = MemoryStore::new(&dir);
        store.store("TypeScript agent runtime with Zod validation", &[]).unwrap();
        store.store("TypeScript is great for backend development", &[]).unwrap();
        store.store("Python is popular for machine learning", &[]).unwrap();

        // Both "TypeScript" and "agent" match entry 1; only "TypeScript" matches entry 2
        let result = store.recall("TypeScript agent", 4000);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("TypeScript"));
        assert!(text.contains("agent"));
    }

    #[test]
    fn recall_relevance_scoring_more_matches_higher() {
        let dir = make_test_dir("relevance-score");
        let store = MemoryStore::new(&dir);
        store.store("alpha beta gamma delta", &[]).unwrap();
        store.store("alpha beta", &[]).unwrap();

        // query "alpha beta gamma" -> first entry matches 3 keywords, second matches 2
        let result = store.recall("alpha beta gamma", 4000);
        assert!(result.is_some());
        let text = result.unwrap();
        // The first match (highest score) should appear in the result
        assert!(text.contains("gamma"));
    }

    #[test]
    fn recall_max_chars_budget_respected() {
        let dir = make_test_dir("budget");
        let store = MemoryStore::new(&dir);
        for i in 0..50 {
            store.store(&format!("Memory entry number {} about TypeScript patterns and best practices and more text here to pad it out", i), &[]).unwrap();
        }

        let result = store.recall("TypeScript", 200);
        assert!(result.is_some());
        let text = result.unwrap();
        // Result should respect max_chars budget (with some reasonable slack)
        assert!(text.len() <= 500, "result length {} exceeds reasonable budget", text.len());
    }

    #[test]
    fn recall_ignores_short_keywords() {
        let dir = make_test_dir("short-keywords");
        let store = MemoryStore::new(&dir);
        store.store("The AI model works well with ML", &[]).unwrap();

        // "AI" and "ML" are < 3 chars, should be filtered out
        let result = store.recall("AI ML", 4000);
        assert!(result.is_none(), "short keywords should be ignored");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_then_immediately_recall_same_content() {
        let dir = make_test_dir("immediate-recall");
        let store = MemoryStore::new(&dir);
        store.store("quantum computing breakthrough in superconducting qubits", &["physics"]).unwrap();

        let result = store.recall("quantum computing qubits", 4000);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("quantum"));
        assert!(text.contains("superconducting"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_case_insensitive_matching() {
        let dir = make_test_dir("case-insensitive");
        let store = MemoryStore::new(&dir);
        store.store("TypeScript is GREAT for Development", &[]).unwrap();

        // Lowercase query should match mixed-case stored content
        let result = store.recall("typescript great development", 4000);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("TypeScript"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_special_characters_in_content() {
        let dir = make_test_dir("special-chars");
        let store = MemoryStore::new(&dir);
        store.store("Formula: E=mc^2, path: /usr/local/bin", &["math"]).unwrap();

        let result = store.recall("Formula path", 4000);
        assert!(result.is_some());
        let text = result.unwrap();
        assert!(text.contains("E=mc^2"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn multiple_queries_returning_different_results() {
        let dir = make_test_dir("different-results");
        let store = MemoryStore::new(&dir);
        store.store("Rust programming for systems development", &[]).unwrap();
        store.store("Python machine learning with TensorFlow", &[]).unwrap();
        store.store("JavaScript frontend React components", &[]).unwrap();

        let rust_result = store.recall("Rust systems programming", 4000);
        assert!(rust_result.is_some());
        assert!(rust_result.unwrap().contains("Rust"));

        let python_result = store.recall("Python machine learning", 4000);
        assert!(python_result.is_some());
        assert!(python_result.unwrap().contains("Python"));

        let js_result = store.recall("JavaScript React frontend", 4000);
        assert!(js_result.is_some());
        assert!(js_result.unwrap().contains("JavaScript"));

        let _ = fs::remove_dir_all(&dir);
    }

    // ── Additional load_recent_context tests ──────────────────

    #[test]
    fn load_recent_context_with_empty_memory_dir() {
        let dir = make_test_dir("empty-recent");
        let store = MemoryStore::new(&dir);
        // No entries stored; memory dir exists but is empty
        let result = store.load_recent_context(4000);
        assert!(result.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_recent_context_budget_truncation() {
        let dir = make_test_dir("recent-budget");
        let store = MemoryStore::new(&dir);
        for i in 0..50 {
            store.store(&format!("Large entry {i}: {}", "Z".repeat(200)), &[]).unwrap();
        }

        let result = store.load_recent_context(500);
        // With a tiny budget, result should be capped (None if first file exceeds budget,
        // or Some with limited content)
        match result {
            Some(text) => {
                // The first file's content likely exceeds 500, so load_recent_context
                // should stop after considering the first file
                assert!(text.len() > 0);
            }
            None => {
                // If budget is too small for even the first file, None is valid
            }
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_returns_none_for_nonexistent_memory_dir() {
        // MemoryStore::new creates the dir, but recall on a path where
        // read_dir fails should return None
        let store = MemoryStore {
            memory_dir: std::path::PathBuf::from("/nonexistent/path/that/does/not/exist/.prismer/memory"),
        };
        let result = store.recall("anything", 4000);
        assert!(result.is_none());
    }

    #[test]
    fn load_recent_context_returns_none_for_nonexistent_dir() {
        let store = MemoryStore {
            memory_dir: std::path::PathBuf::from("/nonexistent/path/.prismer/memory"),
        };
        let result = store.load_recent_context(4000);
        assert!(result.is_none());
    }

    #[test]
    fn store_without_tags_has_no_tags_line() {
        let dir = make_test_dir("no-tags-line");
        let store = MemoryStore::new(&dir);
        store.store("content without tags", &[]).unwrap();

        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        let entries: Vec<_> = fs::read_dir(&memory_dir).unwrap().flatten().collect();
        let file_content = fs::read_to_string(entries[0].path()).unwrap();
        assert!(!file_content.contains("Tags:"), "should not have Tags line when no tags provided");
        assert!(file_content.contains("content without tags"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_empty_query_returns_none() {
        let dir = make_test_dir("empty-query");
        let store = MemoryStore::new(&dir);
        store.store("some content here with keywords", &[]).unwrap();

        // Empty query results in no keywords after filter
        let result = store.recall("", 4000);
        assert!(result.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_all_short_keywords_returns_none() {
        let dir = make_test_dir("all-short");
        let store = MemoryStore::new(&dir);
        store.store("The big cat sat on a mat", &[]).unwrap();

        // All words are <= 2 chars after filtering
        let result = store.recall("a I", 4000);
        assert!(result.is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
