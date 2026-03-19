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

    #[test]
    fn store_and_recall() {
        let dir = "/tmp/lumin-memory-test";
        let _ = fs::remove_dir_all(dir);
        let _ = fs::create_dir_all(format!("{dir}/.prismer/memory"));

        let store = MemoryStore::new(dir);
        store.store("The paper uses CVPR template with 8 sections", &["latex", "paper"]).unwrap();
        store.store("Dataset has 10000 rows in CSV format", &["data"]).unwrap();

        let result = store.recall("CVPR paper template", 4000);
        assert!(result.is_some());
        assert!(result.unwrap().contains("CVPR"));

        let _ = fs::remove_dir_all(dir);
    }
}
