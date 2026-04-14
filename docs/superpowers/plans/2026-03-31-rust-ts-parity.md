# Rust ↔ TS Core Parity Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Rust `lumin-core` to feature parity with the latest TS core (`d7c9631` — CC-inspired agent overhaul).

**Architecture:** 10 gaps ranked by importance. Each task is a self-contained Rust change with tests. No TS changes needed — TS is the reference implementation.

**Tech Stack:** Rust (tokio, serde_json, regex-lite), cargo test

**Baseline:** TS core has 585 tests passing. Rust has 557 unit + 8 integration tests. After this plan: Rust should gain ~12 new tests covering all parity gaps.

---

## File Map

| New/Modified Rust file | Responsibility | TS Equivalent |
|---|---|---|
| `src/microcompact.rs` (new) | Zero-LLM-cost tool result clearing | `src/microcompact.ts` |
| `src/tokens.rs` (new) | Lightweight token estimation | `src/tokens.ts` |
| `src/tools.rs` (modify) | Add `is_concurrency_safe` + `with_filter` | `src/tools.ts` |
| `src/provider.rs` (modify) | Add `finish_reason` + `signal` to types | `src/provider.ts` |
| `src/agent.rs` (modify) | Partitioned tool execution, microcompact, output recovery, depth limit | `src/agent.ts` |
| `src/lib.rs` (modify) | Export new modules | `src/index.ts` |

> **Not porting:** `StreamingToolExecutor` — TS has it as a standalone module but doesn't use it in agent.ts yet (only the simpler `partitionToolCalls` is wired). We port the wired features only.

---

### Task 1: `microcompact.rs` — zero-cost context compression

**Files:**
- Create: `rust/crates/lumin-core/src/microcompact.rs`
- Modify: `rust/crates/lumin-core/src/lib.rs` (add `pub mod microcompact;`)

- [ ] **Step 1: Create microcompact.rs with test**

```rust
// rust/crates/lumin-core/src/microcompact.rs
//! Microcompact — zero-LLM-cost incremental context compression.
//! Mirrors TypeScript `microcompact.ts`.

use crate::provider::Message;

pub const CLEARED_MARKER: &str = "[Old tool result cleared]";

/// Clear old tool result contents, keeping the most recent `keep_recent` intact.
/// Mutates messages in-place for efficiency.
pub fn microcompact(messages: &mut [Message], keep_recent: usize) {
    let tool_indices: Vec<usize> = messages.iter().enumerate()
        .filter(|(_, m)| {
            m.role == "tool"
                && m.text_content().map_or(false, |c| c != CLEARED_MARKER && !c.is_empty())
        })
        .map(|(i, _)| i)
        .collect();

    if tool_indices.len() <= keep_recent {
        return;
    }

    let to_clear = &tool_indices[..tool_indices.len() - keep_recent];
    for &idx in to_clear {
        messages[idx].content = Some(crate::provider::MessageContent::Text(CLEARED_MARKER.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::Message;

    #[test]
    fn clears_old_tool_results_keeping_recent() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::user("q"),
            Message::tool_result("t1", "result-1-long-content"),
            Message::tool_result("t2", "result-2-long-content"),
            Message::tool_result("t3", "result-3-long-content"),
            Message::tool_result("t4", "result-4-long-content"),
            Message::tool_result("t5", "result-5-long-content"),
        ];
        microcompact(&mut msgs, 2);
        // First 3 tool results cleared, last 2 kept
        assert_eq!(msgs[2].text_content(), Some(CLEARED_MARKER));
        assert_eq!(msgs[3].text_content(), Some(CLEARED_MARKER));
        assert_eq!(msgs[4].text_content(), Some(CLEARED_MARKER));
        assert_eq!(msgs[5].text_content(), Some("result-4-long-content"));
        assert_eq!(msgs[6].text_content(), Some("result-5-long-content"));
    }

    #[test]
    fn no_op_when_fewer_than_keep_recent() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::tool_result("t1", "result-1"),
        ];
        microcompact(&mut msgs, 5);
        assert_eq!(msgs[1].text_content(), Some("result-1"));
    }

    #[test]
    fn skips_already_cleared() {
        let mut msgs = vec![
            Message::system("sys"),
            Message::tool_result("t1", CLEARED_MARKER),
            Message::tool_result("t2", "result-2"),
            Message::tool_result("t3", "result-3"),
        ];
        microcompact(&mut msgs, 1);
        // t1 already cleared (not counted), t2 cleared, t3 kept
        assert_eq!(msgs[2].text_content(), Some(CLEARED_MARKER));
        assert_eq!(msgs[3].text_content(), Some("result-3"));
    }
}
```

- [ ] **Step 2: Add module to lib.rs**

Add `pub mod microcompact;` after `pub mod compaction;` in `rust/crates/lumin-core/src/lib.rs`.
Add to re-exports: `pub use microcompact::{microcompact as run_microcompact, CLEARED_MARKER};`

- [ ] **Step 3: Run tests**

Run: `cd rust && cargo test microcompact`
Expected: 3 tests PASS

- [ ] **Step 4: Commit**

```
git add rust/crates/lumin-core/src/microcompact.rs rust/crates/lumin-core/src/lib.rs
git commit -m "feat(rust): add microcompact — zero-cost tool result compression"
```

---

### Task 2: `tokens.rs` — lightweight token estimation

**Files:**
- Create: `rust/crates/lumin-core/src/tokens.rs`
- Modify: `rust/crates/lumin-core/src/lib.rs`

- [ ] **Step 1: Create tokens.rs with tests**

```rust
// rust/crates/lumin-core/src/tokens.rs
//! Lightweight token estimation — mirrors TypeScript `tokens.ts`.

/// Estimate token count for a text string.
/// CJK ~2 chars/token, Latin ~4 chars/token, padded 1.33x.
pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() { return 0; }
    let cjk_count = text.chars().filter(|&c| {
        ('\u{4e00}'..='\u{9fff}').contains(&c)
            || ('\u{3040}'..='\u{30ff}').contains(&c)
            || ('\u{3400}'..='\u{4dbf}').contains(&c)
            || ('\u{ac00}'..='\u{d7af}').contains(&c)
    }).count();
    let non_cjk = text.len().saturating_sub(cjk_count);
    ((non_cjk as f64 / 4.0 + cjk_count as f64 / 2.0) * 1.33).ceil() as usize
}

/// Estimate total tokens for a conversation message array.
pub fn estimate_message_tokens(messages: &[crate::provider::Message]) -> usize {
    let mut total = 0usize;
    for msg in messages {
        total += 4; // role + delimiters
        if let Some(ref content) = msg.content {
            total += estimate_tokens(content.as_text());
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_text() {
        let t = estimate_tokens("Hello, world!");
        assert!(t > 0 && t < 10);
    }

    #[test]
    fn cjk_text() {
        let t = estimate_tokens("你好世界");
        assert!(t >= 2);
    }

    #[test]
    fn empty() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn message_tokens() {
        let msgs = vec![
            crate::provider::Message::system("You are helpful."),
            crate::provider::Message::user("Hello!"),
        ];
        let t = estimate_message_tokens(&msgs);
        assert!(t > 8); // at least 4+4 overhead
    }
}
```

- [ ] **Step 2: Add module to lib.rs**

Add `pub mod tokens;` and `pub use tokens::{estimate_tokens, estimate_message_tokens};`

- [ ] **Step 3: Run tests, commit**

Run: `cd rust && cargo test tokens`

```
git add rust/crates/lumin-core/src/tokens.rs rust/crates/lumin-core/src/lib.rs
git commit -m "feat(rust): add tokens — lightweight token estimation"
```

---

### Task 3: `tools.rs` — `is_concurrency_safe` + `with_filter`

**Files:**
- Modify: `rust/crates/lumin-core/src/tools.rs`

- [ ] **Step 1: Add `is_concurrency_safe` to Tool struct**

In `tools.rs`, add to the `Tool` struct:

```rust
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub execute: ToolFn,
    /// Return true if safe to run concurrently (read-only / no side effects).
    /// None = assume unsafe (serial). Mirrors TS `isConcurrencySafe`.
    pub is_concurrency_safe: Option<Arc<dyn Fn(&Value) -> bool + Send + Sync>>,
}
```

Update `create_bash_tool` and `create_test_tool` to set `is_concurrency_safe: None`.

- [ ] **Step 2: Add `with_filter` method to ToolRegistry**

```rust
impl ToolRegistry {
    /// Create a filtered view. Mirrors TS `ToolRegistry.withFilter`.
    pub fn with_filter<F: Fn(&str) -> bool>(&self, predicate: F) -> ToolRegistry {
        let mut filtered = ToolRegistry::new();
        for (name, tool) in &self.tools {
            if predicate(name) {
                filtered.tools.insert(name.clone(), Tool {
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    parameters: tool.parameters.clone(),
                    execute: tool.execute.clone(),
                    is_concurrency_safe: tool.is_concurrency_safe.clone(),
                });
            }
        }
        filtered
    }
}
```

- [ ] **Step 3: Add tests**

```rust
#[test]
fn with_filter_excludes_tools() {
    let mut reg = ToolRegistry::new();
    reg.register(create_test_tool("bash", "run commands"));
    reg.register(create_test_tool("read", "read files"));
    reg.register(create_test_tool("delegate", "delegate"));
    let filtered = reg.with_filter(|name| name != "delegate");
    assert_eq!(filtered.size(), 2);
    assert!(filtered.has("bash"));
    assert!(!filtered.has("delegate"));
}
```

- [ ] **Step 4: Run tests, commit**

Run: `cd rust && cargo test tools`

```
git commit -m "feat(rust): add is_concurrency_safe + with_filter to tools"
```

---

### Task 4: `provider.rs` — `finish_reason` + `signal` fields

**Files:**
- Modify: `rust/crates/lumin-core/src/provider.rs`

- [ ] **Step 1: Add `finish_reason` to ChatResponse**

```rust
#[derive(Debug, Clone, Default)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub thinking: Option<String>,
    pub usage: Option<Usage>,
    pub finish_reason: Option<String>,  // NEW: "stop" | "tool_calls" | "length"
}
```

- [ ] **Step 2: Parse finish_reason in both batch and stream paths**

In `parse_response()`:
```rust
let finish_reason = choice["finish_reason"].as_str().map(|s| s.to_string());
// ... in the return:
Ok(ChatResponse { text: response_text, tool_calls, thinking, usage, finish_reason })
```

In `chat_stream_internal()`, track `finish_reason` from stream chunks and set on return.

- [ ] **Step 3: Add `signal` to ChatRequest (reserved for future CancellationToken)**

```rust
pub struct ChatRequest {
    // ... existing fields ...
    /// Cancellation token — reserved for future use (Rust uses CancellationToken separately).
    pub cancelled: Option<Arc<Mutex<bool>>>,
}
```

- [ ] **Step 4: Add test**

```rust
#[test]
fn parse_response_with_finish_reason() {
    let raw = json!({
        "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]
    });
    let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
    assert_eq!(resp.finish_reason.as_deref(), Some("stop"));
}

#[test]
fn parse_response_finish_reason_length() {
    let raw = json!({
        "choices": [{"message": {"content": "truncated..."}, "finish_reason": "length"}]
    });
    let resp = OpenAIProvider::parse_response(&raw.to_string()).unwrap();
    assert_eq!(resp.finish_reason.as_deref(), Some("length"));
}
```

- [ ] **Step 5: Run tests, commit**

Run: `cd rust && cargo test provider`

```
git commit -m "feat(rust): add finish_reason to ChatResponse"
```

---

### Task 5: `agent.rs` — partitioned tool execution

**Files:**
- Modify: `rust/crates/lumin-core/src/agent.rs`

- [ ] **Step 1: Add `partition_tool_calls` helper**

```rust
struct ToolBatch {
    concurrent: bool,
    calls: Vec<ToolCall>,
}

fn partition_tool_calls(calls: &[ToolCall], tools: &ToolRegistry) -> Vec<ToolBatch> {
    let mut batches: Vec<ToolBatch> = Vec::new();
    for call in calls {
        let tool = tools.get(&call.name);
        let safe = tool
            .and_then(|t| t.is_concurrency_safe.as_ref())
            .map_or(false, |f| f(&call.arguments));
        let last = batches.last_mut();
        match last {
            Some(batch) if safe && batch.concurrent => {
                batch.calls.push(call.clone());
            }
            _ => {
                batches.push(ToolBatch { concurrent: safe, calls: vec![call.clone()] });
            }
        }
    }
    batches
}
```

- [ ] **Step 2: Replace serial tool execution with batched execution**

In the tool execution section of `process_message_full` (~line 515), replace the `for call in &response.tool_calls` loop with:

```rust
let batches = partition_tool_calls(&response.tool_calls, &self.tools);
for batch in batches {
    if batch.concurrent && batch.calls.len() > 1 {
        // Execute concurrently with tokio::join
        let futs: Vec<_> = batch.calls.iter().map(|call| {
            self.execute_single_tool(call, session, &mut tools_used, &mut all_directives)
        }).collect();
        let results = futures::future::join_all(futs).await;
        for (call, (output, is_error)) in batch.calls.iter().zip(results) {
            // ... append to session, check errors ...
        }
    } else {
        // Execute serially (current behavior)
        for call in &batch.calls {
            // ... existing serial code ...
        }
    }
}
```

Note: The full implementation will need to refactor the tool execution code into a helper method (`execute_single_tool`) to avoid code duplication. The exact implementation should follow the existing patterns in agent.rs.

- [ ] **Step 3: Add test**

```rust
#[test]
fn partition_tool_calls_groups_safe_together() {
    // Test the partitioning logic with mock tools
    let mut reg = ToolRegistry::new();
    // Create tools with is_concurrency_safe set
    // ... verify batching behavior ...
}
```

- [ ] **Step 4: Run tests, commit**

Run: `cd rust && cargo test agent`

```
git commit -m "feat(rust): partitioned tool execution — concurrent read-only tools"
```

---

### Task 6: `agent.rs` — microcompact integration

**Files:**
- Modify: `rust/crates/lumin-core/src/agent.rs`

- [ ] **Step 1: Call microcompact before context guard**

In `process_message_full`, right before the `total_chars` calculation (~line 449), add:

```rust
crate::microcompact::microcompact(&mut messages, 5);
```

- [ ] **Step 2: Run full test suite**

Run: `cd rust && cargo test`
Expected: All existing tests still pass (microcompact is non-breaking — it only clears old results).

- [ ] **Step 3: Commit**

```
git commit -m "feat(rust): integrate microcompact into agent loop"
```

---

### Task 7: `agent.rs` — output recovery (finish_reason=length)

**Files:**
- Modify: `rust/crates/lumin-core/src/agent.rs`

- [ ] **Step 1: Add output_recovery_count to agent loop state**

Add a `let mut output_recovery_count = 0u32;` and `const MAX_OUTPUT_RECOVERY: u32 = 3;` before the loop.

- [ ] **Step 2: After "no tool calls" check, add length recovery**

```rust
if response.tool_calls.is_empty() {
    // Output recovery: if LLM was cut off, ask it to continue
    if response.finish_reason.as_deref() == Some("length") && output_recovery_count < MAX_OUTPUT_RECOVERY {
        let cont_msg = Message::user("Please continue from where you left off.");
        messages.push(cont_msg.clone());
        session.add_message(cont_msg);
        output_recovery_count += 1;
        continue;
    }
    // ... existing break logic ...
}
```

- [ ] **Step 3: Commit**

```
git commit -m "feat(rust): output recovery on finish_reason=length"
```

---

### Task 8: `agent.rs` — sub-agent recursion depth limit

**Files:**
- Modify: `rust/crates/lumin-core/src/agent.rs`

- [ ] **Step 1: Add `depth` field to PrismerAgent**

Add `depth: u32` field, default 0. Add `const MAX_SUBAGENT_DEPTH: u32 = 5;`.

- [ ] **Step 2: Pass `depth + 1` when creating sub-agents in `delegate_to_sub_agent`**

Check `if self.depth >= MAX_SUBAGENT_DEPTH` and return error before spawning.

- [ ] **Step 3: Add test**

```rust
#[test]
fn max_subagent_depth_constant() {
    // Verify the constant exists and is 5
    assert_eq!(MAX_SUBAGENT_DEPTH, 5);
}
```

- [ ] **Step 4: Commit**

```
git commit -m "feat(rust): sub-agent recursion depth limit (max 5)"
```

---

### Task 9: `tools.rs` — update `create_bash_tool` for concurrency safety

**Files:**
- Modify: `rust/crates/lumin-core/src/tools.rs`

- [ ] **Step 1: Update `create_bash_tool` to accept the new field**

```rust
pub fn create_bash_tool(workspace_dir: String) -> Tool {
    Tool {
        name: "bash".into(),
        description: "Execute a bash command in the container".into(),
        parameters: /* ... existing ... */,
        execute: /* ... existing ... */,
        is_concurrency_safe: None, // bash is never concurrent-safe
    }
}
```

- [ ] **Step 2: Fix all other Tool constructions in tests**

Search for `Tool {` in all Rust files and add `is_concurrency_safe: None`.

- [ ] **Step 3: Run full test suite**

Run: `cd rust && cargo test`
Expected: All 557+ tests pass.

- [ ] **Step 4: Commit**

```
git commit -m "fix(rust): add is_concurrency_safe field to all Tool constructions"
```

---

### Task 10: Final — integration test + cargo build

- [ ] **Step 1: Run full Rust test suite**

```bash
cd rust && cargo test 2>&1 | tail -10
```
Expected: All tests pass, no warnings related to new code.

- [ ] **Step 2: Run TS tests to verify no regression**

```bash
npx vitest run --exclude='**/loop-integration*' --exclude='**/memory-recall-benchmark*' --exclude='**/llm-integration*' --exclude='**/locomo-benchmark*'
```
Expected: 35 files, 585+ tests pass.

- [ ] **Step 3: Final commit with parity summary**

```
git commit -m "docs: update parity status after Rust alignment"
```
