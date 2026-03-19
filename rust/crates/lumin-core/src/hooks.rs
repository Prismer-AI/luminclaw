//! Lifecycle hooks — mirrors TypeScript `hooks.ts`.
//! Extension points: before_prompt, before_tool, after_tool, agent_end.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub struct HookContext {
    pub workspace_dir: String,
    pub session_id: String,
    pub agent_id: String,
}

pub type AsyncHookFn<I, O> = Arc<
    dyn Fn(HookContext, I) -> Pin<Box<dyn Future<Output = O> + Send>> + Send + Sync
>;

pub struct BeforeToolResult {
    pub proceed: bool,
    pub args: serde_json::Value,
}

pub struct HookRegistry {
    before_prompt: Vec<AsyncHookFn<String, String>>,
    before_tool: Vec<AsyncHookFn<(String, serde_json::Value), BeforeToolResult>>,
    after_tool: Vec<AsyncHookFn<(String, String, bool), ()>>,
    agent_end: Vec<AsyncHookFn<(), ()>>,
}

impl HookRegistry {
    pub fn new() -> Self {
        Self {
            before_prompt: Vec::new(),
            before_tool: Vec::new(),
            after_tool: Vec::new(),
            agent_end: Vec::new(),
        }
    }

    pub fn on_before_prompt(&mut self, hook: AsyncHookFn<String, String>) {
        self.before_prompt.push(hook);
    }

    pub fn on_before_tool(&mut self, hook: AsyncHookFn<(String, serde_json::Value), BeforeToolResult>) {
        self.before_tool.push(hook);
    }

    pub fn on_after_tool(&mut self, hook: AsyncHookFn<(String, String, bool), ()>) {
        self.after_tool.push(hook);
    }

    pub fn on_agent_end(&mut self, hook: AsyncHookFn<(), ()>) {
        self.agent_end.push(hook);
    }

    /// Run before_prompt hooks in chain (each can modify the prompt).
    pub async fn run_before_prompt(&self, ctx: HookContext, mut prompt: String) -> String {
        for hook in &self.before_prompt {
            prompt = hook(HookContext {
                workspace_dir: ctx.workspace_dir.clone(),
                session_id: ctx.session_id.clone(),
                agent_id: ctx.agent_id.clone(),
            }, prompt).await;
        }
        prompt
    }

    /// Run before_tool hooks. Returns (proceed, modified_args).
    pub async fn run_before_tool(&self, ctx: HookContext, tool: String, args: serde_json::Value) -> BeforeToolResult {
        let mut current_args = args;
        for hook in &self.before_tool {
            let result = hook(HookContext {
                workspace_dir: ctx.workspace_dir.clone(),
                session_id: ctx.session_id.clone(),
                agent_id: ctx.agent_id.clone(),
            }, (tool.clone(), current_args)).await;
            if !result.proceed {
                return result;
            }
            current_args = result.args;
        }
        BeforeToolResult { proceed: true, args: current_args }
    }

    /// Run after_tool hooks (observe only).
    pub async fn run_after_tool(&self, ctx: HookContext, tool: String, result: String, error: bool) {
        for hook in &self.after_tool {
            hook(HookContext {
                workspace_dir: ctx.workspace_dir.clone(),
                session_id: ctx.session_id.clone(),
                agent_id: ctx.agent_id.clone(),
            }, (tool.clone(), result.clone(), error)).await;
        }
    }

    /// Run agent_end hooks (observe only).
    pub async fn run_agent_end(&self, ctx: HookContext) {
        for hook in &self.agent_end {
            hook(HookContext {
                workspace_dir: ctx.workspace_dir.clone(),
                session_id: ctx.session_id.clone(),
                agent_id: ctx.agent_id.clone(),
            }, ()).await;
        }
    }

    pub fn has_hooks(&self) -> bool {
        !self.before_prompt.is_empty() || !self.before_tool.is_empty()
            || !self.after_tool.is_empty() || !self.agent_end.is_empty()
    }
}

impl Default for HookRegistry {
    fn default() -> Self { Self::new() }
}
