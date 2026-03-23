//! EventBus — mirrors TypeScript `sse.ts`.

use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Debug, Clone)]
pub struct AgentEvent {
    pub event_type: String,
    pub data: Value,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<AgentEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn publish(&self, event: AgentEvent) {
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self { Self::new(1000) }
}

// ── Stdout SSE Writer ────────────────────────────────────

/// Writes events to stdout in SSE format for IPC streaming.
/// Used when the agent runs as a subprocess and the host reads stdout.
/// Mirrors TS `StdoutSSEWriter`.
pub struct StdoutSseWriter {
    /// Handle to the spawned task so we can abort it on stop.
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl StdoutSseWriter {
    /// Subscribe to the given EventBus and spawn a task that writes each event
    /// to stdout in SSE format: `event: <type>\ndata: <json>\n\n`.
    pub fn start(bus: &EventBus) -> Self {
        let mut rx = bus.subscribe();
        let handle = tokio::spawn(async move {
            use std::io::Write;
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let data = serde_json::to_string(&event.data).unwrap_or_default();
                        let line = format!("event: {}\ndata: {}\n\n", event.event_type, data);
                        // Write to stdout; ignore errors (pipe broken, etc.)
                        let _ = std::io::stdout().write_all(line.as_bytes());
                        let _ = std::io::stdout().flush();
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // Consumer too slow — log and continue
                        let msg = format!("event: error\ndata: {{\"message\":\"SSE writer lagged, dropped {} events\"}}\n\n", n);
                        let _ = std::io::stdout().write_all(msg.as_bytes());
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Self { handle: Some(handle) }
    }

    /// Stop the writer by aborting the background task.
    pub fn stop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

impl Drop for StdoutSseWriter {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_with_custom_capacity() {
        let bus = EventBus::new(42);
        // Should be able to subscribe without panic
        let _rx = bus.subscribe();
    }

    #[test]
    fn default_uses_capacity_1000() {
        let bus = EventBus::default();
        // Verify it works — capacity is internal to broadcast channel,
        // but we can confirm it constructs successfully and subscribes.
        let _rx = bus.subscribe();
    }

    #[test]
    fn publish_and_subscribe_receives_event() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        bus.publish(AgentEvent {
            event_type: "test".into(),
            data: serde_json::json!({"key": "value"}),
        });

        let event = rx.try_recv().expect("should receive event");
        assert_eq!(event.event_type, "test");
        assert_eq!(event.data["key"], "value");
    }

    #[test]
    fn subscribe_gets_events_published_after_subscription() {
        let bus = EventBus::new(16);

        // Publish before subscribing — subscriber should NOT see this
        bus.publish(AgentEvent {
            event_type: "before".into(),
            data: serde_json::json!(null),
        });

        let mut rx = bus.subscribe();

        // Publish after subscribing — subscriber should see this
        bus.publish(AgentEvent {
            event_type: "after".into(),
            data: serde_json::json!(42),
        });

        let event = rx.try_recv().expect("should receive event published after subscribe");
        assert_eq!(event.event_type, "after");
        assert_eq!(event.data, serde_json::json!(42));
    }

    #[test]
    fn clone_produces_bus_sharing_same_channel() {
        let bus1 = EventBus::new(16);
        let bus2 = bus1.clone();

        let mut rx = bus2.subscribe();

        // Publish on the original bus
        bus1.publish(AgentEvent {
            event_type: "shared".into(),
            data: serde_json::json!("hello"),
        });

        let event = rx.try_recv().expect("cloned bus should share channel");
        assert_eq!(event.event_type, "shared");
    }

    #[test]
    fn multiple_subscribers_each_get_event() {
        let bus = EventBus::new(16);
        let mut rx1 = bus.subscribe();
        let mut rx2 = bus.subscribe();

        bus.publish(AgentEvent {
            event_type: "broadcast".into(),
            data: serde_json::json!(true),
        });

        let e1 = rx1.try_recv().expect("subscriber 1 should receive");
        let e2 = rx2.try_recv().expect("subscriber 2 should receive");
        assert_eq!(e1.event_type, "broadcast");
        assert_eq!(e2.event_type, "broadcast");
    }

    #[test]
    fn publish_without_subscribers_does_not_panic() {
        let bus = EventBus::new(16);
        // No subscribers — should not panic
        bus.publish(AgentEvent {
            event_type: "orphan".into(),
            data: serde_json::json!(null),
        });
    }

    // ── AgentEvent serialization tests ────────────────────────

    #[test]
    fn agent_event_serialization_with_all_fields() {
        let event = AgentEvent {
            event_type: "agent.start".into(),
            data: serde_json::json!({"sessionId": "s1", "agentId": "researcher"}),
        };
        assert_eq!(event.event_type, "agent.start");
        assert_eq!(event.data["sessionId"], "s1");
        assert_eq!(event.data["agentId"], "researcher");
    }

    #[test]
    fn agent_event_agent_end_type() {
        let event = AgentEvent {
            event_type: "agent.end".into(),
            data: serde_json::json!({"sessionId": "s1", "toolsUsed": ["bash", "latex"]}),
        };
        assert_eq!(event.event_type, "agent.end");
        assert_eq!(event.data["toolsUsed"][0], "bash");
        assert_eq!(event.data["toolsUsed"][1], "latex");
    }

    #[test]
    fn agent_event_text_delta_type() {
        let event = AgentEvent {
            event_type: "text.delta".into(),
            data: serde_json::json!({"sessionId": "s1", "delta": "hello"}),
        };
        assert_eq!(event.event_type, "text.delta");
        assert_eq!(event.data["delta"], "hello");
    }

    #[test]
    fn agent_event_tool_start_type() {
        let event = AgentEvent {
            event_type: "tool.start".into(),
            data: serde_json::json!({"sessionId": "s1", "tool": "bash"}),
        };
        assert_eq!(event.event_type, "tool.start");
        assert_eq!(event.data["tool"], "bash");
    }

    #[test]
    fn agent_event_tool_end_type() {
        let event = AgentEvent {
            event_type: "tool.end".into(),
            data: serde_json::json!({"sessionId": "s1", "tool": "bash", "result": "ok"}),
        };
        assert_eq!(event.event_type, "tool.end");
        assert_eq!(event.data["result"], "ok");
    }

    #[test]
    fn agent_event_directive_type() {
        let event = AgentEvent {
            event_type: "directive".into(),
            data: serde_json::json!({"type": "SWITCH_COMPONENT", "payload": {}}),
        };
        assert_eq!(event.event_type, "directive");
        assert_eq!(event.data["type"], "SWITCH_COMPONENT");
    }

    #[test]
    fn agent_event_error_type() {
        let event = AgentEvent {
            event_type: "error".into(),
            data: serde_json::json!({"message": "something failed"}),
        };
        assert_eq!(event.event_type, "error");
        assert_eq!(event.data["message"], "something failed");
    }

    #[test]
    fn agent_event_heartbeat_type() {
        let event = AgentEvent {
            event_type: "heartbeat".into(),
            data: serde_json::json!({"timestamp": 12345}),
        };
        assert_eq!(event.event_type, "heartbeat");
        assert_eq!(event.data["timestamp"], 12345);
    }

    #[test]
    fn agent_event_compaction_type() {
        let event = AgentEvent {
            event_type: "compaction".into(),
            data: serde_json::json!({"summary": "test summary", "droppedCount": 5}),
        };
        assert_eq!(event.event_type, "compaction");
        assert_eq!(event.data["summary"], "test summary");
        assert_eq!(event.data["droppedCount"], 5);
    }

    #[test]
    fn agent_event_subagent_start_type() {
        let event = AgentEvent {
            event_type: "subagent.start".into(),
            data: serde_json::json!({"parentAgent": "researcher", "subAgent": "latex-expert"}),
        };
        assert_eq!(event.event_type, "subagent.start");
        assert_eq!(event.data["parentAgent"], "researcher");
        assert_eq!(event.data["subAgent"], "latex-expert");
    }

    #[test]
    fn agent_event_subagent_end_type() {
        let event = AgentEvent {
            event_type: "subagent.end".into(),
            data: serde_json::json!({"parentAgent": "researcher", "subAgent": "latex-expert"}),
        };
        assert_eq!(event.event_type, "subagent.end");
    }

    #[test]
    fn agent_event_clone() {
        let event = AgentEvent {
            event_type: "test.clone".into(),
            data: serde_json::json!({"key": "value", "nested": {"deep": true}}),
        };
        let cloned = event.clone();
        assert_eq!(cloned.event_type, event.event_type);
        assert_eq!(cloned.data, event.data);
    }

    #[test]
    fn agent_event_type_is_any_string() {
        // Event type is a plain String, any value accepted
        let event = AgentEvent {
            event_type: "custom.completely.arbitrary.event.type".into(),
            data: serde_json::json!(null),
        };
        assert_eq!(event.event_type, "custom.completely.arbitrary.event.type");
    }

    // ── EventBus additional tests ─────────────────────────────

    #[test]
    fn multiple_events_published_in_sequence_received_in_order() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        for i in 0..5 {
            bus.publish(AgentEvent {
                event_type: format!("event-{i}"),
                data: serde_json::json!(i),
            });
        }

        for i in 0..5 {
            let event = rx.try_recv().expect(&format!("should receive event {i}"));
            assert_eq!(event.event_type, format!("event-{i}"));
            assert_eq!(event.data, serde_json::json!(i));
        }
    }

    #[test]
    fn slow_consumer_gets_lagged_error_when_capacity_exceeded() {
        // With capacity 3, publishing 5 events before consuming should lag
        let bus = EventBus::new(3);
        let mut rx = bus.subscribe();

        for i in 0..5 {
            bus.publish(AgentEvent {
                event_type: format!("event-{i}"),
                data: serde_json::json!(i),
            });
        }

        // The receiver should get a Lagged error because capacity was exceeded
        let result = rx.try_recv();
        match result {
            Err(broadcast::error::TryRecvError::Lagged(_)) => {
                // Expected — slow consumer was overrun
            }
            Ok(event) => {
                // Some events may still be available after lag recovery
                // The oldest events should have been dropped
                assert!(
                    event.event_type == "event-2"
                        || event.event_type == "event-3"
                        || event.event_type == "event-4",
                    "should only see recent events, got {}",
                    event.event_type
                );
            }
            Err(e) => panic!("unexpected error: {e:?}"),
        }
    }

    #[test]
    fn subscribe_after_publish_misses_earlier_events_edge_case_empty() {
        let bus = EventBus::new(16);

        // Publish several events
        for i in 0..10 {
            bus.publish(AgentEvent {
                event_type: format!("missed-{i}"),
                data: serde_json::json!(null),
            });
        }

        // Subscribe after all publishes
        let mut rx = bus.subscribe();

        // Should have nothing to receive
        let result = rx.try_recv();
        assert!(result.is_err(), "late subscriber should not see earlier events");
    }

    #[test]
    fn event_bus_publishes_different_event_types() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        bus.publish(AgentEvent {
            event_type: "agent.start".into(),
            data: serde_json::json!({"sessionId": "s1", "agentId": "test"}),
        });
        bus.publish(AgentEvent {
            event_type: "text.delta".into(),
            data: serde_json::json!({"delta": "Hello"}),
        });
        bus.publish(AgentEvent {
            event_type: "tool.end".into(),
            data: serde_json::json!({"tool": "bash", "result": "ok"}),
        });
        bus.publish(AgentEvent {
            event_type: "agent.end".into(),
            data: serde_json::json!({"sessionId": "s1"}),
        });

        let types: Vec<String> = (0..4)
            .map(|_| rx.try_recv().unwrap().event_type)
            .collect();
        assert_eq!(types, vec!["agent.start", "text.delta", "tool.end", "agent.end"]);
    }

    #[test]
    fn event_with_complex_nested_json_data() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        let complex_data = serde_json::json!({
            "level1": {
                "level2": {
                    "level3": {
                        "array": [1, 2, {"nested": true}],
                        "value": "deep"
                    }
                },
                "sibling": [null, false, 42.5]
            }
        });

        bus.publish(AgentEvent {
            event_type: "complex".into(),
            data: complex_data.clone(),
        });

        let event = rx.try_recv().unwrap();
        assert_eq!(event.data, complex_data);
        assert_eq!(event.data["level1"]["level2"]["level3"]["value"], "deep");
        assert_eq!(event.data["level1"]["level2"]["level3"]["array"][2]["nested"], true);
    }

    #[test]
    fn event_with_large_data() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        let large_string = "x".repeat(100_000);
        bus.publish(AgentEvent {
            event_type: "large".into(),
            data: serde_json::json!({"content": large_string}),
        });

        let event = rx.try_recv().unwrap();
        assert_eq!(event.data["content"].as_str().unwrap().len(), 100_000);
    }

    #[test]
    fn event_with_null_data() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        bus.publish(AgentEvent {
            event_type: "null-event".into(),
            data: serde_json::json!(null),
        });

        let event = rx.try_recv().unwrap();
        assert!(event.data.is_null());
    }

    #[test]
    fn event_with_empty_object_data() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        bus.publish(AgentEvent {
            event_type: "empty".into(),
            data: serde_json::json!({}),
        });

        let event = rx.try_recv().unwrap();
        assert!(event.data.is_object());
        assert_eq!(event.data.as_object().unwrap().len(), 0);
    }

    #[test]
    fn agent_event_debug_format() {
        let event = AgentEvent {
            event_type: "test".into(),
            data: serde_json::json!(42),
        };
        let debug = format!("{:?}", event);
        assert!(debug.contains("test"));
        assert!(debug.contains("42"));
    }

    #[test]
    fn event_tool_approval_required_type() {
        let event = AgentEvent {
            event_type: "tool.approval_required".into(),
            data: serde_json::json!({
                "sessionId": "s1",
                "tool": "bash",
                "toolId": "call-1",
                "args": {"command": "rm -rf /tmp"},
                "reason": "destructive"
            }),
        };
        assert_eq!(event.event_type, "tool.approval_required");
        assert_eq!(event.data["reason"], "destructive");
    }

    #[test]
    fn event_tool_approval_response_type() {
        let event = AgentEvent {
            event_type: "tool.approval_response".into(),
            data: serde_json::json!({"toolId": "call-1", "approved": true}),
        };
        assert_eq!(event.event_type, "tool.approval_response");
        assert_eq!(event.data["approved"], true);
    }
}
