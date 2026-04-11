//! Tool registry — mirrors TypeScript `tools.ts`.

pub mod builtins;

use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

/// Event emitted by a tool during execution via [`ToolContext::emit`].
#[derive(Debug, Clone)]
pub struct ToolEvent {
    pub event_type: String, // "directive", "progress", "output"
    pub data: serde_json::Value,
}

/// Emit callback type: tools call this to send events (directives, progress, etc.)
pub type EmitFn = Box<dyn Fn(ToolEvent) + Send + Sync>;

pub struct ToolContext {
    pub workspace_dir: String,
    pub session_id: String,
    pub agent_id: String,
    /// Optional emit callback — tools can publish directives/progress events through this.
    pub emit: Option<EmitFn>,
}

pub type ToolFn = Arc<
    dyn Fn(Value, &ToolContext) -> Pin<Box<dyn Future<Output = String> + Send + '_>>
        + Send
        + Sync,
>;

pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub execute: ToolFn,
    /// Return true if safe to run concurrently (read-only / no side effects).
    /// None = assume unsafe (serial). Mirrors TS `isConcurrencySafe`.
    pub is_concurrency_safe: Option<Arc<dyn Fn(&Value) -> bool + Send + Sync>>,
}

/// Resolve a user-supplied path to an absolute path within the workspace.
/// Returns Err if the resolved path escapes the workspace root.
/// Mirrors TS `safePath()` in `tools/builtins.ts:23-30`.
pub fn safe_path(user_path: &str, workspace_dir: &str) -> Result<PathBuf, String> {
    let base = PathBuf::from(workspace_dir)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(workspace_dir));
    let candidate = if PathBuf::from(user_path).is_absolute() {
        PathBuf::from(user_path)
    } else {
        base.join(user_path)
    };

    // Normalize by resolving . and .. components (mirrors path.resolve in TS)
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::ParentDir => { normalized.pop(); }
            std::path::Component::CurDir => {}
            other => normalized.push(other),
        }
    }

    if !normalized.starts_with(&base) {
        return Err(format!("Path traversal rejected: {user_path}"));
    }
    Ok(normalized)
}

pub struct ToolRegistry {
    tools: HashMap<String, Tool>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self { tools: HashMap::new() }
    }

    pub fn register(&mut self, tool: Tool) {
        self.tools.insert(tool.name.clone(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&Tool> {
        self.tools.get(name)
    }

    pub fn has(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    pub fn size(&self) -> usize {
        self.tools.len()
    }

    pub async fn execute(&self, name: &str, args: Value, ctx: &ToolContext) -> Result<String, String> {
        match self.tools.get(name) {
            Some(tool) => Ok((tool.execute)(args, ctx).await),
            None => Err(format!("Tool not found: {name}")),
        }
    }

    /// Create a filtered view of this registry.
    /// Mirrors TS `ToolRegistry.withFilter`.
    pub fn with_filter<F: Fn(&str) -> bool>(&self, predicate: F) -> ToolRegistry {
        let mut filtered = ToolRegistry::new();
        for (name, tool) in &self.tools {
            if predicate(name) {
                filtered.tools.insert(name.clone(), Tool {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    parameters: tool.parameters.clone(),
                    execute: tool.execute.clone(),
                    is_concurrency_safe: tool.is_concurrency_safe.clone(),
                });
            }
        }
        filtered
    }

    /// Get OpenAI-format tool specs for LLM.
    pub fn get_specs(&self) -> Vec<Value> {
        self.tools.values().map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            })
        }).collect()
    }

    /// Get tool specs filtered to only the allowed tool names.
    /// If `allowed` is empty, returns all specs (same as [`get_specs`]).
    pub fn get_specs_filtered(&self, allowed: &[String]) -> Vec<Value> {
        if allowed.is_empty() {
            return self.get_specs();
        }
        self.tools.values()
            .filter(|t| allowed.iter().any(|a| a == &t.name))
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self { Self::new() }
}

/// Create a no-op tool for testing.
#[cfg(test)]
fn create_test_tool(name: &str, description: &str) -> Tool {
    Tool {
        name: name.into(),
        description: description.into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "input": { "type": "string" } },
            "required": ["input"]
        }),
        execute: Arc::new(move |args, _ctx| {
            Box::pin(async move {
                format!("echo: {}", args["input"].as_str().unwrap_or(""))
            })
        }),
        is_concurrency_safe: None,
    }
}

/// Create a bash tool (container-sandboxed).
pub fn create_bash_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir.clone();
    Tool {
        name: "bash".into(),
        description: "Execute a bash command".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "command": { "type": "string" } },
            "required": ["command"]
        }),
        execute: Arc::new(move |args, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let cmd = args["command"].as_str().unwrap_or("");
                match tokio::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg(cmd)
                    .current_dir(&dir)
                    .output()
                    .await
                {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if output.status.success() {
                            stdout[..stdout.len().min(10_000)].to_string()
                        } else {
                            format!("Error: {}", &stderr[..stderr.len().min(5_000)])
                        }
                    }
                    Err(e) => format!("Error: {e}"),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ctx() -> ToolContext {
        ToolContext {
            workspace_dir: "/tmp".into(),
            session_id: "test-session".into(),
            agent_id: "test-agent".into(),
            emit: None,
        }
    }

    #[test]
    fn registry_new_is_empty() {
        let reg = ToolRegistry::new();
        assert_eq!(reg.size(), 0);
    }

    #[test]
    fn register_adds_tool() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("my_tool", "A test tool"));
        assert_eq!(reg.size(), 1);
    }

    #[test]
    fn get_returns_registered_tool() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("find", "Find files"));
        let tool = reg.get("find");
        assert!(tool.is_some());
        assert_eq!(tool.unwrap().name, "find");
        assert_eq!(tool.unwrap().description, "Find files");
    }

    #[test]
    fn get_returns_none_for_unregistered() {
        let reg = ToolRegistry::new();
        assert!(reg.get("nonexistent").is_none());
    }

    #[test]
    fn has_returns_true_for_registered() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("grep", "Search text"));
        assert!(reg.has("grep"));
    }

    #[test]
    fn has_returns_false_for_unregistered() {
        let reg = ToolRegistry::new();
        assert!(!reg.has("grep"));
    }

    #[test]
    fn size_counts_tools() {
        let mut reg = ToolRegistry::new();
        assert_eq!(reg.size(), 0);
        reg.register(create_test_tool("a", "tool a"));
        assert_eq!(reg.size(), 1);
        reg.register(create_test_tool("b", "tool b"));
        assert_eq!(reg.size(), 2);
    }

    #[test]
    fn get_specs_returns_openai_format() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("my_func", "Does stuff"));

        let specs = reg.get_specs();
        assert_eq!(specs.len(), 1);

        let spec = &specs[0];
        assert_eq!(spec["type"], "function");
        assert_eq!(spec["function"]["name"], "my_func");
        assert_eq!(spec["function"]["description"], "Does stuff");
        assert!(spec["function"]["parameters"].is_object());
        assert_eq!(spec["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn get_specs_multiple_tools() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("tool_a", "A"));
        reg.register(create_test_tool("tool_b", "B"));

        let specs = reg.get_specs();
        assert_eq!(specs.len(), 2);

        let names: Vec<&str> = specs.iter()
            .map(|s| s["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"tool_a"));
        assert!(names.contains(&"tool_b"));
    }

    #[tokio::test]
    async fn execute_returns_error_for_unknown_tool() {
        let reg = ToolRegistry::new();
        let ctx = make_ctx();
        let result = reg.execute("nonexistent", serde_json::json!({}), &ctx).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Tool not found"));
    }

    #[tokio::test]
    async fn execute_runs_tool_and_returns_result() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("echo", "Echo tool"));

        let ctx = make_ctx();
        let result = reg.execute("echo", serde_json::json!({"input": "hello"}), &ctx).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "echo: hello");
    }

    #[test]
    fn create_bash_tool_exists_and_has_correct_name() {
        let tool = create_bash_tool("/tmp".into());
        assert_eq!(tool.name, "bash");
        assert_eq!(tool.description, "Execute a bash command");
        assert!(tool.parameters["properties"]["command"].is_object());
    }

    #[test]
    fn default_creates_empty_registry() {
        let reg = ToolRegistry::default();
        assert_eq!(reg.size(), 0);
    }

    #[test]
    fn register_overwrites_existing_tool() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("dup", "Version 1"));
        reg.register(create_test_tool("dup", "Version 2"));
        assert_eq!(reg.size(), 1);
        assert_eq!(reg.get("dup").unwrap().description, "Version 2");
    }

    // ── bash tool tests ──

    #[tokio::test]
    async fn bash_tool_executes_simple_echo_command() {
        let tool = create_bash_tool("/tmp".into());
        let ctx = make_ctx();
        let result = (tool.execute)(serde_json::json!({"command": "echo hello"}), &ctx).await;
        assert_eq!(result.trim(), "hello");
    }

    #[tokio::test]
    async fn bash_tool_returns_stdout() {
        let tool = create_bash_tool("/tmp".into());
        let ctx = make_ctx();
        let result = (tool.execute)(serde_json::json!({"command": "printf 'line1\nline2\nline3'"}), &ctx).await;
        assert!(result.contains("line1"));
        assert!(result.contains("line2"));
        assert!(result.contains("line3"));
    }

    #[tokio::test]
    async fn bash_tool_truncates_output_over_limit() {
        let tool = create_bash_tool("/tmp".into());
        let ctx = make_ctx();
        // Generate output longer than 10K chars
        let result = (tool.execute)(
            serde_json::json!({"command": "printf '%0.s-' $(seq 1 15000)"}),
            &ctx,
        ).await;
        assert!(result.len() <= 10_000);
    }

    #[tokio::test]
    async fn bash_tool_handles_command_failure_gracefully() {
        let tool = create_bash_tool("/tmp".into());
        let ctx = make_ctx();
        let result = (tool.execute)(serde_json::json!({"command": "false"}), &ctx).await;
        // Should not panic; should return an error message
        assert!(result.starts_with("Error:") || result.is_empty());
    }

    #[test]
    fn bash_tool_json_schema_has_correct_properties() {
        let tool = create_bash_tool("/tmp".into());
        assert_eq!(tool.parameters["type"], "object");
        assert!(tool.parameters["properties"]["command"].is_object());
        assert_eq!(tool.parameters["properties"]["command"]["type"], "string");
        let required = tool.parameters["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "command"));
    }

    // ── get_specs format tests ──

    #[test]
    fn get_specs_empty_registry_returns_empty() {
        let reg = ToolRegistry::new();
        let specs = reg.get_specs();
        assert!(specs.is_empty());
    }

    #[test]
    fn get_specs_includes_parameters_with_required_field() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("test", "Test tool"));

        let specs = reg.get_specs();
        let spec = &specs[0];
        // Must match OpenAI function calling spec format
        assert_eq!(spec["type"], "function");
        assert!(spec["function"].is_object());
        assert!(spec["function"]["parameters"]["required"].is_array());
    }

    #[test]
    fn get_specs_description_included() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("my_tool", "A very descriptive description"));

        let specs = reg.get_specs();
        assert_eq!(specs[0]["function"]["description"], "A very descriptive description");
    }

    // ── register_many ──

    #[test]
    fn register_many_adds_multiple_tools() {
        let mut reg = ToolRegistry::new();
        let tools = vec![
            create_test_tool("tool_1", "First"),
            create_test_tool("tool_2", "Second"),
            create_test_tool("tool_3", "Third"),
        ];
        for t in tools {
            reg.register(t);
        }
        assert_eq!(reg.size(), 3);
        assert!(reg.has("tool_1"));
        assert!(reg.has("tool_2"));
        assert!(reg.has("tool_3"));
    }

    // ── execute with context ──

    #[tokio::test]
    async fn execute_passes_context_correctly() {
        let mut reg = ToolRegistry::new();
        // Create a tool that reads context fields
        let tool = Tool {
            name: "ctx_reader".into(),
            description: "Reads context".into(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
            execute: Arc::new(|_args, ctx| {
                Box::pin(async move {
                    format!("ws={} sess={} agent={}", ctx.workspace_dir, ctx.session_id, ctx.agent_id)
                })
            }),
            is_concurrency_safe: None,
        };
        reg.register(tool);

        let ctx = ToolContext {
            workspace_dir: "/my/workspace".into(),
            session_id: "sess-42".into(),
            agent_id: "agent-007".into(),
            emit: None,
        };
        let result = reg.execute("ctx_reader", serde_json::json!({}), &ctx).await.unwrap();
        assert!(result.contains("ws=/my/workspace"));
        assert!(result.contains("sess=sess-42"));
        assert!(result.contains("agent=agent-007"));
    }

    #[tokio::test]
    async fn execute_with_valid_tool_name_returns_ok() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("valid_tool", "Valid"));
        let ctx = make_ctx();
        let result = reg.execute("valid_tool", serde_json::json!({"input": "test"}), &ctx).await;
        assert!(result.is_ok());
    }

    // ── Tool with complex parameter schema ──

    #[test]
    fn tool_with_complex_parameter_schema() {
        let tool = Tool {
            name: "complex".into(),
            description: "Complex params".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path" },
                    "options": {
                        "type": "object",
                        "properties": {
                            "recursive": { "type": "boolean" },
                            "depth": { "type": "integer" }
                        }
                    }
                },
                "required": ["path"]
            }),
            execute: Arc::new(|_args, _ctx| {
                Box::pin(async { "ok".to_string() })
            }),
            is_concurrency_safe: None,
        };
        let mut reg = ToolRegistry::new();
        reg.register(tool);

        let specs = reg.get_specs();
        let params = &specs[0]["function"]["parameters"];
        assert!(params["properties"]["options"]["properties"]["recursive"].is_object());
        assert_eq!(params["properties"]["options"]["properties"]["depth"]["type"], "integer");
    }

    // ── Re-register tool with same name overwrites (additional check) ──

    #[tokio::test]
    async fn re_register_tool_overwrites_behavior() {
        let mut reg = ToolRegistry::new();

        // Register first version
        let tool_v1 = Tool {
            name: "versioned".into(),
            description: "V1".into(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
            execute: Arc::new(|_args, _ctx| {
                Box::pin(async { "version-1".to_string() })
            }),
            is_concurrency_safe: None,
        };
        reg.register(tool_v1);

        // Register second version with same name
        let tool_v2 = Tool {
            name: "versioned".into(),
            description: "V2".into(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
            execute: Arc::new(|_args, _ctx| {
                Box::pin(async { "version-2".to_string() })
            }),
            is_concurrency_safe: None,
        };
        reg.register(tool_v2);

        let ctx = make_ctx();
        let result = reg.execute("versioned", serde_json::json!({}), &ctx).await.unwrap();
        assert_eq!(result, "version-2");
        assert_eq!(reg.get("versioned").unwrap().description, "V2");
    }

    #[tokio::test]
    async fn bash_tool_handles_empty_command() {
        let tool = create_bash_tool("/tmp".into());
        let ctx = make_ctx();
        // Empty command should not panic
        let result = (tool.execute)(serde_json::json!({"command": ""}), &ctx).await;
        // Just ensure it doesn't panic; result is implementation-defined
        let _ = result;
    }

    #[tokio::test]
    async fn bash_tool_handles_missing_command_key() {
        let tool = create_bash_tool("/tmp".into());
        let ctx = make_ctx();
        // Missing "command" key — as_str returns None, defaults to ""
        let result = (tool.execute)(serde_json::json!({}), &ctx).await;
        let _ = result;
    }

    #[test]
    fn get_specs_all_tools_have_function_type() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("a", "A"));
        reg.register(create_test_tool("b", "B"));
        reg.register(create_test_tool("c", "C"));

        for spec in reg.get_specs() {
            assert_eq!(spec["type"], "function");
            assert!(spec["function"]["name"].is_string());
            assert!(spec["function"]["description"].is_string());
            assert!(spec["function"]["parameters"].is_object());
        }
    }

    // ── get_specs_filtered tests ──

    #[test]
    fn get_specs_filtered_returns_subset() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("bash", "Execute bash"));
        reg.register(create_test_tool("read_file", "Read a file"));
        reg.register(create_test_tool("write_file", "Write a file"));
        reg.register(create_test_tool("echo", "Echo text"));

        let allowed = vec!["bash".to_string(), "echo".to_string()];
        let specs = reg.get_specs_filtered(&allowed);

        assert_eq!(specs.len(), 2);
        let names: Vec<&str> = specs.iter()
            .map(|s| s["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"bash"));
        assert!(names.contains(&"echo"));
        assert!(!names.contains(&"read_file"));
        assert!(!names.contains(&"write_file"));
    }

    #[test]
    fn get_specs_filtered_empty_allowed_returns_all() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("a", "A"));
        reg.register(create_test_tool("b", "B"));
        reg.register(create_test_tool("c", "C"));

        let specs = reg.get_specs_filtered(&[]);
        assert_eq!(specs.len(), 3);
    }

    #[test]
    fn get_specs_filtered_unknown_names_ignored() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("bash", "Bash"));
        reg.register(create_test_tool("echo", "Echo"));

        let allowed = vec!["bash".to_string(), "nonexistent".to_string()];
        let specs = reg.get_specs_filtered(&allowed);
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0]["function"]["name"], "bash");
    }

    #[test]
    fn get_specs_filtered_all_unknown_returns_empty() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("bash", "Bash"));

        let allowed = vec!["foo".to_string(), "bar".to_string()];
        let specs = reg.get_specs_filtered(&allowed);
        assert!(specs.is_empty());
    }

    #[test]
    fn with_filter_excludes_tools() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("bash", "run commands"));
        reg.register(create_test_tool("read", "read files"));
        reg.register(create_test_tool("delegate", "delegate"));
        let filtered = reg.with_filter(|name| name != "delegate");
        assert_eq!(filtered.size(), 2);
        assert!(filtered.has("bash"));
        assert!(filtered.has("read"));
        assert!(!filtered.has("delegate"));
    }

    #[test]
    fn with_filter_empty_keeps_none() {
        let mut reg = ToolRegistry::new();
        reg.register(create_test_tool("bash", "run commands"));
        let filtered = reg.with_filter(|_| false);
        assert_eq!(filtered.size(), 0);
    }

    // ── path safety tests (mirrors TS safePath in builtins.ts:23-30) ──

    #[test]
    fn safe_path_resolves_relative() {
        let result = super::safe_path("src/main.rs", "/workspace");
        assert_eq!(result.unwrap(), std::path::PathBuf::from("/workspace/src/main.rs"));
    }

    #[test]
    fn safe_path_rejects_traversal() {
        let result = super::safe_path("../etc/passwd", "/workspace");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("traversal"));
    }

    #[test]
    fn safe_path_rejects_absolute_escape() {
        let result = super::safe_path("/etc/passwd", "/workspace");
        assert!(result.is_err());
    }

    #[test]
    fn safe_path_allows_workspace_root() {
        let result = super::safe_path(".", "/workspace");
        assert_eq!(result.unwrap(), std::path::PathBuf::from("/workspace"));
    }

    #[test]
    fn safe_path_normalizes_dot_segments() {
        let result = super::safe_path("src/../src/main.rs", "/workspace");
        assert_eq!(result.unwrap(), std::path::PathBuf::from("/workspace/src/main.rs"));
    }
}
