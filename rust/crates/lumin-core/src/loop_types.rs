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
    pub path: Option<String>,
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
    pub task_id: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_mode_single_displays_as_single() {
        assert_eq!(format!("{}", LoopMode::Single), "single");
    }

    #[test]
    fn loop_mode_dual_displays_as_dual() {
        assert_eq!(format!("{}", LoopMode::Dual), "dual");
    }

    #[test]
    fn loop_mode_equality() {
        assert_eq!(LoopMode::Single, LoopMode::Single);
        assert_eq!(LoopMode::Dual, LoopMode::Dual);
        assert_ne!(LoopMode::Single, LoopMode::Dual);
    }

    #[test]
    fn loop_mode_clone() {
        let mode = LoopMode::Dual;
        let cloned = mode;
        assert_eq!(mode, cloned);
    }

    #[test]
    fn loop_mode_debug() {
        let debug_str = format!("{:?}", LoopMode::Single);
        assert_eq!(debug_str, "Single");
        let debug_str = format!("{:?}", LoopMode::Dual);
        assert_eq!(debug_str, "Dual");
    }

    #[test]
    fn agent_loop_input_construction() {
        let input = AgentLoopInput {
            content: "Hello".into(),
            session_id: Some("sess-1".into()),
            images: vec![ImageRef { url: "https://img.png".into(), path: None, mime_type: Some("image/png".into()) }],
            config: Some(serde_json::json!({"temperature": 0.7})),
        };
        assert_eq!(input.content, "Hello");
        assert_eq!(input.session_id, Some("sess-1".into()));
        assert_eq!(input.images.len(), 1);
        assert_eq!(input.images[0].url, "https://img.png");
    }

    #[test]
    fn image_ref_optional_mime_type() {
        let img = ImageRef { url: "https://example.com/photo.jpg".into(), path: None, mime_type: None };
        assert!(img.mime_type.is_none());
    }

    #[test]
    fn loop_mode_copy() {
        let mode = LoopMode::Single;
        let copied = mode;
        // Both the original and copy are still valid (Copy trait)
        assert_eq!(mode, copied);
        assert_eq!(mode, LoopMode::Single);
    }

    #[test]
    fn agent_loop_input_with_no_optional_fields() {
        let input = AgentLoopInput {
            content: "Hello".into(),
            session_id: None,
            images: vec![],
            config: None,
        };
        assert_eq!(input.content, "Hello");
        assert!(input.session_id.is_none());
        assert!(input.images.is_empty());
        assert!(input.config.is_none());
    }

    #[test]
    fn agent_loop_input_with_multiple_images() {
        let input = AgentLoopInput {
            content: "Look at these".into(),
            session_id: Some("sess-multi".into()),
            images: vec![
                ImageRef { url: "https://img1.png".into(), path: None, mime_type: Some("image/png".into()) },
                ImageRef { url: "https://img2.jpg".into(), path: None, mime_type: Some("image/jpeg".into()) },
                ImageRef { url: "data:image/gif;base64,abc".into(), path: None, mime_type: None },
            ],
            config: None,
        };
        assert_eq!(input.images.len(), 3);
        assert_eq!(input.images[0].url, "https://img1.png");
        assert_eq!(input.images[1].mime_type, Some("image/jpeg".into()));
        assert!(input.images[2].mime_type.is_none());
    }

    #[test]
    fn agent_loop_input_with_config() {
        let config = serde_json::json!({
            "model": "gpt-4",
            "temperature": 0.7,
            "maxIterations": 10
        });
        let input = AgentLoopInput {
            content: "test".into(),
            session_id: None,
            images: vec![],
            config: Some(config.clone()),
        };
        assert_eq!(input.config.unwrap()["model"], "gpt-4");
    }

    #[test]
    fn image_ref_clone() {
        let img = ImageRef {
            url: "https://example.com/photo.jpg".into(),
            path: Some("/tmp/photo.jpg".into()),
            mime_type: Some("image/jpeg".into()),
        };
        let cloned = img.clone();
        assert_eq!(cloned.url, "https://example.com/photo.jpg");
        assert_eq!(cloned.mime_type, Some("image/jpeg".into()));
    }

    #[test]
    fn image_ref_debug() {
        let img = ImageRef {
            url: "https://example.com/img.png".into(),
            path: None,
            mime_type: Some("image/png".into()),
        };
        let debug = format!("{:?}", img);
        assert!(debug.contains("https://example.com/img.png"));
        assert!(debug.contains("image/png"));
    }

    #[test]
    fn agent_loop_call_opts_with_bus() {
        let bus = std::sync::Arc::new(crate::sse::EventBus::default());
        let opts = AgentLoopCallOpts { bus: Some(bus.clone()) };
        assert!(opts.bus.is_some());
    }

    #[test]
    fn agent_loop_call_opts_without_bus() {
        let opts = AgentLoopCallOpts { bus: None };
        assert!(opts.bus.is_none());
    }

    #[test]
    fn loop_mode_single_ne_dual() {
        assert_ne!(LoopMode::Single, LoopMode::Dual);
        assert_ne!(LoopMode::Dual, LoopMode::Single);
    }

    #[test]
    fn agent_loop_result_construction() {
        let result = AgentLoopResult {
            text: "Hello".into(),
            thinking: Some("I thought about it".into()),
            directives: vec![crate::directives::Directive {
                r#type: "NOTIFICATION".into(),
                payload: serde_json::json!({"msg": "done"}),
                timestamp: None,
                emitted_by: None,
                task_id: None,
                source: None,
                state_version: None,
            }],
            tools_used: vec!["bash".into()],
            usage: Some(crate::provider::Usage { prompt_tokens: 100, completion_tokens: 50 }),
            iterations: 2,
            session_id: "sess-123".into(),
            task_id: Some("task-1".into()),
        };
        assert_eq!(result.text, "Hello");
        assert_eq!(result.thinking, Some("I thought about it".into()));
        assert_eq!(result.directives.len(), 1);
        assert_eq!(result.tools_used, vec!["bash"]);
        assert_eq!(result.iterations, 2);
        assert_eq!(result.session_id, "sess-123");
        let usage = result.usage.unwrap();
        assert_eq!(usage.prompt_tokens, 100);
        assert_eq!(usage.completion_tokens, 50);
    }

    #[test]
    fn agent_loop_result_minimal() {
        let result = AgentLoopResult {
            text: "minimal".into(),
            thinking: None,
            directives: vec![],
            tools_used: vec![],
            usage: None,
            iterations: 0,
            session_id: "s1".into(),
            task_id: None,
        };
        assert_eq!(result.text, "minimal");
        assert!(result.thinking.is_none());
        assert!(result.directives.is_empty());
        assert!(result.tools_used.is_empty());
        assert!(result.usage.is_none());
        assert_eq!(result.iterations, 0);
    }
}
