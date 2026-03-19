//! IPC — stdin/stdout JSON protocol for host ↔ container communication.
//! Mirrors TypeScript `ipc.ts`.

use serde::{Deserialize, Serialize};

pub const OUTPUT_START: &str = "---LUMIN_OUTPUT_START---";
pub const OUTPUT_END: &str = "---LUMIN_OUTPUT_END---";

#[derive(Debug, Deserialize)]
pub struct InputMessage {
    pub r#type: String, // "message" | "health" | "shutdown"
    pub content: Option<String>,
    pub session_id: Option<String>,
    pub config: Option<InputConfig>,
    pub images: Option<Vec<ImageRef>>,
}

#[derive(Debug, Deserialize)]
pub struct InputConfig {
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub agent_id: Option<String>,
    pub tools: Option<Vec<String>>,
    pub max_iterations: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImageRef {
    pub url: String,
    pub path: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OutputMessage {
    pub status: String, // "success" | "error" | "health_ok"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools_used: Option<Vec<String>>,
}

/// Write structured output to stdout between markers.
pub fn write_output(output: &OutputMessage) {
    let json = serde_json::to_string(output).unwrap_or_default();
    println!("{OUTPUT_START}\n{json}\n{OUTPUT_END}");
}

/// Parse structured output from a stdout buffer.
pub fn parse_output(buffer: &str) -> Option<OutputMessage> {
    let start = buffer.find(OUTPUT_START)?;
    let end = buffer.find(OUTPUT_END)?;
    if end <= start { return None; }
    let json_str = buffer[start + OUTPUT_START.len()..end].trim();
    serde_json::from_str(json_str).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_output_roundtrip() {
        let output = OutputMessage {
            status: "success".into(),
            response: Some("Hello".into()),
            thinking: None, error: None,
            session_id: Some("s1".into()),
            iterations: Some(1),
            tools_used: Some(vec!["bash".into()]),
        };
        let json = serde_json::to_string(&output).unwrap();
        let buffer = format!("{OUTPUT_START}\n{json}\n{OUTPUT_END}");
        let parsed = parse_output(&buffer).unwrap();
        assert_eq!(parsed.status, "success");
        assert_eq!(parsed.response.unwrap(), "Hello");
    }
}
