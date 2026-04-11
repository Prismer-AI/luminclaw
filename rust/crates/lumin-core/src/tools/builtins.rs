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

/// Create the list_files tool.
/// Mirrors TS `builtins.ts:119-145`.
pub fn create_list_files_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "list_files".into(),
        description: "List files in the workspace. Supports glob patterns (e.g., \"**/*.ts\").".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path relative to workspace root (default: \".\")" },
                "pattern": { "type": "string", "description": "Glob pattern to filter files (e.g., \"**/*.ts\")" },
                "maxDepth": { "type": "number", "description": "Max directory depth (default: 10)" }
            }
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let user_path = args["path"].as_str().unwrap_or(".");
                let max_depth = args["maxDepth"].as_u64().unwrap_or(10) as usize;
                let pattern = args["pattern"].as_str().map(|s| s.to_string());
                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                let mut files = Vec::new();
                list_files_recursive(&resolved, &resolved, max_depth, 0, &mut files);
                let filtered: Vec<String> = match &pattern {
                    Some(pat) => files.into_iter().filter(|f| glob_match(pat, f)).collect(),
                    None => files,
                };
                if filtered.is_empty() {
                    return "No files found.".into();
                }
                let max_entries = 500;
                let truncated = filtered.len() > max_entries;
                let mut output: String = filtered[..filtered.len().min(max_entries)].join("\n");
                if truncated {
                    output.push_str(&format!("\n\n... and {} more files", filtered.len() - max_entries));
                }
                output
            })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}

/// Recursive directory listing — mirrors TS `listFilesRecursive` (builtins.ts:86-107).
fn list_files_recursive(
    dir: &std::path::Path, base: &std::path::Path,
    max_depth: usize, depth: usize, results: &mut Vec<String>,
) {
    if depth > max_depth { return; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && depth > 0 { continue; }
        if name == "node_modules" || name == ".git" { continue; }
        let rel = entry.path().strip_prefix(base)
            .unwrap_or(entry.path().as_path())
            .to_string_lossy().to_string();
        if entry.path().is_dir() {
            results.push(format!("{rel}/"));
            list_files_recursive(&entry.path(), base, max_depth, depth + 1, results);
        } else {
            results.push(rel);
        }
    }
}

/// Simple glob match — mirrors TS `globMatch` (builtins.ts:110-117).
fn glob_match(pattern: &str, path: &str) -> bool {
    let regex_str = regex_lite::escape(pattern)
        .replace(r"\*\*", "<<GLOBSTAR>>")
        .replace(r"\*", "[^/]*")
        .replace("<<GLOBSTAR>>", ".*");
    regex_lite::Regex::new(&format!("^{regex_str}$"))
        .map(|re| re.is_match(path))
        .unwrap_or(false)
}

/// Create the grep tool.
/// Mirrors TS `builtins.ts:233-278`.
pub fn create_grep_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "grep".into(),
        description: "Search file contents in the workspace using a regex pattern. Returns matching lines with file paths and line numbers.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regex pattern to search for" },
                "path": { "type": "string", "description": "Directory or file to search (default: workspace root)" },
                "glob": { "type": "string", "description": "File glob filter (e.g., \"*.ts\")" },
                "maxResults": { "type": "number", "description": "Max matches to return (default: 50)" }
            },
            "required": ["pattern"]
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let pattern_str = args["pattern"].as_str().unwrap_or("");
                let user_path = args["path"].as_str().unwrap_or(".");
                let max_results = args["maxResults"].as_u64().unwrap_or(50) as usize;
                let glob_filter = args["glob"].as_str().map(|s| s.to_string());

                let regex = match regex_lite::Regex::new(pattern_str) {
                    Ok(r) => r,
                    Err(e) => return format!("Error: invalid regex: {e}"),
                };
                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };

                let mut results = Vec::new();
                grep_recursive(&resolved, &std::path::PathBuf::from(&dir), &regex, max_results, &mut results, 0);

                let filtered: Vec<_> = match &glob_filter {
                    Some(g) => results.into_iter().filter(|(file, _, _)| {
                        glob_match(g, file) || glob_match(g, file.rsplit('/').next().unwrap_or(file))
                    }).collect(),
                    None => results,
                };

                if filtered.is_empty() {
                    return "No matches found.".into();
                }
                filtered.iter()
                    .map(|(file, line, text)| format!("{file}:{line}\t{text}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}

fn grep_recursive(
    dir: &std::path::Path, base: &std::path::Path, regex: &regex_lite::Regex,
    max_results: usize, results: &mut Vec<(String, usize, String)>, depth: usize,
) {
    if depth > 20 || results.len() >= max_results { return; }
    if dir.is_file() {
        grep_file(dir, base, regex, max_results, results);
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if results.len() >= max_results { return; }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "node_modules" || name == ".git" { continue; }
        if name.starts_with('.') && depth > 0 { continue; }
        let path = entry.path();
        if path.is_dir() {
            grep_recursive(&path, base, regex, max_results, results, depth + 1);
        } else {
            grep_file(&path, base, regex, max_results, results);
        }
    }
}

fn grep_file(
    path: &std::path::Path, base: &std::path::Path, regex: &regex_lite::Regex,
    max_results: usize, results: &mut Vec<(String, usize, String)>,
) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let rel = path.strip_prefix(base).unwrap_or(path).to_string_lossy().to_string();
    for (i, line) in content.lines().enumerate() {
        if results.len() >= max_results { return; }
        if regex.is_match(line) {
            results.push((rel.clone(), i + 1, line.to_string()));
        }
    }
}

/// Create the web_fetch tool.
/// Mirrors TS `builtins.ts:283-316`.
pub fn create_web_fetch_tool() -> Tool {
    Tool {
        name: "web_fetch".into(),
        description: "Fetch a URL and return the response body. Supports GET/POST with optional headers and body.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "URL to fetch" },
                "method": { "type": "string", "description": "HTTP method (default: GET)", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"] },
                "headers": { "type": "object", "description": "Request headers" },
                "body": { "type": "string", "description": "Request body (for POST/PUT/PATCH)" },
                "maxBytes": { "type": "number", "description": "Max response bytes to return (default: 100000)" }
            },
            "required": ["url"]
        }),
        execute: Arc::new(|args: Value, _ctx| {
            Box::pin(async move {
                let url = args["url"].as_str().unwrap_or("");
                let method = args["method"].as_str().unwrap_or("GET");
                let max_bytes = args["maxBytes"].as_u64().unwrap_or(100_000) as usize;

                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(30))
                    .build()
                    .unwrap_or_default();

                let mut req = match method {
                    "POST" => client.post(url),
                    "PUT" => client.put(url),
                    "PATCH" => client.patch(url),
                    "DELETE" => client.delete(url),
                    _ => client.get(url),
                };

                if let Some(headers) = args["headers"].as_object() {
                    for (key, val) in headers {
                        if let Some(v) = val.as_str() {
                            req = req.header(key.as_str(), v);
                        }
                    }
                }

                if method != "GET" {
                    if let Some(body) = args["body"].as_str() {
                        req = req.body(body.to_string());
                    }
                }

                match req.send().await {
                    Ok(resp) => {
                        let status = format!("HTTP {} {}",
                            resp.status().as_u16(),
                            resp.status().canonical_reason().unwrap_or(""));
                        let text = resp.text().await.unwrap_or_default();
                        let truncated = if text.len() > max_bytes {
                            format!("{}\n\n... (truncated)", &text[..max_bytes])
                        } else {
                            text
                        };
                        format!("{status}\n\n{truncated}")
                    }
                    Err(e) => format!("Error: {e}"),
                }
            })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}

/// Create the think tool (scratchpad for reasoning).
/// Mirrors TS `builtins.ts:320-333`.
pub fn create_think_tool() -> Tool {
    Tool {
        name: "think".into(),
        description: "A scratchpad for reasoning. Use this to think through complex problems step by step before acting. The thought is recorded but not shown to the user.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "thought": { "type": "string", "description": "Your reasoning or analysis" }
            },
            "required": ["thought"]
        }),
        execute: Arc::new(|_args: Value, _ctx| {
            Box::pin(async { "Thought recorded.".to_string() })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}
