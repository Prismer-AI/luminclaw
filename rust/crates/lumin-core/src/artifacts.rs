//! Artifact store — mirrors TypeScript `artifacts/`.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub id: String,
    pub mime_type: String,
    pub url: String,
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
