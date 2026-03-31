//! HTTP handlers — /health, /v1/chat, /v1/artifacts
//! Now wired through PrismerAgent for full agent loop.

use axum::{
    extract::State,
    response::Json,
};
use lumin_core::provider::{OpenAIProvider, FallbackProvider, Provider};
use lumin_core::task::TaskStore;
use lumin_core::{PrismerAgent, AgentOptions, ToolRegistry, PromptBuilder, MemoryStore, Tool};
use lumin_core::tools::create_bash_tool;
use lumin_core::sse::EventBus;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tracing::{info, error};

use super::AppState;

// ── Health ────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
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
        runtime: "lumin".into(),
        loop_mode: state.loop_mode.to_string(),
        uptime: state.start_time.elapsed().as_secs_f64(),
    })
}

// ── Chat (via PrismerAgent) ──────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub content: String,
    #[serde(alias = "session_id")]
    pub session_id: Option<String>,
    pub config: Option<ChatConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfig {
    pub model: Option<String>,
    #[serde(alias = "base_url")]
    pub base_url: Option<String>,
    #[serde(alias = "api_key")]
    pub api_key: Option<String>,
    #[serde(alias = "max_iterations")]
    pub max_iterations: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
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
    pub loop_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
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
#[serde(rename_all = "camelCase")]
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
            runtime: "lumin".into(),
            loop_mode: state.loop_mode.to_string(),
            task_id: None,
            iterations: None,
            tools_used: None,
            duration_ms: Some(start.elapsed().as_millis() as u64),
            usage: None,
        });
    }

    // Dual-loop mode: create task and return immediately
    if state.loop_mode == lumin_core::LoopMode::Dual {
        let task_id = uuid::Uuid::new_v4().to_string();
        info!(task_id = %task_id, "dual-loop task created");

        // Spawn background execution
        let config = state.config.clone();
        let content = payload.content.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let provider = OpenAIProvider::new(&config.llm.base_url, &config.llm.api_key, &config.llm.model);
            let mut tools = ToolRegistry::new();
            tools.register(create_bash_tool(config.workspace.dir.clone()));
            let bus = Arc::new(EventBus::default());
            let mut pb = PromptBuilder::new(&config.workspace.dir);
            pb.load_identity();
            pb.add_runtime_info(Some("dual-loop"), Some(&config.llm.model), Some(tools.size()));
            let system_prompt = pb.build();
            let mut session = lumin_core::Session::new(&sid);
            let agent = PrismerAgent::new(
                Arc::new(provider), Arc::new(tools), bus, system_prompt,
                config.llm.model.clone(), "dual-loop".into(), config.workspace.dir.clone(),
            );
            let _ = agent.process_message(&content, &mut session, None).await;
        });

        return Json(ChatResponse {
            status: "success".into(),
            response: Some(format!("Task {task_id} created and executing.")),
            thinking: None,
            error: None,
            session_id,
            runtime: "lumin".into(),
            loop_mode: "dual".into(),
            task_id: Some(task_id),
            iterations: Some(0),
            tools_used: Some(vec![]),
            duration_ms: Some(start.elapsed().as_millis() as u64),
            usage: None,
        });
    }

    let base_provider = OpenAIProvider::new(base_url, api_key, model);
    let fallbacks = state.config.llm.fallback_models.clone();
    let provider: Arc<dyn Provider> = if fallbacks.is_empty() {
        Arc::new(base_provider)
    } else {
        Arc::new(FallbackProvider::new(base_provider, fallbacks))
    };

    // Set up tools (bash + memory_store + memory_recall — matching TS)
    let mut tools = ToolRegistry::new();
    tools.register(create_bash_tool(state.config.workspace.dir.clone()));
    let workspace_dir = state.config.workspace.dir.clone();
    {
        let wd = workspace_dir.clone();
        tools.register(Tool {
            name: "memory_store".into(),
            description: "Store a memory entry for later recall.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The memory content to store" },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional tags" }
                },
                "required": ["content"]
            }),
            execute: std::sync::Arc::new(move |args, _ctx| {
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
        });
    }
    {
        let wd = workspace_dir.clone();
        tools.register(Tool {
            name: "memory_recall".into(),
            description: "Search stored memories by keywords.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Keywords to search for" }
                },
                "required": ["query"]
            }),
            execute: std::sync::Arc::new(move |args, _ctx| {
                let wd = wd.clone();
                Box::pin(async move {
                    let mem = MemoryStore::new(&wd);
                    let query = args["query"].as_str().unwrap_or("");
                    match mem.recall(query, 4000) {
                        Some(result) => result,
                        None => "No matching memories found.".into(),
                    }
                })
            }),
            is_concurrency_safe: None,
        });
    }

    // Set up EventBus
    let bus = Arc::new(EventBus::default());

    // Build system prompt
    let mut pb = PromptBuilder::new(&state.config.workspace.dir);
    pb.load_identity();
    pb.load_tools_ref();
    pb.load_user_profile();
    pb.add_runtime_info(Some("researcher"), Some(model), Some(tools.size()));
    let system_prompt = pb.build();

    // Get or create session (persistent across requests)
    let mut session = state.sessions.get_or_create(&session_id);

    let agent = PrismerAgent::new(
        provider,
        Arc::new(tools),
        bus,
        system_prompt,
        model.to_string(),
        "researcher".into(),
        state.config.workspace.dir.clone(),
    ).with_options(AgentOptions {
        max_iterations,
        max_context_chars: state.config.agent.max_context_chars,
        ..AgentOptions::default()
    });

    match agent.process_message(&payload.content, &mut session, None).await {
        Ok(result) => {
            // Persist session for multi-turn
            state.sessions.update(session);

            let duration_ms = start.elapsed().as_millis() as u64;
            info!(iterations = result.iterations, duration_ms, tools = ?result.tools_used, "agent_complete");

            Json(ChatResponse {
                status: "success".into(),
                response: Some(result.text),
                thinking: result.thinking,
                error: None,
                session_id,
                runtime: "lumin".into(),
                loop_mode: state.loop_mode.to_string(),
                task_id: None,
                iterations: Some(result.iterations),
                tools_used: Some(result.tools_used),
                duration_ms: Some(duration_ms),
                usage: result.usage.map(|u| UsageResponse {
                    prompt_tokens: u.prompt_tokens,
                    completion_tokens: u.completion_tokens,
                }),
            })
        }
        Err(e) => {
            error!(error = %e, "agent_error");
            Json(ChatResponse {
                status: "error".into(),
                response: None,
                thinking: None,
                error: Some(e),
                session_id,
                runtime: "lumin".into(),
                loop_mode: state.loop_mode.to_string(),
                task_id: None,
                iterations: None,
                tools_used: None,
                duration_ms: Some(start.elapsed().as_millis() as u64),
                usage: None,
            })
        }
    }
}

// ── Tools ─────────────────────────────────────────────────

/// GET /v1/tools — list registered tools in OpenAI format.
/// Mirrors TS `handleTools()` in server.ts.
pub async fn list_tools(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let mut tools = ToolRegistry::new();
    tools.register(create_bash_tool(state.config.workspace.dir.clone()));

    // memory_store + memory_recall
    let wd = state.config.workspace.dir.clone();
    tools.register(Tool {
        name: "memory_store".into(),
        description: "Store a memory entry for later recall.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "The memory content to store" },
                "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional tags" }
            },
            "required": ["content"]
        }),
        execute: std::sync::Arc::new(move |_args, _ctx| {
            Box::pin(async move { String::new() })
        }),
        is_concurrency_safe: None,
    });
    let wd2 = state.config.workspace.dir.clone();
    tools.register(Tool {
        name: "memory_recall".into(),
        description: "Search stored memories by keywords.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Keywords to search for" }
            },
            "required": ["query"]
        }),
        execute: std::sync::Arc::new(move |_args, _ctx| {
            Box::pin(async move { String::new() })
        }),
        is_concurrency_safe: None,
    });

    let specs = tools.get_specs();
    Json(serde_json::json!({ "tools": specs, "count": specs.len() }))
}

// ── Artifacts ─────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRequest {
    pub url: String,
    #[serde(alias = "mime_type")]
    pub mime_type: String,
    pub r#type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
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

// ── Task Polling ──────────────────────────────────────────

pub async fn list_tasks(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let tasks = state.tasks.list();
    Json(serde_json::json!({ "tasks": tasks, "count": tasks.len() }))
}

pub async fn get_task(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    match state.tasks.get(&id) {
        Some(task) => Json(serde_json::json!(task)),
        None => Json(serde_json::json!({ "error": format!("Task {} not found", id) })),
    }
}
