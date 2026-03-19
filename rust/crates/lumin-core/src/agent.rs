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
use tracing::{info, warn, error};

// ── Result ────────────────────────────────────────────────

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

        let tool_specs = self.tools.get_specs();

        for iteration in 1..=self.opts.max_iterations {

            // ── Context guard: truncate if over budget ──
            let mut messages = session.build_messages(
                if iteration == 1 { input } else { "" },
                &self.system_prompt,
            );

            if iteration > 1 {
                // Rebuild from session directly for subsequent iterations
                messages = vec![Message::system(&self.system_prompt)];
                messages.extend(session.messages.iter().cloned());
            }

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

            info!(
                duration_ms = 0, // TODO: measure
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
            iterations: self.opts.max_iterations, // TODO: track actual
        })
    }
}
