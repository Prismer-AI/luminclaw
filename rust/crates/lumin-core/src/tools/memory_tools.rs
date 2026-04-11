//! Memory tools — mirrors TS `index.ts:143-180`.

use crate::memory::MemoryStore;
use crate::tools::Tool;
use std::sync::Arc;

/// Create the memory_store tool.
/// Mirrors TS `index.ts:143-161`.
pub fn create_memory_store_tool(workspace_dir: String) -> Tool {
    let wd = workspace_dir;
    Tool {
        name: "memory_store".into(),
        description: "Store a memory entry for later recall. Use to save important facts, decisions, code snippets, or action items.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "The memory content to store" },
                "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional tags for categorization" }
            },
            "required": ["content"]
        }),
        execute: Arc::new(move |args, _ctx| {
            let wd = wd.clone();
            Box::pin(async move {
                let mem = MemoryStore::new(&wd);
                let content = args["content"].as_str().unwrap_or("");
                let tags: Vec<&str> = args["tags"].as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                    .unwrap_or_default();
                match mem.store(content, &tags) {
                    Ok(_) => "Memory stored successfully.".into(),
                    Err(e) => format!("Error: {e}"),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}

/// Create the memory_recall tool.
/// Mirrors TS `index.ts:162-180`.
pub fn create_memory_recall_tool(workspace_dir: String) -> Tool {
    let wd = workspace_dir;
    Tool {
        name: "memory_recall".into(),
        description: "Search stored memories by keywords. Returns relevant past entries sorted by relevance.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Keywords to search for in memories" },
                "maxChars": { "type": "number", "description": "Max characters to return (default: 4000)" }
            },
            "required": ["query"]
        }),
        execute: Arc::new(move |args, _ctx| {
            let wd = wd.clone();
            Box::pin(async move {
                let mem = MemoryStore::new(&wd);
                let query = args["query"].as_str().unwrap_or("");
                let max_chars = args["maxChars"].as_u64().unwrap_or(4000) as usize;
                match mem.recall(query, max_chars) {
                    Some(result) => result,
                    None => "No matching memories found.".into(),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}
