//! File-based persistent memory — mirrors TypeScript `memory.ts`.
//! Stores facts as markdown, recalls by keyword matching.
//!
//! The [`MemoryStore`] facade wraps a file-based backend and exposes both the
//! original string API (`store`/`recall`/`load_recent_context`) and a new
//! structured API (`search` returning [`MemorySearchResult`]s).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

// ── Types ────────────────────────────────────────────────

/// A single memory search result (mirrors TS `MemorySearchResult`).
#[derive(Debug, Clone)]
pub struct MemorySearchResult {
    /// The matched memory content.
    pub text: String,
    /// Date of the memory entry (ISO format YYYY-MM-DD).
    pub date: String,
    /// Relevance score, normalized 0.0–1.0 (1.0 = perfect match).
    pub score: f64,
    /// Tags associated with the entry (if any).
    pub tags: Vec<String>,
    /// Source file path.
    pub source: String,
}

/// Capabilities declared by the memory backend.
#[derive(Debug, Clone)]
pub struct MemoryCapabilities {
    /// Supports embedding-based semantic similarity search.
    pub semantic_search: bool,
    /// Supports filtering search results by tags.
    pub tag_filtering: bool,
    /// Storage limit in bytes (None = unlimited).
    pub max_storage_bytes: Option<usize>,
}

/// Options for a memory search operation (mirrors TS `MemorySearchOptions`).
#[derive(Debug, Clone, Default)]
pub struct MemorySearchOptions {
    /// Maximum number of results to return.
    pub max_results: Option<usize>,
    /// Maximum total characters across all results.
    pub max_chars: Option<usize>,
    /// Filter by tags — only return entries that have at least one of these tags.
    pub tags: Option<Vec<String>>,
}

// ── Helpers ──────────────────────────────────────────────

/// Split a large memory entry into turn-level chunks for finer-grained search.
///
/// Groups consecutive lines into chunks of ~3 turns, with 1-turn overlap
/// to preserve context across chunk boundaries. A "turn" is a line that
/// starts with a speaker pattern (e.g., "Jon: ...", "[USER] ...").
///
/// Entries that don't look like conversation (e.g., bullet-point notes)
/// are split by paragraph breaks instead.
fn split_into_chunks(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.split('\n').collect();

    // Detect if this is conversational (lines start with "Name: ..." or headers)
    let turn_count = lines
        .iter()
        .filter(|l| is_turn_start(l.trim()))
        .count();
    let is_conversational = turn_count >= 3;

    if is_conversational {
        // Group by turns (each turn starts with speaker pattern)
        let mut turns: Vec<String> = Vec::new();
        let mut current = String::new();
        for line in &lines {
            if is_turn_start(line.trim()) && !current.is_empty() {
                turns.push(current.trim().to_string());
                current = line.to_string();
            } else {
                if !current.is_empty() {
                    current.push('\n');
                }
                current.push_str(line);
            }
        }
        if !current.trim().is_empty() {
            turns.push(current.trim().to_string());
        }

        // Sliding window: 3 turns per chunk, step 2 (1 turn overlap)
        let window = 3;
        let step = 2;
        let mut chunks: Vec<String> = Vec::new();
        let mut i = 0;
        while i < turns.len() {
            let end = (i + window).min(turns.len());
            let chunk = turns[i..end].join("\n");
            chunks.push(chunk);
            i += step;
        }
        // Always include the full entry as a candidate too (for broad matches)
        if chunks.len() > 1 {
            chunks.push(text.trim().to_string());
        }
        chunks
    } else {
        // Non-conversational: split by paragraph breaks
        let paragraphs: Vec<&str> = text
            .split("\n\n")
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect();

        if paragraphs.len() <= 1 {
            return vec![text.to_string()];
        }

        // Group 2-3 paragraphs per chunk with overlap
        let mut chunks: Vec<String> = Vec::new();
        let mut i = 0;
        while i < paragraphs.len() {
            let end = (i + 3).min(paragraphs.len());
            let chunk = paragraphs[i..end].join("\n\n");
            chunks.push(chunk);
            i += 2;
        }
        if chunks.len() > 1 {
            chunks.push(text.trim().to_string());
        }
        chunks
    }
}

/// Check if a line looks like the start of a conversational turn.
/// Matches patterns like "Name: ...", "## ...", "# ...", "[USER] ...", "[ASSISTANT] ..."
fn is_turn_start(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    // [USER] or [ASSISTANT] prefix
    if line.starts_with("[USER]") || line.starts_with("[ASSISTANT]") {
        return true;
    }
    // Markdown heading: ## or #
    if line.starts_with("## ") || line.starts_with("# ") {
        return true;
    }
    // Speaker pattern: word(s) followed by colon, e.g. "Jon:", "Dr Smith:"
    // Match: one or more word chars (optionally followed by spaces and more word chars),
    // then a colon.
    let bytes = line.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    // Find the first colon
    if let Some(colon_pos) = line.find(':') {
        // Everything before the colon must be word chars and spaces
        let prefix = &line[..colon_pos];
        if !prefix.is_empty()
            && prefix
                .chars()
                .all(|c| c.is_alphanumeric() || c == ' ' || c == '_')
        {
            return true;
        }
    }
    false
}

/// Extract tags from an entry's content.
///
/// Supports two formats:
/// 1. Old format: `Tags: alpha, beta` line
/// 2. TS-parity format: `## HH:MM — [alpha, beta]` heading
fn extract_tags(entry: &str) -> Vec<String> {
    for line in entry.lines() {
        let trimmed = line.trim();
        // Old format: "Tags: alpha, beta"
        if let Some(rest) = trimmed.strip_prefix("Tags: ") {
            return rest.split(", ").map(|s| s.trim().to_string()).collect();
        }
        // TS-parity format: "## HH:MM — [alpha, beta]"
        // Look for " — [" ... "]" in heading lines
        if trimmed.starts_with("## ") {
            let marker = " \u{2014} ["; // " — [" (em-dash is 3 bytes UTF-8)
            if let Some(bracket_start) = trimmed.find(marker) {
                let tag_start = bracket_start + marker.len();
                if let Some(bracket_end) = trimmed[tag_start..].find(']') {
                    let tag_str = &trimmed[tag_start..tag_start + bracket_end];
                    return tag_str
                        .split(", ")
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
        }
    }
    Vec::new()
}

// ── MemoryStore ──────────────────────────────────────────

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

        let time = chrono_time();
        let tag_str = if tags.is_empty() {
            String::new()
        } else {
            format!(" — [{}]", tags.join(", "))
        };

        let entry = format!("## {time}{tag_str}\n{}\n\n---\n\n", content.trim());

        // Append to today's file
        let existing = fs::read_to_string(&path).unwrap_or_default();
        fs::write(&path, format!("{existing}{entry}"))
    }

    /// Keyword-based recall — returns matching entries as a plain string.
    /// This is the backward-compatible API used by the `memory_recall` tool.
    pub fn recall(&self, query: &str, max_chars: usize) -> Option<String> {
        let results = self.search(query, &MemorySearchOptions {
            max_chars: Some(max_chars),
            ..Default::default()
        });

        if results.is_empty() {
            return None;
        }

        let formatted = format_results(&results);
        if formatted.is_empty() {
            None
        } else {
            Some(formatted)
        }
    }

    /// Structured search — returns [`MemorySearchResult`] for richer consumers.
    ///
    /// Features matching TS parity:
    /// - Turn-level chunking for large entries (>500 chars)
    /// - Multi-query fallback when query has 5+ keywords
    /// - Tag filtering via `options.tags`
    /// - Score normalization to 0.0–1.0 (keyword hit ratio)
    pub fn search(&self, query: &str, options: &MemorySearchOptions) -> Vec<MemorySearchResult> {
        if !self.memory_dir.exists() {
            return Vec::new();
        }

        let max_chars = options.max_chars.unwrap_or(4000);

        let mut files: Vec<_> = fs::read_dir(&self.memory_dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        // Sort newest first (reverse alphabetical on YYYY-MM-DD.md filenames)
        files.sort();
        files.reverse();

        let keywords: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .filter(|w| w.len() > 2)
            .map(|s| s.to_string())
            .collect();

        if keywords.is_empty() {
            return Vec::new();
        }

        // Multi-query: when query has 5+ keywords, also search sub-groups
        let mut keyword_sets: Vec<Vec<String>> = vec![keywords.clone()];
        if keywords.len() >= 5 {
            let mut i = 0;
            while i + 3 <= keywords.len() {
                keyword_sets.push(keywords[i..i + 3].to_vec());
                i += 2;
            }
        }

        let filter_tags: Option<&Vec<String>> = options.tags.as_ref();

        let mut scored: Vec<MemorySearchResult> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for file in &files {
            let date = file.trim_end_matches(".md").to_string();
            let file_path = self.memory_dir.join(file);
            let content = match fs::read_to_string(&file_path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let entries: Vec<&str> = content
                .split("\n---\n")
                .filter(|e| !e.trim().is_empty())
                .collect();

            for entry in &entries {
                let entry_tags = extract_tags(entry);

                // Tag filtering: if filter tags are specified, entry must have at least one
                if let Some(filter) = filter_tags {
                    if !filter.is_empty()
                        && !entry_tags.iter().any(|t| {
                            filter.iter().any(|f| f.eq_ignore_ascii_case(t))
                        })
                    {
                        continue;
                    }
                }

                // Turn-level chunking for large entries
                let chunks = if entry.len() > 500 {
                    split_into_chunks(entry)
                } else {
                    vec![entry.to_string()]
                };

                for chunk in &chunks {
                    let lower = chunk.to_lowercase();
                    let trimmed = chunk.trim();
                    if trimmed.is_empty() || trimmed.len() < 10 {
                        continue;
                    }

                    let dedup_key = if trimmed.len() >= 100 {
                        trimmed[..100].to_string()
                    } else {
                        trimmed.to_string()
                    };
                    if seen.contains(&dedup_key) {
                        continue;
                    }

                    // Score against all keyword sets, take best
                    let mut best_score: f64 = 0.0;
                    for kws in &keyword_sets {
                        let hits = kws
                            .iter()
                            .filter(|kw| lower.contains(kw.as_str()))
                            .count();
                        let score = hits as f64 / kws.len() as f64;
                        if score > best_score {
                            best_score = score;
                        }
                    }

                    if best_score > 0.0 {
                        seen.insert(dedup_key);
                        scored.push(MemorySearchResult {
                            text: trimmed.to_string(),
                            date: date.clone(),
                            score: best_score,
                            tags: entry_tags.clone(),
                            source: file_path.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }

        // Sort by score descending
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        // Apply max_chars and max_results budget
        let mut results: Vec<MemorySearchResult> = Vec::new();
        let mut total: usize = 0;
        for item in scored {
            if let Some(max_r) = options.max_results {
                if results.len() >= max_r {
                    break;
                }
            }
            if total + item.text.len() > max_chars {
                break;
            }
            total += item.text.len() + item.date.len() + 3;
            results.push(item);
        }

        results
    }

    /// Load recent context (today + yesterday) for system prompt injection.
    ///
    /// Matches TS behavior: loads only today and yesterday files, groups by date,
    /// respects max_chars budget.
    pub fn load_recent_context(&self, max_chars: usize) -> Option<String> {
        if !self.memory_dir.exists() {
            return None;
        }

        let today = chrono_today();
        let yesterday = chrono_yesterday();
        let dates = [today, yesterday];

        let mut parts: Vec<String> = Vec::new();
        let mut total: usize = 0;

        for date in &dates {
            let file_path = self.memory_dir.join(format!("{date}.md"));
            let content = match fs::read_to_string(&file_path) {
                Ok(c) => c.trim().to_string(),
                Err(_) => continue,
            };
            if content.is_empty() {
                continue;
            }

            let chunk = format!("### {date}\n{content}");

            if total + chunk.len() > max_chars {
                let remaining = max_chars - total;
                if remaining > 100 {
                    parts.push(chunk[..remaining].to_string());
                }
                break;
            }
            total += chunk.len();
            parts.push(chunk);
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n\n"))
        }
    }

    /// Backend capabilities (file backend: no semantic search, no tag filtering built-in).
    pub fn capabilities(&self) -> MemoryCapabilities {
        MemoryCapabilities {
            semantic_search: false,
            tag_filtering: false,
            max_storage_bytes: None,
        }
    }

    /// Backend name.
    pub fn backend_name(&self) -> &str {
        "file"
    }

    /// Release resources (no-op for file backend, provided for API parity).
    pub fn close(&self) {
        // No resources to release for file-based backend.
    }
}

/// Format search results into a plain string (used by recall).
fn format_results(results: &[MemorySearchResult]) -> String {
    if results.is_empty() {
        return String::new();
    }
    results
        .iter()
        .map(|r| format!("[{}] {}", r.date, r.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ── Date helpers ─────────────────────────────────────────

/// Return today's date as YYYY-MM-DD.
fn chrono_today() -> String {
    date_from_epoch_days(epoch_days())
}

/// Return yesterday's date as YYYY-MM-DD.
fn chrono_yesterday() -> String {
    let days = epoch_days();
    if days == 0 {
        return date_from_epoch_days(0);
    }
    date_from_epoch_days(days - 1)
}

/// Return current time as HH:MM.
fn chrono_time() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let day_secs = secs % 86400;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    format!("{hours:02}:{minutes:02}")
}

/// Days since Unix epoch.
fn epoch_days() -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    now.as_secs() / 86400
}

/// Convert days-since-epoch to a YYYY-MM-DD string.
/// Uses a proper civil date algorithm (Howard Hinnant's) for correctness.
fn date_from_epoch_days(days: u64) -> String {
    // Algorithm from https://howardhinnant.github.io/date_algorithms.html
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // day of era [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_dir(name: &str) -> String {
        let dir = format!("/tmp/lumin-memory-test-{name}");
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    // ── Existing tests (preserved) ───────────────────────────

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
        let dir = make_test_dir("tags-v2");
        let store = MemoryStore::new(&dir);
        store.store("tagged content", &["alpha", "beta"]).unwrap();

        // Read back the file and check for tags in the heading
        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        let entries: Vec<_> = fs::read_dir(&memory_dir).unwrap().flatten().collect();
        let file_content = fs::read_to_string(entries[0].path()).unwrap();
        assert!(file_content.contains("[alpha, beta]"));
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
        assert!(file_content.contains("[big]"));

        let _ = fs::remove_dir_all(&dir);
    }

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
        // With a tiny budget, result should be capped
        match result {
            Some(text) => {
                assert!(!text.is_empty());
            }
            None => {
                // If budget is too small for even the header, None is valid
            }
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_returns_none_for_nonexistent_memory_dir() {
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
        let dir = make_test_dir("no-tags-line-v2");
        let store = MemoryStore::new(&dir);
        store.store("content without tags", &[]).unwrap();

        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        let entries: Vec<_> = fs::read_dir(&memory_dir).unwrap().flatten().collect();
        let file_content = fs::read_to_string(entries[0].path()).unwrap();
        // Tags are in the heading as " — [tag1, tag2]", so no tags = no brackets
        assert!(!file_content.contains('['), "should not have tag brackets when no tags provided");
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

    // ── New tests: search() returns scored results ───────────

    #[test]
    fn search_returns_structured_results_with_scores() {
        let dir = make_test_dir("search-scored");
        let store = MemoryStore::new(&dir);
        store.store("Rust programming for systems development", &["rust"]).unwrap();
        store.store("Python machine learning with TensorFlow", &["python"]).unwrap();

        let results = store.search("Rust systems programming", &MemorySearchOptions::default());
        assert!(!results.is_empty());

        let best = &results[0];
        assert!(best.text.contains("Rust"));
        assert!(best.score > 0.0);
        assert!(best.score <= 1.0);
        assert!(!best.date.is_empty());
        assert!(!best.source.is_empty());

        // Score should be normalized: 3 out of 3 keywords match ("rust", "systems", "programming")
        // so score should be 1.0
        assert!(
            (best.score - 1.0).abs() < f64::EPSILON,
            "expected score 1.0 for all keywords matching, got {}",
            best.score
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_partial_match_has_lower_score() {
        let dir = make_test_dir("search-partial");
        let store = MemoryStore::new(&dir);
        store.store("Rust programming for systems development", &[]).unwrap();

        // Only 2 of 3 keywords match ("rust", "programming" match; "blockchain" doesn't)
        let results = store.search("Rust programming blockchain", &MemorySearchOptions::default());
        assert!(!results.is_empty());

        let best = &results[0];
        // 2/3 ~ 0.667
        assert!(best.score > 0.6 && best.score < 0.7, "expected ~0.667, got {}", best.score);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_max_results_limits_output() {
        let dir = make_test_dir("search-maxresults");
        let store = MemoryStore::new(&dir);
        for i in 0..10 {
            store.store(&format!("TypeScript entry number {i} about code patterns"), &[]).unwrap();
        }

        let results = store.search("TypeScript code patterns", &MemorySearchOptions {
            max_results: Some(3),
            ..Default::default()
        });
        assert!(results.len() <= 3, "expected at most 3 results, got {}", results.len());

        let _ = fs::remove_dir_all(&dir);
    }

    // ── New tests: turn-level chunking ───────────────────────

    #[test]
    fn split_into_chunks_conversational() {
        let text = "\
User: Hello there
Assistant: Hi! How can I help?
User: Tell me about Rust
Assistant: Rust is a systems programming language
User: What about memory safety?
Assistant: Rust provides memory safety without GC
User: Thanks!";

        let chunks = split_into_chunks(text);
        // Should produce overlapping windows of 3 turns + full text
        assert!(chunks.len() > 1, "should produce multiple chunks, got {}", chunks.len());

        // First chunk should contain first 3 turns
        assert!(chunks[0].contains("Hello there"));
        assert!(chunks[0].contains("How can I help"));

        // Full text should be the last chunk
        let last = &chunks[chunks.len() - 1];
        assert!(last.contains("Thanks!"));
        assert!(last.contains("Hello there"));
    }

    #[test]
    fn split_into_chunks_non_conversational_paragraphs() {
        let text = "First paragraph about Rust.\n\n\
                    Second paragraph about TypeScript.\n\n\
                    Third paragraph about Python.\n\n\
                    Fourth paragraph about Go.";

        let chunks = split_into_chunks(text);
        assert!(chunks.len() > 1, "should produce multiple chunks");

        // First chunk should have paragraphs 1-3
        assert!(chunks[0].contains("First paragraph"));
        assert!(chunks[0].contains("Second paragraph"));
        assert!(chunks[0].contains("Third paragraph"));
    }

    #[test]
    fn split_into_chunks_short_text_no_split() {
        let text = "Just a short note.";
        let chunks = split_into_chunks(text);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], text);
    }

    #[test]
    fn chunking_produces_overlapping_windows() {
        let text = "\
Speaker_A: Turn 1 content
Speaker_B: Turn 2 content
Speaker_A: Turn 3 content
Speaker_B: Turn 4 content
Speaker_A: Turn 5 content";

        let chunks = split_into_chunks(text);
        // With 5 turns, window=3, step=2:
        // chunk 0: turns 0,1,2
        // chunk 1: turns 2,3,4
        // chunk 2 (full text): all turns
        assert!(chunks.len() >= 2, "expected at least 2 chunks, got {}", chunks.len());

        // Verify overlap: turn 3 ("Speaker_A: Turn 3") should appear in both chunk 0 and chunk 1
        assert!(chunks[0].contains("Turn 3"), "chunk 0 should contain turn 3");
        assert!(chunks[1].contains("Turn 3"), "chunk 1 should also contain turn 3 (overlap)");
    }

    // ── New tests: multi-query fallback with 5+ keywords ─────

    #[test]
    fn multi_query_fallback_with_five_plus_keywords() {
        let dir = make_test_dir("multi-query");
        let store = MemoryStore::new(&dir);
        // This entry matches only 3 keywords out of 6, but multi-query subsets
        // (windows of 3 keywords) should catch it with a higher sub-score
        store.store("alpha beta gamma are important concepts in research", &[]).unwrap();
        store.store("delta epsilon zeta are different concepts entirely", &[]).unwrap();

        // 6 keywords; without multi-query, both entries would score 3/6 = 0.5
        // With multi-query windows: [alpha,beta,gamma] scores 3/3 = 1.0 for entry 1
        let results = store.search(
            "alpha beta gamma delta epsilon zeta",
            &MemorySearchOptions::default(),
        );
        assert!(!results.is_empty());

        // Check that at least one result has a higher score from sub-query matching
        let has_high_score = results.iter().any(|r| r.score > 0.9);
        assert!(
            has_high_score,
            "multi-query should produce a score > 0.9 from subset matching; best was {}",
            results.iter().map(|r| r.score).fold(0.0f64, f64::max)
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn multi_query_not_applied_for_few_keywords() {
        let dir = make_test_dir("no-multi-query");
        let store = MemoryStore::new(&dir);
        store.store("alpha beta gamma are important", &[]).unwrap();

        // Only 4 keywords -> no multi-query fallback
        let results = store.search("alpha beta gamma delta", &MemorySearchOptions::default());
        assert!(!results.is_empty());

        // With 4 keywords, only primary set is used: 3/4 = 0.75
        let best = &results[0];
        assert!(
            (best.score - 0.75).abs() < 0.01,
            "without multi-query, score should be 3/4 = 0.75, got {}",
            best.score
        );

        let _ = fs::remove_dir_all(&dir);
    }

    // ── New tests: tag filtering ─────────────────────────────

    #[test]
    fn search_with_tag_filter() {
        let dir = make_test_dir("tag-filter");
        let store = MemoryStore::new(&dir);
        store.store("Rust is great for systems programming", &["rust", "systems"]).unwrap();
        store.store("Python is great for machine learning", &["python", "ml"]).unwrap();
        store.store("TypeScript is great for web development", &["typescript", "web"]).unwrap();

        // Search with tag filter: only entries tagged "python" or "ml"
        let results = store.search("great programming", &MemorySearchOptions {
            tags: Some(vec!["python".to_string()]),
            ..Default::default()
        });

        // Should only return Python entry
        assert!(!results.is_empty());
        for r in &results {
            assert!(
                r.text.contains("Python"),
                "filtered result should only contain Python entries, got: {}",
                r.text
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_with_empty_tag_filter_returns_all() {
        let dir = make_test_dir("tag-filter-empty");
        let store = MemoryStore::new(&dir);
        store.store("Rust is great for programming", &["rust"]).unwrap();
        store.store("Python is great for programming", &["python"]).unwrap();

        // Empty tag filter -> no filtering
        let results = store.search("great programming", &MemorySearchOptions {
            tags: Some(vec![]),
            ..Default::default()
        });

        // Both entries should match
        assert!(results.len() >= 2, "empty tag filter should not filter anything");

        let _ = fs::remove_dir_all(&dir);
    }

    // ── New tests: score normalization ───────────────────────

    #[test]
    fn score_normalization_range() {
        let dir = make_test_dir("score-range");
        let store = MemoryStore::new(&dir);
        store.store("alpha beta gamma delta epsilon", &[]).unwrap();
        store.store("only alpha here", &[]).unwrap();

        let results = store.search("alpha beta gamma", &MemorySearchOptions::default());
        for r in &results {
            assert!(r.score >= 0.0, "score should be >= 0, got {}", r.score);
            assert!(r.score <= 1.0, "score should be <= 1, got {}", r.score);
        }

        // Entry with all 3 keywords matching should score 1.0
        let full_match = results.iter().find(|r| r.text.contains("gamma"));
        assert!(full_match.is_some(), "should find entry with gamma");
        assert!(
            (full_match.unwrap().score - 1.0).abs() < f64::EPSILON,
            "full match should score 1.0"
        );

        // Entry with 1 of 3 keywords matching should score ~0.333
        let partial_match = results.iter().find(|r| r.text.contains("only alpha"));
        assert!(partial_match.is_some(), "should find entry with only alpha");
        let partial_score = partial_match.unwrap().score;
        assert!(
            (partial_score - 1.0 / 3.0).abs() < 0.01,
            "partial match should score ~0.333, got {}",
            partial_score
        );

        let _ = fs::remove_dir_all(&dir);
    }

    // ── New tests: close() ───────────────────────────────────

    #[test]
    fn close_is_callable() {
        let dir = make_test_dir("close");
        let store = MemoryStore::new(&dir);
        store.store("some data", &[]).unwrap();

        // close() should not panic
        store.close();

        // Store should still be usable after close (file backend has no state to release)
        let result = store.recall("some data", 4000);
        assert!(result.is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    // ── New tests: capabilities and backend_name ─────────────

    #[test]
    fn capabilities_returns_file_backend_defaults() {
        let dir = make_test_dir("capabilities");
        let store = MemoryStore::new(&dir);
        let caps = store.capabilities();
        assert!(!caps.semantic_search);
        assert!(!caps.tag_filtering);
        assert!(caps.max_storage_bytes.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backend_name_is_file() {
        let dir = make_test_dir("backend-name");
        let store = MemoryStore::new(&dir);
        assert_eq!(store.backend_name(), "file");

        let _ = fs::remove_dir_all(&dir);
    }

    // ── New tests: format matches TS ─────────────────────────

    #[test]
    fn store_format_matches_ts_with_separator() {
        let dir = make_test_dir("format-ts");
        let store = MemoryStore::new(&dir);
        store.store("hello world", &["tag1"]).unwrap();

        let memory_dir = Path::new(&dir).join(".prismer").join("memory");
        let entries: Vec<_> = fs::read_dir(&memory_dir).unwrap().flatten().collect();
        let content = fs::read_to_string(entries[0].path()).unwrap();

        // TS format: "## HH:MM — [tag1]\nhello world\n\n---\n\n"
        assert!(content.contains("## "), "should have heading");
        assert!(content.contains("[tag1]"), "should have tag in brackets");
        assert!(content.contains("hello world"), "should have content");
        assert!(content.contains("---"), "should have separator");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recall_format_includes_date_prefix() {
        let dir = make_test_dir("recall-format");
        let store = MemoryStore::new(&dir);
        store.store("important fact about Rust memory safety", &[]).unwrap();

        let result = store.recall("Rust memory safety", 4000);
        assert!(result.is_some());
        let text = result.unwrap();
        // Format should be "[YYYY-MM-DD] ..."
        assert!(text.starts_with('['), "recall output should start with date bracket");
        assert!(text.contains(']'), "recall output should have closing bracket");

        let _ = fs::remove_dir_all(&dir);
    }

    // ── New tests: date helpers ──────────────────────────────

    #[test]
    fn date_from_epoch_days_known_dates() {
        // 2024-01-01 = day 19723
        assert_eq!(date_from_epoch_days(19723), "2024-01-01");
        // 1970-01-01 = day 0
        assert_eq!(date_from_epoch_days(0), "1970-01-01");
        // 2000-03-01 = day 11017
        assert_eq!(date_from_epoch_days(11017), "2000-03-01");
    }

    #[test]
    fn chrono_today_returns_valid_date_format() {
        let today = chrono_today();
        // Should be YYYY-MM-DD format
        assert_eq!(today.len(), 10, "date should be 10 chars: {}", today);
        assert_eq!(&today[4..5], "-");
        assert_eq!(&today[7..8], "-");
    }

    #[test]
    fn chrono_yesterday_is_before_today() {
        let today = chrono_today();
        let yesterday = chrono_yesterday();
        assert!(yesterday < today || today == "1970-01-01", "yesterday should be before today");
    }

    // ── New tests: extract_tags helper ───────────────────────

    #[test]
    fn extract_tags_from_entry() {
        // Old format: "Tags: ..." line
        let old_format = "## Entry\nTags: rust, systems\nSome rust content\n";
        let tags = extract_tags(old_format);
        assert_eq!(tags, vec!["rust", "systems"]);

        // TS-parity format: "## HH:MM — [tag1, tag2]" heading
        let ts_format = "## 14:30 \u{2014} [alpha, beta]\nSome content\n";
        let tags2 = extract_tags(ts_format);
        assert_eq!(tags2, vec!["alpha", "beta"]);

        // No tags at all
        let no_tags = "## 14:30\nSome content\n";
        let tags3 = extract_tags(no_tags);
        assert!(tags3.is_empty());
    }

    // ── New tests: is_turn_start helper ──────────────────────

    #[test]
    fn is_turn_start_patterns() {
        assert!(is_turn_start("User: hello"));
        assert!(is_turn_start("[USER] hello"));
        assert!(is_turn_start("[ASSISTANT] hi"));
        assert!(is_turn_start("## Heading"));
        assert!(is_turn_start("# Title"));
        assert!(is_turn_start("Dr Smith: something"));

        assert!(!is_turn_start(""));
        assert!(!is_turn_start("just a regular line"));
        assert!(!is_turn_start("  indented line"));
    }

    // ── New tests: search with chunking integration ──────────

    #[test]
    fn search_with_large_entry_uses_chunking() {
        let dir = make_test_dir("search-chunking");
        let store = MemoryStore::new(&dir);

        // Create a large conversational entry (>500 chars) that will be chunked
        let mut large_entry = String::new();
        for i in 0..10 {
            large_entry.push_str(&format!(
                "Speaker{}: This is turn {} discussing topic {} with enough padding to make it long enough for chunking to kick in\n",
                i % 2, i, if i < 5 { "quantum" } else { "classical" }
            ));
        }
        store.store(&large_entry, &[]).unwrap();

        let results = store.search("quantum topic discussing", &MemorySearchOptions::default());
        assert!(!results.is_empty(), "chunked search should find results");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_results_sorted_by_score_descending() {
        let dir = make_test_dir("search-sorted");
        let store = MemoryStore::new(&dir);
        store.store("alpha beta gamma delta epsilon", &[]).unwrap();
        store.store("alpha only here with padding to be long enough", &[]).unwrap();
        store.store("alpha beta here also with some extra padding text", &[]).unwrap();

        let results = store.search("alpha beta gamma", &MemorySearchOptions::default());
        assert!(results.len() >= 2);

        // Results should be sorted by score descending
        for i in 1..results.len() {
            assert!(
                results[i - 1].score >= results[i].score,
                "results should be sorted descending: {} >= {}",
                results[i - 1].score,
                results[i].score
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
