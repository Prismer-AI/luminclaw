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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_ctx() -> HookContext {
        HookContext {
            workspace_dir: "/tmp/test".into(),
            session_id: "s1".into(),
            agent_id: "agent1".into(),
        }
    }

    #[test]
    fn new_is_empty() {
        let registry = HookRegistry::new();
        assert!(!registry.has_hooks());
    }

    #[test]
    fn has_hooks_returns_false_when_empty() {
        let registry = HookRegistry::default();
        assert!(!registry.has_hooks());
    }

    #[tokio::test]
    async fn register_before_prompt_and_run_it() {
        let mut registry = HookRegistry::new();
        let hook: AsyncHookFn<String, String> = Arc::new(|_ctx, prompt| {
            Box::pin(async move { prompt })
        });
        registry.on_before_prompt(hook);
        assert!(registry.has_hooks());

        let result = registry.run_before_prompt(make_ctx(), "hello".into()).await;
        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn before_prompt_modifies_prompt_string() {
        let mut registry = HookRegistry::new();
        let hook: AsyncHookFn<String, String> = Arc::new(|_ctx, prompt| {
            Box::pin(async move { format!("{prompt} [modified]") })
        });
        registry.on_before_prompt(hook);

        let result = registry.run_before_prompt(make_ctx(), "original".into()).await;
        assert_eq!(result, "original [modified]");
    }

    #[tokio::test]
    async fn register_before_tool_and_verify_proceed_true() {
        let mut registry = HookRegistry::new();
        let hook: AsyncHookFn<(String, serde_json::Value), BeforeToolResult> = Arc::new(|_ctx, (_tool, args)| {
            Box::pin(async move {
                BeforeToolResult { proceed: true, args }
            })
        });
        registry.on_before_tool(hook);
        assert!(registry.has_hooks());

        let result = registry.run_before_tool(
            make_ctx(),
            "bash".into(),
            serde_json::json!({"cmd": "ls"}),
        ).await;
        assert!(result.proceed);
        assert_eq!(result.args["cmd"], "ls");
    }

    #[tokio::test]
    async fn before_tool_can_block() {
        let mut registry = HookRegistry::new();
        let hook: AsyncHookFn<(String, serde_json::Value), BeforeToolResult> = Arc::new(|_ctx, (_tool, args)| {
            Box::pin(async move {
                BeforeToolResult { proceed: false, args }
            })
        });
        registry.on_before_tool(hook);

        let result = registry.run_before_tool(
            make_ctx(),
            "dangerous_tool".into(),
            serde_json::json!({}),
        ).await;
        assert!(!result.proceed);
    }

    #[tokio::test]
    async fn after_tool_runs_without_error() {
        let mut registry = HookRegistry::new();
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let called_clone = called.clone();
        let hook: AsyncHookFn<(String, String, bool), ()> = Arc::new(move |_ctx, (_tool, _result, _error)| {
            let called = called_clone.clone();
            Box::pin(async move {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
            })
        });
        registry.on_after_tool(hook);

        registry.run_after_tool(
            make_ctx(),
            "bash".into(),
            "output".into(),
            false,
        ).await;
        assert!(called.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn agent_end_runs_without_error() {
        let mut registry = HookRegistry::new();
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let called_clone = called.clone();
        let hook: AsyncHookFn<(), ()> = Arc::new(move |_ctx, ()| {
            let called = called_clone.clone();
            Box::pin(async move {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
            })
        });
        registry.on_agent_end(hook);

        registry.run_agent_end(make_ctx()).await;
        assert!(called.load(std::sync::atomic::Ordering::SeqCst));
    }
}
