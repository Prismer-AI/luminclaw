//! SingleLoopAgent — mirrors TypeScript `loop/single.ts`.

use crate::loop_types::*;
use crate::artifacts::{Artifact, ArtifactStore, InMemoryArtifactStore};
use crate::sse::EventBus;
use std::sync::Arc;

pub struct SingleLoopAgent {
    pub artifacts: InMemoryArtifactStore,
}

impl SingleLoopAgent {
    pub fn new() -> Self {
        Self { artifacts: InMemoryArtifactStore::new() }
    }
}

impl Default for SingleLoopAgent {
    fn default() -> Self { Self::new() }
}

#[async_trait::async_trait]
impl AgentLoop for SingleLoopAgent {
    fn mode(&self) -> LoopMode { LoopMode::Single }

    async fn process_message(&self, input: AgentLoopInput, _opts: Option<AgentLoopCallOpts>) -> Result<AgentLoopResult, String> {
        // In the full implementation, this would wire up PrismerAgent.
        // For now, return a placeholder that shows the loop is working.
        let session_id = input.session_id.unwrap_or_else(|| format!("session-{}", uuid::Uuid::new_v4()));
        Ok(AgentLoopResult {
            text: format!("SingleLoopAgent received: {}", &input.content[..input.content.len().min(100)]),
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

    fn resume(&self, _clarification: &str) { /* no-op in single mode */ }
    fn cancel(&self) { /* no-op in single mode */ }
    async fn shutdown(&self) { /* no-op */ }
}
