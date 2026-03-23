//! Agent loop factory — mirrors TypeScript `loop/factory.ts`.

use crate::loop_types::{AgentLoop, LoopMode};
use crate::loop_single::SingleLoopAgent;
use crate::loop_dual::DualLoopAgent;
use std::sync::Arc;
use tracing::info;

/// Resolve the effective loop mode.
/// Priority: db_mode > LUMIN_LOOP_MODE env > "single" default.
pub fn resolve_loop_mode(db_mode: Option<&str>) -> LoopMode {
    if let Some("dual") = db_mode { return LoopMode::Dual; }
    if let Some("single") = db_mode { return LoopMode::Single; }

    match std::env::var("LUMIN_LOOP_MODE").as_deref() {
        Ok("dual") => LoopMode::Dual,
        Ok("single") => LoopMode::Single,
        _ => LoopMode::Single,
    }
}

/// Create an agent loop for the given mode.
pub fn create_agent_loop(mode: Option<LoopMode>) -> Arc<dyn AgentLoop> {
    let resolved = mode.unwrap_or_else(|| resolve_loop_mode(None));
    info!(mode = %resolved, "creating agent loop");

    match resolved {
        LoopMode::Single => Arc::new(SingleLoopAgent::new()),
        LoopMode::Dual => {
            info!("creating dual-loop agent");
            Arc::new(DualLoopAgent::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_single() {
        // Don't modify env in tests (unsafe in Rust 2024); just test with db_mode
        assert_eq!(resolve_loop_mode(None), LoopMode::Single);
    }

    #[test]
    fn db_overrides_env() {
        assert_eq!(resolve_loop_mode(Some("dual")), LoopMode::Dual);
        assert_eq!(resolve_loop_mode(Some("single")), LoopMode::Single);
    }

    #[test]
    fn resolve_with_explicit_dual_mode() {
        assert_eq!(resolve_loop_mode(Some("dual")), LoopMode::Dual);
    }

    #[test]
    fn resolve_with_explicit_single_mode() {
        assert_eq!(resolve_loop_mode(Some("single")), LoopMode::Single);
    }

    #[test]
    fn resolve_with_unknown_db_mode_defaults_to_single() {
        // An unrecognized db_mode value falls through to env/default
        assert_eq!(resolve_loop_mode(Some("unknown")), LoopMode::Single);
    }

    #[test]
    fn resolve_with_none_defaults_to_single() {
        assert_eq!(resolve_loop_mode(None), LoopMode::Single);
    }

    #[test]
    fn create_agent_loop_single_returns_single_mode() {
        let agent = create_agent_loop(Some(LoopMode::Single));
        assert_eq!(agent.mode(), LoopMode::Single);
    }

    #[test]
    fn create_agent_loop_dual_returns_dual_mode() {
        let agent = create_agent_loop(Some(LoopMode::Dual));
        assert_eq!(agent.mode(), LoopMode::Dual);
    }

    #[test]
    fn create_agent_loop_none_defaults_to_single() {
        let agent = create_agent_loop(None);
        assert_eq!(agent.mode(), LoopMode::Single);
    }

    #[test]
    fn resolve_with_db_mode_dual() {
        assert_eq!(resolve_loop_mode(Some("dual")), LoopMode::Dual);
    }

    #[test]
    fn resolve_with_db_mode_single() {
        assert_eq!(resolve_loop_mode(Some("single")), LoopMode::Single);
    }

    #[test]
    fn resolve_with_invalid_db_mode_falls_back_to_single() {
        assert_eq!(resolve_loop_mode(Some("invalid")), LoopMode::Single);
    }

    #[test]
    fn resolve_with_empty_string_db_mode_falls_back_to_single() {
        assert_eq!(resolve_loop_mode(Some("")), LoopMode::Single);
    }

    #[test]
    fn explicit_mode_single_to_create_agent_loop() {
        let agent = create_agent_loop(Some(LoopMode::Single));
        assert_eq!(agent.mode(), LoopMode::Single);
    }

    #[test]
    fn explicit_mode_dual_to_create_agent_loop() {
        let agent = create_agent_loop(Some(LoopMode::Dual));
        assert_eq!(agent.mode(), LoopMode::Dual);
    }

    #[test]
    fn create_agent_loop_single_implements_agent_loop_trait() {
        let agent = create_agent_loop(Some(LoopMode::Single));
        // Verify all trait methods exist via the dyn trait
        assert_eq!(agent.mode(), LoopMode::Single);
        agent.add_artifact(crate::artifacts::Artifact {
            id: "test".into(),
            mime_type: "text/plain".into(),
            url: "https://example.com".into(),
            artifact_type: "file".into(),
            added_by: "test".into(),
            task_id: None,
            added_at: 0,
        });
        agent.resume("test");
        agent.cancel();
    }

    #[test]
    fn create_agent_loop_dual_implements_agent_loop_trait() {
        let agent = create_agent_loop(Some(LoopMode::Dual));
        assert_eq!(agent.mode(), LoopMode::Dual);
        agent.add_artifact(crate::artifacts::Artifact {
            id: "test".into(),
            mime_type: "text/plain".into(),
            url: "https://example.com".into(),
            artifact_type: "file".into(),
            added_by: "test".into(),
            task_id: None,
            added_at: 0,
        });
        agent.resume("test");
        agent.cancel();
    }

    #[test]
    fn multiple_agent_loops_are_independent() {
        let single = create_agent_loop(Some(LoopMode::Single));
        let dual = create_agent_loop(Some(LoopMode::Dual));
        assert_eq!(single.mode(), LoopMode::Single);
        assert_eq!(dual.mode(), LoopMode::Dual);
        assert_ne!(single.mode(), dual.mode());
    }
}
