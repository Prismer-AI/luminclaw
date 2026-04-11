//! SingleLoopAgent — mirrors TypeScript `loop/single.ts`.
//! Wraps `PrismerAgent` to conform to the `AgentLoop` trait.

use crate::loop_types::*;
use crate::artifacts::{Artifact, ArtifactStore, InMemoryArtifactStore};
use crate::agent::{PrismerAgent, AgentOptions};
use crate::provider::OpenAIProvider;
use crate::tools::{ToolRegistry, create_bash_tool};
use crate::session::SessionStore;
use crate::prompt::PromptBuilder;
use crate::sse::EventBus;
use crate::config::LuminConfig;
use std::sync::Arc;

pub struct SingleLoopAgent {
    pub artifacts: InMemoryArtifactStore,
    config: LuminConfig,
    sessions: SessionStore,
}

impl SingleLoopAgent {
    pub fn new() -> Self {
        Self {
            artifacts: InMemoryArtifactStore::new(),
            config: LuminConfig::from_env(),
            sessions: SessionStore::new(),
        }
    }

    pub fn with_config(config: LuminConfig) -> Self {
        Self {
            artifacts: InMemoryArtifactStore::new(),
            config,
            sessions: SessionStore::new(),
        }
    }
}

impl Default for SingleLoopAgent {
    fn default() -> Self { Self::new() }
}

#[async_trait::async_trait]
impl AgentLoop for SingleLoopAgent {
    fn mode(&self) -> LoopMode { LoopMode::Single }

    async fn process_message(&self, input: AgentLoopInput, opts: Option<AgentLoopCallOpts>) -> Result<AgentLoopResult, String> {
        let session_id = input.session_id.unwrap_or_else(|| format!("session-{}", uuid::Uuid::new_v4()));

        // Get or create session
        let mut session = self.sessions.get_or_create(&session_id);

        // Set up provider
        let provider = OpenAIProvider::new(
            &self.config.llm.base_url,
            &self.config.llm.api_key,
            &self.config.llm.model,
        );

        // Set up tools
        let mut tools = ToolRegistry::new();
        tools.register(create_bash_tool(self.config.workspace.dir.clone()));

        // Set up EventBus
        let bus = if let Some(ref call_opts) = opts {
            call_opts.bus.clone().unwrap_or_else(|| Arc::new(EventBus::default()))
        } else {
            Arc::new(EventBus::default())
        };

        // Build system prompt
        let mut pb = PromptBuilder::new(&self.config.workspace.dir);
        pb.load_identity();
        pb.load_tools_ref();
        pb.load_user_profile();
        pb.add_runtime_info(Some("researcher"), Some(&self.config.llm.model), Some(tools.size()));
        let system_prompt = pb.build();

        // Create and run agent
        let agent = PrismerAgent::new(
            Arc::new(provider),
            Arc::new(tools),
            bus,
            system_prompt,
            self.config.llm.model.clone(),
            "researcher".into(),
            self.config.workspace.dir.clone(),
        ).with_options(AgentOptions {
            max_iterations: self.config.agent.max_iterations,
            max_context_chars: self.config.agent.max_context_chars,
            ..AgentOptions::default()
        });

        let result = agent.process_message(&input.content, &mut session, None).await?;

        // Persist session
        self.sessions.update(session);

        Ok(AgentLoopResult {
            text: result.text,
            thinking: result.thinking,
            directives: result.directives,
            tools_used: result.tools_used,
            usage: result.usage,
            iterations: result.iterations,
            session_id,
            task_id: None,
        })
    }

    fn add_artifact(&self, artifact: Artifact) {
        self.artifacts.add(artifact);
    }

    fn resume(&self, _clarification: &str) { /* no-op in single mode */ }
    fn cancel(&self) { /* no-op in single mode */ }
    async fn shutdown(&self) { /* no-op */ }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_returns_single() {
        let agent = SingleLoopAgent::new();
        assert_eq!(agent.mode(), LoopMode::Single);
    }

    #[test]
    fn default_creates_single_loop_agent() {
        let agent = SingleLoopAgent::default();
        assert_eq!(agent.mode(), LoopMode::Single);
    }

    #[test]
    fn add_artifact_stores_artifact() {
        let agent = SingleLoopAgent::new();
        agent.add_artifact(Artifact {
            id: "art-1".into(),
            mime_type: "image/png".into(),
            url: "data:image/png;base64,abc".into(),
            artifact_type: "image".into(),
            added_by: "user".into(),
            task_id: None,
            added_at: 0,
        });
        assert_eq!(agent.artifacts.list().len(), 1);
    }

    #[test]
    fn add_artifact_stores_multiple() {
        let agent = SingleLoopAgent::new();
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
    fn resume_is_noop() {
        let agent = SingleLoopAgent::new();
        // Should not panic
        agent.resume("user clarification");
    }

    #[test]
    fn cancel_is_noop() {
        let agent = SingleLoopAgent::new();
        // Should not panic
        agent.cancel();
    }

    #[tokio::test]
    async fn shutdown_resolves_without_error() {
        let agent = SingleLoopAgent::new();
        agent.shutdown().await;
        // No panic = success
    }

    #[test]
    fn multiple_instances_are_independent() {
        let a = SingleLoopAgent::new();
        let b = SingleLoopAgent::new();
        assert_eq!(a.mode(), LoopMode::Single);
        assert_eq!(b.mode(), LoopMode::Single);

        a.add_artifact(Artifact {
            id: "a-only".into(),
            mime_type: "text/plain".into(),
            url: "https://a.com".into(),
            artifact_type: "file".into(),
            added_by: "user".into(),
            task_id: None,
            added_at: 0,
        });
        assert_eq!(a.artifacts.list().len(), 1);
        assert_eq!(b.artifacts.list().len(), 0);
    }

    #[test]
    fn artifacts_stored_but_unused_in_single_mode() {
        let agent = SingleLoopAgent::new();
        agent.add_artifact(Artifact {
            id: "test".into(),
            mime_type: "image/png".into(),
            url: "https://img.png".into(),
            artifact_type: "image".into(),
            added_by: "user".into(),
            task_id: None,
            added_at: 0,
        });
        // Artifacts are stored (accessible) but not used by single loop processing
        let artifacts = agent.artifacts.list();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].id, "test");
    }

    #[test]
    fn with_config_creates_agent_with_custom_config() {
        let config = LuminConfig::from_env();
        let agent = SingleLoopAgent::with_config(config);
        assert_eq!(agent.mode(), LoopMode::Single);
    }

    #[test]
    fn resume_cancel_shutdown_sequence_does_not_panic() {
        let agent = SingleLoopAgent::new();
        agent.resume("some input");
        agent.cancel();
        // Can call them multiple times without issue
        agent.resume("more input");
        agent.cancel();
    }
}
