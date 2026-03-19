//! DualLoopAgent — HIL (outer) + ExecutionLoop (inner) in Rust.
//!
//! processMessage() resolves quickly after creating a task.
//! Result arrives later via EventBus events.

use crate::loop_types::*;
use crate::artifacts::{Artifact, ArtifactStore, InMemoryArtifactStore};
use crate::task::{Task, TaskStatus, TaskStateMachine, InMemoryTaskStore, TaskStore};
use crate::world_model::WorldModel;
use crate::sse::{EventBus, AgentEvent};
use std::sync::{Arc, Mutex};
use tracing::{info, warn};

pub struct DualLoopAgent {
    pub artifacts: InMemoryArtifactStore,
    pub tasks: InMemoryTaskStore,
    world_model: Mutex<Option<WorldModel>>,
    cancelled: Mutex<bool>,
}

impl DualLoopAgent {
    pub fn new() -> Self {
        Self {
            artifacts: InMemoryArtifactStore::new(),
            tasks: InMemoryTaskStore::new(),
            world_model: Mutex::new(None),
            cancelled: Mutex::new(false),
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
        *self.cancelled.lock().unwrap() = false;

        let session_id = input.session_id.unwrap_or_else(|| format!("dual-{}", uuid::Uuid::new_v4()));
        let task_id = uuid::Uuid::new_v4().to_string();

        // Assign unassigned artifacts
        let unassigned = self.artifacts.get_unassigned();
        let artifact_ids: Vec<String> = unassigned.iter().map(|a| a.id.clone()).collect();
        for a in &unassigned {
            self.artifacts.assign_to_task(&a.id, &task_id);
        }

        // Create task
        let task = self.tasks.create(Task {
            id: task_id.clone(),
            session_id: session_id.clone(),
            instruction: input.content.clone(),
            artifact_ids,
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
        *self.world_model.lock().unwrap() = Some(WorldModel::new(&task_id, &input.content));

        // Emit event
        if let Some(ref opts) = opts {
            if let Some(ref bus) = opts.bus {
                bus.publish(AgentEvent {
                    event_type: "agent.start".into(),
                    data: serde_json::json!({ "sessionId": &session_id, "agentId": "dual-loop", "taskId": &task_id }),
                });
            }
        }

        info!(task_id = %task_id, "task created and executing (dual-loop)");

        // Return immediately — inner loop would run in background
        Ok(AgentLoopResult {
            text: format!("Task {task_id} created and executing."),
            thinking: None,
            directives: vec![],
            tools_used: vec![],
            usage: None,
            iterations: 0,
            session_id,
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
        *self.cancelled.lock().unwrap() = true;
        if let Some(task) = self.tasks.get_active() {
            self.tasks.update_status(&task.id, TaskStatus::Failed);
            info!(task_id = %task.id, "task cancelled");
        }
    }

    async fn shutdown(&self) {
        self.cancel();
        *self.world_model.lock().unwrap() = None;
    }
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
        let task = agent.tasks.create(Task {
            id: "t1".into(), session_id: "s1".into(), instruction: "test".into(),
            artifact_ids: vec![], status: TaskStatus::Pending, checkpoints: vec![],
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
}
