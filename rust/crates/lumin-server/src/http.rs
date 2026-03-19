//! HTTP handlers — /health, /v1/chat, /v1/artifacts
//! Now wired to real LLM via OpenAIProvider.

use axum::{
    extract::State,
    response::Json,
};
use lumin_core::provider::{OpenAIProvider, Provider, ChatRequest as LlmRequest, Message};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tracing::{info, error};

use super::AppState;

// ── Health ────────────────────────────────────────────────

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub runtime: String,
    pub loop_mode: String,
    pub uptime: f64,
}

pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: if state.config.llm.api_key.is_empty() { "degraded" } else { "ok" }.into(),
        version: "0.1.0-rust".into(),
        runtime: "lumin-rust".into(),
        loop_mode: state.loop_mode.to_string(),
        uptime: state.start_time.elapsed().as_secs_f64(),
    })
}

// ── Chat (real LLM) ──────────────────────────────────────

#[derive(Deserialize)]
pub struct ChatRequest {
    pub content: String,
    pub session_id: Option<String>,
    pub config: Option<ChatConfig>,
}

#[derive(Deserialize)]
pub struct ChatConfig {
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub max_iterations: Option<u32>,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub session_id: String,
    pub runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools_used: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageResponse>,
}

#[derive(Serialize)]
pub struct UsageResponse {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

pub async fn chat(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ChatRequest>,
) -> Json<ChatResponse> {
    let session_id = payload.session_id.unwrap_or_else(|| format!("rust-{}", uuid::Uuid::new_v4()));
    let start = Instant::now();

    // Resolve LLM config (request overrides > server config)
    let cfg_override = payload.config.as_ref();
    let base_url = cfg_override.and_then(|c| c.base_url.as_deref()).unwrap_or(&state.config.llm.base_url);
    let api_key = cfg_override.and_then(|c| c.api_key.as_deref()).unwrap_or(&state.config.llm.api_key);
    let model = cfg_override.and_then(|c| c.model.as_deref()).unwrap_or(&state.config.llm.model);
    let max_iterations = cfg_override.and_then(|c| c.max_iterations).unwrap_or(state.config.agent.max_iterations);

    if api_key.is_empty() {
        return Json(ChatResponse {
            status: "error".into(),
            response: None,
            thinking: None,
            error: Some("No API key configured".into()),
            session_id,
            runtime: "lumin-rust".into(),
            iterations: None,
            tools_used: None,
            duration_ms: Some(start.elapsed().as_millis() as u64),
            usage: None,
        });
    }

    let provider = OpenAIProvider::new(base_url, api_key, model);

    // Simple agent loop: LLM call → check for tool calls → repeat
    let system_prompt = "You are a research assistant. Be concise and precise.";
    let mut messages = vec![
        Message::system(system_prompt),
        Message::user(&payload.content),
    ];

    let mut tools_used: Vec<String> = Vec::new();
    let mut last_text = String::new();
    let mut last_thinking = None;
    let mut total_prompt_tokens = 0u32;
    let mut total_completion_tokens = 0u32;
    let mut iterations = 0u32;

    // Bash tool spec for LLM
    let bash_tool = serde_json::json!([{
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a bash command. Use for file operations, system commands.",
            "parameters": {
                "type": "object",
                "properties": { "command": { "type": "string", "description": "The bash command" } },
                "required": ["command"]
            }
        }
    }]);

    // Agent loop with tool execution
    let mut consecutive_errors = 0u32;
    for iter in 1..=max_iterations {
        iterations = iter;
        info!(iteration = iter, model, message_count = messages.len(), "llm_request");

        match provider.chat(LlmRequest {
            messages: messages.clone(),
            tools: Some(bash_tool.as_array().unwrap().clone()),
            model: Some(model.to_string()),
            max_tokens: Some(state.config.llm.max_tokens),
            stream: true,
        }).await {
            Ok(response) => {
                if let Some(usage) = &response.usage {
                    total_prompt_tokens += usage.prompt_tokens;
                    total_completion_tokens += usage.completion_tokens;
                }
                last_text = response.text.clone();
                last_thinking = response.thinking.clone();

                // No tool calls → add assistant text and break
                if response.tool_calls.is_empty() {
                    messages.push(Message::assistant(&response.text));
                    break;
                }

                // Has tool calls → add assistant message WITH tool_calls array (OpenAI format)
                let tc_json: Vec<serde_json::Value> = response.tool_calls.iter().map(|tc| {
                    serde_json::json!({
                        "id": tc.id,
                        "type": "function",
                        "function": { "name": tc.name, "arguments": serde_json::to_string(&tc.arguments).unwrap_or_default() }
                    })
                }).collect();
                messages.push(Message::assistant_with_tools(tc_json, response.thinking.clone()));

                // Execute tool calls
                let mut all_errors = true;
                for tc in &response.tool_calls {
                    tools_used.push(tc.name.clone());
                    info!(tool = %tc.name, "tool_start");

                    let result = if tc.name == "bash" {
                        let cmd = tc.arguments["command"].as_str().unwrap_or("");
                        match tokio::process::Command::new("/bin/sh")
                            .arg("-c").arg(cmd)
                            .current_dir(&state.config.workspace.dir)
                            .output().await
                        {
                            Ok(output) => {
                                all_errors = false;
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
                    } else {
                        format!("Error: unknown tool '{}'", tc.name)
                    };

                    info!(tool = %tc.name, result_len = result.len(), "tool_end");

                    // Add tool result with proper tool_call_id (OpenAI format)
                    messages.push(Message::tool_result(&tc.id, &result));
                }

                // Doom-loop detection
                if all_errors {
                    consecutive_errors += 1;
                    if consecutive_errors >= 3 {
                        last_text = "Repeated errors detected. Stopping.".into();
                        break;
                    }
                } else {
                    consecutive_errors = 0;
                }
            }
            Err(e) => {
                error!(error = %e, iteration = iter, "llm_error");
                return Json(ChatResponse {
                    status: "success".into(),
                    response: Some(format!("Error: {e}")),
                    thinking: None,
                    error: None,
                    session_id,
                    runtime: "lumin-rust".into(),
                    iterations: Some(iterations),
                    tools_used: None,
                    duration_ms: Some(start.elapsed().as_millis() as u64),
                    usage: None,
                });
            }
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;
    info!(iterations, duration_ms, tools = ?tools_used, "agent_complete");

    Json(ChatResponse {
        status: "success".into(),
        response: Some(last_text),
        thinking: last_thinking,
        error: None,
        session_id,
        runtime: "lumin-rust".into(),
        iterations: Some(iterations),
        tools_used: Some(tools_used),
        duration_ms: Some(duration_ms),
        usage: Some(UsageResponse {
            prompt_tokens: total_prompt_tokens,
            completion_tokens: total_completion_tokens,
        }),
    })
}

// ── Artifacts ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ArtifactRequest {
    pub url: String,
    pub mime_type: String,
    pub r#type: Option<String>,
}

#[derive(Serialize)]
pub struct ArtifactResponse {
    pub artifact_id: String,
    pub r#type: String,
    pub mime_type: String,
}

pub async fn artifacts(
    Json(payload): Json<ArtifactRequest>,
) -> Json<ArtifactResponse> {
    let artifact_type = payload.r#type.unwrap_or_else(|| {
        if payload.mime_type.starts_with("image/") { "image".into() } else { "file".into() }
    });

    Json(ArtifactResponse {
        artifact_id: uuid::Uuid::new_v4().to_string(),
        r#type: artifact_type,
        mime_type: payload.mime_type,
    })
}
