//! Task model + state machine — mirrors TypeScript `task/`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus { Pending, Planning, Executing, Paused, Completed, Failed }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub task_id: String,
    #[serde(rename = "type")]
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
    tasks: Arc<Mutex<HashMap<String, Task>>>,
}

impl InMemoryTaskStore {
    pub fn new() -> Self { Self { tasks: Arc::new(Mutex::new(HashMap::new())) } }

    /// Clone the store handle (shares the same underlying data).
    pub fn clone_store(&self) -> Self {
        Self { tasks: self.tasks.clone() }
    }
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

    fn make_task(status: TaskStatus) -> Task {
        Task {
            id: "task-1".into(),
            session_id: "s1".into(),
            instruction: "Write a paper".into(),
            artifact_ids: vec!["art-1".into()],
            status,
            checkpoints: vec![],
            result: None,
            error: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    // ── Task creation ───────────────────────────────────────

    #[test]
    fn task_creation_with_all_fields() {
        let task = Task {
            id: "task-42".into(),
            session_id: "sess-7".into(),
            instruction: "Analyze dataset".into(),
            artifact_ids: vec!["a1".into(), "a2".into()],
            status: TaskStatus::Pending,
            checkpoints: vec![Checkpoint {
                id: "cp-1".into(),
                task_id: "task-42".into(),
                checkpoint_type: "progress".into(),
                message: "Step 1 done".into(),
                requires_user_action: false,
                emitted_at: 1000,
            }],
            result: Some("Completed analysis".into()),
            error: None,
            created_at: 100,
            updated_at: 200,
        };
        assert_eq!(task.id, "task-42");
        assert_eq!(task.session_id, "sess-7");
        assert_eq!(task.instruction, "Analyze dataset");
        assert_eq!(task.artifact_ids.len(), 2);
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.checkpoints.len(), 1);
        assert_eq!(task.checkpoints[0].checkpoint_type, "progress");
        assert_eq!(task.result, Some("Completed analysis".into()));
        assert!(task.error.is_none());
        assert_eq!(task.created_at, 100);
        assert_eq!(task.updated_at, 200);
    }

    // ── TaskStateMachine: all valid transitions ─────────────

    #[test]
    fn valid_pending_to_planning() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Pending, TaskStatus::Planning));
        let mut task = make_task(TaskStatus::Pending);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Planning).is_ok());
        assert_eq!(task.status, TaskStatus::Planning);
    }

    #[test]
    fn valid_pending_to_executing() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Pending, TaskStatus::Executing));
        let mut task = make_task(TaskStatus::Pending);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Executing).is_ok());
        assert_eq!(task.status, TaskStatus::Executing);
    }

    #[test]
    fn valid_pending_to_failed() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Pending, TaskStatus::Failed));
        let mut task = make_task(TaskStatus::Pending);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Failed).is_ok());
        assert_eq!(task.status, TaskStatus::Failed);
    }

    #[test]
    fn valid_planning_to_executing() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Planning, TaskStatus::Executing));
        let mut task = make_task(TaskStatus::Planning);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Executing).is_ok());
        assert_eq!(task.status, TaskStatus::Executing);
    }

    #[test]
    fn valid_planning_to_failed() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Planning, TaskStatus::Failed));
        let mut task = make_task(TaskStatus::Planning);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Failed).is_ok());
        assert_eq!(task.status, TaskStatus::Failed);
    }

    #[test]
    fn valid_executing_to_paused() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Executing, TaskStatus::Paused));
        let mut task = make_task(TaskStatus::Executing);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Paused).is_ok());
        assert_eq!(task.status, TaskStatus::Paused);
    }

    #[test]
    fn valid_executing_to_completed() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Executing, TaskStatus::Completed));
        let mut task = make_task(TaskStatus::Executing);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Completed).is_ok());
        assert_eq!(task.status, TaskStatus::Completed);
    }

    #[test]
    fn valid_executing_to_failed() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Executing, TaskStatus::Failed));
        let mut task = make_task(TaskStatus::Executing);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Failed).is_ok());
        assert_eq!(task.status, TaskStatus::Failed);
    }

    #[test]
    fn valid_paused_to_executing() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Paused, TaskStatus::Executing));
        let mut task = make_task(TaskStatus::Paused);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Executing).is_ok());
        assert_eq!(task.status, TaskStatus::Executing);
    }

    #[test]
    fn valid_paused_to_failed() {
        assert!(TaskStateMachine::can_transition(TaskStatus::Paused, TaskStatus::Failed));
        let mut task = make_task(TaskStatus::Paused);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Failed).is_ok());
        assert_eq!(task.status, TaskStatus::Failed);
    }

    // ── TaskStateMachine: invalid transitions ───────────────

    #[test]
    fn invalid_completed_to_any() {
        assert!(!TaskStateMachine::can_transition(TaskStatus::Completed, TaskStatus::Executing));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Completed, TaskStatus::Failed));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Completed, TaskStatus::Pending));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Completed, TaskStatus::Planning));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Completed, TaskStatus::Paused));

        let mut task = make_task(TaskStatus::Completed);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Executing).is_err());
    }

    #[test]
    fn invalid_failed_to_any() {
        assert!(!TaskStateMachine::can_transition(TaskStatus::Failed, TaskStatus::Executing));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Failed, TaskStatus::Pending));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Failed, TaskStatus::Planning));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Failed, TaskStatus::Completed));
        assert!(!TaskStateMachine::can_transition(TaskStatus::Failed, TaskStatus::Paused));

        let mut task = make_task(TaskStatus::Failed);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Pending).is_err());
    }

    #[test]
    fn invalid_pending_to_completed() {
        assert!(!TaskStateMachine::can_transition(TaskStatus::Pending, TaskStatus::Completed));
        let mut task = make_task(TaskStatus::Pending);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Completed).is_err());
    }

    #[test]
    fn invalid_pending_to_paused() {
        assert!(!TaskStateMachine::can_transition(TaskStatus::Pending, TaskStatus::Paused));
        let mut task = make_task(TaskStatus::Pending);
        assert!(TaskStateMachine::transition(&mut task, TaskStatus::Paused).is_err());
    }

    // ── complete() and fail() ───────────────────────────────

    #[test]
    fn complete_sets_result_and_status() {
        let mut task = make_task(TaskStatus::Executing);
        assert!(TaskStateMachine::complete(&mut task, "Done!".into()).is_ok());
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.result, Some("Done!".into()));
    }

    #[test]
    fn complete_from_non_executing_fails() {
        let mut task = make_task(TaskStatus::Pending);
        assert!(TaskStateMachine::complete(&mut task, "x".into()).is_err());
        // Status should not change on error
        assert_eq!(task.status, TaskStatus::Pending);
    }

    #[test]
    fn fail_sets_error_and_status() {
        let mut task = make_task(TaskStatus::Executing);
        assert!(TaskStateMachine::fail(&mut task, "Something broke".into()).is_ok());
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.error, Some("Something broke".into()));
    }

    #[test]
    fn fail_from_completed_errors() {
        let mut task = make_task(TaskStatus::Completed);
        assert!(TaskStateMachine::fail(&mut task, "err".into()).is_err());
        assert_eq!(task.status, TaskStatus::Completed);
    }

    // ── transition updates updated_at ───────────────────────

    #[test]
    fn transition_updates_timestamp() {
        let mut task = make_task(TaskStatus::Pending);
        task.updated_at = 0;
        TaskStateMachine::transition(&mut task, TaskStatus::Executing).unwrap();
        assert!(task.updated_at > 0);
    }

    // ── InMemoryTaskStore ───────────────────────────────────

    #[test]
    fn store_create_sets_timestamps() {
        let store = InMemoryTaskStore::new();
        let task = store.create(make_task(TaskStatus::Pending));
        assert!(task.created_at > 0, "created_at should be set");
        assert!(task.updated_at > 0, "updated_at should be set");
        assert_eq!(task.created_at, task.updated_at);
    }

    #[test]
    fn store_get_returns_none_for_missing() {
        let store = InMemoryTaskStore::new();
        assert!(store.get("nonexistent").is_none());
    }

    #[test]
    fn store_create_and_get_roundtrip() {
        let store = InMemoryTaskStore::new();
        let created = store.create(make_task(TaskStatus::Pending));
        let fetched = store.get(&created.id).expect("task should exist");
        assert_eq!(fetched.id, created.id);
        assert_eq!(fetched.instruction, "Write a paper");
    }

    #[test]
    fn store_update_status_changes_status() {
        let store = InMemoryTaskStore::new();
        store.create(make_task(TaskStatus::Pending));
        let updated = store.update_status("task-1", TaskStatus::Executing);
        assert!(updated.is_some());
        let t = updated.unwrap();
        assert_eq!(t.status, TaskStatus::Executing);
        assert!(t.updated_at > 0);
    }

    #[test]
    fn store_update_status_returns_none_for_missing() {
        let store = InMemoryTaskStore::new();
        assert!(store.update_status("nope", TaskStatus::Failed).is_none());
    }

    #[test]
    fn store_get_active_returns_executing_task() {
        let store = InMemoryTaskStore::new();
        let mut t1 = make_task(TaskStatus::Pending);
        t1.id = "t1".into();
        let mut t2 = make_task(TaskStatus::Pending);
        t2.id = "t2".into();
        store.create(t1);
        store.create(t2);
        store.update_status("t2", TaskStatus::Executing);

        let active = store.get_active().expect("should find active task");
        assert_eq!(active.id, "t2");
        assert_eq!(active.status, TaskStatus::Executing);
    }

    #[test]
    fn store_get_active_returns_paused_task() {
        let store = InMemoryTaskStore::new();
        let mut t1 = make_task(TaskStatus::Pending);
        t1.id = "t1".into();
        store.create(t1);
        store.update_status("t1", TaskStatus::Paused);

        let active = store.get_active().expect("should find paused task");
        assert_eq!(active.id, "t1");
        assert_eq!(active.status, TaskStatus::Paused);
    }

    #[test]
    fn store_get_active_returns_none_when_no_active() {
        let store = InMemoryTaskStore::new();
        let mut t1 = make_task(TaskStatus::Completed);
        t1.id = "t1".into();
        let mut t2 = make_task(TaskStatus::Failed);
        t2.id = "t2".into();
        store.create(t1);
        store.create(t2);

        assert!(store.get_active().is_none());
    }

    #[test]
    fn store_list_returns_all_tasks() {
        let store = InMemoryTaskStore::new();
        let mut t1 = make_task(TaskStatus::Pending);
        t1.id = "t1".into();
        let mut t2 = make_task(TaskStatus::Completed);
        t2.id = "t2".into();
        store.create(t1);
        store.create(t2);

        assert_eq!(store.list().len(), 2);
    }

    #[test]
    fn store_list_empty() {
        let store = InMemoryTaskStore::new();
        assert_eq!(store.list().len(), 0);
    }

    #[test]
    fn clone_store_shares_data() {
        let store = InMemoryTaskStore::new();
        store.create(make_task(TaskStatus::Pending));

        let cloned = store.clone_store();
        // Cloned store should see the same task
        assert!(cloned.get("task-1").is_some());

        // Modifying through the clone is visible in the original
        cloned.update_status("task-1", TaskStatus::Executing);
        let from_original = store.get("task-1").unwrap();
        assert_eq!(from_original.status, TaskStatus::Executing);
    }

    // ── Serde round-trip ────────────────────────────────────

    #[test]
    fn task_status_serializes_lowercase() {
        let json = serde_json::to_string(&TaskStatus::Pending).unwrap();
        assert_eq!(json, "\"pending\"");

        let json = serde_json::to_string(&TaskStatus::Completed).unwrap();
        assert_eq!(json, "\"completed\"");
    }

    #[test]
    fn task_status_deserializes_lowercase() {
        let status: TaskStatus = serde_json::from_str("\"executing\"").unwrap();
        assert_eq!(status, TaskStatus::Executing);
    }
}
