//! Directive types — mirrors TypeScript `directives.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directive {
    pub r#type: String,
    pub payload: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emitted_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_version: Option<u64>,
}

/// All known directive types.
pub const DIRECTIVE_TYPES: &[&str] = &[
    "SWITCH_COMPONENT", "UPDATE_CONTENT", "UPDATE_LATEX", "COMPILE_COMPLETE",
    "JUPYTER_ADD_CELL", "JUPYTER_CELL_OUTPUT", "UPDATE_GALLERY", "UPDATE_CODE",
    "UPDATE_DATA_GRID", "TASK_UPDATE", "UPDATE_TASKS", "TIMELINE_EVENT",
    "THINKING_UPDATE", "OPERATION_STATUS", "ACTION_REQUEST", "REQUEST_CONFIRMATION",
    "NOTIFICATION", "EXTENSION_UPDATE", "COMPONENT_STATE_SYNC", "AGENT_CURSOR", "HUMAN_CURSOR",
];
