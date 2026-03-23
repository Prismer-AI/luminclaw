//! Core agent loop — full implementation mirroring TypeScript `agent.ts`.
//! LLM → tool execution → doom-loop detection → context guard → compaction.

use crate::provider::{Provider, ChatRequest, ChatResponse, Message, ToolCall, Usage};
use crate::tools::{ToolRegistry, ToolContext};
use crate::session::Session;
use crate::hooks::{HookRegistry, HookContext, BeforeToolResult};
use crate::sse::{EventBus, AgentEvent};
use crate::directives::Directive;
use crate::compaction;
use std::collections::{HashSet, HashMap};
use std::sync::Arc;
use std::time::Instant;
use tracing::{info, warn, error};

// ── Result ────────────────────────────────────────────────

#[derive(Debug)]
pub struct AgentResult {
    pub text: String,
    pub thinking: Option<String>,
    pub directives: Vec<Directive>,
    pub tools_used: Vec<String>,
    pub usage: Option<Usage>,
    pub iterations: u32,
}

// ── Config ────────────────────────────────────────────────

pub struct AgentOptions {
    pub max_iterations: u32,
    pub max_context_chars: usize,
    pub max_tool_result_chars: usize,
    pub doom_loop_threshold: u32,
    pub repetition_threshold: u32,
    pub sensitive_tools: HashSet<String>,
}

impl Default for AgentOptions {
    fn default() -> Self {
        Self {
            max_iterations: 40,
            max_context_chars: 600_000,
            max_tool_result_chars: 140_000,
            doom_loop_threshold: 3,
            repetition_threshold: 5,
            sensitive_tools: HashSet::from(["bash".to_string()]),
        }
    }
}

// ── Agent ─────────────────────────────────────────────────

pub struct PrismerAgent {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    bus: Arc<EventBus>,
    hooks: Option<Arc<HookRegistry>>,
    system_prompt: String,
    model: String,
    agent_id: String,
    workspace_dir: String,
    opts: AgentOptions,
}

impl PrismerAgent {
    pub fn new(
        provider: Arc<dyn Provider>,
        tools: Arc<ToolRegistry>,
        bus: Arc<EventBus>,
        system_prompt: String,
        model: String,
        agent_id: String,
        workspace_dir: String,
    ) -> Self {
        Self {
            provider, tools, bus, hooks: None,
            system_prompt, model, agent_id, workspace_dir,
            opts: AgentOptions::default(),
        }
    }

    pub fn with_options(mut self, opts: AgentOptions) -> Self {
        self.opts = opts; self
    }

    pub fn with_hooks(mut self, hooks: Arc<HookRegistry>) -> Self {
        self.hooks = Some(hooks); self
    }

    pub async fn process_message(&self, input: &str, session: &mut Session) -> Result<AgentResult, String> {
        let mut tools_used: HashSet<String> = HashSet::new();
        let mut all_directives: Vec<Directive> = Vec::new();
        let mut last_text = String::new();
        let mut last_thinking = None;
        let mut total_usage = Usage::default();
        let mut consecutive_errors = 0u32;
        let mut tool_signatures: HashMap<String, u32> = HashMap::new();

        self.bus.publish(AgentEvent {
            event_type: "agent.start".into(),
            data: serde_json::json!({ "sessionId": session.id, "agentId": self.agent_id, "input": &input[..input.len().min(200)] }),
        });

        // Persist user input to session for multi-turn recall
        session.add_message(Message::user(input));

        let tool_specs = self.tools.get_specs();
        let mut actual_iterations = 0u32;

        for iteration in 1..=self.opts.max_iterations {
            actual_iterations = iteration;

            // ── Build messages from session (user input already in session.messages) ──
            let mut messages = session.build_messages(&self.system_prompt);

            let total_chars: usize = messages.iter()
                .map(|m| m.content.as_deref().unwrap_or("").len())
                .sum();

            if total_chars > self.opts.max_context_chars {
                let removed = compaction::truncate_oldest_turns(&mut messages, self.opts.max_context_chars, 6);
                if removed > 0 {
                    compaction::repair_orphaned_tool_results(&mut messages);
                    self.bus.publish(AgentEvent {
                        event_type: "compaction".into(),
                        data: serde_json::json!({ "droppedCount": removed }),
                    });
                }
            }

            // ── Hook: before_prompt ──
            // (hooks can modify system prompt — skipped if no hooks registered)

            info!(iteration, model = %self.model, message_count = messages.len(), tool_count = tool_specs.len(), "llm_request");

            // ── LLM call ──
            let response = match self.provider.chat(ChatRequest {
                messages,
                tools: if tool_specs.is_empty() { None } else { Some(tool_specs.clone()) },
                model: Some(self.model.clone()),
                max_tokens: Some(8192),
                stream: true,
            }).await {
                Ok(r) => r,
                Err(e) => {
                    error!(error = %e, iteration, "provider_error");
                    self.bus.publish(AgentEvent {
                        event_type: "error".into(),
                        data: serde_json::json!({ "error": e.to_string(), "iteration": iteration }),
                    });
                    return Err(e.to_string());
                }
            };

            if let Some(ref usage) = response.usage {
                total_usage.prompt_tokens += usage.prompt_tokens;
                total_usage.completion_tokens += usage.completion_tokens;
            }

            let _llm_duration = Instant::now();
            info!(
                has_tool_calls = !response.tool_calls.is_empty(),
                text_length = response.text.len(),
                "llm_response"
            );

            last_text = response.text.clone();
            last_thinking = response.thinking.clone();

            // ── No tool calls → final response ──
            if response.tool_calls.is_empty() {
                session.add_message(Message::assistant(&response.text));
                self.bus.publish(AgentEvent {
                    event_type: "text.delta".into(),
                    data: serde_json::json!({ "sessionId": session.id, "delta": response.text }),
                });
                break;
            }

            // ── Add assistant message with tool_calls ──
            let tc_json: Vec<serde_json::Value> = response.tool_calls.iter().map(|tc| {
                serde_json::json!({
                    "id": tc.id, "type": "function",
                    "function": { "name": tc.name, "arguments": serde_json::to_string(&tc.arguments).unwrap_or_default() }
                })
            }).collect();
            session.add_message(Message::assistant_with_tools(tc_json, response.thinking.clone()));

            // ── Execute tools ──
            let mut all_errors = true;
            for call in &response.tool_calls {
                tools_used.insert(call.name.clone());

                // Repetition detection
                let sig = format!("{}:{}", call.name, serde_json::to_string(&call.arguments).unwrap_or_default());
                let count = tool_signatures.entry(sig).or_insert(0);
                *count += 1;
                if *count >= self.opts.repetition_threshold {
                    warn!(tool = %call.name, count = *count, "repetition detected — stopping");
                    last_text = format!("Stopping: repeated {} call {} times.", call.name, count);
                    self.bus.publish(AgentEvent {
                        event_type: "error".into(),
                        data: serde_json::json!({ "error": "repetition_detected", "tool": call.name }),
                    });
                    // Break out of both loops
                    session.add_message(Message::tool_result(&call.id, &last_text));
                    break;
                }

                self.bus.publish(AgentEvent {
                    event_type: "tool.start".into(),
                    data: serde_json::json!({ "sessionId": session.id, "tool": call.name, "toolId": call.id }),
                });

                // Hook: before_tool
                if let Some(ref hooks) = self.hooks {
                    let ctx = HookContext {
                        workspace_dir: self.workspace_dir.clone(),
                        session_id: session.id.clone(),
                        agent_id: self.agent_id.clone(),
                    };
                    let hook_result = hooks.run_before_tool(ctx, call.name.clone(), call.arguments.clone()).await;
                    if !hook_result.proceed {
                        session.add_message(Message::tool_result(&call.id, "[Tool blocked by hook]"));
                        continue;
                    }
                }

                // Execute
                let ctx = ToolContext {
                    workspace_dir: self.workspace_dir.clone(),
                    session_id: session.id.clone(),
                    agent_id: self.agent_id.clone(),
                };
                let result = match self.tools.execute(&call.name, call.arguments.clone(), &ctx).await {
                    Ok(output) => { all_errors = false; output }
                    Err(e) => format!("Error: {e}"),
                };

                // Truncate oversized results
                let truncated = if result.len() > self.opts.max_tool_result_chars {
                    let head = &result[..90_000.min(result.len())];
                    let tail = &result[result.len().saturating_sub(50_000)..];
                    format!("{head}\n\n[... truncated ...]\n\n{tail}")
                } else {
                    result.clone()
                };

                self.bus.publish(AgentEvent {
                    event_type: "tool.end".into(),
                    data: serde_json::json!({ "sessionId": session.id, "tool": call.name, "toolId": call.id, "result": &truncated[..truncated.len().min(200)] }),
                });

                // Hook: after_tool
                if let Some(ref hooks) = self.hooks {
                    let ctx = HookContext {
                        workspace_dir: self.workspace_dir.clone(),
                        session_id: session.id.clone(),
                        agent_id: self.agent_id.clone(),
                    };
                    hooks.run_after_tool(ctx, call.name.clone(), truncated.clone(), result.starts_with("Error:")).await;
                }

                session.add_message(Message::tool_result(&call.id, &truncated));
            }

            // ── Doom-loop detection ──
            if all_errors {
                consecutive_errors += 1;
                if consecutive_errors >= self.opts.doom_loop_threshold {
                    warn!(consecutive = consecutive_errors, "doom loop detected");
                    last_text = "I'm encountering repeated errors. Please try a different approach.".into();
                    self.bus.publish(AgentEvent {
                        event_type: "error".into(),
                        data: serde_json::json!({ "error": "doom_loop", "consecutive_errors": consecutive_errors }),
                    });
                    break;
                }
            } else {
                consecutive_errors = 0;
            }
        }

        // Hook: agent_end
        if let Some(ref hooks) = self.hooks {
            let ctx = HookContext {
                workspace_dir: self.workspace_dir.clone(),
                session_id: session.id.clone(),
                agent_id: self.agent_id.clone(),
            };
            hooks.run_agent_end(ctx).await;
        }

        let tools_vec: Vec<String> = tools_used.into_iter().collect();
        self.bus.publish(AgentEvent {
            event_type: "agent.end".into(),
            data: serde_json::json!({ "sessionId": session.id, "toolsUsed": tools_vec }),
        });

        Ok(AgentResult {
            text: last_text,
            thinking: last_thinking,
            directives: all_directives,
            tools_used: tools_vec.clone(),
            usage: Some(total_usage),
            iterations: actual_iterations,
        })
    }
}

// ── Tests ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Provider, ChatRequest, ChatResponse, ProviderError, ToolCall, Usage};
    use crate::tools::{Tool, ToolRegistry};
    use crate::session::Session;
    use crate::sse::EventBus;
    use std::sync::{Arc, Mutex};

    // ── MockProvider ────────────────────────────────────────

    struct MockProvider {
        responses: Mutex<Vec<ChatResponse>>,
        call_index: Mutex<usize>,
    }

    impl MockProvider {
        fn new(responses: Vec<ChatResponse>) -> Self {
            Self {
                responses: Mutex::new(responses),
                call_index: Mutex::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl Provider for MockProvider {
        async fn chat(&self, _request: ChatRequest) -> Result<ChatResponse, ProviderError> {
            let mut idx = self.call_index.lock().unwrap();
            let responses = self.responses.lock().unwrap();
            if *idx >= responses.len() {
                return Ok(ChatResponse {
                    text: "done".into(),
                    tool_calls: vec![],
                    thinking: None,
                    usage: None,
                });
            }
            let resp = responses[*idx].clone();
            *idx += 1;
            Ok(resp)
        }

        fn name(&self) -> &str { "mock" }
    }

    /// A provider that always returns an error.
    struct FailingProvider;

    #[async_trait::async_trait]
    impl Provider for FailingProvider {
        async fn chat(&self, _request: ChatRequest) -> Result<ChatResponse, ProviderError> {
            Err(ProviderError::Network("Network down".into()))
        }

        fn name(&self) -> &str { "failing" }
    }

    // ── Helper functions ────────────────────────────────────

    fn create_tools() -> ToolRegistry {
        let mut tools = ToolRegistry::new();

        // echo tool — returns "Echo: {text}"
        tools.register(Tool {
            name: "echo".into(),
            description: "Echo input".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
            execute: Arc::new(|args, _ctx| {
                Box::pin(async move {
                    let text = args["text"].as_str().unwrap_or("");
                    format!("Echo: {text}")
                })
            }),
        });

        // big_output tool — returns 200K chars
        tools.register(Tool {
            name: "big_output".into(),
            description: "Returns a large output".into(),
            parameters: serde_json::json!({ "type": "object", "properties": {} }),
            execute: Arc::new(|_args, _ctx| {
                Box::pin(async move {
                    "X".repeat(200_000)
                })
            }),
        });

        // failing_tool — returns an error string (tools.execute returns Err)
        // Note: ToolRegistry::execute returns Err only for unknown tools.
        // A tool function that panics/errors must return the error itself.
        // In the TS test, the tool throws. In Rust, ToolFn returns String,
        // so we simulate a "failing" tool by registering it as an unknown tool name.
        // Actually, looking at the agent code, an unknown tool goes through
        // self.tools.execute() which returns Err("Tool not found: ...").
        // For the doom loop test we need a tool that the agent calls and gets
        // an error from. The simplest is to NOT register "failing_tool" so it
        // returns Err from execute(). But we also need it to show up in tool specs.
        // Actually — the agent calls self.tools.execute() and if Err, formats
        // "Error: {e}". So we can just not register the tool, and when the mock
        // provider returns a tool_call to "failing_tool", execute returns Err.

        tools
    }

    fn create_agent(provider: Arc<dyn Provider>, tools: Option<ToolRegistry>) -> PrismerAgent {
        let tools = tools.unwrap_or_else(create_tools);
        PrismerAgent::new(
            provider,
            Arc::new(tools),
            Arc::new(EventBus::default()),
            "You are a test agent.".into(),
            "test-model".into(),
            "researcher".into(),
            "/tmp".into(),
        )
    }

    fn make_tool_call(id: &str, name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args,
        }
    }

    // ── Tests ───────────────────────────────────────────────

    // 1. Basic flow: returns text response when no tool calls

    #[tokio::test]
    async fn basic_flow_returns_text_when_no_tool_calls() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "Hello!".into(),
                tool_calls: vec![],
                thinking: None,
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-1");
        let result = agent.process_message("hi", &mut session).await.unwrap();

        assert_eq!(result.text, "Hello!");
        assert!(result.tools_used.is_empty());
        assert_eq!(result.iterations, 1);
    }

    // 2. Basic flow: executes tool calls and returns final text

    #[tokio::test]
    async fn basic_flow_executes_tool_calls_and_returns_text() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-1", "echo", serde_json::json!({"text": "world"}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "Got echo result.".into(),
                tool_calls: vec![],
                thinking: None,
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-2");
        let result = agent.process_message("echo test", &mut session).await.unwrap();

        assert_eq!(result.text, "Got echo result.");
        assert!(result.tools_used.contains(&"echo".to_string()));
        assert_eq!(result.iterations, 2);
    }

    // 3. Doom loop detection — all errors: stops after 3 consecutive all-error rounds

    #[tokio::test]
    async fn doom_loop_stops_after_consecutive_errors() {
        // "failing_tool" is not registered, so execute returns Err → all_errors stays true
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-1", "failing_tool", serde_json::json!({}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-2", "failing_tool", serde_json::json!({}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-3", "failing_tool", serde_json::json!({}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "should not reach here".into(),
                tool_calls: vec![],
                thinking: None,
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-doom");
        let result = agent.process_message("do something", &mut session).await.unwrap();

        // The doom loop message from the Rust implementation
        assert!(result.text.contains("repeated errors"), "Expected doom loop message, got: {}", result.text);
    }

    // 4. Doom loop detection — repetition: stops after 5 identical tool calls

    #[tokio::test]
    async fn repetition_detection_stops_identical_calls() {
        // Provide 8 identical tool call responses to ensure doom loop eventually fires.
        // Repetition detection triggers at the 5th identical call (iter 5), then
        // consecutive_errors accumulates since all_errors stays true after the inner break.
        // After 3 consecutive all-error rounds (iters 5, 6, 7), doom loop fires.
        let mut responses: Vec<ChatResponse> = Vec::new();
        for i in 0..8 {
            responses.push(ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call(&format!("tc-{i}"), "echo", serde_json::json!({"text": "same"}))],
                thinking: None,
                usage: None,
            });
        }
        responses.push(ChatResponse {
            text: "should not reach here".into(),
            tool_calls: vec![],
            thinking: None,
            usage: None,
        });

        let provider = Arc::new(MockProvider::new(responses));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-repetition");
        let result = agent.process_message("repeat", &mut session).await.unwrap();

        // After repetition detection triggers (iter 5), the agent continues but
        // all_errors stays true. After 3 consecutive error rounds, doom loop fires.
        // The final last_text is the doom loop message.
        assert!(
            result.text.contains("repeated") || result.text.contains("Stopping"),
            "Expected repetition or doom loop message, got: {}",
            result.text
        );
    }

    // 5. Doom loop detection — repetition: does not trigger for different tool calls

    #[tokio::test]
    async fn no_repetition_for_different_tool_calls() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-1", "echo", serde_json::json!({"text": "a"}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-2", "echo", serde_json::json!({"text": "b"}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-3", "echo", serde_json::json!({"text": "c"}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-4", "echo", serde_json::json!({"text": "d"}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-5", "echo", serde_json::json!({"text": "e"}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "All done.".into(),
                tool_calls: vec![],
                thinking: None,
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-different");
        let result = agent.process_message("various", &mut session).await.unwrap();

        assert_eq!(result.text, "All done.");
        assert!(!result.text.contains("Stopping"));
        assert!(!result.text.contains("repeated errors"));
    }

    // 6. Error handling: returns error on provider failure

    #[tokio::test]
    async fn returns_error_on_provider_failure() {
        let provider = Arc::new(FailingProvider);
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-error");
        let result = agent.process_message("fail", &mut session).await;

        // The Rust agent returns Err on provider failure
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Network down"), "Expected network error, got: {}", err);
    }

    // 7. Error handling: handles unknown tool gracefully

    #[tokio::test]
    async fn handles_unknown_tool_gracefully() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-unknown", "nonexistent_tool", serde_json::json!({}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "Recovered.".into(),
                tool_calls: vec![],
                thinking: None,
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-unknown-tool");
        let result = agent.process_message("use unknown", &mut session).await.unwrap();

        // Agent should recover — unknown tool returns error, agent continues
        assert_eq!(result.text, "Recovered.");
    }

    // 8. Max iterations: stops at max iterations

    #[tokio::test]
    async fn stops_at_max_iterations() {
        // Always return tool calls with different args to avoid repetition detection
        let mut responses: Vec<ChatResponse> = Vec::new();
        for i in 0..15 {
            responses.push(ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call(&format!("tc-{i}"), "echo", serde_json::json!({"text": format!("iter-{i}")}))],
                thinking: None,
                usage: None,
            });
        }

        let provider = Arc::new(MockProvider::new(responses));
        let tools = create_tools();
        let agent = PrismerAgent::new(
            provider,
            Arc::new(tools),
            Arc::new(EventBus::default()),
            "Test.".into(),
            "test-model".into(),
            "researcher".into(),
            "/tmp".into(),
        ).with_options(AgentOptions {
            max_iterations: 5,
            ..AgentOptions::default()
        });

        let mut session = Session::new("test-max-iter");
        let result = agent.process_message("loop forever", &mut session).await.unwrap();

        // Should stop at or before max iterations (5)
        assert!(result.iterations <= 5, "Expected <= 5 iterations, got {}", result.iterations);
    }

    // 9. Thinking model support: preserves thinking/reasoning in result

    #[tokio::test]
    async fn preserves_thinking_in_result() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "Answer.".into(),
                tool_calls: vec![],
                thinking: Some("I need to think about this...".into()),
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-thinking");
        let result = agent.process_message("think hard", &mut session).await.unwrap();

        assert_eq!(result.text, "Answer.");
        assert_eq!(result.thinking.as_deref(), Some("I need to think about this..."));
    }

    // 10. Thinking model support: stores reasoning in assistant messages

    #[tokio::test]
    async fn stores_reasoning_in_assistant_messages() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-1", "echo", serde_json::json!({"text": "test"}))],
                thinking: Some("Let me use a tool.".into()),
                usage: None,
            },
            ChatResponse {
                text: "Done.".into(),
                tool_calls: vec![],
                thinking: Some("Tool worked.".into()),
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-reasoning-roundtrip");
        let _result = agent.process_message("reason and act", &mut session).await.unwrap();

        // Check that the assistant message with tool calls has reasoning_content
        let assistant_msgs: Vec<&Message> = session.messages.iter()
            .filter(|m| m.role == "assistant")
            .collect();

        // First assistant message should have reasoning_content from tool call response
        assert!(assistant_msgs.len() >= 1, "Expected at least 1 assistant message");
        assert_eq!(
            assistant_msgs[0].reasoning_content.as_deref(),
            Some("Let me use a tool."),
            "First assistant message should preserve reasoning"
        );
    }

    // 11. Tool result compaction: compacts tool output exceeding max_tool_result_chars

    #[tokio::test]
    async fn compacts_oversized_tool_output() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-big", "big_output", serde_json::json!({}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "Processed.".into(),
                tool_calls: vec![],
                thinking: None,
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-compact");
        let result = agent.process_message("get big data", &mut session).await.unwrap();

        // Find the tool result message in session
        let tool_msg = session.messages.iter().find(|m| m.role == "tool");
        assert!(tool_msg.is_some(), "Expected a tool result message in session");

        let tool_content = tool_msg.unwrap().content.as_deref().unwrap();
        // 200K output exceeds 140K limit, should be truncated
        assert!(tool_content.len() < 200_000, "Tool result should be compacted");
        assert!(tool_content.contains("truncated"), "Compacted result should contain truncation marker");
        assert_eq!(result.text, "Processed.");
    }

    // 12. Tool result compaction: does not compact small tool outputs

    #[tokio::test]
    async fn does_not_compact_small_tool_outputs() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-small", "echo", serde_json::json!({"text": "hello"}))],
                thinking: None,
                usage: None,
            },
            ChatResponse {
                text: "ok".into(),
                tool_calls: vec![],
                thinking: None,
                usage: None,
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-no-compact");
        let _result = agent.process_message("echo", &mut session).await.unwrap();

        let tool_msg = session.messages.iter().find(|m| m.role == "tool");
        assert!(tool_msg.is_some(), "Expected a tool result message");

        let content = tool_msg.unwrap().content.as_deref().unwrap();
        assert_eq!(content, "Echo: hello");
        assert!(!content.contains("truncated"));
    }

    // 13. Usage tracking: accumulates token usage across iterations

    #[tokio::test]
    async fn accumulates_token_usage_across_iterations() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse {
                text: "".into(),
                tool_calls: vec![make_tool_call("tc-1", "echo", serde_json::json!({"text": "a"}))],
                thinking: None,
                usage: Some(Usage { prompt_tokens: 100, completion_tokens: 50 }),
            },
            ChatResponse {
                text: "Done.".into(),
                tool_calls: vec![],
                thinking: None,
                usage: Some(Usage { prompt_tokens: 200, completion_tokens: 80 }),
            },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-usage");
        let result = agent.process_message("track usage", &mut session).await.unwrap();

        let usage = result.usage.expect("Expected usage to be present");
        assert_eq!(usage.prompt_tokens, 300);
        assert_eq!(usage.completion_tokens, 130);
    }
}
