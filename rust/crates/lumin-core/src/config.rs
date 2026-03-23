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
    #[serde(default)]
    pub approval: ApprovalConfig,
    #[serde(default)]
    pub session: SessionConfig,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub event_bus: EventBusConfig,
    #[serde(default)]
    pub memory: MemoryConfig,
}

/// Approval gate for sensitive tools — mirrors TS `approval` config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalConfig {
    #[serde(default = "default_approval_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_sensitive_tools")]
    pub sensitive_tools: Vec<String>,
    #[serde(default = "default_bash_patterns")]
    pub bash_patterns: Vec<String>,
}

/// Session management — mirrors TS `session` config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    #[serde(default = "default_session_max_idle")]
    pub max_idle_ms: u64,
    #[serde(default = "default_cleanup_interval")]
    pub cleanup_interval_ms: u64,
}

/// Server internals — mirrors TS `server` config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_body_timeout")]
    pub body_timeout_ms: u64,
    #[serde(default = "default_ws_heartbeat")]
    pub ws_heartbeat_ms: u64,
    #[serde(default = "default_shutdown_timeout")]
    pub shutdown_timeout_ms: u64,
    #[serde(default = "default_cors_max_age")]
    pub cors_max_age: u32,
}

/// EventBus backpressure settings — mirrors TS `eventBus` config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventBusConfig {
    #[serde(default = "default_max_buffer")]
    pub max_buffer: usize,
}

/// Memory backend settings — mirrors TS `memory` config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    #[serde(default = "default_memory_backend")]
    pub backend: String,
    #[serde(default = "default_recent_context_max_chars")]
    pub recent_context_max_chars: usize,
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
fn default_base_url() -> String { "https://api.openai.com/v1".into() }
fn default_model() -> String { "gpt-4o".into() }
fn default_max_tokens() -> u32 { 8192 }
fn default_request_timeout() -> u64 { 300_000 }
fn default_max_iterations() -> u32 { 40 }
fn default_max_context_chars() -> usize { 600_000 }
fn default_loop_mode() -> String { "single".into() }
fn default_workspace_dir() -> String { "/workspace".into() }
fn default_plugin_path() -> String { "/opt/prismer/plugins/prismer-workspace/dist/src/tools.js".into() }
fn default_approval_timeout() -> u64 { 30_000 }
fn default_sensitive_tools() -> Vec<String> { vec!["bash".into()] }
fn default_bash_patterns() -> Vec<String> {
    vec![
        r"\brm\s".into(), r"\brmdir\b".into(), r"\bmv\s".into(),
        r"\bchmod\b".into(), r"\bchown\b".into(), r"\bkill\b".into(),
    ]
}
fn default_session_max_idle() -> u64 { 1_800_000 } // 30 min
fn default_cleanup_interval() -> u64 { 60_000 }
fn default_body_timeout() -> u64 { 30_000 }
fn default_ws_heartbeat() -> u64 { 30_000 }
fn default_shutdown_timeout() -> u64 { 5_000 }
fn default_cors_max_age() -> u32 { 86_400 }
fn default_max_buffer() -> usize { 1_000 }
fn default_memory_backend() -> String { "file".into() }
fn default_recent_context_max_chars() -> usize { 3_000 }

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

impl Default for ApprovalConfig {
    fn default() -> Self {
        Self {
            timeout_ms: default_approval_timeout(),
            sensitive_tools: default_sensitive_tools(),
            bash_patterns: default_bash_patterns(),
        }
    }
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            max_idle_ms: default_session_max_idle(),
            cleanup_interval_ms: default_cleanup_interval(),
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            body_timeout_ms: default_body_timeout(),
            ws_heartbeat_ms: default_ws_heartbeat(),
            shutdown_timeout_ms: default_shutdown_timeout(),
            cors_max_age: default_cors_max_age(),
        }
    }
}

impl Default for EventBusConfig {
    fn default() -> Self {
        Self { max_buffer: default_max_buffer() }
    }
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            backend: default_memory_backend(),
            recent_context_max_chars: default_recent_context_max_chars(),
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
            // Only strip the prismer-gateway/ prefix; keep other prefixes (e.g. openai/) intact
            cfg.llm.model = if v.starts_with("prismer-gateway/") {
                v.strip_prefix("prismer-gateway/").unwrap().to_string()
            } else {
                v
            };
        }
        if let Ok(v) = std::env::var("LUMIN_LOOP_MODE") { cfg.agent.loop_mode = v; }
        if let Ok(v) = std::env::var("WORKSPACE_DIR") { cfg.workspace.dir = v; }
        if let Ok(v) = std::env::var("MAX_CONTEXT_CHARS") { cfg.agent.max_context_chars = v.parse().unwrap_or(600_000); }

        // Approval
        if let Ok(v) = std::env::var("APPROVAL_TIMEOUT_MS") { cfg.approval.timeout_ms = v.parse().unwrap_or(30_000); }
        if let Ok(v) = std::env::var("SENSITIVE_TOOLS") {
            cfg.approval.sensitive_tools = v.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
        }

        // Session
        if let Ok(v) = std::env::var("SESSION_MAX_IDLE_MS") { cfg.session.max_idle_ms = v.parse().unwrap_or(1_800_000); }

        // Memory
        if let Ok(v) = std::env::var("MEMORY_BACKEND") { cfg.memory.backend = v; }

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
            approval: ApprovalConfig::default(),
            session: SessionConfig::default(),
            server: ServerConfig::default(),
            event_bus: EventBusConfig::default(),
            memory: MemoryConfig::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Mutex to serialize tests that mutate environment variables.
    // Required because env vars are process-global state.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Helper: set env vars, run a closure, then restore originals.
    fn with_env_vars<F: FnOnce()>(vars: &[(&str, &str)], f: F) {
        let _guard = ENV_LOCK.lock().unwrap();
        let saved: Vec<(&str, Option<String>)> = vars
            .iter()
            .map(|(k, _)| (*k, std::env::var(k).ok()))
            .collect();
        for (k, v) in vars {
            // SAFETY: test-only; serialized by ENV_LOCK so no concurrent access.
            unsafe { std::env::set_var(k, v); }
        }
        f();
        for (k, original) in &saved {
            match original {
                // SAFETY: test-only; serialized by ENV_LOCK.
                Some(v) => unsafe { std::env::set_var(k, v); },
                None => unsafe { std::env::remove_var(k); },
            }
        }
    }

    /// Helper: remove env vars, run closure, restore originals.
    fn without_env_vars<F: FnOnce()>(keys: &[&str], f: F) {
        let _guard = ENV_LOCK.lock().unwrap();
        let saved: Vec<(&str, Option<String>)> = keys
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        for k in keys {
            // SAFETY: test-only; serialized by ENV_LOCK.
            unsafe { std::env::remove_var(k); }
        }
        f();
        for (k, original) in &saved {
            if let Some(v) = original {
                // SAFETY: test-only; serialized by ENV_LOCK.
                unsafe { std::env::set_var(k, v); }
            }
        }
    }

    // ── Default values ──

    #[test]
    fn default_config() {
        let cfg = LuminConfig::default();
        assert_eq!(cfg.port, 3001);
        assert_eq!(cfg.llm.model, "gpt-4o");
        assert_eq!(cfg.agent.max_iterations, 40);
        assert_eq!(cfg.agent.loop_mode, "single");
    }

    #[test]
    fn default_values_for_all_fields() {
        let cfg = LuminConfig::default();
        assert_eq!(cfg.port, 3001);
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.llm.base_url, "https://api.openai.com/v1");
        assert_eq!(cfg.llm.api_key, "");
        assert_eq!(cfg.llm.model, "gpt-4o");
        assert!(cfg.llm.fallback_models.is_empty());
        assert_eq!(cfg.llm.max_tokens, 8192);
        assert_eq!(cfg.llm.request_timeout_ms, 300_000);
        assert_eq!(cfg.agent.max_iterations, 40);
        assert_eq!(cfg.agent.max_context_chars, 600_000);
        assert_eq!(cfg.agent.loop_mode, "single");
        assert_eq!(cfg.workspace.dir, "/workspace");
        assert_eq!(cfg.workspace.plugin_path, "/opt/prismer/plugins/prismer-workspace/dist/src/tools.js");
    }

    #[test]
    fn default_workspace_dir_is_workspace() {
        let cfg = LuminConfig::default();
        assert_eq!(cfg.workspace.dir, "/workspace");
    }

    #[test]
    fn default_base_url_is_openai() {
        let cfg = LuminConfig::default();
        assert_eq!(cfg.llm.base_url, "https://api.openai.com/v1");
    }

    // ── LlmConfig default ──

    #[test]
    fn llm_config_default() {
        let llm = LlmConfig::default();
        assert_eq!(llm.base_url, "https://api.openai.com/v1");
        assert_eq!(llm.api_key, "");
        assert_eq!(llm.model, "gpt-4o");
        assert!(llm.fallback_models.is_empty());
        assert_eq!(llm.max_tokens, 8192);
        assert_eq!(llm.request_timeout_ms, 300_000);
    }

    // ── AgentConfig default ──

    #[test]
    fn agent_config_default() {
        let agent = AgentConfig::default();
        assert_eq!(agent.max_iterations, 40);
        assert_eq!(agent.max_context_chars, 600_000);
        assert_eq!(agent.loop_mode, "single");
    }

    // ── WorkspaceConfig default ──

    #[test]
    fn workspace_config_default() {
        let ws = WorkspaceConfig::default();
        assert_eq!(ws.dir, "/workspace");
    }

    // ── from_env ──

    #[test]
    fn from_env_reads_openai_api_base_url() {
        with_env_vars(&[("OPENAI_API_BASE_URL", "http://myserver:5000/v1")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.llm.base_url, "http://myserver:5000/v1");
        });
    }

    #[test]
    fn from_env_reads_openai_api_key() {
        with_env_vars(&[("OPENAI_API_KEY", "sk-test-key-123")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.llm.api_key, "sk-test-key-123");
        });
    }

    #[test]
    fn from_env_reads_agent_default_model_with_prefix_stripping() {
        with_env_vars(&[("AGENT_DEFAULT_MODEL", "prismer-gateway/us-kimi-k2.5")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.llm.model, "us-kimi-k2.5");
        });
    }

    #[test]
    fn from_env_reads_agent_default_model_without_prefix_kept_as_is() {
        with_env_vars(&[("AGENT_DEFAULT_MODEL", "openai/gpt-4o")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.llm.model, "openai/gpt-4o");
        });
    }

    #[test]
    fn from_env_reads_agent_default_model_plain() {
        with_env_vars(&[("AGENT_DEFAULT_MODEL", "claude-sonnet-4")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.llm.model, "claude-sonnet-4");
        });
    }

    #[test]
    fn from_env_reads_lumin_loop_mode() {
        with_env_vars(&[("LUMIN_LOOP_MODE", "continuous")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.agent.loop_mode, "continuous");
        });
    }

    #[test]
    fn from_env_reads_workspace_dir() {
        with_env_vars(&[("WORKSPACE_DIR", "/home/user/workspace")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.workspace.dir, "/home/user/workspace");
        });
    }

    #[test]
    fn from_env_reads_max_context_chars() {
        with_env_vars(&[("MAX_CONTEXT_CHARS", "400000")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.agent.max_context_chars, 400_000);
        });
    }

    #[test]
    fn from_env_reads_lumin_port() {
        with_env_vars(&[("LUMIN_PORT", "8080")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.port, 8080);
        });
    }

    #[test]
    fn from_env_invalid_port_falls_back_to_default() {
        with_env_vars(&[("LUMIN_PORT", "not-a-number")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.port, 3001);
        });
    }

    #[test]
    fn from_env_invalid_max_context_chars_falls_back_to_default() {
        with_env_vars(&[("MAX_CONTEXT_CHARS", "abc")], || {
            let cfg = LuminConfig::from_env();
            assert_eq!(cfg.agent.max_context_chars, 600_000);
        });
    }

    #[test]
    fn from_env_defaults_when_no_env_vars() {
        without_env_vars(
            &[
                "LUMIN_PORT", "OPENAI_API_BASE_URL", "OPENAI_API_KEY",
                "AGENT_DEFAULT_MODEL", "LUMIN_LOOP_MODE", "WORKSPACE_DIR",
                "MAX_CONTEXT_CHARS",
            ],
            || {
                let cfg = LuminConfig::from_env();
                assert_eq!(cfg.port, 3001);
                assert_eq!(cfg.llm.base_url, "https://api.openai.com/v1");
                assert_eq!(cfg.llm.model, "gpt-4o");
                assert_eq!(cfg.agent.loop_mode, "single");
                assert_eq!(cfg.workspace.dir, "/workspace");
                assert_eq!(cfg.agent.max_context_chars, 600_000);
            },
        );
    }

    // ── Serde deserialization ──

    #[test]
    fn deserialize_empty_json_uses_defaults() {
        let cfg: LuminConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg.port, 3001);
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.llm.base_url, "https://api.openai.com/v1");
        assert_eq!(cfg.llm.model, "gpt-4o");
    }

    #[test]
    fn deserialize_nested_overrides() {
        let json = r#"{
            "port": 8080,
            "llm": { "model": "gpt-4o", "max_tokens": 4096 },
            "agent": { "max_iterations": 20 }
        }"#;
        let cfg: LuminConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.llm.model, "gpt-4o");
        assert_eq!(cfg.llm.max_tokens, 4096);
        // Defaults preserved for unspecified fields
        assert_eq!(cfg.llm.base_url, "https://api.openai.com/v1");
        assert_eq!(cfg.agent.max_iterations, 20);
        assert_eq!(cfg.agent.max_context_chars, 600_000);
    }
}
