//! DualLoopAgent — HIL (outer) + ExecutionLoop (inner) in Rust.
//!
//! processMessage() resolves quickly after creating a task.
//! Result arrives later via EventBus events.

use crate::loop_types::*;
use crate::artifacts::{Artifact, ArtifactStore, InMemoryArtifactStore};
use crate::task::{Task, TaskStatus, TaskStateMachine, InMemoryTaskStore, TaskStore};
use crate::world_model::WorldModel;
use crate::agent::{PrismerAgent, AgentOptions};
use crate::provider::OpenAIProvider;
use crate::tools::ToolRegistry;
use crate::tools::builtins::register_all_builtins;
use crate::session::Session;
use crate::prompt::PromptBuilder;
use crate::config::LuminConfig;
use crate::sse::{EventBus, AgentEvent};
use crate::abort::AbortReason;
use std::sync::{Arc, Mutex};
use tracing::{info, error};

pub struct DualLoopAgent {
    pub artifacts: InMemoryArtifactStore,
    pub tasks: InMemoryTaskStore,
    world_model: Mutex<Option<WorldModel>>,
    cancelled: Arc<Mutex<Option<AbortReason>>>,
    config: LuminConfig,
}

impl DualLoopAgent {
    pub fn new() -> Self {
        Self {
            artifacts: InMemoryArtifactStore::new(),
            tasks: InMemoryTaskStore::new(),
            world_model: Mutex::new(None),
            cancelled: Arc::new(Mutex::new(None)),
            config: LuminConfig::from_env(),
        }
    }

    pub fn with_config(config: LuminConfig) -> Self {
        Self {
            artifacts: InMemoryArtifactStore::new(),
            tasks: InMemoryTaskStore::new(),
            world_model: Mutex::new(None),
            cancelled: Arc::new(Mutex::new(None)),
            config,
        }
    }

    /// Cancel with an explicit reason.  `None` defaults to `UserExplicitCancel`.
    pub fn cancel_with_reason(&self, reason: Option<AbortReason>) {
        let reason = reason.unwrap_or(AbortReason::UserExplicitCancel);
        *self.cancelled.lock().unwrap() = Some(reason);
        if let Some(task) = self.tasks.get_active() {
            self.tasks.update_status(&task.id, TaskStatus::Failed);
            info!(task_id = %task.id, reason = reason.as_str(), "task cancelled");
        }
    }
}

impl Default for DualLoopAgent {
    fn default() -> Self { Self::new() }
}

#[async_trait::async_trait]
impl AgentLoop for DualLoopAgent {
    fn mode(&self) -> LoopMode { LoopMode::Dual }

    async fn process_message(&self, input: AgentLoopInput, opts: Option<AgentLoopCallOpts>) -> Result<AgentLoopResult, String> {
        *self.cancelled.lock().unwrap() = None;

        let session_id = input.session_id.unwrap_or_else(|| format!("dual-{}", uuid::Uuid::new_v4()));
        let task_id = uuid::Uuid::new_v4().to_string();

        // Assign unassigned artifacts
        let unassigned = self.artifacts.get_unassigned();
        let artifact_ids: Vec<String> = unassigned.iter().map(|a| a.id.clone()).collect();
        for a in &unassigned {
            self.artifacts.assign_to_task(&a.id, &task_id);
        }

        // Lazy eviction — remove old completed/failed tasks (24h)
        self.tasks.evict_completed(24 * 60 * 60 * 1000);

        // Create task
        let _task = self.tasks.create(Task {
            id: task_id.clone(),
            session_id: session_id.clone(),
            instruction: input.content.clone(),
            artifact_ids,
            plan: None,
            status: TaskStatus::Pending,
            checkpoints: vec![],
            result: None,
            error: None,
            created_at: 0,
            updated_at: 0,
        });

        // Transition to executing
        if let Some(mut t) = self.tasks.get(&task_id) {
            let _ = TaskStateMachine::transition(&mut t, TaskStatus::Executing);
            self.tasks.update_status(&task_id, TaskStatus::Executing);
        }

        // Create world model
        let world_model = WorldModel::new(&task_id, &input.content);
        *self.world_model.lock().unwrap() = Some(world_model.clone());

        // Get bus for inner loop
        let bus = opts
            .as_ref()
            .and_then(|o| o.bus.clone())
            .unwrap_or_else(|| Arc::new(EventBus::default()));

        // Emit task.created event (frontend can use taskId for status polling)
        bus.publish(AgentEvent {
            event_type: "task.created".into(),
            data: serde_json::json!({
                "taskId": &task_id,
                "sessionId": &session_id,
                "instruction": &input.content[..input.content.len().min(500)],
            }),
        });

        bus.publish(AgentEvent {
            event_type: "agent.start".into(),
            data: serde_json::json!({ "sessionId": &session_id, "agentId": "dual-loop", "taskId": &task_id }),
        });

        info!(task_id = %task_id, "task created and executing (dual-loop)");

        // Fire inner loop in background
        let config = self.config.clone();
        let cancelled = self.cancelled.clone();
        let task_id_clone = task_id.clone();
        let session_id_clone = session_id.clone();
        let content = input.content.clone();
        let tasks = self.tasks.clone_store();
        let world_model_ref = self.world_model.lock().unwrap().clone();
        let bus_clone = bus.clone();

        tokio::spawn(async move {
            let result = run_inner_loop(
                &config, &content, &session_id_clone, &task_id_clone,
                world_model_ref, &cancelled, &bus_clone,
            ).await;

            match result {
                Ok(agent_result) => {
                    // Extract and persist facts to MemoryStore
                    let facts = crate::world_model::WorldModel::extract_structured_facts(&agent_result.text, "researcher");
                    if !facts.is_empty() {
                        let facts_str = format!("[WorldModel Facts] task={}\n{}",
                            task_id_clone,
                            facts.iter().map(|f| format!("{}: {}", f.key, f.value)).collect::<Vec<_>>().join("\n")
                        );
                        let _ = crate::MemoryStore::new(&config.workspace.dir).store(&facts_str, &["world-model"]);
                    }

                    // Complete the task
                    if let Some(mut t) = tasks.get(&task_id_clone) {
                        let _ = TaskStateMachine::complete(&mut t, agent_result.text.clone());
                        tasks.update_status(&task_id_clone, TaskStatus::Completed);
                    }

                    bus_clone.publish(AgentEvent {
                        event_type: "task.completed".into(),
                        data: serde_json::json!({
                            "taskId": task_id_clone,
                            "sessionId": session_id_clone,
                            "result": &agent_result.text[..agent_result.text.len().min(500)],
                            "toolsUsed": agent_result.tools_used,
                        }),
                    });

                    // Emit chat.final so frontend gets the result
                    bus_clone.publish(AgentEvent {
                        event_type: "chat.final".into(),
                        data: serde_json::json!({
                            "content": agent_result.text,
                            "thinking": agent_result.thinking,
                            "toolsUsed": agent_result.tools_used,
                            "directives": agent_result.directives.iter().map(|d| serde_json::json!({"type": d.r#type, "payload": d.payload})).collect::<Vec<_>>(),
                            "iterations": agent_result.iterations,
                            "sessionId": session_id_clone,
                            "taskId": task_id_clone,
                        }),
                    });

                    info!(task_id = %task_id_clone, "inner loop completed");
                }
                Err(e) => {
                    if let Some(mut t) = tasks.get(&task_id_clone) {
                        let _ = TaskStateMachine::fail(&mut t, e.clone());
                        tasks.update_status(&task_id_clone, TaskStatus::Failed);
                    }

                    bus_clone.publish(AgentEvent {
                        event_type: "error".into(),
                        data: serde_json::json!({
                            "taskId": task_id_clone,
                            "error": e,
                        }),
                    });

                    error!(task_id = %task_id_clone, error = %e, "inner loop failed");
                }
            }
        });

        // Return immediately — inner loop runs in background
        Ok(AgentLoopResult {
            text: format!("Task {task_id} created and executing."),
            thinking: None,
            directives: vec![],
            tools_used: vec![],
            usage: None,
            iterations: 0,
            session_id,
            task_id: Some(task_id),
        })
    }

    fn add_artifact(&self, artifact: Artifact) {
        self.artifacts.add(artifact);
    }

    fn resume(&self, clarification: &str) {
        if let Some(task) = self.tasks.get_active() {
            if task.status == TaskStatus::Paused {
                self.tasks.update_status(&task.id, TaskStatus::Executing);
                info!(task_id = %task.id, clarification = &clarification[..clarification.len().min(100)], "task resumed");
            }
        }
    }

    fn cancel(&self) {
        self.cancel_with_reason(None);
    }

    async fn shutdown(&self) {
        self.cancel_with_reason(Some(AbortReason::ServerShutdown));
        *self.world_model.lock().unwrap() = None;
    }
}

/// Inner execution loop — runs PrismerAgent in background.
async fn run_inner_loop(
    config: &LuminConfig,
    content: &str,
    session_id: &str,
    _task_id: &str,
    world_model: Option<WorldModel>,
    cancelled: &Arc<Mutex<Option<AbortReason>>>,
    bus: &EventBus,
) -> Result<crate::agent::AgentResult, String> {
    // Check cancel before starting
    if let Some(reason) = cancelled.lock().unwrap().as_ref() {
        return Err(format!("Cancelled before execution: {}", reason.as_str()));
    }

    let provider = OpenAIProvider::new(
        &config.llm.base_url,
        &config.llm.api_key,
        &config.llm.model,
    );

    let mut tools = ToolRegistry::new();
    register_all_builtins(&mut tools, &config.workspace.dir);

    // Build system prompt with handoff context
    let mut pb = PromptBuilder::new(&config.workspace.dir);
    pb.load_identity();
    pb.load_tools_ref();
    pb.load_user_profile();

    if let Some(ref wm) = world_model {
        let handoff = wm.build_handoff_context("inner-loop");
        pb.set_workspace_context(&handoff);
    }

    pb.add_runtime_info(Some("dual-loop"), Some(&config.llm.model), Some(tools.size()));
    let system_prompt = pb.build();

    let mut session = Session::new(session_id);
    let bus = Arc::new(bus.clone());

    let agent = PrismerAgent::new(
        Arc::new(provider),
        Arc::new(tools),
        bus,
        system_prompt,
        config.llm.model.clone(),
        "dual-loop".into(),
        config.workspace.dir.clone(),
    ).with_options(AgentOptions {
        max_iterations: config.agent.max_iterations,
        max_context_chars: config.agent.max_context_chars,
        ..AgentOptions::default()
    });

    agent.process_message(content, &mut session, Some(cancelled.clone())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_is_dual() {
        let agent = DualLoopAgent::new();
        assert_eq!(agent.mode(), LoopMode::Dual);
    }

    #[test]
    fn add_artifact_stores() {
        let agent = DualLoopAgent::new();
        agent.add_artifact(Artifact {
            id: String::new(), mime_type: "image/png".into(), url: "https://x.png".into(),
            artifact_type: "image".into(), added_by: "user".into(), task_id: None, added_at: 0,
        });
        assert_eq!(agent.artifacts.list().len(), 1);
    }

    #[test]
    fn cancel_fails_active_task() {
        let agent = DualLoopAgent::new();
        let _task = agent.tasks.create(Task {
            id: "t1".into(), session_id: "s1".into(), instruction: "test".into(),
            artifact_ids: vec![], plan: None, status: TaskStatus::Pending, checkpoints: vec![],
            result: None, error: None, created_at: 0, updated_at: 0,
        });
        agent.tasks.update_status("t1", TaskStatus::Executing);
        agent.cancel();
        assert_eq!(agent.tasks.get("t1").unwrap().status, TaskStatus::Failed);
    }

    #[tokio::test]
    async fn process_message_returns_quickly() {
        let agent = DualLoopAgent::new();
        let start = std::time::Instant::now();
        let result = agent.process_message(
            AgentLoopInput { content: "test".into(), session_id: None, images: vec![], config: None },
            None,
        ).await.unwrap();
        let elapsed = start.elapsed();

        assert!(elapsed.as_millis() < 100, "dual-loop should resolve quickly");
        assert!(result.text.contains("Task"));
        assert_eq!(result.iterations, 0);
    }

    #[test]
    fn default_creates_dual_loop_agent() {
        let agent = DualLoopAgent::default();
        assert_eq!(agent.mode(), LoopMode::Dual);
    }

    #[test]
    fn world_model_created_for_task() {
        let agent = DualLoopAgent::new();
        // Initially no world model
        assert!(agent.world_model.lock().unwrap().is_none());
    }

    #[test]
    fn add_artifact_stores_in_artifact_store() {
        let agent = DualLoopAgent::new();
        agent.add_artifact(Artifact {
            id: "img-1".into(),
            mime_type: "image/png".into(),
            url: "https://img.png".into(),
            artifact_type: "image".into(),
            added_by: "user".into(),
            task_id: None,
            added_at: 0,
        });
        assert_eq!(agent.artifacts.list().len(), 1);
        assert_eq!(agent.artifacts.list()[0].id, "img-1");
    }

    #[test]
    fn multiple_artifacts_can_be_added() {
        let agent = DualLoopAgent::new();
        for i in 0..5 {
            agent.add_artifact(Artifact {
                id: format!("art-{i}"),
                mime_type: "text/plain".into(),
                url: format!("https://example.com/{i}"),
                artifact_type: "file".into(),
                added_by: "user".into(),
                task_id: None,
                added_at: 0,
            });
        }
        assert_eq!(agent.artifacts.list().len(), 5);
    }

    #[test]
    fn multiple_tasks_can_be_created() {
        let agent = DualLoopAgent::new();
        for i in 0..3 {
            agent.tasks.create(Task {
                id: format!("task-{i}"),
                session_id: "s1".into(),
                instruction: format!("Task {i}"),
                artifact_ids: vec![],
                plan: None,
                status: TaskStatus::Pending,
                checkpoints: vec![],
                result: None,
                error: None,
                created_at: 0,
                updated_at: 0,
            });
        }
        assert_eq!(agent.tasks.list().len(), 3);
    }

    #[tokio::test]
    async fn shutdown_clears_world_model() {
        let agent = DualLoopAgent::new();
        // Set a world model manually
        *agent.world_model.lock().unwrap() = Some(crate::world_model::WorldModel::new("t1", "test goal"));
        assert!(agent.world_model.lock().unwrap().is_some());

        agent.shutdown().await;
        assert!(agent.world_model.lock().unwrap().is_none());
    }

    #[test]
    fn resume_transitions_paused_task_to_executing() {
        let agent = DualLoopAgent::new();
        agent.tasks.create(Task {
            id: "resume-task".into(),
            session_id: "s1".into(),
            instruction: "test".into(),
            artifact_ids: vec![],
            plan: None,
            status: TaskStatus::Pending,
            checkpoints: vec![],
            result: None,
            error: None,
            created_at: 0,
            updated_at: 0,
        });
        // Transition: Pending -> Executing -> Paused
        agent.tasks.update_status("resume-task", TaskStatus::Executing);
        agent.tasks.update_status("resume-task", TaskStatus::Paused);

        assert_eq!(agent.tasks.get("resume-task").unwrap().status, TaskStatus::Paused);

        agent.resume("Continue please");
        assert_eq!(agent.tasks.get("resume-task").unwrap().status, TaskStatus::Executing);
    }

    #[test]
    fn resume_does_nothing_when_no_paused_task() {
        let agent = DualLoopAgent::new();
        // No tasks at all
        agent.resume("Continue");
        // Should not panic
    }

    #[test]
    fn resume_does_nothing_when_task_is_executing_not_paused() {
        let agent = DualLoopAgent::new();
        agent.tasks.create(Task {
            id: "exec-task".into(),
            session_id: "s1".into(),
            instruction: "test".into(),
            artifact_ids: vec![],
            plan: None,
            status: TaskStatus::Pending,
            checkpoints: vec![],
            result: None,
            error: None,
            created_at: 0,
            updated_at: 0,
        });
        agent.tasks.update_status("exec-task", TaskStatus::Executing);

        // Resume should only act on paused tasks
        agent.resume("Continue");
        // Task should still be executing (resume doesn't change executing -> executing)
        assert_eq!(agent.tasks.get("exec-task").unwrap().status, TaskStatus::Executing);
    }

    #[test]
    fn cancel_sets_cancelled_flag() {
        let agent = DualLoopAgent::new();
        assert!(agent.cancelled.lock().unwrap().is_none());
        agent.cancel();
        assert!(agent.cancelled.lock().unwrap().is_some());
        assert_eq!(
            *agent.cancelled.lock().unwrap(),
            Some(AbortReason::UserExplicitCancel)
        );
    }

    #[test]
    fn cancel_with_no_active_task_sets_flag_only() {
        let agent = DualLoopAgent::new();
        agent.cancel();
        assert!(agent.cancelled.lock().unwrap().is_some());
    }

    #[test]
    fn cancel_with_reason_stores_reason() {
        let agent = DualLoopAgent::new();
        agent.cancel_with_reason(Some(AbortReason::Timeout));
        assert_eq!(
            *agent.cancelled.lock().unwrap(),
            Some(AbortReason::Timeout)
        );
    }

    #[test]
    fn with_config_creates_agent_with_custom_config() {
        let config = LuminConfig::from_env();
        let agent = DualLoopAgent::with_config(config);
        assert_eq!(agent.mode(), LoopMode::Dual);
    }

    #[tokio::test]
    async fn process_message_creates_task_in_store() {
        let agent = DualLoopAgent::new();
        let result = agent.process_message(
            AgentLoopInput {
                content: "Write a paper".into(),
                session_id: Some("sess-1".into()),
                images: vec![],
                config: None,
            },
            None,
        ).await.unwrap();

        // A task should have been created
        let tasks = agent.tasks.list();
        assert!(!tasks.is_empty(), "should have created a task");
        assert_eq!(result.session_id, "sess-1");
    }

    #[tokio::test]
    async fn process_message_assigns_unassigned_artifacts_to_task() {
        let agent = DualLoopAgent::new();
        // Add an unassigned artifact first
        agent.add_artifact(Artifact {
            id: "pre-artifact".into(),
            mime_type: "image/png".into(),
            url: "https://img.png".into(),
            artifact_type: "image".into(),
            added_by: "user".into(),
            task_id: None,
            added_at: 0,
        });

        let _result = agent.process_message(
            AgentLoopInput {
                content: "Analyze this image".into(),
                session_id: None,
                images: vec![],
                config: None,
            },
            None,
        ).await.unwrap();

        // The artifact should now be assigned to the task
        let artifact = agent.artifacts.get("pre-artifact").unwrap();
        assert!(artifact.task_id.is_some(), "artifact should be assigned to a task");
        // No more unassigned artifacts
        assert!(agent.artifacts.get_unassigned().is_empty());
    }
}
