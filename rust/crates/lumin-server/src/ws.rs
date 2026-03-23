//! WebSocket handler — /v1/stream endpoint.
//! Same protocol as TypeScript: connected → lifecycle.start → text.delta → tool.start/end → chat.final

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::IntoResponse,
};
use lumin_core::provider::OpenAIProvider;
use lumin_core::{PrismerAgent, AgentOptions, ToolRegistry, Session, PromptBuilder};
use lumin_core::tools::create_bash_tool;
use lumin_core::sse::{EventBus, AgentEvent};
use serde_json::json;
use std::sync::Arc;
use tracing::error;

use super::AppState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let session_id = format!("ws-rust-{}", uuid::Uuid::new_v4());

    // Send connected message
    let _ = socket.send(Message::Text(json!({
        "type": "connected",
        "sessionId": session_id,
        "version": "0.1.0-rust",
        "runtime": "lumin-rust",
    }).to_string().into())).await;

    // Process incoming messages
    while let Some(Ok(msg)) = socket.recv().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Ping(d) => { let _ = socket.send(Message::Pong(d)).await; continue; }
            Message::Close(_) => break,
            _ => continue,
        };

        let parsed: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                let _ = socket.send(Message::Text(json!({"type":"error","message":"Invalid JSON"}).to_string().into())).await;
                continue;
            }
        };

        let msg_type = parsed["type"].as_str().unwrap_or("");

        if msg_type == "ping" {
            let _ = socket.send(Message::Text(json!({"type":"pong","timestamp": chrono_now()}).to_string().into())).await;
            continue;
        }

        if msg_type != "chat.send" {
            let _ = socket.send(Message::Text(json!({"type":"error","message":format!("Unknown type: {msg_type}")}).to_string().into())).await;
            continue;
        }

        let content = parsed["content"].as_str().unwrap_or("");
        if content.is_empty() {
            let _ = socket.send(Message::Text(json!({"type":"error","message":"content is required"}).to_string().into())).await;
            continue;
        }

        // Emit lifecycle.start
        let _ = socket.send(Message::Text(json!({"type":"lifecycle.start","sessionId":&session_id}).to_string().into())).await;

        // Set up agent infrastructure
        let provider = OpenAIProvider::new(
            &state.config.llm.base_url,
            &state.config.llm.api_key,
            &state.config.llm.model,
        );

        let mut tools = ToolRegistry::new();
        tools.register(create_bash_tool(state.config.workspace.dir.clone()));

        let bus = Arc::new(EventBus::default());

        // Subscribe to bus events and forward to WebSocket
        let mut rx = bus.subscribe();

        let mut pb = PromptBuilder::new(&state.config.workspace.dir);
        pb.load_identity();
        pb.load_tools_ref();
        pb.load_user_profile();
        pb.add_runtime_info(Some("researcher"), Some(&state.config.llm.model), Some(tools.size()));
        let system_prompt = pb.build();

        let mut session = Session::new(&session_id);

        let agent = PrismerAgent::new(
            Arc::new(provider),
            Arc::new(tools),
            bus.clone(),
            system_prompt,
            state.config.llm.model.clone(),
            "researcher".into(),
            state.config.workspace.dir.clone(),
        ).with_options(AgentOptions {
            max_iterations: state.config.agent.max_iterations,
            max_context_chars: state.config.agent.max_context_chars,
            ..AgentOptions::default()
        });

        // Run agent and collect events
        let result = agent.process_message(content, &mut session).await;

        // Drain bus events and forward to WebSocket
        while let Ok(event) = rx.try_recv() {
            let ws_msg = match event.event_type.as_str() {
                "text.delta" => json!({"type":"text.delta","delta": event.data["delta"]}),
                "tool.start" => json!({"type":"tool.start","tool": event.data["tool"],"toolId": event.data["toolId"]}),
                "tool.end" => json!({"type":"tool.end","tool": event.data["tool"],"toolId": event.data["toolId"],"result": event.data["result"]}),
                "error" => json!({"type":"error","message": event.data["error"]}),
                _ => continue,
            };
            let _ = socket.send(Message::Text(ws_msg.to_string().into())).await;
        }

        // Emit chat.final
        match result {
            Ok(result) => {
                let _ = socket.send(Message::Text(json!({
                    "type": "chat.final",
                    "content": result.text,
                    "thinking": result.thinking,
                    "toolsUsed": result.tools_used,
                    "sessionId": session_id,
                    "runtime": "lumin-rust",
                }).to_string().into())).await;
            }
            Err(e) => {
                error!(error = %e, "ws_agent_error");
                let _ = socket.send(Message::Text(json!({
                    "type": "chat.final",
                    "content": format!("Error: {e}"),
                    "thinking": null,
                    "toolsUsed": [],
                    "sessionId": session_id,
                    "runtime": "lumin-rust",
                }).to_string().into())).await;
            }
        }
    }
}

fn chrono_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
