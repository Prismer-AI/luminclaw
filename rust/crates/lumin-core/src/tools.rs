//! Tool registry — mirrors TypeScript `tools.ts`.

use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub struct ToolContext {
    pub workspace_dir: String,
    pub session_id: String,
    pub agent_id: String,
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
}

impl Default for ToolRegistry {
    fn default() -> Self { Self::new() }
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
    }
}
