//! Tool registration coverage + schema parity with canonical spec.
//! Mirrors TS `tests/tool-schema-parity.test.ts` — same canonical definitions.

use lumin_core::tools::builtins::register_all_builtins;
use lumin_core::tools::ToolRegistry;

/// Canonical tool spec — must match the TS test's CANONICAL object exactly.
const EXPECTED: &[(&str, &[&str], &[&str])] = &[
    // (name, required, properties)
    ("bash",          &["command"],                             &["command", "timeout"]),
    ("read_file",     &["path"],                                &["path", "offset", "limit"]),
    ("write_file",    &["path", "content"],                     &["path", "content"]),
    ("edit_file",     &["path", "old_string", "new_string"],    &["path", "old_string", "new_string", "replace_all"]),
    ("list_files",    &[],                                      &["path", "pattern", "maxDepth"]),
    ("grep",          &["pattern"],                             &["pattern", "path", "glob", "maxResults"]),
    ("web_fetch",     &["url"],                                 &["url", "method", "headers", "body", "maxBytes"]),
    ("think",         &["thought"],                             &["thought"]),
    ("memory_store",  &["content"],                             &["content", "tags"]),
    ("memory_recall", &["query"],                               &["query", "maxChars"]),
];

fn make_registry() -> ToolRegistry {
    let mut r = ToolRegistry::new();
    register_all_builtins(&mut r, "/tmp/test-workspace");
    r
}

#[test]
fn has_exactly_10_tools() {
    let r = make_registry();
    assert_eq!(r.size(), 10);
}

#[test]
fn has_every_expected_tool() {
    let r = make_registry();
    for (name, _, _) in EXPECTED {
        assert!(r.has(name), "missing tool: {name}");
    }
}

#[test]
fn has_no_unexpected_tools() {
    let r = make_registry();
    let specs = r.get_specs();
    let expected_names: Vec<&str> = EXPECTED.iter().map(|(n, _, _)| *n).collect();
    for spec in &specs {
        let name = spec["function"]["name"].as_str().unwrap();
        assert!(expected_names.contains(&name), "unexpected tool: {name}");
    }
}

#[test]
fn all_specs_have_valid_openai_format() {
    let r = make_registry();
    for spec in r.get_specs() {
        assert_eq!(spec["type"], "function");
        let func = &spec["function"];
        assert!(func["name"].is_string());
        assert!(func["description"].is_string());
        assert!(func["parameters"].is_object());
        assert_eq!(func["parameters"]["type"], "object");
        assert!(func["parameters"]["properties"].is_object());
    }
}

#[test]
fn required_fields_match_canonical() {
    let r = make_registry();
    let specs = r.get_specs();
    for (name, expected_required, _) in EXPECTED {
        let spec = specs.iter().find(|s| s["function"]["name"] == *name)
            .unwrap_or_else(|| panic!("tool not found: {name}"));
        let params = &spec["function"]["parameters"];

        let mut actual: Vec<String> = params["required"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        actual.sort();

        let mut expected: Vec<String> = expected_required.iter().map(|s| s.to_string()).collect();
        expected.sort();

        assert_eq!(actual, expected, "{name}: required mismatch");
    }
}

#[test]
fn property_names_match_canonical() {
    let r = make_registry();
    let specs = r.get_specs();
    for (name, _, expected_props) in EXPECTED {
        let spec = specs.iter().find(|s| s["function"]["name"] == *name)
            .unwrap_or_else(|| panic!("tool not found: {name}"));
        let params = &spec["function"]["parameters"];

        let mut actual: Vec<String> = params["properties"].as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        actual.sort();

        let mut expected: Vec<String> = expected_props.iter().map(|s| s.to_string()).collect();
        expected.sort();

        assert_eq!(actual, expected, "{name}: properties mismatch");
    }
}

#[test]
fn concurrency_safe_flags_are_correct() {
    let r = make_registry();
    // Read-only tools should be concurrency-safe
    for name in &["read_file", "list_files", "grep", "web_fetch", "think"] {
        let tool = r.get(name).unwrap();
        assert!(tool.is_concurrency_safe.is_some(), "{name} should be concurrency-safe");
    }
    // Mutating tools should NOT be concurrency-safe
    for name in &["bash", "write_file", "edit_file", "memory_store", "memory_recall"] {
        let tool = r.get(name).unwrap();
        assert!(tool.is_concurrency_safe.is_none(), "{name} should not be concurrency-safe");
    }
}
