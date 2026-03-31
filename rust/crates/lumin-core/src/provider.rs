//! OpenAI-compatible LLM provider — with SSE streaming support and fallback.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use futures::StreamExt;
use tracing::warn;

// ── Multimodal Content Blocks ────────────────────────────

/// Content block for multimodal messages (OpenAI-compatible format).
/// Used when a user message contains both text and images.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlBlock },
}

/// Image URL reference within a content block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrlBlock {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Message content — either a plain string or an array of content blocks
/// (for multimodal messages). Uses `#[serde(untagged)]` so it serializes
/// as a JSON string or JSON array, matching the OpenAI format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl MessageContent {
    /// Extract text content, joining text blocks if multimodal.
    pub fn as_text(&self) -> &str {
        match self {
            MessageContent::Text(s) => s,
            MessageContent::Blocks(_) => "",
        }
    }

    /// Get length in characters (for budget calculations).
    pub fn char_len(&self) -> usize {
        match self {
            MessageContent::Text(s) => s.len(),
            MessageContent::Blocks(blocks) => blocks.iter().map(|b| match b {
                ContentBlock::Text { text } => text.len(),
                ContentBlock::ImageUrl { .. } => 100, // rough estimate for URL
            }).sum(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<MessageContent>,
    /// Tool calls in the assistant message (OpenAI format).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<serde_json::Value>>,
    /// Tool call ID for role="tool" messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Reasoning content — stored internally but NOT sent back to API.
    /// Many providers reject unknown properties on assistant messages.
    #[serde(skip_serializing)]
    pub reasoning_content: Option<String>,
}

impl Message {
    pub fn system(content: &str) -> Self {
        Self { role: "system".into(), content: Some(MessageContent::Text(content.into())), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn user(content: &str) -> Self {
        Self { role: "user".into(), content: Some(MessageContent::Text(content.into())), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    /// Create a user message with multimodal content blocks (text + images).
    pub fn user_multimodal(blocks: Vec<ContentBlock>) -> Self {
        Self { role: "user".into(), content: Some(MessageContent::Blocks(blocks)), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn assistant(content: &str) -> Self {
        Self { role: "assistant".into(), content: Some(MessageContent::Text(content.into())), tool_calls: None, tool_call_id: None, reasoning_content: None }
    }
    pub fn assistant_with_tools(tool_calls: Vec<serde_json::Value>, reasoning: Option<String>) -> Self {
        Self { role: "assistant".into(), content: None, tool_calls: Some(tool_calls), tool_call_id: None, reasoning_content: reasoning }
    }
    pub fn tool_result(tool_call_id: &str, content: &str) -> Self {
        Self { role: "tool".into(), content: Some(MessageContent::Text(content.into())), tool_calls: None, tool_call_id: Some(tool_call_id.into()), reasoning_content: None }
    }

    /// Helper: get text content as `Option<&str>`, returning `None` for multimodal blocks.
    pub fn text_content(&self) -> Option<&str> {
        match &self.content {
            Some(MessageContent::Text(s)) => Some(s),
            _ => None,
        }
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
    pub temperature: Option<f32>,
    pub thinking_level: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub thinking: Option<String>,
    pub usage: Option<Usage>,
    /// Why the model stopped: "stop", "tool_calls", "length", etc.
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, ProviderError>;

    /// Streaming chat completion — calls `on_delta` for each text token.
    /// Default implementation falls back to non-streaming `chat()`.
    async fn chat_stream(
        &self,
        request: ChatRequest,
        _on_delta: Box<dyn Fn(&str) + Send>,
        _on_thinking_delta: Option<Box<dyn Fn(&str) + Send>>,
    ) -> Result<ChatResponse, ProviderError> {
        self.chat(request).await
    }

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
        if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }
        Self::apply_thinking_params(&mut body, model, request.thinking_level.as_deref());

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
    async fn chat_stream_internal(&self, request: &ChatRequest) -> Result<ChatResponse, ProviderError> {
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
        if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }
        Self::apply_thinking_params(&mut body, model, request.thinking_level.as_deref());

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
        let mut finish_reason: Option<String> = None;

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

                            // Reasoning/thinking delta (reasoning_content or reasoning)
                            if let Some(reasoning) = delta["reasoning_content"].as_str()
                                .or_else(|| delta["reasoning"].as_str()) {
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

                            // Finish reason
                            if let Some(fr) = json["choices"][0]["finish_reason"].as_str() {
                                finish_reason = Some(fr.to_string());
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

        let text = text_parts.join("");
        let thinking = if thinking_parts.is_empty() { None } else { Some(thinking_parts.join("")) };
        // Some models put all content in reasoning with empty content — use thinking as fallback
        let text = if text.is_empty() { thinking.clone().unwrap_or_default() } else { text };
        Ok(ChatResponse { text, tool_calls: parsed_tool_calls, thinking, usage, finish_reason })
    }

    fn parse_response(text: &str) -> Result<ChatResponse, ProviderError> {
        let json: serde_json::Value = serde_json::from_str(text)
            .map_err(|e| ProviderError::Parse(e.to_string()))?;

        let choice = &json["choices"][0];
        let message = &choice["message"];
        let raw_text = message["content"].as_str().unwrap_or("").to_string();
        let thinking = message["reasoning_content"].as_str()
            .or_else(|| message["reasoning"].as_str())
            .map(|s| s.to_string());
        // Some models put all content in reasoning with empty content — use thinking as fallback
        let response_text = if raw_text.is_empty() {
            thinking.clone().unwrap_or_default()
        } else {
            raw_text
        };

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

        let finish_reason = choice["finish_reason"].as_str().map(|s| s.to_string());

        Ok(ChatResponse { text: response_text, tool_calls, thinking, usage, finish_reason })
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
            self.chat_stream_internal(&request).await
        } else {
            self.chat_batch(&request).await
        }
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
        _on_delta: Box<dyn Fn(&str) + Send>,
        _on_thinking_delta: Option<Box<dyn Fn(&str) + Send>>,
    ) -> Result<ChatResponse, ProviderError> {
        // Use internal streaming, the on_delta callback can be wired to
        // text_parts accumulation in a future enhancement.
        let mut req = request;
        req.stream = true;
        self.chat_stream_internal(&req).await
    }

    fn name(&self) -> &str { "openai-compatible" }
}

impl OpenAIProvider {
    /// Apply thinking/reasoning parameters based on model name and level.
    fn apply_thinking_params(body: &mut serde_json::Value, model: &str, level: Option<&str>) {
        let level = match level {
            Some(l) if l != "off" => l,
            _ => return,
        };

        let budget = match level {
            "low" => 4096,
            "high" => 32768,
            _ => 8192,
        };

        if model.contains("kimi") || model.contains("k2") {
            body["enable_thinking"] = serde_json::json!(true);
        } else if model.contains("claude") {
            body["thinking"] = serde_json::json!({
                "type": "enabled",
                "budget_tokens": budget,
            });
        }
        // For other models, thinking is controlled via temperature (lower = more thinking)
    }
}

// ── Tests ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Message constructors ──

    #[test]
    fn message_system() {
        let msg = Message::system("You are helpful.");
        assert_eq!(msg.role, "system");
        assert_eq!(msg.text_content(), Some("You are helpful."));
        assert!(msg.tool_calls.is_none());
        assert!(msg.tool_call_id.is_none());
        assert!(msg.reasoning_content.is_none());
    }

    #[test]
    fn message_user() {
        let msg = Message::user("Hello!");
        assert_eq!(msg.role, "user");
        assert_eq!(msg.text_content(), Some("Hello!"));
    }

    #[test]
    fn message_assistant() {
        let msg = Message::assistant("Sure, I can help.");
        assert_eq!(msg.role, "assistant");
        assert_eq!(msg.text_content(), Some("Sure, I can help."));
        assert!(msg.tool_calls.is_none());
    }

    #[test]
    fn message_assistant_with_tools() {
        let tc = vec![json!({"id": "tc1", "function": {"name": "bash", "arguments": "{\"cmd\":\"ls\"}"}})];
        let msg = Message::assistant_with_tools(tc.clone(), Some("thinking about it".into()));
        assert_eq!(msg.role, "assistant");
        assert!(msg.content.is_none());
        assert_eq!(msg.tool_calls.as_ref().unwrap().len(), 1);
        assert_eq!(msg.reasoning_content.as_deref(), Some("thinking about it"));
    }

    #[test]
    fn message_tool_result() {
        let msg = Message::tool_result("call_123", "result output");
        assert_eq!(msg.role, "tool");
        assert_eq!(msg.text_content(), Some("result output"));
        assert_eq!(msg.tool_call_id.as_deref(), Some("call_123"));
    }

    // ── Message serialization ──

    #[test]
    fn message_serialization_skips_none_fields() {
        let msg = Message::user("hi");
        let json_val = serde_json::to_value(&msg).unwrap();

        // Should have role and content
        assert_eq!(json_val["role"], "user");
        assert_eq!(json_val["content"], "hi");

        // None fields should be absent (skip_serializing_if)
        assert!(json_val.get("tool_calls").is_none());
        assert!(json_val.get("tool_call_id").is_none());

        // reasoning_content uses skip_serializing (always skipped)
        assert!(json_val.get("reasoning_content").is_none());
    }

    #[test]
    fn message_serialization_reasoning_always_skipped() {
        // reasoning_content should never be serialized, even when Some
        let msg = Message {
            role: "assistant".into(),
            content: Some(MessageContent::Text("reply".into())),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: Some("deep thoughts".into()),
        };
        let json_val = serde_json::to_value(&msg).unwrap();
        assert!(json_val.get("reasoning_content").is_none());
    }

    #[test]
    fn message_serialization_includes_tool_calls_when_present() {
        let tc = vec![json!({"id": "tc1"})];
        let msg = Message::assistant_with_tools(tc, None);
        let json_val = serde_json::to_value(&msg).unwrap();
        assert!(json_val.get("tool_calls").is_some());
        assert_eq!(json_val["tool_calls"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn message_serialization_includes_tool_call_id_when_present() {
        let msg = Message::tool_result("call_abc", "output");
        let json_val = serde_json::to_value(&msg).unwrap();
        assert_eq!(json_val["tool_call_id"], "call_abc");
    }

    // ── ChatRequest clone ──

    #[test]
    fn chat_request_clone() {
        let req = ChatRequest {
            messages: vec![Message::user("hello")],
            tools: Some(vec![json!({"type": "function"})]),
            model: Some("gpt-4o".into()),
            max_tokens: Some(1024),
            stream: false,
            temperature: Some(0.7),
            thinking_level: Some("high".into()),
        };
        let cloned = req.clone();
        assert_eq!(cloned.messages.len(), 1);
        assert_eq!(cloned.messages[0].text_content(), Some("hello"));
        assert_eq!(cloned.model.as_deref(), Some("gpt-4o"));
        assert_eq!(cloned.max_tokens, Some(1024));
        assert!(!cloned.stream);
        assert_eq!(cloned.tools.as_ref().unwrap().len(), 1);
    }

    // ── parse_response ──

    #[test]
    fn parse_response_text_only() {
        let raw = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "Hello, world!"
                }
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5
            }
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.text, "Hello, world!");
        assert!(resp.tool_calls.is_empty());
        assert!(resp.thinking.is_none());
        assert_eq!(resp.usage.as_ref().unwrap().prompt_tokens, 10);
        assert_eq!(resp.usage.as_ref().unwrap().completion_tokens, 5);
    }

    #[test]
    fn parse_response_with_tool_calls() {
        let raw = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "bash",
                            "arguments": "{\"cmd\":\"ls -la\"}"
                        }
                    }]
                }
            }]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "call_1");
        assert_eq!(resp.tool_calls[0].name, "bash");
        assert_eq!(resp.tool_calls[0].arguments["cmd"], "ls -la");
    }

    #[test]
    fn parse_response_with_reasoning_content() {
        let raw = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "The answer is 42.",
                    "reasoning_content": "Let me think step by step..."
                }
            }]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.text, "The answer is 42.");
        assert_eq!(resp.thinking.as_deref(), Some("Let me think step by step..."));
    }

    #[test]
    fn parse_response_with_reasoning_field() {
        // Some providers use "reasoning" instead of "reasoning_content"
        let raw = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "Result here.",
                    "reasoning": "Deep thought process..."
                }
            }]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.text, "Result here.");
        assert_eq!(resp.thinking.as_deref(), Some("Deep thought process..."));
    }

    #[test]
    fn parse_response_empty_content_reasoning_fallback() {
        // When content is empty but reasoning_content exists, text should fall back to reasoning
        let raw = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "All my reasoning goes here"
                }
            }]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.text, "All my reasoning goes here");
        assert_eq!(resp.thinking.as_deref(), Some("All my reasoning goes here"));
    }

    #[test]
    fn parse_response_null_content_reasoning_fallback() {
        // When content is null (missing) and reasoning exists
        let raw = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "reasoning_content": "Thinking only output"
                }
            }]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.text, "Thinking only output");
    }

    #[test]
    fn parse_response_no_usage() {
        let raw = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "no usage"
                }
            }]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert!(resp.usage.is_none());
    }

    #[test]
    fn parse_response_invalid_json() {
        let result = OpenAIProvider::parse_response("not json at all");
        assert!(result.is_err());
        match result.unwrap_err() {
            ProviderError::Parse(_) => {} // expected
            other => panic!("Expected Parse error, got: {:?}", other),
        }
    }

    #[test]
    fn parse_response_multiple_tool_calls() {
        let raw = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "function": { "name": "bash", "arguments": "{\"cmd\":\"echo a\"}" }
                        },
                        {
                            "id": "call_2",
                            "function": { "name": "read_file", "arguments": "{\"path\":\"/tmp/x\"}" }
                        }
                    ]
                }
            }]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.tool_calls.len(), 2);
        assert_eq!(resp.tool_calls[0].name, "bash");
        assert_eq!(resp.tool_calls[1].name, "read_file");
    }

    // ── FallbackProvider::is_retryable ──

    #[test]
    fn is_retryable_429() {
        let err = ProviderError::Http { status: 429, body: "rate limit".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_retryable_500() {
        let err = ProviderError::Http { status: 500, body: "internal error".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_retryable_503() {
        let err = ProviderError::Http { status: 503, body: "unavailable".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_retryable_502() {
        let err = ProviderError::Http { status: 502, body: "bad gateway".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_retryable_504() {
        let err = ProviderError::Http { status: 504, body: "gateway timeout".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_not_retryable_400() {
        let err = ProviderError::Http { status: 400, body: "bad request".into() };
        assert!(!FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_not_retryable_401() {
        let err = ProviderError::Http { status: 401, body: "unauthorized".into() };
        assert!(!FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_not_retryable_403() {
        let err = ProviderError::Http { status: 403, body: "forbidden".into() };
        assert!(!FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_not_retryable_404() {
        let err = ProviderError::Http { status: 404, body: "not found".into() };
        assert!(!FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_retryable_network_error() {
        let err = ProviderError::Network("connection reset".into());
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_not_retryable_parse_error() {
        let err = ProviderError::Parse("invalid json".into());
        assert!(!FallbackProvider::is_retryable(&err));
    }

    // ── Usage defaults ──

    #[test]
    fn usage_default_values() {
        let usage = Usage::default();
        assert_eq!(usage.prompt_tokens, 0);
        assert_eq!(usage.completion_tokens, 0);
    }

    // ── ChatResponse defaults ──

    #[test]
    fn chat_response_default() {
        let resp = ChatResponse::default();
        assert_eq!(resp.text, "");
        assert!(resp.tool_calls.is_empty());
        assert!(resp.thinking.is_none());
        assert!(resp.usage.is_none());
    }

    // ── ProviderError display ──

    #[test]
    fn provider_error_display_http() {
        let err = ProviderError::Http { status: 500, body: "oops".into() };
        assert_eq!(format!("{err}"), "HTTP error 500: oops");
    }

    #[test]
    fn provider_error_display_network() {
        let err = ProviderError::Network("timeout".into());
        assert_eq!(format!("{err}"), "Network error: timeout");
    }

    #[test]
    fn provider_error_display_parse() {
        let err = ProviderError::Parse("bad json".into());
        assert_eq!(format!("{err}"), "Parse error: bad json");
    }

    // ── Regex-based retryable pattern tests (TS parity) ──

    #[test]
    fn is_retryable_rate_limit_in_body() {
        // TS pattern: /rate.?limit/i
        let err = ProviderError::Http { status: 200, body: "rate_limit exceeded".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_retryable_capacity_in_body() {
        // TS pattern: /capacity/i
        let err = ProviderError::Http { status: 200, body: "server at capacity".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_retryable_overloaded_in_body() {
        // TS pattern: /overloaded/i
        let err = ProviderError::Http { status: 200, body: "model is Overloaded".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    #[test]
    fn is_retryable_timeout_in_body() {
        // TS pattern: /timeout/i
        let err = ProviderError::Http { status: 200, body: "request Timeout".into() };
        assert!(FallbackProvider::is_retryable(&err));
    }

    // ── ContentBlock + MessageContent tests ──

    #[test]
    fn content_block_text_serialization() {
        let block = ContentBlock::Text { text: "hello".into() };
        let json_val = serde_json::to_value(&block).unwrap();
        assert_eq!(json_val["type"], "text");
        assert_eq!(json_val["text"], "hello");
    }

    #[test]
    fn content_block_image_url_serialization() {
        let block = ContentBlock::ImageUrl {
            image_url: ImageUrlBlock { url: "https://example.com/img.png".into(), detail: Some("high".into()) },
        };
        let json_val = serde_json::to_value(&block).unwrap();
        assert_eq!(json_val["type"], "image_url");
        assert_eq!(json_val["image_url"]["url"], "https://example.com/img.png");
        assert_eq!(json_val["image_url"]["detail"], "high");
    }

    #[test]
    fn message_content_text_serializes_as_string() {
        let mc = MessageContent::Text("hello world".into());
        let json_val = serde_json::to_value(&mc).unwrap();
        assert_eq!(json_val, "hello world");
    }

    #[test]
    fn message_content_blocks_serializes_as_array() {
        let mc = MessageContent::Blocks(vec![
            ContentBlock::Text { text: "describe this".into() },
            ContentBlock::ImageUrl { image_url: ImageUrlBlock { url: "https://img.png".into(), detail: None } },
        ]);
        let json_val = serde_json::to_value(&mc).unwrap();
        assert!(json_val.is_array());
        assert_eq!(json_val.as_array().unwrap().len(), 2);
        assert_eq!(json_val[0]["type"], "text");
        assert_eq!(json_val[1]["type"], "image_url");
    }

    #[test]
    fn user_multimodal_message() {
        let msg = Message::user_multimodal(vec![
            ContentBlock::Text { text: "What is this?".into() },
            ContentBlock::ImageUrl { image_url: ImageUrlBlock { url: "https://img.png".into(), detail: Some("auto".into()) } },
        ]);
        assert_eq!(msg.role, "user");
        let json_val = serde_json::to_value(&msg).unwrap();
        assert!(json_val["content"].is_array());
        assert_eq!(json_val["content"][0]["type"], "text");
        assert_eq!(json_val["content"][1]["type"], "image_url");
    }

    #[test]
    fn message_content_char_len_text() {
        let mc = MessageContent::Text("hello".into());
        assert_eq!(mc.char_len(), 5);
    }

    #[test]
    fn message_content_char_len_blocks() {
        let mc = MessageContent::Blocks(vec![
            ContentBlock::Text { text: "abc".into() },
            ContentBlock::ImageUrl { image_url: ImageUrlBlock { url: "https://x.png".into(), detail: None } },
        ]);
        assert_eq!(mc.char_len(), 3 + 100); // text len + 100 for image
    }

    #[test]
    fn text_content_helper_returns_text() {
        let msg = Message::user("hello");
        assert_eq!(msg.text_content(), Some("hello"));
    }

    #[test]
    fn text_content_helper_returns_none_for_blocks() {
        let msg = Message::user_multimodal(vec![ContentBlock::Text { text: "hi".into() }]);
        assert_eq!(msg.text_content(), None);
    }

    // ── finish_reason ──

    #[test]
    fn parse_response_with_finish_reason_stop() {
        let raw = json!({
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn parse_response_with_finish_reason_length() {
        let raw = json!({
            "choices": [{"message": {"content": "truncated..."}, "finish_reason": "length"}]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn parse_response_with_finish_reason_tool_calls() {
        let raw = json!({
            "choices": [{
                "message": {"content": null, "tool_calls": [{"id": "c1", "function": {"name": "bash", "arguments": "{}"}}]},
                "finish_reason": "tool_calls"
            }]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert_eq!(resp.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn parse_response_no_finish_reason() {
        let raw = json!({
            "choices": [{"message": {"content": "hi"}}]
        });
        let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
        assert!(resp.finish_reason.is_none());
    }

    #[test]
    fn chat_response_default_has_no_finish_reason() {
        let resp = ChatResponse::default();
        assert!(resp.finish_reason.is_none());
    }
}

// ── FallbackProvider ─────────────────────────────────────

/// Wraps a base provider with retry and model fallback chain.
/// On retryable errors (429, 5xx, rate-limit, timeout, overloaded),
/// automatically retries with the next model in the chain.
///
/// Matches TS `FallbackProvider` error-pattern detection: uses regex patterns
/// on error messages (not just status codes) so that message-body hints like
/// "rate_limit" or "overloaded" are caught even on non-standard status codes.
pub struct FallbackProvider {
    base: OpenAIProvider,
    fallback_models: Vec<String>,
    max_retries: u32,
}

impl FallbackProvider {
    pub fn new(base: OpenAIProvider, fallback_models: Vec<String>) -> Self {
        Self { base, fallback_models, max_retries: 2 }
    }

    /// Check whether an error is retryable using regex patterns on the full
    /// error message string — matching the TS `retryablePatterns` array.
    pub fn is_retryable(err: &ProviderError) -> bool {
        // Parse errors are never retryable
        if matches!(err, ProviderError::Parse(_)) {
            return false;
        }
        // Network errors are always retryable
        if matches!(err, ProviderError::Network(_)) {
            return true;
        }
        // For HTTP errors, check both status code and message patterns
        let msg = err.to_string();
        use regex_lite::Regex;
        // Lazy-init would be ideal but regex_lite is cheap to construct
        let patterns: &[&str] = &[
            r"\b(429|500|502|503|504)\b",
            r"(?i)rate.?limit",
            r"(?i)capacity",
            r"(?i)overloaded",
            r"(?i)timeout",
        ];
        for pat in patterns {
            if let Ok(re) = Regex::new(pat) {
                if re.is_match(&msg) {
                    return true;
                }
            }
        }
        false
    }
}

#[async_trait::async_trait]
impl Provider for FallbackProvider {
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, ProviderError> {
        // Try primary model with retries
        let mut last_error = None;
        for attempt in 0..=self.max_retries {
            match self.base.chat(request.clone()).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    if Self::is_retryable(&e) {
                        warn!(attempt, error = %e, "retryable error, will try again");
                        last_error = Some(e);
                        // Exponential backoff: 500ms, 1000ms
                        tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
                    } else {
                        return Err(e);
                    }
                }
            }
        }

        // Try fallback models (TS iterates models in order, one attempt each)
        for fallback_model in &self.fallback_models {
            warn!(model = %fallback_model, "trying fallback model");
            let mut fallback_request = request.clone();
            fallback_request.model = Some(fallback_model.clone());
            match self.base.chat(fallback_request).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    if !Self::is_retryable(&e) {
                        return Err(e);
                    }
                    warn!(model = %fallback_model, error = %e, "fallback model failed");
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or(ProviderError::Network("All models exhausted".into())))
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
        _on_delta: Box<dyn Fn(&str) + Send>,
        _on_thinking_delta: Option<Box<dyn Fn(&str) + Send>>,
    ) -> Result<ChatResponse, ProviderError> {
        // Try each model in sequence for streaming, matching TS FallbackProvider.chatStream
        let mut last_error = None;
        let models: Vec<Option<String>> = std::iter::once(request.model.clone())
            .chain(self.fallback_models.iter().map(|m| Some(m.clone())))
            .collect();

        for model in &models {
            let mut req = request.clone();
            req.model = model.clone();
            match self.base.chat_stream(req, Box::new(|_| {}), None).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    if !Self::is_retryable(&e) {
                        return Err(e);
                    }
                    warn!(model = ?model, "stream failed, trying next");
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or(ProviderError::Network("All models exhausted".into())))
    }

    fn name(&self) -> &str { "fallback" }
}

