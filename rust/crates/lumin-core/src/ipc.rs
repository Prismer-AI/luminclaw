//! IPC — stdin/stdout JSON protocol for host ↔ container communication.
//! Mirrors TypeScript `ipc.ts`.

use serde::{Deserialize, Serialize};

pub const OUTPUT_START: &str = "---LUMIN_OUTPUT_START---";
pub const OUTPUT_END: &str = "---LUMIN_OUTPUT_END---";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputMessage {
    pub r#type: String, // "message" | "health" | "shutdown"
    pub content: Option<String>,
    #[serde(alias = "session_id")]
    pub session_id: Option<String>,
    pub config: Option<InputConfig>,
    pub images: Option<Vec<ImageRef>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputConfig {
    pub model: Option<String>,
    #[serde(alias = "base_url")]
    pub base_url: Option<String>,
    #[serde(alias = "api_key")]
    pub api_key: Option<String>,
    #[serde(alias = "agent_id")]
    pub agent_id: Option<String>,
    pub tools: Option<Vec<String>>,
    #[serde(alias = "max_iterations")]
    pub max_iterations: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub url: String,
    pub path: Option<String>,
    #[serde(alias = "mime_type")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

    #[test]
    fn write_output_produces_correct_marker_format() {
        // We can't easily capture println! output, but we can verify the
        // format by constructing the expected string manually and parsing it.
        let output = OutputMessage {
            status: "success".into(),
            response: Some("result".into()),
            thinking: None,
            error: None,
            session_id: None,
            iterations: None,
            tools_used: None,
        };
        let json = serde_json::to_string(&output).unwrap();
        let buffer = format!("{OUTPUT_START}\n{json}\n{OUTPUT_END}");

        // Verify the buffer contains the markers
        assert!(buffer.starts_with(OUTPUT_START));
        assert!(buffer.ends_with(OUTPUT_END));

        // And it parses correctly
        let parsed = parse_output(&buffer).unwrap();
        assert_eq!(parsed.status, "success");
        assert_eq!(parsed.response.unwrap(), "result");
    }

    #[test]
    fn parse_output_extracts_json_between_markers() {
        let buffer = format!(
            "some prefix text\n{OUTPUT_START}\n{{\"status\":\"error\",\"error\":\"bad input\"}}\n{OUTPUT_END}\nsome suffix text"
        );
        let parsed = parse_output(&buffer).unwrap();
        assert_eq!(parsed.status, "error");
        assert_eq!(parsed.error.unwrap(), "bad input");
        assert!(parsed.response.is_none());
    }

    #[test]
    fn parse_output_returns_none_for_no_markers() {
        let buffer = "just some random text without any markers";
        assert!(parse_output(buffer).is_none());
    }

    #[test]
    fn parse_output_returns_none_for_partial_markers() {
        let buffer = format!("{OUTPUT_START}\n{{\"status\":\"ok\"}}");
        // Has start but no end marker
        assert!(parse_output(&buffer).is_none());
    }

    #[test]
    fn output_message_serialization_with_all_fields() {
        let output = OutputMessage {
            status: "success".into(),
            response: Some("hello world".into()),
            thinking: Some("let me think...".into()),
            error: Some("minor warning".into()),
            session_id: Some("session-123".into()),
            iterations: Some(5),
            tools_used: Some(vec!["bash".into(), "read".into()]),
        };
        let json = serde_json::to_string(&output).unwrap();

        // All fields should be present
        assert!(json.contains("\"status\":\"success\""));
        assert!(json.contains("\"response\":\"hello world\""));
        assert!(json.contains("\"thinking\":\"let me think...\""));
        assert!(json.contains("\"error\":\"minor warning\""));
        assert!(json.contains("\"sessionId\":\"session-123\""));
        assert!(json.contains("\"iterations\":5"));
        assert!(json.contains("\"toolsUsed\":[\"bash\",\"read\"]"));
    }

    #[test]
    fn output_message_serialization_skips_none_fields() {
        let output = OutputMessage {
            status: "health_ok".into(),
            response: None,
            thinking: None,
            error: None,
            session_id: None,
            iterations: None,
            tools_used: None,
        };
        let json = serde_json::to_string(&output).unwrap();

        // Only status should be present
        assert!(json.contains("\"status\":\"health_ok\""));
        assert!(!json.contains("response"));
        assert!(!json.contains("thinking"));
        assert!(!json.contains("error"));
        assert!(!json.contains("sessionId"));
        assert!(!json.contains("iterations"));
        assert!(!json.contains("toolsUsed"));
    }

    #[test]
    fn roundtrip_write_then_parse() {
        let original = OutputMessage {
            status: "success".into(),
            response: Some("Completed analysis".into()),
            thinking: Some("I should analyze the data".into()),
            error: None,
            session_id: Some("sess-abc".into()),
            iterations: Some(3),
            tools_used: Some(vec!["bash".into(), "python".into()]),
        };

        // Simulate what write_output would produce
        let json = serde_json::to_string(&original).unwrap();
        let buffer = format!("{OUTPUT_START}\n{json}\n{OUTPUT_END}");

        let parsed = parse_output(&buffer).unwrap();
        assert_eq!(parsed.status, original.status);
        assert_eq!(parsed.response, original.response);
        assert_eq!(parsed.thinking, original.thinking);
        assert_eq!(parsed.error, original.error);
        assert_eq!(parsed.session_id, original.session_id);
        assert_eq!(parsed.iterations, original.iterations);
        assert_eq!(parsed.tools_used, original.tools_used);
    }

    // ── InputMessage deserialization tests ─────────────────────

    #[test]
    fn input_message_type_message() {
        let json = r#"{"type": "message", "content": "hello", "session_id": "s1"}"#;
        let input: InputMessage = serde_json::from_str(json).unwrap();
        assert_eq!(input.r#type, "message");
        assert_eq!(input.content.unwrap(), "hello");
        assert_eq!(input.session_id.unwrap(), "s1");
    }

    #[test]
    fn input_message_type_health() {
        let json = r#"{"type": "health"}"#;
        let input: InputMessage = serde_json::from_str(json).unwrap();
        assert_eq!(input.r#type, "health");
        assert!(input.content.is_none());
        assert!(input.session_id.is_none());
        assert!(input.config.is_none());
    }

    #[test]
    fn input_message_type_shutdown() {
        let json = r#"{"type": "shutdown"}"#;
        let input: InputMessage = serde_json::from_str(json).unwrap();
        assert_eq!(input.r#type, "shutdown");
        assert!(input.content.is_none());
    }

    #[test]
    fn input_message_with_images() {
        let json = r#"{
            "type": "message",
            "content": "look at this",
            "images": [
                {"url": "https://example.com/img.png", "mime_type": "image/png"},
                {"url": "data:image/jpeg;base64,abc", "path": "/tmp/photo.jpg"}
            ]
        }"#;
        let input: InputMessage = serde_json::from_str(json).unwrap();
        let images = input.images.unwrap();
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].url, "https://example.com/img.png");
        assert_eq!(images[0].mime_type.as_deref(), Some("image/png"));
        assert_eq!(images[1].path.as_deref(), Some("/tmp/photo.jpg"));
    }

    #[test]
    fn input_message_with_config_overrides() {
        let json = r#"{
            "type": "message",
            "content": "test",
            "config": {
                "model": "gpt-4",
                "base_url": "http://localhost:11434/v1",
                "api_key": "test-key",
                "agent_id": "researcher",
                "tools": ["bash", "latex"],
                "max_iterations": 10
            }
        }"#;
        let input: InputMessage = serde_json::from_str(json).unwrap();
        let config = input.config.unwrap();
        assert_eq!(config.model.unwrap(), "gpt-4");
        assert_eq!(config.base_url.unwrap(), "http://localhost:11434/v1");
        assert_eq!(config.api_key.unwrap(), "test-key");
        assert_eq!(config.agent_id.unwrap(), "researcher");
        assert_eq!(config.tools.unwrap(), vec!["bash", "latex"]);
        assert_eq!(config.max_iterations.unwrap(), 10);
    }

    #[test]
    fn input_message_optional_fields_absent() {
        let json = r#"{"type": "message"}"#;
        let input: InputMessage = serde_json::from_str(json).unwrap();
        assert_eq!(input.r#type, "message");
        assert!(input.content.is_none());
        assert!(input.session_id.is_none());
        assert!(input.config.is_none());
        assert!(input.images.is_none());
    }

    // ── OutputMessage additional tests ────────────────────────

    #[test]
    fn output_message_error_status() {
        let output = OutputMessage {
            status: "error".into(),
            response: None,
            thinking: None,
            error: Some("Something went wrong".into()),
            session_id: None,
            iterations: None,
            tools_used: None,
        };
        let json = serde_json::to_string(&output).unwrap();
        assert!(json.contains("\"status\":\"error\""));
        assert!(json.contains("\"error\":\"Something went wrong\""));
        assert!(!json.contains("response"));
    }

    #[test]
    fn output_message_health_ok_status() {
        let output = OutputMessage {
            status: "health_ok".into(),
            response: None,
            thinking: None,
            error: None,
            session_id: None,
            iterations: None,
            tools_used: None,
        };
        let json = serde_json::to_string(&output).unwrap();
        assert!(json.contains("\"status\":\"health_ok\""));
        // Only status should be present
        assert!(!json.contains("response"));
        assert!(!json.contains("error"));
    }

    #[test]
    fn output_message_with_tools_used() {
        let output = OutputMessage {
            status: "success".into(),
            response: Some("Done".into()),
            thinking: None,
            error: None,
            session_id: Some("s1".into()),
            iterations: Some(3),
            tools_used: Some(vec!["bash".into(), "read".into(), "python".into()]),
        };
        let json = serde_json::to_string(&output).unwrap();
        assert!(json.contains("\"toolsUsed\":[\"bash\",\"read\",\"python\"]"));
    }

    #[test]
    fn output_message_deserialization_from_json() {
        let json = r#"{"status":"success","response":"hello","iterations":2,"toolsUsed":["bash"]}"#;
        let output: OutputMessage = serde_json::from_str(json).unwrap();
        assert_eq!(output.status, "success");
        assert_eq!(output.response.unwrap(), "hello");
        assert_eq!(output.iterations.unwrap(), 2);
        assert_eq!(output.tools_used.unwrap(), vec!["bash"]);
        assert!(output.thinking.is_none());
        assert!(output.error.is_none());
    }

    // ── parse_output additional tests ─────────────────────────

    #[test]
    fn parse_output_with_surrounding_noise() {
        let json = r#"{"status":"success","response":"extracted"}"#;
        let buffer = format!(
            "lots of debug output here\nstderr lines\n{OUTPUT_START}\n{json}\n{OUTPUT_END}\nmore noise after"
        );
        let result = parse_output(&buffer).unwrap();
        assert_eq!(result.status, "success");
        assert_eq!(result.response.unwrap(), "extracted");
    }

    #[test]
    fn parse_output_with_multiple_output_blocks_takes_first() {
        let json1 = r#"{"status":"success","response":"first"}"#;
        let json2 = r#"{"status":"error","error":"second"}"#;
        let buffer = format!(
            "{OUTPUT_START}\n{json1}\n{OUTPUT_END}\n{OUTPUT_START}\n{json2}\n{OUTPUT_END}"
        );
        // parse_output finds the first OUTPUT_START and first OUTPUT_END
        let result = parse_output(&buffer).unwrap();
        assert_eq!(result.status, "success");
        assert_eq!(result.response.unwrap(), "first");
    }

    #[test]
    fn parse_output_returns_none_for_end_before_start() {
        let buffer = format!("{OUTPUT_END}\n{{\"status\":\"success\"}}\n{OUTPUT_START}");
        assert!(parse_output(&buffer).is_none());
    }

    #[test]
    fn parse_output_returns_none_for_malformed_json() {
        let buffer = format!("{OUTPUT_START}\nnot-valid-json\n{OUTPUT_END}");
        assert!(parse_output(&buffer).is_none());
    }

    #[test]
    fn parse_output_handles_large_json() {
        let large_response = "x".repeat(100_000);
        let json = serde_json::to_string(&OutputMessage {
            status: "success".into(),
            response: Some(large_response.clone()),
            thinking: None,
            error: None,
            session_id: None,
            iterations: None,
            tools_used: None,
        }).unwrap();
        let buffer = format!("{OUTPUT_START}\n{json}\n{OUTPUT_END}");

        let result = parse_output(&buffer).unwrap();
        assert_eq!(result.response.unwrap().len(), 100_000);
    }

    #[test]
    fn write_output_produces_valid_json_between_markers() {
        let output = OutputMessage {
            status: "success".into(),
            response: Some("test response".into()),
            thinking: None,
            error: None,
            session_id: Some("s1".into()),
            iterations: Some(1),
            tools_used: Some(vec!["bash".into()]),
        };
        // Simulate write_output format (it uses println! which we can't capture,
        // so we recreate the format)
        let json = serde_json::to_string(&output).unwrap();
        let buffer = format!("{OUTPUT_START}\n{json}\n{OUTPUT_END}");

        // Verify the JSON between markers is valid
        let start_pos = buffer.find(OUTPUT_START).unwrap() + OUTPUT_START.len();
        let end_pos = buffer.find(OUTPUT_END).unwrap();
        let json_str = buffer[start_pos..end_pos].trim();
        let parsed: OutputMessage = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed.status, "success");
        assert_eq!(parsed.response.unwrap(), "test response");
    }

    #[test]
    fn protocol_markers_are_correct() {
        assert_eq!(OUTPUT_START, "---LUMIN_OUTPUT_START---");
        assert_eq!(OUTPUT_END, "---LUMIN_OUTPUT_END---");
    }

    #[test]
    fn image_ref_clone() {
        let img = ImageRef {
            url: "https://example.com/img.png".into(),
            path: Some("/tmp/img.png".into()),
            mime_type: Some("image/png".into()),
        };
        let cloned = img.clone();
        assert_eq!(cloned.url, img.url);
        assert_eq!(cloned.path, img.path);
        assert_eq!(cloned.mime_type, img.mime_type);
    }

    #[test]
    fn input_config_all_fields_optional() {
        let json = r#"{"type": "message", "config": {}}"#;
        let input: InputMessage = serde_json::from_str(json).unwrap();
        let config = input.config.unwrap();
        assert!(config.model.is_none());
        assert!(config.base_url.is_none());
        assert!(config.api_key.is_none());
        assert!(config.agent_id.is_none());
        assert!(config.tools.is_none());
        assert!(config.max_iterations.is_none());
    }
}
