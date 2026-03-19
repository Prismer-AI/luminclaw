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
}
