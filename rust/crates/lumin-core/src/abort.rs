//! Structured abort reasons.  Mirrors TS `src/abort.ts`.
//!
//! Wire format: snake_case strings, matching TS `AbortReason` enum values.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AbortReason {
    UserInterrupted,
    UserExplicitCancel,
    Timeout,
    SiblingError,
    ServerShutdown,
}

impl AbortReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::UserInterrupted => "user_interrupted",
            Self::UserExplicitCancel => "user_explicit_cancel",
            Self::Timeout => "timeout",
            Self::SiblingError => "sibling_error",
            Self::ServerShutdown => "server_shutdown",
        }
    }
}

impl std::fmt::Display for AbortReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
