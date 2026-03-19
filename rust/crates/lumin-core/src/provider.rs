//! OpenAI-compatible LLM provider — with SSE streaming support.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use futures::StreamExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Tool calls in the assistant message (OpenAI format).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<serde_json::Value>>,
    /// Tool call ID for role="tool" messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Reasoning content — required by Kimi K2.5 for assistant tool call messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

impl Message {
    pub fn system(content: &str) -> Self {
        Self { role: "system".into(), content: Some(content.into()), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn user(content: &str) -> Self {
        Self { role: "user".into(), content: Some(content.into()), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn assistant(content: &str) -> Self {
        Self { role: "assistant".into(), content: Some(content.into()), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn assistant_with_tools(tool_calls: Vec<serde_json::Value>, reasoning: Option<String>) -> Self {
        Self { role: "assistant".into(), content: Some(String::new()), tool_calls: Some(tool_calls), tool_call_id: None, reasoning_content: reasoning }
    }
    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        Self { role: "tool".into(), content: Some(content.into()), tool_calls: None, tool_call_id: Some(tool_call_id.into()), reasoning_content: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub messages: Vec<Message>,
    pub tools: Option<Vec<serde_json::Value>>,
    pub model: Option<String>,
    pub max_tokens: Option<u32>,
    pub stream: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub thinking: Option<String>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, ProviderError>;
    fn name(&self) -> &str;
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("HTTP error {status}: {body}")]
    Http { status: u16, body: String },
    #[error("Network error: {0}")]
    Network(String),
    #[error("Parse error: {0}")]
    Parse(String),
}

pub struct OpenAIProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    default_model: String,
}

impl OpenAIProvider {
    pub fn new(base_url: &str, api_key: &str, default_model: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("HTTP client");
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            default_model: default_model.to_string(),
        }
    }

    /// Non-streaming call.
    async fn chat_batch(&self, request: &ChatRequest) -> Result<ChatResponse, ProviderError> {
        let model = request.model.as_deref().unwrap_or(&self.default_model);
        let mut body = serde_json::json!({
            "model": model,
            "messages": request.messages,
        });
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = serde_json::json!(max_tokens);
        }
        if let Some(tools) = &request.tools {
            body["tools"] = serde_json::json!(tools);
        }

        let res = self.client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send().await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| ProviderError::Network(e.to_string()))?;
        if status != 200 {
            return Err(ProviderError::Http { status, body: text });
        }

        Self::parse_response(&text)
    }

    /// Streaming SSE call — processes tokens as they arrive.
    async fn chat_stream(&self, request: &ChatRequest) -> Result<ChatResponse, ProviderError> {
        let model = request.model.as_deref().unwrap_or(&self.default_model);
        let mut body = serde_json::json!({
            "model": model,
            "messages": request.messages,
            "stream": true,
        });
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = serde_json::json!(max_tokens);
        }
        if let Some(tools) = &request.tools {
            body["tools"] = serde_json::json!(tools);
        }

        let res = self.client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send().await
            .map_err(|e| ProviderError::Network(e.to_string()))?;

        let status = res.status().as_u16();
        if status != 200 {
            let text = res.text().await.unwrap_or_default();
            return Err(ProviderError::Http { status, body: text });
        }

        // Parse SSE stream
        let mut text_parts = Vec::new();
        let mut thinking_parts = Vec::new();
        let mut tool_calls: Vec<ToolCallAccum> = Vec::new();
        let mut usage = None;

        let mut stream = res.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ProviderError::Network(e.to_string()))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Process complete SSE lines
            while let Some(pos) = buffer.find("\n\n") {
                let event_block = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();

                for line in event_block.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data.trim() == "[DONE]" { continue; }

                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                            let delta = &json["choices"][0]["delta"];

                            // Content delta
                            if let Some(content) = delta["content"].as_str() {
                                if !content.is_empty() {
                                    text_parts.push(content.to_string());
                                }
                            }

                            // Reasoning/thinking delta
                            if let Some(reasoning) = delta["reasoning_content"].as_str() {
                                if !reasoning.is_empty() {
                                    thinking_parts.push(reasoning.to_string());
                                }
                            }

                            // Tool call deltas
                            if let Some(tcs) = delta["tool_calls"].as_array() {
                                for tc in tcs {
                                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                                    while tool_calls.len() <= idx {
                                        tool_calls.push(ToolCallAccum::default());
                                    }
                                    if let Some(id) = tc["id"].as_str() {
                                        tool_calls[idx].id = id.to_string();
                                    }
                                    if let Some(name) = tc["function"]["name"].as_str() {
                                        tool_calls[idx].name.push_str(name);
                                    }
                                    if let Some(args) = tc["function"]["arguments"].as_str() {
                                        tool_calls[idx].arguments.push_str(args);
                                    }
                                }
                            }

                            // Usage (in the last chunk)
                            if let Some(u) = json["usage"].as_object() {
                                usage = Some(Usage {
                                    prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
                                    completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Process any remaining buffer
        for line in buffer.lines() {
            if let Some(data) = line.strip_prefix("data: ") {
                if data.trim() != "[DONE]" {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(u) = json["usage"].as_object() {
                            usage = Some(Usage {
                                prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
                                completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
                            });
                        }
                    }
                }
            }
        }

        // Assemble final response
        let parsed_tool_calls: Vec<ToolCall> = tool_calls.into_iter()
            .filter(|tc| !tc.name.is_empty())
            .map(|tc| {
                let args: serde_json::Value = serde_json::from_str(&tc.arguments).unwrap_or_default();
                ToolCall { id: tc.id, name: tc.name, arguments: args }
            })
            .collect();

        Ok(ChatResponse {
            text: text_parts.join(""),
            tool_calls: parsed_tool_calls,
            thinking: if thinking_parts.is_empty() { None } else { Some(thinking_parts.join("")) },
            usage,
        })
    }

    fn parse_response(text: &str) -> Result<ChatResponse, ProviderError> {
        let json: serde_json::Value = serde_json::from_str(text)
            .map_err(|e| ProviderError::Parse(e.to_string()))?;

        let choice = &json["choices"][0];
        let message = &choice["message"];
        let response_text = message["content"].as_str().unwrap_or("").to_string();
        let thinking = message["reasoning_content"].as_str().map(|s| s.to_string());

        let mut tool_calls = Vec::new();
        if let Some(tcs) = message["tool_calls"].as_array() {
            for tc in tcs {
                let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
                let args: serde_json::Value = serde_json::from_str(args_str).unwrap_or_default();
                tool_calls.push(ToolCall {
                    id: tc["id"].as_str().unwrap_or("").to_string(),
                    name: tc["function"]["name"].as_str().unwrap_or("").to_string(),
                    arguments: args,
                });
            }
        }

        let usage = json["usage"].as_object().map(|u| Usage {
            prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
        });

        Ok(ChatResponse { text: response_text, tool_calls, thinking, usage })
    }
}

#[derive(Default)]
struct ToolCallAccum {
    id: String,
    name: String,
    arguments: String,
}

#[async_trait::async_trait]
impl Provider for OpenAIProvider {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, ProviderError> {
        if request.stream {
            self.chat_stream(&request).await
        } else {
            self.chat_batch(&request).await
        }
    }

    fn name(&self) -> &str { "openai-compatible" }
}
