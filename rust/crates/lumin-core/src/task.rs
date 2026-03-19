//! Task model + state machine — mirrors TypeScript `task/`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus { Pending, Planning, Executing, Paused, Completed, Failed }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub session_id: String,
    pub instruction: String,
    pub artifact_ids: Vec<String>,
    pub status: TaskStatus,
    pub checkpoints: Vec<Checkpoint>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub task_id: String,
    pub checkpoint_type: String,
    pub message: String,
    pub requires_user_action: bool,
    pub emitted_at: u64,
}

// ── State Machine ─────────────────────────────────────────

pub struct TaskStateMachine;

impl TaskStateMachine {
    pub fn can_transition(from: TaskStatus, to: TaskStatus) -> bool {
        matches!(
            (from, to),
            (TaskStatus::Pending, TaskStatus::Planning)
            | (TaskStatus::Pending, TaskStatus::Executing)
            | (TaskStatus::Pending, TaskStatus::Failed)
            | (TaskStatus::Planning, TaskStatus::Executing)
            | (TaskStatus::Planning, TaskStatus::Failed)
            | (TaskStatus::Executing, TaskStatus::Paused)
            | (TaskStatus::Executing, TaskStatus::Completed)
            | (TaskStatus::Executing, TaskStatus::Failed)
            | (TaskStatus::Paused, TaskStatus::Executing)
            | (TaskStatus::Paused, TaskStatus::Failed)
        )
    }

    pub fn transition(task: &mut Task, to: TaskStatus) -> Result<(), String> {
        if !Self::can_transition(task.status, to) {
            return Err(format!("Invalid transition: {:?} → {:?}", task.status, to));
        }
        task.status = to;
        task.updated_at = now_ms();
        Ok(())
    }

    pub fn complete(task: &mut Task, result: String) -> Result<(), String> {
        Self::transition(task, TaskStatus::Completed)?;
        task.result = Some(result);
        Ok(())
    }

    pub fn fail(task: &mut Task, error: String) -> Result<(), String> {
        Self::transition(task, TaskStatus::Failed)?;
        task.error = Some(error);
        Ok(())
    }
}

// ── Store ─────────────────────────────────────────────────

pub trait TaskStore: Send + Sync {
    fn create(&self, task: Task) -> Task;
    fn get(&self, id: &str) -> Option<Task>;
    fn update_status(&self, id: &str, status: TaskStatus) -> Option<Task>;
    fn get_active(&self) -> Option<Task>;
    fn list(&self) -> Vec<Task>;
}

pub struct InMemoryTaskStore {
    tasks: Mutex<HashMap<String, Task>>,
}

impl InMemoryTaskStore {
    pub fn new() -> Self { Self { tasks: Mutex::new(HashMap::new()) } }
}

impl Default for InMemoryTaskStore {
    fn default() -> Self { Self::new() }
}

impl TaskStore for InMemoryTaskStore {
    fn create(&self, mut task: Task) -> Task {
        let now = now_ms();
        task.created_at = now;
        task.updated_at = now;
        let mut map = self.tasks.lock().unwrap();
        map.insert(task.id.clone(), task.clone());
        task
    }

    fn get(&self, id: &str) -> Option<Task> {
        self.tasks.lock().unwrap().get(id).cloned()
    }

    fn update_status(&self, id: &str, status: TaskStatus) -> Option<Task> {
        let mut map = self.tasks.lock().unwrap();
        if let Some(task) = map.get_mut(id) {
            task.status = status;
            task.updated_at = now_ms();
            Some(task.clone())
        } else {
            None
        }
    }

    fn get_active(&self) -> Option<Task> {
        self.tasks.lock().unwrap().values()
            .find(|t| t.status == TaskStatus::Executing || t.status == TaskStatus::Paused)
            .cloned()
    }

    fn list(&self) -> Vec<Task> {
        self.tasks.lock().unwrap().values().cloned().collect()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_transitions() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Pending, TaskStatus::Executing));
        assert!(TaskStateMachine::can_transition(TaskStatus::Executing, TaskStatus::Completed));
        assert!(TaskStateMachine::can_transition(TaskStatus::Executing, TaskStatus::Paused));
        assert!(TaskStateMachine::can_transition(TaskStatus::Paused, TaskStatus::Executing));
    }

    #[test]
    fn invalid_transitions() {
        assert!(!TaskStateMachine::can_transition(TaskStatus::Completed, TaskStatus::Executing));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Failed, TaskStatus::Pending));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Pending, TaskStatus::Completed));
    }
}
