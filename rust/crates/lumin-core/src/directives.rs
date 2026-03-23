//! Directive types — mirrors TypeScript `directives.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Helper ──────────────────────────────────────────────

    /// Create a minimal directive (just type + payload, all optional fields None).
    fn minimal(dtype: &str, payload: serde_json::Value) -> Directive {
        Directive {
            r#type: dtype.into(),
            payload,
            timestamp: None,
            emitted_by: None,
            task_id: None,
            source: None,
            state_version: None,
        }
    }

    /// Create a directive with all optional fields populated.
    fn full(dtype: &str, payload: serde_json::Value) -> Directive {
        Directive {
            r#type: dtype.into(),
            payload,
            timestamp: Some("2026-03-23T10:00:00Z".into()),
            emitted_by: Some("test-agent".into()),
            task_id: Some("task-99".into()),
            source: Some("dual-loop".into()),
            state_version: Some(42),
        }
    }

    // ── Existing tests (kept) ───────────────────────────────

    #[test]
    fn directive_serialization_with_all_fields() {
        let directive = Directive {
            r#type: "UPDATE_CONTENT".into(),
            payload: json!({"text": "hello"}),
            timestamp: Some("2024-01-01T00:00:00Z".into()),
            emitted_by: Some("agent-1".into()),
            task_id: Some("task-42".into()),
            source: Some("inner-loop".into()),
            state_version: Some(5),
        };

        let json = serde_json::to_value(&directive).unwrap();
        assert_eq!(json["type"], "UPDATE_CONTENT");
        assert_eq!(json["payload"]["text"], "hello");
        assert_eq!(json["timestamp"], "2024-01-01T00:00:00Z");
        assert_eq!(json["emittedBy"], "agent-1");
        assert_eq!(json["taskId"], "task-42");
        assert_eq!(json["source"], "inner-loop");
        assert_eq!(json["stateVersion"], 5);
    }

    #[test]
    fn directive_serialization_skips_none_fields() {
        let directive = Directive {
            r#type: "NOTIFICATION".into(),
            payload: json!({"msg": "test"}),
            timestamp: None,
            emitted_by: None,
            task_id: None,
            source: None,
            state_version: None,
        };

        let json = serde_json::to_value(&directive).unwrap();
        assert_eq!(json["type"], "NOTIFICATION");
        assert!(json.get("timestamp").is_none(), "None fields should be skipped");
        assert!(json.get("emittedBy").is_none(), "None fields should be skipped");
        assert!(json.get("taskId").is_none(), "None fields should be skipped");
        assert!(json.get("source").is_none(), "None fields should be skipped");
        assert!(json.get("stateVersion").is_none(), "None fields should be skipped");
    }

    #[test]
    fn directive_deserialization_with_missing_optional_fields() {
        let json_str = r#"{"type": "TASK_UPDATE", "payload": {"status": "done"}}"#;
        // Note: "type" and "payload" are single-word so unaffected by camelCase rename
        let directive: Directive = serde_json::from_str(json_str).unwrap();
        assert_eq!(directive.r#type, "TASK_UPDATE");
        assert!(directive.timestamp.is_none());
        assert!(directive.emitted_by.is_none());
        assert!(directive.task_id.is_none());
        assert!(directive.source.is_none());
        assert!(directive.state_version.is_none());
    }

    #[test]
    fn directive_types_contains_expected_types() {
        let expected = [
            "SWITCH_COMPONENT",
            "UPDATE_CONTENT",
            "UPDATE_LATEX",
            "COMPILE_COMPLETE",
            "JUPYTER_ADD_CELL",
            "JUPYTER_CELL_OUTPUT",
            "UPDATE_GALLERY",
            "UPDATE_CODE",
            "UPDATE_DATA_GRID",
            "TASK_UPDATE",
            "UPDATE_TASKS",
            "TIMELINE_EVENT",
            "THINKING_UPDATE",
            "OPERATION_STATUS",
            "ACTION_REQUEST",
            "REQUEST_CONFIRMATION",
            "NOTIFICATION",
            "EXTENSION_UPDATE",
            "COMPONENT_STATE_SYNC",
            "AGENT_CURSOR",
            "HUMAN_CURSOR",
        ];

        for expected_type in &expected {
            assert!(
                DIRECTIVE_TYPES.contains(expected_type),
                "DIRECTIVE_TYPES should contain {expected_type}"
            );
        }
        assert_eq!(DIRECTIVE_TYPES.len(), expected.len());
    }

    #[test]
    fn directive_serde_round_trip() {
        let directive = Directive {
            r#type: "UPDATE_CODE".into(),
            payload: json!({"language": "rust", "code": "fn main() {}"}),
            timestamp: Some("2024-06-15T12:00:00Z".into()),
            emitted_by: Some("coder".into()),
            task_id: Some("t1".into()),
            source: Some("single-loop".into()),
            state_version: Some(3),
        };

        let json_str = serde_json::to_string(&directive).unwrap();
        let deserialized: Directive = serde_json::from_str(&json_str).unwrap();

        assert_eq!(deserialized.r#type, directive.r#type);
        assert_eq!(deserialized.timestamp, directive.timestamp);
        assert_eq!(deserialized.emitted_by, directive.emitted_by);
        assert_eq!(deserialized.task_id, directive.task_id);
        assert_eq!(deserialized.source, directive.source);
        assert_eq!(deserialized.state_version, directive.state_version);
    }

    // ── DIRECTIVE_TYPES count ───────────────────────────────

    #[test]
    fn directive_types_has_21_entries() {
        assert_eq!(DIRECTIVE_TYPES.len(), 21);
    }

    // ── Each DIRECTIVE_TYPE individually verifiable ──────────

    #[test]
    fn type_switch_component_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"SWITCH_COMPONENT"));
    }

    #[test]
    fn type_timeline_event_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"TIMELINE_EVENT"));
    }

    #[test]
    fn type_thinking_update_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"THINKING_UPDATE"));
    }

    #[test]
    fn type_operation_status_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"OPERATION_STATUS"));
    }

    #[test]
    fn type_update_content_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"UPDATE_CONTENT"));
    }

    #[test]
    fn type_update_latex_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"UPDATE_LATEX"));
    }

    #[test]
    fn type_update_code_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"UPDATE_CODE"));
    }

    #[test]
    fn type_update_data_grid_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"UPDATE_DATA_GRID"));
    }

    #[test]
    fn type_update_gallery_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"UPDATE_GALLERY"));
    }

    #[test]
    fn type_jupyter_add_cell_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"JUPYTER_ADD_CELL"));
    }

    #[test]
    fn type_jupyter_cell_output_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"JUPYTER_CELL_OUTPUT"));
    }

    #[test]
    fn type_extension_update_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"EXTENSION_UPDATE"));
    }

    #[test]
    fn type_agent_cursor_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"AGENT_CURSOR"));
    }

    #[test]
    fn type_human_cursor_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"HUMAN_CURSOR"));
    }

    #[test]
    fn type_compile_complete_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"COMPILE_COMPLETE"));
    }

    #[test]
    fn type_notification_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"NOTIFICATION"));
    }

    #[test]
    fn type_component_state_sync_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"COMPONENT_STATE_SYNC"));
    }

    #[test]
    fn type_task_update_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"TASK_UPDATE"));
    }

    #[test]
    fn type_update_tasks_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"UPDATE_TASKS"));
    }

    #[test]
    fn type_action_request_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"ACTION_REQUEST"));
    }

    #[test]
    fn type_request_confirmation_is_present() {
        assert!(DIRECTIVE_TYPES.contains(&"REQUEST_CONFIRMATION"));
    }

    // ── Directive with minimal fields (just type + payload) ─

    #[test]
    fn minimal_directive_has_only_type_and_payload() {
        let d = minimal("SWITCH_COMPONENT", json!({"component": "pdf-reader"}));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["type"], "SWITCH_COMPONENT");
        assert_eq!(v["payload"]["component"], "pdf-reader");
        // No optional fields in serialized output
        assert!(v.get("timestamp").is_none());
        assert!(v.get("emittedBy").is_none());
        assert!(v.get("taskId").is_none());
        assert!(v.get("source").is_none());
        assert!(v.get("stateVersion").is_none());
    }

    // ── Directive with all optional fields populated ────────

    #[test]
    fn full_directive_has_all_optional_fields() {
        let d = full("UPDATE_LATEX", json!({"content": "\\section{Intro}"}));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["type"], "UPDATE_LATEX");
        assert_eq!(v["timestamp"], "2026-03-23T10:00:00Z");
        assert_eq!(v["emittedBy"], "test-agent");
        assert_eq!(v["taskId"], "task-99");
        assert_eq!(v["source"], "dual-loop");
        assert_eq!(v["stateVersion"], 42);
    }

    // ── Serialization preserves payload keys ────────────────

    #[test]
    fn serialization_preserves_payload_keys() {
        let d = minimal("UPDATE_CODE", json!({
            "language": "python",
            "code": "print('hello')",
            "filename": "main.py"
        }));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["payload"]["language"], "python");
        assert_eq!(v["payload"]["code"], "print('hello')");
        assert_eq!(v["payload"]["filename"], "main.py");
    }

    // ── Nested payload objects ──────────────────────────────

    #[test]
    fn nested_payload_objects_preserved() {
        let payload = json!({
            "component": "ag-grid",
            "data": {
                "columns": [{"field": "name"}, {"field": "value"}],
                "rows": [{"name": "a", "value": 1}]
            },
            "meta": {
                "source": {
                    "file": "data.csv",
                    "encoding": "utf-8"
                }
            }
        });
        let d = minimal("UPDATE_DATA_GRID", payload.clone());
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["payload"]["data"]["columns"][0]["field"], "name");
        assert_eq!(v["payload"]["data"]["rows"][0]["value"], 1);
        assert_eq!(v["payload"]["meta"]["source"]["file"], "data.csv");
    }

    // ── Timestamp field behavior ────────────────────────────

    #[test]
    fn timestamp_none_omitted_from_json() {
        let d = minimal("NOTIFICATION", json!({"message": "hi"}));
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("timestamp").is_none());
    }

    #[test]
    fn timestamp_some_present_in_json() {
        let mut d = minimal("NOTIFICATION", json!({"message": "hi"}));
        d.timestamp = Some("2026-03-12T00:00:00Z".into());
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["timestamp"], "2026-03-12T00:00:00Z");
    }

    #[test]
    fn timestamp_round_trips_through_serde() {
        let mut d = minimal("UPDATE_CONTENT", json!({"content": "abc"}));
        d.timestamp = Some("2026-01-15T08:30:00Z".into());
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.timestamp, Some("2026-01-15T08:30:00Z".into()));
    }

    // ── emitted_by field ────────────────────────────────────

    #[test]
    fn emitted_by_none_omitted() {
        let d = minimal("THINKING_UPDATE", json!({"thought": "hmm"}));
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("emittedBy").is_none());
    }

    #[test]
    fn emitted_by_some_present() {
        let mut d = minimal("THINKING_UPDATE", json!({"thought": "hmm"}));
        d.emitted_by = Some("latex-expert".into());
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["emittedBy"], "latex-expert");
    }

    // ── task_id field ───────────────────────────────────────

    #[test]
    fn task_id_none_omitted() {
        let d = minimal("OPERATION_STATUS", json!({"status": "running"}));
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("taskId").is_none());
    }

    #[test]
    fn task_id_some_present() {
        let mut d = minimal("OPERATION_STATUS", json!({"status": "running"}));
        d.task_id = Some("task-7".into());
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["taskId"], "task-7");
    }

    // ── source field ────────────────────────────────────────

    #[test]
    fn source_none_omitted() {
        let d = minimal("EXTENSION_UPDATE", json!({"ext": "citations"}));
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("source").is_none());
    }

    #[test]
    fn source_some_present() {
        let mut d = minimal("EXTENSION_UPDATE", json!({"ext": "citations"}));
        d.source = Some("agent".into());
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["source"], "agent");
    }

    // ── state_version field ─────────────────────────────────

    #[test]
    fn state_version_none_omitted() {
        let d = minimal("AGENT_CURSOR", json!({"position": 10}));
        let v = serde_json::to_value(&d).unwrap();
        assert!(v.get("stateVersion").is_none());
    }

    #[test]
    fn state_version_some_present() {
        let mut d = minimal("AGENT_CURSOR", json!({"position": 10}));
        d.state_version = Some(100);
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["stateVersion"], 100);
    }

    #[test]
    fn state_version_zero_is_valid() {
        let mut d = minimal("HUMAN_CURSOR", json!({"line": 1}));
        d.state_version = Some(0);
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["stateVersion"], 0);
    }

    // ── Empty payload ───────────────────────────────────────

    #[test]
    fn empty_payload_object() {
        let d = minimal("COMPONENT_STATE_SYNC", json!({}));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["payload"], json!({}));
    }

    #[test]
    fn empty_payload_round_trips() {
        let d = minimal("NOTIFICATION", json!({}));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.payload, json!({}));
    }

    // ── Large payload ───────────────────────────────────────

    #[test]
    fn large_payload_with_many_keys() {
        let mut map = serde_json::Map::new();
        for i in 0..200 {
            map.insert(format!("key_{i}"), json!(i));
        }
        let d = minimal("UPDATE_DATA_GRID", serde_json::Value::Object(map));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["payload"]["key_0"], 0);
        assert_eq!(v["payload"]["key_199"], 199);
    }

    #[test]
    fn large_payload_with_long_string_value() {
        let long_text = "x".repeat(100_000);
        let d = minimal("UPDATE_CONTENT", json!({"content": long_text}));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.payload["content"].as_str().unwrap().len(), 100_000);
    }

    // ── Special characters in payload ───────────────────────

    #[test]
    fn payload_with_unicode() {
        let d = minimal("UPDATE_CONTENT", json!({"content": "Hello, \u{4e16}\u{754c}! \u{1f600}"}));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert!(d2.payload["content"].as_str().unwrap().contains('\u{4e16}'));
    }

    #[test]
    fn payload_with_newlines_and_tabs() {
        let d = minimal("UPDATE_CODE", json!({"code": "line1\n\tline2\nline3"}));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.payload["code"], "line1\n\tline2\nline3");
    }

    #[test]
    fn payload_with_quotes_and_backslashes() {
        let d = minimal("UPDATE_LATEX", json!({"tex": r#"He said \"hi\" and \\end"#}));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert!(d2.payload["tex"].as_str().unwrap().contains("\\\\end"));
    }

    #[test]
    fn payload_with_html_entities() {
        let d = minimal("UPDATE_CONTENT", json!({"html": "<div class=\"x\">&amp;</div>"}));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert!(d2.payload["html"].as_str().unwrap().contains("<div"));
        assert!(d2.payload["html"].as_str().unwrap().contains("&amp;"));
    }

    // ── Payload with various JSON value types ───────────────

    #[test]
    fn payload_with_null_value() {
        let d = minimal("NOTIFICATION", json!({"message": null}));
        let v = serde_json::to_value(&d).unwrap();
        assert!(v["payload"]["message"].is_null());
    }

    #[test]
    fn payload_with_boolean_values() {
        let d = minimal("OPERATION_STATUS", json!({"success": true, "retry": false}));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["payload"]["success"], true);
        assert_eq!(v["payload"]["retry"], false);
    }

    #[test]
    fn payload_with_array_value() {
        let d = minimal("UPDATE_GALLERY", json!({"images": ["a.png", "b.png", "c.png"]}));
        let v = serde_json::to_value(&d).unwrap();
        let images = v["payload"]["images"].as_array().unwrap();
        assert_eq!(images.len(), 3);
        assert_eq!(images[0], "a.png");
    }

    #[test]
    fn payload_with_numeric_types() {
        let d = minimal("TASK_UPDATE", json!({
            "id": "t1",
            "progress": 0.75,
            "step": 3,
            "negative": -10
        }));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["payload"]["progress"], 0.75);
        assert_eq!(v["payload"]["step"], 3);
        assert_eq!(v["payload"]["negative"], -10);
    }

    // ── Deserialization from JSON with extra unknown fields ─

    #[test]
    fn deserialization_ignores_unknown_top_level_fields() {
        // serde by default ignores unknown fields for structs (not deny_unknown_fields)
        let json_str = r#"{
            "type": "NOTIFICATION",
            "payload": {"msg": "ok"},
            "extra_field": 123,
            "another": true
        }"#;
        let d: Directive = serde_json::from_str(json_str).unwrap();
        assert_eq!(d.r#type, "NOTIFICATION");
        assert_eq!(d.payload["msg"], "ok");
    }

    // ── Clone behavior ─────────────────────────────────────

    #[test]
    fn clone_produces_independent_copy() {
        let d1 = full("UPDATE_CONTENT", json!({"text": "original"}));
        let mut d2 = d1.clone();
        d2.r#type = "NOTIFICATION".into();
        d2.payload = json!({"message": "changed"});
        // d1 is unaffected
        assert_eq!(d1.r#type, "UPDATE_CONTENT");
        assert_eq!(d1.payload["text"], "original");
        assert_eq!(d2.r#type, "NOTIFICATION");
    }

    // ── Debug formatting ────────────────────────────────────

    #[test]
    fn debug_format_includes_type() {
        let d = minimal("SWITCH_COMPONENT", json!({"component": "ai-editor"}));
        let debug_str = format!("{:?}", d);
        assert!(debug_str.contains("SWITCH_COMPONENT"));
    }

    // ── Deserialization with all optional fields present ─────

    #[test]
    fn deserialization_with_all_fields_from_json_string() {
        let json_str = r#"{
            "type": "UPDATE_GALLERY",
            "payload": {"images": ["a.png"]},
            "timestamp": "2026-03-23T12:00:00Z",
            "emittedBy": "gallery-agent",
            "taskId": "task-img",
            "source": "inner-loop",
            "stateVersion": 7
        }"#;
        let d: Directive = serde_json::from_str(json_str).unwrap();
        assert_eq!(d.r#type, "UPDATE_GALLERY");
        assert_eq!(d.timestamp, Some("2026-03-23T12:00:00Z".into()));
        assert_eq!(d.emitted_by, Some("gallery-agent".into()));
        assert_eq!(d.task_id, Some("task-img".into()));
        assert_eq!(d.source, Some("inner-loop".into()));
        assert_eq!(d.state_version, Some(7));
        assert_eq!(d.payload["images"][0], "a.png");
    }

    // ── Directive type string is not validated at serde level ─

    #[test]
    fn unknown_type_string_still_deserializes() {
        // The Rust struct uses String, not an enum, so any type string is accepted.
        let json_str = r#"{"type": "FUTURE_DIRECTIVE", "payload": {}}"#;
        let d: Directive = serde_json::from_str(json_str).unwrap();
        assert_eq!(d.r#type, "FUTURE_DIRECTIVE");
    }

    #[test]
    fn lowercase_type_string_deserializes() {
        // Unlike TS Zod enum which rejects lowercase, Rust String accepts it.
        let json_str = r#"{"type": "switch_component", "payload": {}}"#;
        let d: Directive = serde_json::from_str(json_str).unwrap();
        assert_eq!(d.r#type, "switch_component");
    }

    // ── Per-type serialization round-trip (representative) ──

    #[test]
    fn switch_component_round_trip() {
        let d = minimal("SWITCH_COMPONENT", json!({"component": "latex-editor", "title": "Paper"}));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "SWITCH_COMPONENT");
        assert_eq!(d2.payload["component"], "latex-editor");
        assert_eq!(d2.payload["title"], "Paper");
    }

    #[test]
    fn jupyter_add_cell_round_trip() {
        let d = minimal("JUPYTER_ADD_CELL", json!({
            "cell_type": "code",
            "source": "import numpy as np",
            "index": 0
        }));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "JUPYTER_ADD_CELL");
        assert_eq!(d2.payload["cell_type"], "code");
        assert_eq!(d2.payload["source"], "import numpy as np");
    }

    #[test]
    fn jupyter_cell_output_round_trip() {
        let d = minimal("JUPYTER_CELL_OUTPUT", json!({
            "cell_index": 2,
            "output_type": "execute_result",
            "data": {"text/plain": "42"}
        }));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "JUPYTER_CELL_OUTPUT");
        assert_eq!(d2.payload["data"]["text/plain"], "42");
    }

    #[test]
    fn action_request_round_trip() {
        let d = minimal("ACTION_REQUEST", json!({
            "question": "Proceed with compilation?",
            "options": ["yes", "no"]
        }));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "ACTION_REQUEST");
        assert_eq!(d2.payload["question"], "Proceed with compilation?");
        let opts = d2.payload["options"].as_array().unwrap();
        assert_eq!(opts.len(), 2);
    }

    #[test]
    fn request_confirmation_round_trip() {
        let d = full("REQUEST_CONFIRMATION", json!({
            "action": "delete_file",
            "target": "/tmp/old.tex"
        }));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "REQUEST_CONFIRMATION");
        assert_eq!(d2.payload["action"], "delete_file");
        assert_eq!(d2.emitted_by, Some("test-agent".into()));
    }

    #[test]
    fn timeline_event_round_trip() {
        let d = minimal("TIMELINE_EVENT", json!({
            "id": "evt-1",
            "componentType": "latex-editor",
            "action": "compile",
            "description": "Compiled paper",
            "actorId": "researcher",
            "actorType": "agent",
            "duration": 3500
        }));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "TIMELINE_EVENT");
        assert_eq!(d2.payload["actorType"], "agent");
        assert_eq!(d2.payload["duration"], 3500);
    }

    #[test]
    fn compile_complete_round_trip() {
        let d = minimal("COMPILE_COMPLETE", json!({
            "status": "success",
            "pdf_url": "/output/paper.pdf",
            "warnings": 2
        }));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "COMPILE_COMPLETE");
        assert_eq!(d2.payload["status"], "success");
        assert_eq!(d2.payload["warnings"], 2);
    }

    #[test]
    fn component_state_sync_round_trip() {
        let d = full("COMPONENT_STATE_SYNC", json!({
            "component": "jupyter-notebook",
            "state": {"cell_count": 5, "kernel": "python3"}
        }));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "COMPONENT_STATE_SYNC");
        assert_eq!(d2.state_version, Some(42));
        assert_eq!(d2.payload["state"]["cell_count"], 5);
    }

    #[test]
    fn update_tasks_round_trip() {
        let d = minimal("UPDATE_TASKS", json!({
            "tasks": [
                {"id": "t1", "title": "Compile", "status": "completed"},
                {"id": "t2", "title": "Review", "status": "pending"}
            ]
        }));
        let s = serde_json::to_string(&d).unwrap();
        let d2: Directive = serde_json::from_str(&s).unwrap();
        assert_eq!(d2.r#type, "UPDATE_TASKS");
        let tasks = d2.payload["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0]["status"], "completed");
    }

    // ── Payload is serde_json::Value (null payload) ─────────

    #[test]
    fn null_payload_serializes() {
        let d = Directive {
            r#type: "NOTIFICATION".into(),
            payload: serde_json::Value::Null,
            timestamp: None,
            emitted_by: None,
            task_id: None,
            source: None,
            state_version: None,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert!(v["payload"].is_null());
    }

    #[test]
    fn array_payload_serializes() {
        let d = Directive {
            r#type: "UPDATE_GALLERY".into(),
            payload: json!(["img1.png", "img2.png"]),
            timestamp: None,
            emitted_by: None,
            task_id: None,
            source: None,
            state_version: None,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert!(v["payload"].is_array());
        assert_eq!(v["payload"][0], "img1.png");
    }
}
