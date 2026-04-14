use lumin_core::abort::AbortReason;

#[test]
fn abort_reason_snake_case_serialization() {
    let r = AbortReason::UserExplicitCancel;
    let json = serde_json::to_string(&r).unwrap();
    assert_eq!(json, "\"user_explicit_cancel\"");
}

#[test]
fn abort_reason_as_str_matches_ts() {
    assert_eq!(AbortReason::UserInterrupted.as_str(), "user_interrupted");
    assert_eq!(AbortReason::Timeout.as_str(), "timeout");
    assert_eq!(AbortReason::ServerShutdown.as_str(), "server_shutdown");
}
