//! Integration tests for built-in tools — verifies Rust matches TS behavior.

use lumin_core::tools::builtins::*;
use lumin_core::tools::{ToolContext, ToolRegistry};
use tempfile::TempDir;

fn make_ctx(dir: &str) -> ToolContext {
    ToolContext {
        workspace_dir: dir.into(),
        session_id: "test".into(),
        agent_id: "test".into(),
        emit: None,
    }
}

// ── read_file ──

#[tokio::test]
async fn read_file_returns_numbered_lines() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("hello.txt"), "line1\nline2\nline3\n").unwrap();
    let tool = create_read_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"path": "hello.txt"}), &ctx).await;
    assert!(result.contains("1\tline1"));
    assert!(result.contains("2\tline2"));
    assert!(result.contains("3\tline3"));
}

#[tokio::test]
async fn read_file_with_offset_and_limit() {
    let tmp = TempDir::new().unwrap();
    let content: String = (1..=10).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n");
    std::fs::write(tmp.path().join("ten.txt"), &content).unwrap();
    let tool = create_read_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"path": "ten.txt", "offset": 3, "limit": 2}), &ctx).await;
    assert!(result.contains("3\tline3"));
    assert!(result.contains("4\tline4"));
    assert!(!result.contains("5\tline5"));
}

#[tokio::test]
async fn read_file_rejects_path_traversal() {
    let tmp = TempDir::new().unwrap();
    let tool = create_read_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"path": "../../../etc/passwd"}), &ctx).await;
    assert!(result.contains("traversal"));
}

// ── write_file ──

#[tokio::test]
async fn write_file_creates_file_and_dirs() {
    let tmp = TempDir::new().unwrap();
    let tool = create_write_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({"path": "sub/dir/test.txt", "content": "hello world"}),
        &ctx,
    ).await;
    assert!(result.contains("Wrote 11 bytes"));
    assert_eq!(std::fs::read_to_string(tmp.path().join("sub/dir/test.txt")).unwrap(), "hello world");
}

// ── edit_file ──

#[tokio::test]
async fn edit_file_replaces_unique_string() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("code.py"), "def fib(n):\n    return n\n").unwrap();
    let tool = create_edit_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({
            "path": "code.py",
            "old_string": "return n",
            "new_string": "return fib(n-1) + fib(n-2) if n > 1 else n"
        }),
        &ctx,
    ).await;
    assert!(result.contains("Replaced 1"));
    let content = std::fs::read_to_string(tmp.path().join("code.py")).unwrap();
    assert!(content.contains("fib(n-1)"));
}

#[tokio::test]
async fn edit_file_rejects_ambiguous_match() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("dup.txt"), "foo bar foo baz foo").unwrap();
    let tool = create_edit_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({"path": "dup.txt", "old_string": "foo", "new_string": "qux"}),
        &ctx,
    ).await;
    assert!(result.contains("3 times"));
}

// ── list_files ──

#[tokio::test]
async fn list_files_finds_files() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("a.rs"), "").unwrap();
    std::fs::create_dir_all(tmp.path().join("src")).unwrap();
    std::fs::write(tmp.path().join("src/b.rs"), "").unwrap();
    let tool = create_list_files_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({}), &ctx).await;
    assert!(result.contains("a.rs"));
    assert!(result.contains("src/"));
}

// ── grep ──

#[tokio::test]
async fn grep_finds_matching_lines() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("code.py"), "def hello():\n    pass\ndef world():\n    pass\n").unwrap();
    let tool = create_grep_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"pattern": "def "}), &ctx).await;
    assert!(result.contains("code.py:1"));
    assert!(result.contains("def hello()"));
    assert!(result.contains("code.py:3"));
    assert!(result.contains("def world()"));
}

// ── think ──

#[tokio::test]
async fn think_returns_recorded() {
    let tool = create_think_tool();
    let ctx = make_ctx("/tmp");
    let result = (tool.execute)(serde_json::json!({"thought": "test reasoning"}), &ctx).await;
    assert_eq!(result, "Thought recorded.");
}

// ── web_fetch (network required) ──

#[tokio::test]
async fn web_fetch_gets_httpbin_json() {
    let tool = create_web_fetch_tool();
    let ctx = make_ctx("/tmp");
    let result = (tool.execute)(serde_json::json!({"url": "https://httpbin.org/json"}), &ctx).await;
    assert!(result.contains("HTTP 200"), "got: {result}");
    assert!(result.contains("slideshow"), "got: {result}");
}

// ── register_all_builtins ──

#[test]
fn register_all_builtins_registers_10_tools() {
    let mut registry = ToolRegistry::new();
    register_all_builtins(&mut registry, "/tmp/workspace");
    assert_eq!(registry.size(), 10);
    assert!(registry.has("bash"));
    assert!(registry.has("read_file"));
    assert!(registry.has("write_file"));
    assert!(registry.has("edit_file"));
    assert!(registry.has("list_files"));
    assert!(registry.has("grep"));
    assert!(registry.has("web_fetch"));
    assert!(registry.has("think"));
    assert!(registry.has("memory_store"));
    assert!(registry.has("memory_recall"));
}
