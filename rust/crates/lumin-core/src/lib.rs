//! Lumin Agent Runtime Core — Rust implementation.
//! Full feature parity with TypeScript `@prismer/agent-core`.

pub mod config;
pub mod provider;
pub mod tools;
pub mod session;
pub mod agent;
pub mod agents;
pub mod directives;
pub mod sse;
pub mod prompt;
pub mod skills;
pub mod memory;
pub mod hooks;
pub mod compaction;
pub mod microcompact;
pub mod workspace;
pub mod ipc;
pub mod channels;
pub mod loop_types;
pub mod loop_single;
pub mod loop_dual;
pub mod loop_factory;
pub mod artifacts;
pub mod task;
pub mod world_model;
pub mod tokens;
pub mod abort;

// Re-exports
pub use abort::AbortReason;
pub use config::{LuminConfig, ApprovalConfig, SessionConfig, ServerConfig, EventBusConfig, MemoryConfig, LogConfig, ModulesConfig, PrismerConfig};
pub use provider::{Provider, OpenAIProvider, FallbackProvider, ChatRequest, ChatResponse, ToolCall, ContentBlock, ImageUrlBlock, MessageContent};
pub use tools::{Tool, ToolRegistry, ToolContext, ToolEvent, EmitFn, safe_path};
pub use session::{Session, SessionStore};
pub use agent::{PrismerAgent, AgentResult, AgentOptions};
pub use agents::{AgentRegistry, AgentConfig, AgentMode, builtin_agents};
pub use prompt::PromptBuilder;
pub use skills::SkillLoader;
pub use memory::{MemoryStore, MemorySearchResult, MemorySearchOptions, MemoryCapabilities};
pub use hooks::HookRegistry;
pub use loop_types::{AgentLoop, LoopMode, AgentLoopInput, AgentLoopResult};
pub use loop_factory::{create_agent_loop, resolve_loop_mode};
pub use artifacts::{Artifact, ArtifactStore, InMemoryArtifactStore};
pub use task::{Task, TaskStatus, TaskStore, InMemoryTaskStore, TaskStateMachine};
pub use channels::ChannelManager;
pub use workspace::WorkspaceConfig;
pub use microcompact::{microcompact as run_microcompact, CLEARED_MARKER};
pub use tokens::{estimate_tokens, estimate_message_tokens};
