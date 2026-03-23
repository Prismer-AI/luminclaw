//! Artifact store — mirrors TypeScript `artifacts/`.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub mime_type: String,
    pub url: String,
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub added_by: String,
    pub task_id: Option<String>,
    pub added_at: u64,
}

pub trait ArtifactStore: Send + Sync {
    fn add(&self, artifact: Artifact) -> Artifact;
    fn get(&self, id: &str) -> Option<Artifact>;
    fn get_by_task(&self, task_id: &str) -> Vec<Artifact>;
    fn get_unassigned(&self) -> Vec<Artifact>;
    fn assign_to_task(&self, artifact_id: &str, task_id: &str) -> bool;
    fn list(&self) -> Vec<Artifact>;
    fn clear(&self);
}

pub struct InMemoryArtifactStore {
    artifacts: Mutex<HashMap<String, Artifact>>,
}

impl InMemoryArtifactStore {
    pub fn new() -> Self {
        Self { artifacts: Mutex::new(HashMap::new()) }
    }
}

impl Default for InMemoryArtifactStore {
    fn default() -> Self { Self::new() }
}

impl ArtifactStore for InMemoryArtifactStore {
    fn add(&self, mut artifact: Artifact) -> Artifact {
        if artifact.id.is_empty() {
            artifact.id = uuid::Uuid::new_v4().to_string();
        }
        if artifact.added_at == 0 {
            artifact.added_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        }
        let mut map = self.artifacts.lock().unwrap();
        map.insert(artifact.id.clone(), artifact.clone());
        artifact
    }

    fn get(&self, id: &str) -> Option<Artifact> {
        self.artifacts.lock().unwrap().get(id).cloned()
    }

    fn get_by_task(&self, task_id: &str) -> Vec<Artifact> {
        self.artifacts.lock().unwrap().values()
            .filter(|a| a.task_id.as_deref() == Some(task_id))
            .cloned().collect()
    }

    fn get_unassigned(&self) -> Vec<Artifact> {
        self.artifacts.lock().unwrap().values()
            .filter(|a| a.task_id.is_none())
            .cloned().collect()
    }

    fn assign_to_task(&self, artifact_id: &str, task_id: &str) -> bool {
        let mut map = self.artifacts.lock().unwrap();
        if let Some(a) = map.get_mut(artifact_id) {
            a.task_id = Some(task_id.to_string());
            true
        } else {
            false
        }
    }

    fn list(&self) -> Vec<Artifact> {
        self.artifacts.lock().unwrap().values().cloned().collect()
    }

    fn clear(&self) {
        self.artifacts.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_artifact(id: &str, task_id: Option<&str>) -> Artifact {
        Artifact {
            id: id.into(),
            mime_type: "image/png".into(),
            url: format!("https://example.com/{id}.png"),
            artifact_type: "image".into(),
            added_by: "user".into(),
            task_id: task_id.map(|s| s.into()),
            added_at: 0,
        }
    }

    #[test]
    fn artifact_creation_auto_generated_id() {
        let store = InMemoryArtifactStore::new();
        let artifact = store.add(Artifact {
            id: String::new(), // empty = auto-generate
            mime_type: "image/png".into(),
            url: "https://example.com/img.png".into(),
            artifact_type: "image".into(),
            added_by: "user".into(),
            task_id: None,
            added_at: 0,
        });
        assert!(!artifact.id.is_empty(), "id should be auto-generated");
        assert!(artifact.added_at > 0, "added_at should be set");
    }

    #[test]
    fn artifact_creation_preserves_explicit_id() {
        let store = InMemoryArtifactStore::new();
        let artifact = store.add(make_artifact("my-id", None));
        assert_eq!(artifact.id, "my-id");
    }

    #[test]
    fn add_and_get() {
        let store = InMemoryArtifactStore::new();
        let added = store.add(make_artifact("a1", None));
        let fetched = store.get("a1").expect("should find artifact");
        assert_eq!(fetched.id, added.id);
        assert_eq!(fetched.url, added.url);
    }

    #[test]
    fn get_returns_none_for_missing() {
        let store = InMemoryArtifactStore::new();
        assert!(store.get("nonexistent").is_none());
    }

    #[test]
    fn get_by_task_filters_correctly() {
        let store = InMemoryArtifactStore::new();
        store.add(make_artifact("a1", Some("task-1")));
        store.add(make_artifact("a2", Some("task-2")));
        store.add(make_artifact("a3", Some("task-1")));
        store.add(make_artifact("a4", None));

        let result = store.get_by_task("task-1");
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|a| a.task_id.as_deref() == Some("task-1")));
    }

    #[test]
    fn get_by_task_returns_empty_for_unknown_task() {
        let store = InMemoryArtifactStore::new();
        store.add(make_artifact("a1", Some("task-1")));
        assert!(store.get_by_task("task-999").is_empty());
    }

    #[test]
    fn get_unassigned_returns_unassigned_only() {
        let store = InMemoryArtifactStore::new();
        store.add(make_artifact("a1", Some("task-1")));
        store.add(make_artifact("a2", None));
        store.add(make_artifact("a3", None));

        let unassigned = store.get_unassigned();
        assert_eq!(unassigned.len(), 2);
        assert!(unassigned.iter().all(|a| a.task_id.is_none()));
    }

    #[test]
    fn get_unassigned_returns_empty_when_all_assigned() {
        let store = InMemoryArtifactStore::new();
        store.add(make_artifact("a1", Some("task-1")));
        assert!(store.get_unassigned().is_empty());
    }

    #[test]
    fn assign_to_task_updates_task_id() {
        let store = InMemoryArtifactStore::new();
        store.add(make_artifact("a1", None));

        assert!(store.assign_to_task("a1", "task-99"));
        let artifact = store.get("a1").unwrap();
        assert_eq!(artifact.task_id, Some("task-99".into()));

        // Should now appear in get_by_task
        assert_eq!(store.get_by_task("task-99").len(), 1);
        // And not in unassigned
        assert!(store.get_unassigned().is_empty());
    }

    #[test]
    fn assign_to_task_returns_false_for_missing() {
        let store = InMemoryArtifactStore::new();
        assert!(!store.assign_to_task("nonexistent", "task-1"));
    }

    #[test]
    fn list_returns_all() {
        let store = InMemoryArtifactStore::new();
        store.add(make_artifact("a1", None));
        store.add(make_artifact("a2", Some("task-1")));
        store.add(make_artifact("a3", None));

        assert_eq!(store.list().len(), 3);
    }

    #[test]
    fn list_empty_store() {
        let store = InMemoryArtifactStore::new();
        assert!(store.list().is_empty());
    }

    #[test]
    fn clear_removes_all() {
        let store = InMemoryArtifactStore::new();
        store.add(make_artifact("a1", None));
        store.add(make_artifact("a2", Some("task-1")));
        assert_eq!(store.list().len(), 2);

        store.clear();
        assert!(store.list().is_empty());
        assert!(store.get("a1").is_none());
    }

    #[test]
    fn default_creates_empty_store() {
        let store = InMemoryArtifactStore::default();
        assert!(store.list().is_empty());
    }

    #[test]
    fn artifact_serde_round_trip() {
        let artifact = make_artifact("a1", Some("task-1"));
        let json = serde_json::to_string(&artifact).unwrap();
        let deserialized: Artifact = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "a1");
        assert_eq!(deserialized.task_id, Some("task-1".into()));
        assert_eq!(deserialized.mime_type, "image/png");
    }
}
