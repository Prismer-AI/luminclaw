//! Runtime configuration — mirrors TypeScript `config.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LuminConfig {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default)]
    pub llm: LlmConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub workspace: WorkspaceConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub fallback_models: Vec<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_request_timeout")]
    pub request_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    #[serde(default = "default_max_context_chars")]
    pub max_context_chars: usize,
    #[serde(default = "default_loop_mode")]
    pub loop_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    #[serde(default = "default_workspace_dir")]
    pub dir: String,
    #[serde(default = "default_plugin_path")]
    pub plugin_path: String,
}

// Defaults
fn default_port() -> u16 { 3001 }
fn default_host() -> String { "0.0.0.0".into() }
fn default_base_url() -> String { "http://localhost:3000/v1".into() }
fn default_model() -> String { "us-kimi-k2.5".into() }
fn default_max_tokens() -> u32 { 8192 }
fn default_request_timeout() -> u64 { 300_000 }
fn default_max_iterations() -> u32 { 40 }
fn default_max_context_chars() -> usize { 600_000 }
fn default_loop_mode() -> String { "single".into() }
fn default_workspace_dir() -> String { "/workspace".into() }
fn default_plugin_path() -> String { "/opt/prismer/plugins/prismer-workspace/dist/src/tools.js".into() }

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            base_url: default_base_url(),
            api_key: String::new(),
            model: default_model(),
            fallback_models: vec![],
            max_tokens: default_max_tokens(),
            request_timeout_ms: default_request_timeout(),
        }
    }
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_iterations: default_max_iterations(),
            max_context_chars: default_max_context_chars(),
            loop_mode: default_loop_mode(),
        }
    }
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            dir: default_workspace_dir(),
            plugin_path: default_plugin_path(),
        }
    }
}

impl LuminConfig {
    /// Load configuration from environment variables.
    pub fn from_env() -> Self {
        let mut cfg = Self::default();

        if let Ok(v) = std::env::var("LUMIN_PORT") { cfg.port = v.parse().unwrap_or(3001); }
        if let Ok(v) = std::env::var("OPENAI_API_BASE_URL") { cfg.llm.base_url = v; }
        if let Ok(v) = std::env::var("OPENAI_API_KEY") { cfg.llm.api_key = v; }
        if let Ok(v) = std::env::var("AGENT_DEFAULT_MODEL") {
            cfg.llm.model = if v.contains('/') { v.split('/').last().unwrap_or(&v).to_string() } else { v };
        }
        if let Ok(v) = std::env::var("LUMIN_LOOP_MODE") { cfg.agent.loop_mode = v; }
        if let Ok(v) = std::env::var("WORKSPACE_DIR") { cfg.workspace.dir = v; }
        if let Ok(v) = std::env::var("MAX_CONTEXT_CHARS") { cfg.agent.max_context_chars = v.parse().unwrap_or(600_000); }

        cfg
    }
}

impl Default for LuminConfig {
    fn default() -> Self {
        Self {
            port: default_port(),
            host: default_host(),
            llm: LlmConfig::default(),
            agent: AgentConfig::default(),
            workspace: WorkspaceConfig::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config() {
        let cfg = LuminConfig::default();
        assert_eq!(cfg.port, 3001);
        assert_eq!(cfg.llm.model, "us-kimi-k2.5");
        assert_eq!(cfg.agent.max_iterations, 40);
        assert_eq!(cfg.agent.loop_mode, "single");
    }
}
