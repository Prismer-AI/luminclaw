//! Core agent loop — full implementation mirroring TypeScript `agent.ts`.
//! LLM → tool execution → approval gates → sub-agent delegation →
//! directive file scanning → doom-loop detection → context guard → compaction.

use crate::provider::{Provider, ChatRequest, Message, ToolCall, Usage};
use crate::tools::{ToolRegistry, ToolContext, ToolEvent};
use crate::session::Session;
use crate::hooks::{HookRegistry, HookContext};
use crate::sse::{EventBus, AgentEvent};
use crate::agents::{AgentRegistry, AgentMode};
use crate::directives::Directive;
use crate::compaction;
use regex_lite::Regex;
use std::collections::{HashSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
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
    /// Regex patterns matching destructive bash commands (rm, mv, chmod, etc.).
    /// If a bash tool call's command matches any pattern, approval is required.
    pub bash_sensitive_patterns: Vec<String>,
    /// Timeout in milliseconds before auto-rejecting an approval request.
    pub approval_timeout_ms: u64,
    /// Maximum chars to include in tool.end event result preview.
    pub tool_end_summary_chars: usize,
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
            bash_sensitive_patterns: vec![
                r"\brm\s".to_string(),
                r"\brmdir\b".to_string(),
                r"\bmv\s".to_string(),
                r"\bchmod\b".to_string(),
                r"\bchown\b".to_string(),
                r"\bkill\b".to_string(),
            ],
            approval_timeout_ms: 300_000, // 5 minutes
            tool_end_summary_chars: 1000,
        }
    }
}

// ── Agent ─────────────────────────────────────────────────

pub struct PrismerAgent {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    bus: Arc<EventBus>,
    hooks: Option<Arc<HookRegistry>>,
    agents: Option<Arc<AgentRegistry>>,
    system_prompt: String,
    model: String,
    agent_id: String,
    workspace_dir: String,
    opts: AgentOptions,
    /// Compiled regex patterns for bash sensitive commands.
    bash_patterns: Vec<Regex>,
    /// Pending approval resolvers — keyed by toolId, resolved by external approval response.
    approval_resolvers: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
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
        let opts = AgentOptions::default();
        let bash_patterns = compile_bash_patterns(&opts.bash_sensitive_patterns);
        Self {
            provider, tools, bus, hooks: None, agents: None,
            system_prompt, model, agent_id, workspace_dir,
            bash_patterns,
            approval_resolvers: Arc::new(Mutex::new(HashMap::new())),
            opts,
        }
    }

    pub fn with_options(mut self, opts: AgentOptions) -> Self {
        self.bash_patterns = compile_bash_patterns(&opts.bash_sensitive_patterns);
        self.opts = opts;
        self
    }

    pub fn with_hooks(mut self, hooks: Arc<HookRegistry>) -> Self {
        self.hooks = Some(hooks); self
    }

    pub fn with_agents(mut self, agents: Arc<AgentRegistry>) -> Self {
        self.agents = Some(agents); self
    }

    // ── Approval gates (TS parity: lines 165-202, 438-454) ──

    /// Check if a tool call needs human approval before execution.
    /// Matches the TypeScript `needsApproval(toolName, args)` method.
    pub fn needs_approval(&self, tool_name: &str, args: &serde_json::Value) -> bool {
        if !self.opts.sensitive_tools.contains(tool_name) {
            return false;
        }
        // bash: only flag destructive commands matching patterns
        if tool_name == "bash" {
            let cmd = args.get("command")
                .or_else(|| args.get("cmd"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            return self.bash_patterns.iter().any(|p| p.is_match(cmd));
        }
        // All other sensitive tools always require approval
        true
    }

    /// Resolve a pending approval request (called from WS handler or external code).
    pub fn resolve_approval(&self, tool_id: &str, approved: bool) {
        let mut resolvers = self.approval_resolvers.lock().unwrap();
        if let Some(sender) = resolvers.remove(tool_id) {
            let _ = sender.send(approved);
        }
    }

    /// Wait for external approval with timeout. Returns false on timeout (safe default).
    async fn wait_for_approval(&self, tool_id: &str) -> bool {
        let (tx, rx) = oneshot::channel::<bool>();
        {
            let mut resolvers = self.approval_resolvers.lock().unwrap();
            resolvers.insert(tool_id.to_string(), tx);
        }
        let timeout = Duration::from_millis(self.opts.approval_timeout_ms);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(approved)) => approved,
            _ => {
                // Timeout or channel dropped -> reject (safe default)
                warn!(tool_id, timeout_ms = self.opts.approval_timeout_ms, "approval timed out, rejecting");
                let mut resolvers = self.approval_resolvers.lock().unwrap();
                resolvers.remove(tool_id);
                false
            }
        }
    }

    // ── Directive file scanning (TS parity: lines 208-231) ──

    /// Snapshot current directive files (before tool execution).
    fn snapshot_directive_files(&self) -> HashSet<String> {
        let dir_path = format!("{}/.openclaw/directives", self.workspace_dir);
        match std::fs::read_dir(&dir_path) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|f| f.ends_with(".json"))
                .collect(),
            Err(_) => HashSet::new(),
        }
    }

    /// Scan {workspace_dir}/.openclaw/directives/ for directive files written by plugin tools.
    /// Emits them on the EventBus and accumulates directives, then deletes processed files.
    fn scan_directive_files(&self, directives: &mut Vec<Directive>, known_files: &HashSet<String>) {
        let dir_path = format!("{}/.openclaw/directives", self.workspace_dir);
        let files = match std::fs::read_dir(&dir_path) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|f| f.ends_with(".json"))
                .collect::<Vec<_>>(),
            Err(_) => return, // Directory doesn't exist yet
        };

        for file in files {
            if known_files.contains(&file) {
                continue;
            }
            let file_path = format!("{}/{}", dir_path, file);
            let raw = match std::fs::read_to_string(&file_path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue, // Skip malformed files
            };

            let directive = Directive {
                r#type: parsed["type"].as_str().unwrap_or("UNKNOWN").to_string(),
                payload: parsed.get("payload").cloned().unwrap_or(serde_json::json!({})),
                timestamp: parsed["timestamp"].as_str().map(|s| s.to_string()),
                emitted_by: None,
                task_id: None,
                source: None,
                state_version: None,
            };

            self.bus.publish(AgentEvent {
                event_type: "directive".into(),
                data: serde_json::json!({
                    "type": directive.r#type,
                    "payload": directive.payload,
                    "timestamp": directive.timestamp,
                }),
            });

            directives.push(directive);

            // Delete processed file
            let _ = std::fs::remove_file(&file_path);
        }
    }

    // ── Sub-agent delegation (TS parity: lines 268-274, 560-640) ──

    /// Delegate to a sub-agent.
    fn delegate_to_sub_agent<'a>(
        &'a self,
        agent_id: &'a str,
        message: &'a str,
        parent_session: &'a Session,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<AgentResult, String>> + Send + 'a>> {
        Box::pin(async move {
        let agents = self.agents.as_ref().ok_or("No agent registry available")?;
        let config = agents.get(agent_id)
            .ok_or_else(|| format!("Unknown sub-agent: {agent_id}"))?;

        if config.mode == AgentMode::Hidden {
            return Err(format!("Unknown sub-agent: {agent_id}"));
        }

        self.bus.publish(AgentEvent {
            event_type: "subagent.start".into(),
            data: serde_json::json!({ "parentAgent": self.agent_id, "subAgent": agent_id }),
        });

        let mut child_session = parent_session.create_child(agent_id);

        let sub_agent = PrismerAgent::new(
            self.provider.clone(),
            self.tools.clone(),
            self.bus.clone(),
            config.system_prompt.clone(),
            config.model.clone().unwrap_or_else(|| self.model.clone()),
            config.id.clone(),
            self.workspace_dir.clone(),
        ).with_options(AgentOptions {
            max_iterations: config.max_iterations.unwrap_or(20),
            ..AgentOptions::default()
        });

        // If agents registry exists, pass it to sub-agent too
        let sub_agent = if let Some(ref agents) = self.agents {
            sub_agent.with_agents(agents.clone())
        } else {
            sub_agent
        };

        let result = sub_agent.process_message(message, &mut child_session, None).await?;

        self.bus.publish(AgentEvent {
            event_type: "subagent.end".into(),
            data: serde_json::json!({
                "parentAgent": self.agent_id,
                "subAgent": agent_id,
                "toolsUsed": result.tools_used,
                "iterations": result.iterations,
            }),
        });

        Ok(result)
        })
    }

    /// Handle the "delegate" tool call (invoked via LLM tool calling).
    async fn handle_delegate_call(
        &self,
        call: &ToolCall,
        session: &Session,
        tools_used: &mut HashSet<String>,
    ) -> (String, bool) {
        let target_agent = call.arguments.get("agent").and_then(|v| v.as_str()).unwrap_or("");
        let task = call.arguments.get("task").and_then(|v| v.as_str()).unwrap_or("");

        if target_agent.is_empty() || task.is_empty() {
            return ("Error: delegate requires \"agent\" and \"task\" arguments".into(), true);
        }

        tools_used.insert(format!("delegate:{target_agent}"));

        match self.delegate_to_sub_agent(target_agent, task, session).await {
            Ok(result) => (result.text, false),
            Err(e) => (format!("Delegation failed: {e}"), true),
        }
    }

    /// Build the delegate tool spec for LLM.
    fn get_delegate_tool_spec(&self) -> Option<serde_json::Value> {
        let agents = self.agents.as_ref()?;
        let delegatable = agents.get_delegatable_agents();
        if delegatable.is_empty() {
            return None;
        }
        Some(serde_json::json!({
            "type": "function",
            "function": {
                "name": "delegate",
                "description": format!("Delegate a task to a specialized sub-agent. Available: {}", delegatable.join(", ")),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent": {
                            "type": "string",
                            "enum": delegatable,
                            "description": "The sub-agent to delegate to"
                        },
                        "task": {
                            "type": "string",
                            "description": "The task description for the sub-agent"
                        }
                    },
                    "required": ["agent", "task"]
                }
            }
        }))
    }

    // ── Main loop ─────────────────────────────────────────────

    pub async fn process_message(
        &self,
        input: &str,
        session: &mut Session,
        cancelled: Option<Arc<Mutex<bool>>>,
    ) -> Result<AgentResult, String> {
        self.process_message_full(input, session, cancelled, None, None).await
    }

    /// Full process_message with all optional parameters (mirrors TS signature).
    pub async fn process_message_full(
        &self,
        input: &str,
        session: &mut Session,
        cancelled: Option<Arc<Mutex<bool>>>,
        memory_context: Option<&str>,
        _images: Option<&[crate::loop_types::ImageRef]>,
    ) -> Result<AgentResult, String> {
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

        // ── Check @-mention for explicit sub-agent delegation (TS parity: lines 268-274) ──
        if let Some(ref agents) = self.agents {
            if let Some((agent_id, message)) = agents.resolve_from_mention(input) {
                let result = self.delegate_to_sub_agent(agent_id, message, session).await?;
                self.bus.publish(AgentEvent {
                    event_type: "agent.end".into(),
                    data: serde_json::json!({ "sessionId": session.id, "toolsUsed": result.tools_used }),
                });
                return Ok(result);
            }
        }

        // Persist user input to session for multi-turn recall
        session.add_message(Message::user(input));

        // Get tool specs (filter by agent config if sub-agent)
        let mut tool_specs = if let Some(ref agents) = self.agents {
            let agent_config = agents.get(&self.agent_id);
            match agent_config.and_then(|c| c.tools.as_ref()) {
                Some(allowed) => self.tools.get_specs_filtered(allowed),
                None => self.tools.get_specs(),
            }
        } else {
            self.tools.get_specs()
        };

        // Add delegate tool if this is the primary agent and sub-agents exist
        if let Some(ref agents) = self.agents {
            let agent_config = agents.get(&self.agent_id);
            let is_primary = agent_config.map_or(true, |c| c.mode == AgentMode::Primary);
            if is_primary {
                if let Some(delegate_spec) = self.get_delegate_tool_spec() {
                    tool_specs.push(delegate_spec);
                }
            }
        }

        let mut actual_iterations = 0u32;

        for iteration in 1..=self.opts.max_iterations {
            actual_iterations = iteration;

            // ── Emit iteration start ──
            self.bus.publish(AgentEvent {
                event_type: "iteration.start".into(),
                data: serde_json::json!({
                    "sessionId": session.id,
                    "iteration": iteration,
                    "maxIterations": self.opts.max_iterations,
                }),
            });

            // ── Check cancellation flag ──
            if let Some(ref flag) = cancelled {
                if *flag.lock().unwrap() {
                    return Err("Cancelled by user".into());
                }
            }

            // ── Build messages from session (user input already in session.messages) ──
            let mut messages = session.build_messages_with_memory(&self.system_prompt, memory_context);

            let total_chars: usize = messages.iter()
                .map(|m| m.content.as_ref().map_or(0, |c| c.char_len()))
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

            info!(iteration, model = %self.model, message_count = messages.len(), tool_count = tool_specs.len(), "llm_request");

            // ── LLM call ──
            let response = match self.provider.chat(ChatRequest {
                messages,
                tools: if tool_specs.is_empty() { None } else { Some(tool_specs.clone()) },
                model: Some(self.model.clone()),
                max_tokens: Some(8192),
                stream: true,
                temperature: None,
                thinking_level: None,
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

            // ── No tool calls -> final response ──
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
            let pre_tool_directive_files = self.snapshot_directive_files();
            let mut all_errors = true;

            for call in &response.tool_calls {
                // Handle delegate tool specially
                if call.name == "delegate" {
                    let (output, is_error) = self.handle_delegate_call(call, session, &mut tools_used).await;
                    if !is_error { all_errors = false; }
                    session.add_message(Message::tool_result(&call.id, &output));
                    continue;
                }

                tools_used.insert(call.name.clone());

                // Repetition detection
                let sig = format!("{}:{}", call.name, serde_json::to_string(&call.arguments).unwrap_or_default());
                let count = tool_signatures.entry(sig).or_insert(0);
                *count += 1;
                if *count >= self.opts.repetition_threshold {
                    warn!(tool = %call.name, count = *count, "repetition detected, stopping");
                    last_text = format!("Stopping: repeated {} call {} times.", call.name, count);
                    self.bus.publish(AgentEvent {
                        event_type: "error".into(),
                        data: serde_json::json!({ "error": "repetition_detected", "tool": call.name }),
                    });
                    session.add_message(Message::tool_result(&call.id, &last_text));
                    break;
                }

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

                // ── Approval gate (TS parity: lines 438-454) ──
                if self.needs_approval(&call.name, &call.arguments) {
                    let reason = format!("Tool \"{}\" requires approval", call.name);
                    self.bus.publish(AgentEvent {
                        event_type: "tool.approval_required".into(),
                        data: serde_json::json!({
                            "sessionId": session.id,
                            "tool": call.name,
                            "toolId": call.id,
                            "args": call.arguments,
                            "reason": reason,
                        }),
                    });
                    let approved = self.wait_for_approval(&call.id).await;
                    self.bus.publish(AgentEvent {
                        event_type: "tool.approval_response".into(),
                        data: serde_json::json!({
                            "toolId": call.id,
                            "approved": approved,
                            "reason": if approved { "approved" } else { "rejected/timeout" },
                        }),
                    });
                    if !approved {
                        session.add_message(Message::tool_result(&call.id, "[Tool blocked: approval denied or timed out]"));
                        continue;
                    }
                }

                self.bus.publish(AgentEvent {
                    event_type: "tool.start".into(),
                    data: serde_json::json!({ "sessionId": session.id, "tool": call.name, "toolId": call.id }),
                });

                // ── Execute with ToolContext.emit wired up (TS parity: tools/index.ts) ──
                let bus_for_emit = self.bus.clone();
                let directives_for_emit: Arc<Mutex<Vec<Directive>>> = Arc::new(Mutex::new(Vec::new()));
                let directives_clone = directives_for_emit.clone();
                let session_id_for_emit = session.id.clone();
                let tool_name_for_emit = call.name.clone();
                let tool_id_for_emit = call.id.clone();
                let emit_fn = Box::new(move |event: ToolEvent| {
                    if event.event_type == "directive" {
                        let directive = Directive {
                            r#type: event.data.get("type").and_then(|v| v.as_str()).unwrap_or("UNKNOWN").to_string(),
                            payload: event.data.get("payload").cloned().unwrap_or(serde_json::json!({})),
                            timestamp: event.data.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            emitted_by: None,
                            task_id: None,
                            source: None,
                            state_version: None,
                        };
                        directives_clone.lock().unwrap().push(directive);
                        bus_for_emit.publish(AgentEvent {
                            event_type: "directive".into(),
                            data: event.data,
                        });
                    } else if event.event_type == "progress" {
                        bus_for_emit.publish(AgentEvent {
                            event_type: "tool.progress".into(),
                            data: serde_json::json!({
                                "sessionId": session_id_for_emit,
                                "tool": tool_name_for_emit,
                                "toolId": tool_id_for_emit,
                                "percent": event.data.get("percent"),
                                "message": event.data.get("message"),
                            }),
                        });
                    } else if event.event_type == "output" {
                        let action = event.data.get("action").and_then(|v| v.as_str()).unwrap_or("");
                        if action == "store" || action == "recall" {
                            bus_for_emit.publish(AgentEvent {
                                event_type: "memory.accessed".into(),
                                data: serde_json::json!({
                                    "sessionId": session_id_for_emit,
                                    "action": action,
                                    "query": event.data.get("query"),
                                    "resultCount": event.data.get("resultCount"),
                                    "preview": event.data.get("preview"),
                                }),
                            });
                        }
                    }
                });

                let ctx = ToolContext {
                    workspace_dir: self.workspace_dir.clone(),
                    session_id: session.id.clone(),
                    agent_id: self.agent_id.clone(),
                    emit: Some(emit_fn),
                };

                let result = match self.tools.execute(&call.name, call.arguments.clone(), &ctx).await {
                    Ok(output) => { all_errors = false; output }
                    Err(e) => format!("Error: {e}"),
                };

                // Collect any directives emitted by the tool via emit()
                {
                    let emitted = directives_for_emit.lock().unwrap();
                    all_directives.extend(emitted.iter().cloned());
                }

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
                    data: serde_json::json!({ "sessionId": session.id, "tool": call.name, "toolId": call.id, "result": &truncated[..truncated.len().min(self.opts.tool_end_summary_chars)] }),
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

            // ── Scan for directive files written by plugin tools (filesystem fallback) ──
            self.scan_directive_files(&mut all_directives, &pre_tool_directive_files);

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
            tools_used: tools_vec,
            usage: Some(total_usage),
            iterations: actual_iterations,
        })
    }
}

/// Compile bash-sensitive regex patterns from string list.
fn compile_bash_patterns(patterns: &[String]) -> Vec<Regex> {
    patterns.iter()
        .filter_map(|p| Regex::new(p).ok())
        .collect()
}

// ── Tests ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Provider, ChatRequest, ChatResponse, ProviderError, ToolCall, Usage};
    use crate::tools::{Tool, ToolRegistry};
    use crate::agents::{AgentConfig, AgentMode, AgentRegistry, builtin_agents};
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
                    finish_reason: None,
                });
            }
            let resp = responses[*idx].clone();
            *idx += 1;
            Ok(resp)
        }

        fn name(&self) -> &str { "mock" }
    }

    struct FailingProvider;

    #[async_trait::async_trait]
    impl Provider for FailingProvider {
        async fn chat(&self, _request: ChatRequest) -> Result<ChatResponse, ProviderError> {
            Err(ProviderError::Network("Network down".into()))
        }

        fn name(&self) -> &str { "failing" }
    }

    // ── Helpers ─────────────────────────────────────────────

    fn create_tools() -> ToolRegistry {
        let mut tools = ToolRegistry::new();
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
            is_concurrency_safe: None,
        });
        tools.register(Tool {
            name: "big_output".into(),
            description: "Returns a large output".into(),
            parameters: serde_json::json!({ "type": "object", "properties": {} }),
            execute: Arc::new(|_args, _ctx| {
                Box::pin(async move { "X".repeat(200_000) })
            }),
            is_concurrency_safe: None,
        });
        tools
    }

    fn create_agent(provider: Arc<dyn Provider>, tools: Option<ToolRegistry>) -> PrismerAgent {
        let tools = tools.unwrap_or_else(create_tools);
        PrismerAgent::new(
            provider, Arc::new(tools), Arc::new(EventBus::default()),
            "You are a test agent.".into(), "test-model".into(), "researcher".into(), "/tmp".into(),
        )
    }

    fn make_tool_call(id: &str, name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: id.into(), name: name.into(), arguments: args }
    }

    // ══════════════════════════════════════════════════════════
    //  Existing tests (preserved)
    // ══════════════════════════════════════════════════════════

    #[tokio::test]
    async fn basic_flow_returns_text_when_no_tool_calls() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "Hello!".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-1");
        let result = agent.process_message("hi", &mut session, None).await.unwrap();
        assert_eq!(result.text, "Hello!");
        assert!(result.tools_used.is_empty());
        assert_eq!(result.iterations, 1);
    }

    #[tokio::test]
    async fn basic_flow_executes_tool_calls_and_returns_text() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-1", "echo", serde_json::json!({"text": "world"}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "Got echo result.".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-2");
        let result = agent.process_message("echo test", &mut session, None).await.unwrap();
        assert_eq!(result.text, "Got echo result.");
        assert!(result.tools_used.contains(&"echo".to_string()));
        assert_eq!(result.iterations, 2);
    }

    #[tokio::test]
    async fn doom_loop_stops_after_consecutive_errors() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-1", "failing_tool", serde_json::json!({}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-2", "failing_tool", serde_json::json!({}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-3", "failing_tool", serde_json::json!({}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "should not reach here".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-doom");
        let result = agent.process_message("do something", &mut session, None).await.unwrap();
        assert!(result.text.contains("repeated errors"), "Expected doom loop message, got: {}", result.text);
    }

    #[tokio::test]
    async fn repetition_detection_stops_identical_calls() {
        let mut responses: Vec<ChatResponse> = Vec::new();
        for i in 0..8 {
            responses.push(ChatResponse { text: "".into(), tool_calls: vec![make_tool_call(&format!("tc-{i}"), "echo", serde_json::json!({"text": "same"}))], thinking: None, usage: None, finish_reason: None });
        }
        responses.push(ChatResponse { text: "should not reach here".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None });
        let provider = Arc::new(MockProvider::new(responses));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-repetition");
        let result = agent.process_message("repeat", &mut session, None).await.unwrap();
        assert!(result.text.contains("repeated") || result.text.contains("Stopping"), "Expected repetition or doom loop message, got: {}", result.text);
    }

    #[tokio::test]
    async fn no_repetition_for_different_tool_calls() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-1", "echo", serde_json::json!({"text": "a"}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-2", "echo", serde_json::json!({"text": "b"}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-3", "echo", serde_json::json!({"text": "c"}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-4", "echo", serde_json::json!({"text": "d"}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-5", "echo", serde_json::json!({"text": "e"}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "All done.".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-different");
        let result = agent.process_message("various", &mut session, None).await.unwrap();
        assert_eq!(result.text, "All done.");
    }

    #[tokio::test]
    async fn returns_error_on_provider_failure() {
        let agent = create_agent(Arc::new(FailingProvider), None);
        let mut session = Session::new("test-error");
        let result = agent.process_message("fail", &mut session, None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Network down"));
    }

    #[tokio::test]
    async fn handles_unknown_tool_gracefully() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-x", "nonexistent_tool", serde_json::json!({}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "Recovered.".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-unknown-tool");
        let result = agent.process_message("use unknown", &mut session, None).await.unwrap();
        assert_eq!(result.text, "Recovered.");
    }

    #[tokio::test]
    async fn stops_at_max_iterations() {
        let mut responses: Vec<ChatResponse> = Vec::new();
        for i in 0..15 {
            responses.push(ChatResponse { text: "".into(), tool_calls: vec![make_tool_call(&format!("tc-{i}"), "echo", serde_json::json!({"text": format!("iter-{i}")}))], thinking: None, usage: None, finish_reason: None });
        }
        let provider = Arc::new(MockProvider::new(responses));
        let tools = create_tools();
        let agent = PrismerAgent::new(
            provider, Arc::new(tools), Arc::new(EventBus::default()),
            "Test.".into(), "test-model".into(), "researcher".into(), "/tmp".into(),
        ).with_options(AgentOptions { max_iterations: 5, ..AgentOptions::default() });
        let mut session = Session::new("test-max-iter");
        let result = agent.process_message("loop forever", &mut session, None).await.unwrap();
        assert!(result.iterations <= 5, "Expected <= 5 iterations, got {}", result.iterations);
    }

    #[tokio::test]
    async fn preserves_thinking_in_result() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "Answer.".into(), tool_calls: vec![], thinking: Some("I need to think about this...".into()), usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-thinking");
        let result = agent.process_message("think hard", &mut session, None).await.unwrap();
        assert_eq!(result.text, "Answer.");
        assert_eq!(result.thinking.as_deref(), Some("I need to think about this..."));
    }

    #[tokio::test]
    async fn stores_reasoning_in_assistant_messages() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-1", "echo", serde_json::json!({"text": "test"}))], thinking: Some("Let me use a tool.".into()), usage: None, finish_reason: None },
            ChatResponse { text: "Done.".into(), tool_calls: vec![], thinking: Some("Tool worked.".into()), usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-reasoning-roundtrip");
        let _result = agent.process_message("reason and act", &mut session, None).await.unwrap();
        let assistant_msgs: Vec<&Message> = session.messages.iter().filter(|m| m.role == "assistant").collect();
        assert!(assistant_msgs.len() >= 1);
        assert_eq!(assistant_msgs[0].reasoning_content.as_deref(), Some("Let me use a tool."));
    }

    #[tokio::test]
    async fn compacts_oversized_tool_output() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-big", "big_output", serde_json::json!({}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "Processed.".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-compact");
        let result = agent.process_message("get big data", &mut session, None).await.unwrap();
        let tool_msg = session.messages.iter().find(|m| m.role == "tool").unwrap();
        let tool_content = tool_msg.text_content().unwrap();
        assert!(tool_content.len() < 200_000);
        assert!(tool_content.contains("truncated"));
        assert_eq!(result.text, "Processed.");
    }

    #[tokio::test]
    async fn does_not_compact_small_tool_outputs() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-small", "echo", serde_json::json!({"text": "hello"}))], thinking: None, usage: None, finish_reason: None },
            ChatResponse { text: "ok".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-no-compact");
        let _result = agent.process_message("echo", &mut session, None).await.unwrap();
        let tool_msg = session.messages.iter().find(|m| m.role == "tool").unwrap();
        assert_eq!(tool_msg.text_content().unwrap(), "Echo: hello");
    }

    #[tokio::test]
    async fn accumulates_token_usage_across_iterations() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "".into(), tool_calls: vec![make_tool_call("tc-1", "echo", serde_json::json!({"text": "a"}))], thinking: None, usage: Some(Usage { prompt_tokens: 100, completion_tokens: 50 }), finish_reason: None },
            ChatResponse { text: "Done.".into(), tool_calls: vec![], thinking: None, usage: Some(Usage { prompt_tokens: 200, completion_tokens: 80 }), finish_reason: None },
        ]));
        let agent = create_agent(provider, None);
        let mut session = Session::new("test-usage");
        let result = agent.process_message("track usage", &mut session, None).await.unwrap();
        let usage = result.usage.unwrap();
        assert_eq!(usage.prompt_tokens, 300);
        assert_eq!(usage.completion_tokens, 130);
    }

    // ══════════════════════════════════════════════════════════
    //  NEW: Approval gate tests
    // ══════════════════════════════════════════════════════════

    #[test]
    fn needs_approval_returns_true_for_bash_with_rm_rf() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        assert!(agent.needs_approval("bash", &serde_json::json!({"command": "rm -rf /tmp/data"})));
    }

    #[test]
    fn needs_approval_returns_true_for_bash_with_mv() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        assert!(agent.needs_approval("bash", &serde_json::json!({"command": "mv /important/file /dev/null"})));
    }

    #[test]
    fn needs_approval_returns_true_for_bash_with_chmod() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        assert!(agent.needs_approval("bash", &serde_json::json!({"command": "chmod 777 /etc/passwd"})));
    }

    #[test]
    fn needs_approval_returns_true_for_bash_with_kill() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        assert!(agent.needs_approval("bash", &serde_json::json!({"command": "kill -9 1234"})));
    }

    #[test]
    fn needs_approval_returns_false_for_bash_with_safe_command() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        assert!(!agent.needs_approval("bash", &serde_json::json!({"command": "echo hello"})));
    }

    #[test]
    fn needs_approval_returns_false_for_bash_with_ls() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        assert!(!agent.needs_approval("bash", &serde_json::json!({"command": "ls -la /tmp"})));
    }

    #[test]
    fn needs_approval_returns_false_for_echo_tool() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        // "echo" is not in sensitive_tools, so always false
        assert!(!agent.needs_approval("echo", &serde_json::json!({"text": "rm -rf /"})));
    }

    #[test]
    fn needs_approval_returns_false_for_non_sensitive_tool() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        assert!(!agent.needs_approval("read_file", &serde_json::json!({})));
    }

    #[test]
    fn needs_approval_uses_cmd_field_as_fallback() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        // TS code checks args.command || args.cmd
        assert!(agent.needs_approval("bash", &serde_json::json!({"cmd": "rm -rf /data"})));
    }

    #[tokio::test]
    async fn approval_times_out_to_false() {
        let agent = PrismerAgent::new(
            Arc::new(MockProvider::new(vec![])), Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Test.".into(), "test-model".into(), "researcher".into(), "/tmp".into(),
        ).with_options(AgentOptions { approval_timeout_ms: 100, ..AgentOptions::default() });

        assert!(!agent.wait_for_approval("timeout-tool").await, "Approval should time out to false");
    }

    #[tokio::test]
    async fn resolve_approval_approves_waiting_tool() {
        let agent = Arc::new(PrismerAgent::new(
            Arc::new(MockProvider::new(vec![])), Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Test.".into(), "test-model".into(), "researcher".into(), "/tmp".into(),
        ).with_options(AgentOptions { approval_timeout_ms: 5_000, ..AgentOptions::default() }));

        let agent_clone = agent.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            agent_clone.resolve_approval("tool-approve", true);
        });

        assert!(agent.wait_for_approval("tool-approve").await);
    }

    #[tokio::test]
    async fn resolve_approval_rejects_waiting_tool() {
        let agent = Arc::new(PrismerAgent::new(
            Arc::new(MockProvider::new(vec![])), Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Test.".into(), "test-model".into(), "researcher".into(), "/tmp".into(),
        ).with_options(AgentOptions { approval_timeout_ms: 5_000, ..AgentOptions::default() }));

        let agent_clone = agent.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            agent_clone.resolve_approval("tool-reject", false);
        });

        assert!(!agent.wait_for_approval("tool-reject").await);
    }

    // ══════════════════════════════════════════════════════════
    //  NEW: Sub-agent delegation tests
    // ══════════════════════════════════════════════════════════

    #[test]
    fn resolve_from_mention_creates_child_session() {
        let mut agents = AgentRegistry::new();
        agents.register_many(builtin_agents());

        let result = agents.resolve_from_mention("@latex-expert compile this paper");
        assert!(result.is_some());
        let (agent_id, message) = result.unwrap();
        assert_eq!(agent_id, "latex-expert");
        assert_eq!(message, "compile this paper");

        let parent = Session::new("parent-sess");
        let child = parent.create_child(agent_id);
        assert!(child.id.contains("parent-sess"));
        assert!(child.id.contains("latex-expert"));
        assert_eq!(child.parent_id.as_deref(), Some("parent-sess"));
    }

    #[tokio::test]
    async fn delegate_to_sub_agent_returns_result() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "Compiled successfully.".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let mut agents = AgentRegistry::new();
        agents.register(AgentConfig {
            id: "latex-expert".into(), name: "LaTeX Expert".into(), mode: AgentMode::Subagent,
            system_prompt: "You are a LaTeX expert.".into(), model: None, tools: None, max_iterations: Some(10),
        });
        let agent = PrismerAgent::new(
            provider, Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Primary agent.".into(), "test-model".into(), "researcher".into(), "/tmp".into(),
        ).with_agents(Arc::new(agents));

        let session = Session::new("parent");
        let result = agent.delegate_to_sub_agent("latex-expert", "compile this", &session).await.unwrap();
        assert_eq!(result.text, "Compiled successfully.");
    }

    #[tokio::test]
    async fn delegate_to_unknown_agent_returns_error() {
        let agent = PrismerAgent::new(
            Arc::new(MockProvider::new(vec![])), Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Primary.".into(), "test-model".into(), "researcher".into(), "/tmp".into(),
        ).with_agents(Arc::new(AgentRegistry::new()));

        let session = Session::new("parent");
        let result = agent.delegate_to_sub_agent("nonexistent", "do something", &session).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown sub-agent"));
    }

    #[tokio::test]
    async fn mention_triggers_delegation() {
        let provider = Arc::new(MockProvider::new(vec![
            ChatResponse { text: "LaTeX compiled.".into(), tool_calls: vec![], thinking: None, usage: None, finish_reason: None },
        ]));
        let mut agents = AgentRegistry::new();
        agents.register(AgentConfig {
            id: "latex-expert".into(), name: "LaTeX Expert".into(), mode: AgentMode::Subagent,
            system_prompt: "You are a LaTeX expert.".into(), model: None, tools: None, max_iterations: Some(10),
        });
        let agent = PrismerAgent::new(
            provider, Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Primary agent.".into(), "test-model".into(), "researcher".into(), "/tmp".into(),
        ).with_agents(Arc::new(agents));

        let mut session = Session::new("test-mention");
        let result = agent.process_message("@latex-expert compile this", &mut session, None).await.unwrap();
        assert_eq!(result.text, "LaTeX compiled.");
    }

    // ══════════════════════════════════════════════════════════
    //  NEW: Directive file scanning tests
    // ══════════════════════════════════════════════════════════

    #[test]
    fn snapshot_directive_files_returns_empty_for_nonexistent_dir() {
        let agent = create_agent(Arc::new(MockProvider::new(vec![])), None);
        assert!(agent.snapshot_directive_files().is_empty());
    }

    #[test]
    fn scan_directive_files_processes_json_files() {
        let dir = tempfile::tempdir().unwrap();
        let directive_dir = dir.path().join(".openclaw/directives");
        std::fs::create_dir_all(&directive_dir).unwrap();
        std::fs::write(
            directive_dir.join("test-directive.json"),
            serde_json::to_string(&serde_json::json!({
                "type": "UPDATE_CONTENT", "payload": {"text": "hello"}, "timestamp": "2026-03-24T00:00:00Z"
            })).unwrap(),
        ).unwrap();

        let agent = PrismerAgent::new(
            Arc::new(MockProvider::new(vec![])), Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Test.".into(), "test-model".into(), "researcher".into(), dir.path().to_string_lossy().to_string(),
        );

        let mut directives = Vec::new();
        agent.scan_directive_files(&mut directives, &HashSet::new());

        assert_eq!(directives.len(), 1);
        assert_eq!(directives[0].r#type, "UPDATE_CONTENT");
        assert_eq!(directives[0].payload["text"], "hello");
        assert!(!directive_dir.join("test-directive.json").exists()); // deleted
    }

    #[test]
    fn scan_directive_files_skips_known_files() {
        let dir = tempfile::tempdir().unwrap();
        let directive_dir = dir.path().join(".openclaw/directives");
        std::fs::create_dir_all(&directive_dir).unwrap();
        std::fs::write(
            directive_dir.join("known.json"),
            serde_json::to_string(&serde_json::json!({"type": "NOTIFICATION", "payload": {"msg": "test"}})).unwrap(),
        ).unwrap();

        let agent = PrismerAgent::new(
            Arc::new(MockProvider::new(vec![])), Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Test.".into(), "test-model".into(), "researcher".into(), dir.path().to_string_lossy().to_string(),
        );

        let mut directives = Vec::new();
        let mut known = HashSet::new();
        known.insert("known.json".to_string());
        agent.scan_directive_files(&mut directives, &known);

        assert!(directives.is_empty());
        assert!(directive_dir.join("known.json").exists()); // not deleted
    }

    #[test]
    fn scan_directive_files_skips_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        let directive_dir = dir.path().join(".openclaw/directives");
        std::fs::create_dir_all(&directive_dir).unwrap();
        std::fs::write(directive_dir.join("bad.json"), "not json at all").unwrap();

        let agent = PrismerAgent::new(
            Arc::new(MockProvider::new(vec![])), Arc::new(create_tools()), Arc::new(EventBus::default()),
            "Test.".into(), "test-model".into(), "researcher".into(), dir.path().to_string_lossy().to_string(),
        );

        let mut directives = Vec::new();
        agent.scan_directive_files(&mut directives, &HashSet::new());
        assert!(directives.is_empty());
    }
}
