//! Built-in file I/O tools — mirrors TypeScript `tools/builtins.ts`.

use super::{safe_path, Tool};
use serde_json::Value;
use std::sync::Arc;

/// Create a `read_file` tool that reads file content with line numbers.
/// Mirrors TS builtins.ts:34-56.
pub fn create_read_file_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "read_file".into(),
        description: "Read a file from the workspace. Returns file content with line numbers."
            .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to workspace root" },
                "offset": { "type": "number", "description": "Start line (1-based, default: 1)" },
                "limit": { "type": "number", "description": "Max lines to return (default: 2000)" }
            },
            "required": ["path"]
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let user_path = args["path"].as_str().unwrap_or("");
                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                let content = match tokio::fs::read_to_string(&resolved).await {
                    Ok(c) => c,
                    Err(e) => return format!("Error: {e}"),
                };
                let lines: Vec<&str> = content.lines().collect();
                let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
                let limit = args["limit"].as_u64().unwrap_or(2000) as usize;
                let start = offset - 1;
                let end = lines.len().min(start + limit);
                if start >= lines.len() {
                    return format!(
                        "Error: offset {offset} exceeds file length ({} lines)",
                        lines.len()
                    );
                }
                lines[start..end]
                    .iter()
                    .enumerate()
                    .map(|(i, line)| format!("{}\t{line}", start + i + 1))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}

/// Create a `write_file` tool that writes content to a file.
/// Mirrors TS builtins.ts:60-78.
pub fn create_write_file_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "write_file".into(),
        description:
            "Write content to a file in the workspace. Creates parent directories if needed."
                .into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to workspace root" },
                "content": { "type": "string", "description": "Content to write" }
            },
            "required": ["path", "content"]
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let user_path = args["path"].as_str().unwrap_or("");
                let content = args["content"].as_str().unwrap_or("");
                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                if let Some(parent) = resolved.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        return format!("Error creating directory: {e}");
                    }
                }
                match tokio::fs::write(&resolved, content).await {
                    Ok(()) => format!("Wrote {} bytes to {user_path}", content.len()),
                    Err(e) => format!("Error: {e}"),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}

/// Create an `edit_file` tool that replaces exact string matches.
/// Mirrors TS builtins.ts:149-190.
pub fn create_edit_file_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "edit_file".into(),
        description: "Edit a file by replacing an exact string match. The old_string must appear exactly once in the file (unless replace_all is true).".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to workspace root" },
                "old_string": { "type": "string", "description": "Exact string to find (must be unique in file)" },
                "new_string": { "type": "string", "description": "Replacement string" },
                "replace_all": { "type": "boolean", "description": "Replace all occurrences (default: false)" }
            },
            "required": ["path", "old_string", "new_string"]
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let user_path = args["path"].as_str().unwrap_or("");
                let old_str = args["old_string"].as_str().unwrap_or("");
                let new_str = args["new_string"].as_str().unwrap_or("");
                let replace_all = args["replace_all"].as_bool().unwrap_or(false);

                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                let content = match tokio::fs::read_to_string(&resolved).await {
                    Ok(c) => c,
                    Err(e) => return format!("Error: {e}"),
                };
                if !content.contains(old_str) {
                    return format!("Error: old_string not found in {user_path}");
                }
                let count = content.matches(old_str).count();
                if !replace_all && count > 1 {
                    return format!(
                        "Error: old_string found {count} times in {user_path}. Use replace_all: true or provide a more specific string."
                    );
                }
                let updated = content.replace(old_str, new_str);
                match tokio::fs::write(&resolved, &updated).await {
                    Ok(()) => format!("Replaced {count} occurrence(s) in {user_path}"),
                    Err(e) => format!("Error writing: {e}"),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}
