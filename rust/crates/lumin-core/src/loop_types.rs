//! IAgentLoop trait — mirrors TypeScript `loop/types.ts`.

use crate::artifacts::Artifact;
use crate::directives::Directive;
use crate::sse::EventBus;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopMode { Single, Dual }

impl std::fmt::Display for LoopMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { Self::Single => write!(f, "single"), Self::Dual => write!(f, "dual") }
    }
}

pub struct AgentLoopInput {
    pub content: String,
    pub session_id: Option<String>,
    pub images: Vec<ImageRef>,
    pub config: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct ImageRef {
    pub url: String,
    pub mime_type: Option<String>,
}

pub struct AgentLoopResult {
    pub text: String,
    pub thinking: Option<String>,
    pub directives: Vec<Directive>,
    pub tools_used: Vec<String>,
    pub usage: Option<crate::provider::Usage>,
    pub iterations: u32,
    pub session_id: String,
}

pub struct AgentLoopCallOpts {
    pub bus: Option<Arc<EventBus>>,
}

/// The unified agent loop interface.
#[async_trait::async_trait]
pub trait AgentLoop: Send + Sync {
    fn mode(&self) -> LoopMode;
    async fn process_message(&self, input: AgentLoopInput, opts: Option<AgentLoopCallOpts>) -> Result<AgentLoopResult, String>;
    fn add_artifact(&self, artifact: Artifact);
    fn resume(&self, clarification: &str);
    fn cancel(&self);
    async fn shutdown(&self);
}
