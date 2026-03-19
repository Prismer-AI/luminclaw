//! WebSocket handler — /v1/stream endpoint.
//! Same protocol as TypeScript: connected → lifecycle.start → text.delta → tool.start/end → chat.final

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::IntoResponse,
};
use lumin_core::provider::{OpenAIProvider, Provider, ChatRequest as LlmRequest, Message as LlmMessage};
use serde_json::json;
use std::sync::Arc;
use tracing::{info, error};

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

        // Run agent
        let provider = OpenAIProvider::new(
            &state.config.llm.base_url,
            &state.config.llm.api_key,
            &state.config.llm.model,
        );

        let tool_spec = json!([{
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Execute a bash command",
                "parameters": {"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}
            }
        }]);

        let mut messages = vec![
            LlmMessage::system("You are a research assistant. Be concise."),
            LlmMessage::user(content),
        ];

        let mut tools_used: Vec<String> = Vec::new();
        let mut final_text = String::new();
        let mut final_thinking = None;
        let max_iterations = state.config.agent.max_iterations;

        for iter in 1..=max_iterations {
            info!(iteration = iter, "ws_llm_request");

            match provider.chat(LlmRequest {
                messages: messages.clone(),
                tools: Some(tool_spec.as_array().unwrap().clone()),
                model: Some(state.config.llm.model.clone()),
                max_tokens: Some(state.config.llm.max_tokens),
                stream: true,
            }).await {
                Ok(response) => {
                    final_text = response.text.clone();
                    final_thinking = response.thinking.clone();

                    if response.tool_calls.is_empty() {
                        // Emit text.delta
                        if !response.text.is_empty() {
                            let _ = socket.send(Message::Text(json!({"type":"text.delta","delta":&response.text}).to_string().into())).await;
                        }
                        messages.push(LlmMessage::assistant(&response.text));
                        break;
                    }

                    // Has tool calls
                    let tc_json: Vec<serde_json::Value> = response.tool_calls.iter().map(|tc| {
                        json!({"id":tc.id,"type":"function","function":{"name":tc.name,"arguments":serde_json::to_string(&tc.arguments).unwrap_or_default()}})
                    }).collect();
                    messages.push(LlmMessage::assistant_with_tools(tc_json, response.thinking.clone()));

                    for tc in &response.tool_calls {
                        tools_used.push(tc.name.clone());

                        // Emit tool.start
                        let _ = socket.send(Message::Text(json!({"type":"tool.start","tool":&tc.name,"toolId":&tc.id}).to_string().into())).await;

                        let result = if tc.name == "bash" {
                            let cmd = tc.arguments["command"].as_str().unwrap_or("");
                            match tokio::process::Command::new("/bin/sh").arg("-c").arg(cmd)
                                .current_dir(&state.config.workspace.dir).output().await {
                                Ok(o) => {
                                    let s = String::from_utf8_lossy(if o.status.success() { &o.stdout } else { &o.stderr });
                                    s[..s.len().min(10_000)].to_string()
                                }
                                Err(e) => format!("Error: {e}"),
                            }
                        } else {
                            format!("Error: unknown tool '{}'", tc.name)
                        };

                        // Emit tool.end
                        let _ = socket.send(Message::Text(json!({"type":"tool.end","tool":&tc.name,"toolId":&tc.id,"result":&result[..result.len().min(200)]}).to_string().into())).await;

                        messages.push(LlmMessage::tool_result(&tc.id, &result));
                    }
                }
                Err(e) => {
                    error!(error = %e, "ws_llm_error");
                    let _ = socket.send(Message::Text(json!({"type":"error","message":e.to_string()}).to_string().into())).await;
                    final_text = format!("Error: {e}");
                    break;
                }
            }
        }

        // Emit chat.final
        let _ = socket.send(Message::Text(json!({
            "type": "chat.final",
            "content": final_text,
            "thinking": final_thinking,
            "toolsUsed": tools_used,
            "sessionId": session_id,
            "runtime": "lumin-rust",
        }).to_string().into())).await;
    }
}

fn chrono_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
