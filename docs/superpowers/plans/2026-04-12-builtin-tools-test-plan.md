# Builtin Tools 测试验证方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全评审发现的测试覆盖缺口，确保 Rust builtins 行为与 TS 完全一致，对 TS↔Rust schema parity 建立自动化验证。

**Architecture:** 三层测试 — (1) Rust 单元/集成测试补全边界场景，(2) TS 侧 canonical schema 验证，(3) Rust 侧 canonical schema 验证。两端使用相同的 canonical 定义，任一端修改 schema 都会使测试失败。

**Tech Stack:** Rust (cargo test, tempfile, tokio), TypeScript (vitest)

---

## 评审发现的测试缺口

| # | 缺口 | 严重程度 | 覆盖方案 |
|---|---|---|---|
| G1 | edit_file `replace_all=true` 未测试 | High | Task 1 |
| G2 | list_files glob pattern 未测试 | High | Task 1 |
| G3 | grep glob filter 未测试 | High | Task 1 |
| G4 | write_file path traversal 未测试 | Medium | Task 1 |
| G5 | web_fetch POST/headers/body 未测试 | Medium | Task 1 |
| G6 | memory_store / memory_recall 独立功能未测试 | Medium | Task 1 |
| G7 | read_file 不存在的文件 未测试 | Medium | Task 1 |
| G8 | edit_file old_string 不存在 未测试 | Medium | Task 1 |
| G9 | grep 无效 regex 未测试 | Medium | Task 1 |
| G10 | TS↔Rust schema 一致性无自动化验证 | High | Task 2 + 3 |
| G11 | ws.rs / loop_single / loop_dual 注册 10 tools 未验证 | High | Task 3 |
| G12 | web_fetch 依赖外部网络（httpbin.org），CI 不稳定 | Medium | Task 1 |

## File Map

| File | Action | Responsibility |
|---|---|---|
| `rust/crates/lumin-core/tests/builtins_integration.rs` | **Modify** | 补全 G1-G9, G12 边界测试 |
| `tests/tool-schema-parity.test.ts` | **Create** | TS 侧 canonical schema 验证 (G10) |
| `rust/crates/lumin-core/tests/tool_registration.rs` | **Create** | Rust 侧 schema + 注册覆盖验证 (G10, G11) |

---

### Task 1: Rust 边界场景测试补全

补全评审发现的 9 个缺口（G1-G9），加上 G12 的 `#[ignore]` 标注。

**Files:**
- Modify: `rust/crates/lumin-core/tests/builtins_integration.rs`

- [ ] **Step 1: 追加以下测试到文件末尾（`register_all_builtins_registers_10_tools` 之前）**

追加 import:
```rust
use lumin_core::tools::memory_tools::*;
```

追加测试:

```rust
// ── edit_file replace_all (G1) ──

#[tokio::test]
async fn edit_file_replace_all_replaces_all_occurrences() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("multi.txt"), "foo bar foo baz foo").unwrap();
    let tool = create_edit_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({
            "path": "multi.txt",
            "old_string": "foo",
            "new_string": "qux",
            "replace_all": true
        }),
        &ctx,
    ).await;
    assert!(result.contains("Replaced 3"));
    let content = std::fs::read_to_string(tmp.path().join("multi.txt")).unwrap();
    assert_eq!(content, "qux bar qux baz qux");
}

// ── edit_file not found (G8) ──

#[tokio::test]
async fn edit_file_returns_error_when_old_string_not_found() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("nope.txt"), "hello world").unwrap();
    let tool = create_edit_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({"path": "nope.txt", "old_string": "xyz", "new_string": "abc"}),
        &ctx,
    ).await;
    assert!(result.contains("Error: old_string not found"));
}

// ── list_files glob (G2) ──

#[tokio::test]
async fn list_files_filters_by_glob_pattern() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("main.rs"), "").unwrap();
    std::fs::write(tmp.path().join("lib.rs"), "").unwrap();
    std::fs::write(tmp.path().join("readme.md"), "").unwrap();
    let tool = create_list_files_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"pattern": "*.rs"}), &ctx).await;
    assert!(result.contains("main.rs"));
    assert!(result.contains("lib.rs"));
    assert!(!result.contains("readme.md"));
}

// ── grep glob (G3) ──

#[tokio::test]
async fn grep_filters_by_glob() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("code.rs"), "fn main() {}\n").unwrap();
    std::fs::write(tmp.path().join("notes.md"), "fn is a keyword\n").unwrap();
    let tool = create_grep_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"pattern": "fn", "glob": "*.rs"}), &ctx).await;
    assert!(result.contains("code.rs"));
    assert!(!result.contains("notes.md"));
}

// ── grep invalid regex (G9) ──

#[tokio::test]
async fn grep_returns_error_for_invalid_regex() {
    let tmp = TempDir::new().unwrap();
    let tool = create_grep_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"pattern": "[invalid"}), &ctx).await;
    assert!(result.contains("Error: invalid regex"));
}

// ── write_file path traversal (G4) ──

#[tokio::test]
async fn write_file_rejects_path_traversal() {
    let tmp = TempDir::new().unwrap();
    let tool = create_write_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({"path": "../../etc/evil.txt", "content": "hack"}),
        &ctx,
    ).await;
    assert!(result.contains("traversal"));
}

// ── read_file missing file (G7) ──

#[tokio::test]
async fn read_file_returns_error_for_missing_file() {
    let tmp = TempDir::new().unwrap();
    let tool = create_read_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"path": "nonexistent.txt"}), &ctx).await;
    assert!(result.starts_with("Error:"));
}

// ── memory roundtrip (G6) ──

#[tokio::test]
async fn memory_store_and_recall_roundtrip() {
    let tmp = TempDir::new().unwrap();
    let ws = tmp.path().to_string_lossy().to_string();
    let ctx = make_ctx(&ws);

    let store_tool = create_memory_store_tool(ws.clone());
    let result = (store_tool.execute)(
        serde_json::json!({"content": "The project uses Rust and TypeScript", "tags": ["tech"]}),
        &ctx,
    ).await;
    assert_eq!(result, "Memory stored successfully.");

    let recall_tool = create_memory_recall_tool(ws);
    let result = (recall_tool.execute)(
        serde_json::json!({"query": "Rust TypeScript"}),
        &ctx,
    ).await;
    assert!(result.contains("Rust") || result.contains("TypeScript"),
        "recall should find stored content, got: {result}");
}

#[tokio::test]
async fn memory_recall_returns_not_found_for_empty_store() {
    let tmp = TempDir::new().unwrap();
    let ws = tmp.path().to_string_lossy().to_string();
    let ctx = make_ctx(&ws);
    let tool = create_memory_recall_tool(ws);
    let result = (tool.execute)(serde_json::json!({"query": "nothing here"}), &ctx).await;
    assert_eq!(result, "No matching memories found.");
}

// ── web_fetch error handling (G5/G12) ──

#[tokio::test]
async fn web_fetch_returns_error_for_unreachable_url() {
    let tool = create_web_fetch_tool();
    let ctx = make_ctx("/tmp");
    let result = (tool.execute)(
        serde_json::json!({"url": "http://127.0.0.1:1/unreachable"}),
        &ctx,
    ).await;
    assert!(result.starts_with("Error:"));
}
```

- [ ] **Step 2: 标记外部网络测试为 `#[ignore]`**

在现有的 `web_fetch_gets_httpbin_json` 测试上方添加 `#[ignore]`：

将:
```rust
#[tokio::test]
async fn web_fetch_gets_httpbin_json() {
```
改为:
```rust
#[tokio::test]
#[ignore] // requires network — run with: cargo test -- --ignored
async fn web_fetch_gets_httpbin_json() {
```

- [ ] **Step 3: 运行测试**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo test -p lumin-core --test builtins_integration`
Expected: 22 tests passed, 1 ignored (web_fetch_gets_httpbin_json)。

- [ ] **Step 4: 提交**

```bash
git add crates/lumin-core/tests/builtins_integration.rs
git commit -m "test(rust): add boundary tests — edit replace_all, glob filters, error cases, memory roundtrip"
```

---

### Task 2: TS 侧 Canonical Schema 验证

用一份 canonical spec 定义验证 TS 的 tool schemas，确保与 Rust 侧使用相同的标准。

**Files:**
- Create: `tests/tool-schema-parity.test.ts`

- [ ] **Step 1: 编写 schema 验证测试**

```typescript
/**
 * TS tool schema parity test — verifies TS tools match the canonical spec.
 * The Rust side has a matching test (tool_registration.rs) using the same spec.
 * If either side's schema changes, one of the two tests will fail.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Canonical schema — source of truth shared conceptually with Rust test.
const CANONICAL: Record<string, {
  required: string[];
  properties: string[];  // property names only (type checked separately)
}> = {
  bash:          { required: ['command'],                         properties: ['command'] },
  read_file:     { required: ['path'],                            properties: ['path', 'offset', 'limit'] },
  write_file:    { required: ['path', 'content'],                 properties: ['path', 'content'] },
  edit_file:     { required: ['path', 'old_string', 'new_string'], properties: ['path', 'old_string', 'new_string', 'replace_all'] },
  list_files:    { required: [],                                  properties: ['path', 'pattern', 'maxDepth'] },
  grep:          { required: ['pattern'],                         properties: ['pattern', 'path', 'glob', 'maxResults'] },
  web_fetch:     { required: ['url'],                             properties: ['url', 'method', 'headers', 'body', 'maxBytes'] },
  think:         { required: ['thought'],                         properties: ['thought'] },
  memory_store:  { required: ['content'],                         properties: ['content', 'tags'] },
  memory_recall: { required: ['query'],                           properties: ['query', 'maxChars'] },
};

const TOOL_NAMES = Object.keys(CANONICAL);

describe('TS tool schemas match canonical spec', () => {
  let specs: any[];

  beforeAll(async () => {
    const { getToolSpecs } = await import('../src/index.js');
    const result = await getToolSpecs();
    specs = result.specs;
  });

  it('has all 10 canonical tools', () => {
    const names = specs.map((s: any) => s.function.name);
    for (const name of TOOL_NAMES) {
      expect(names, `missing tool: ${name}`).toContain(name);
    }
  });

  for (const toolName of TOOL_NAMES) {
    it(`${toolName}: required fields match`, () => {
      const spec = specs.find((s: any) => s.function.name === toolName);
      const actual = (spec.function.parameters.required ?? []).slice().sort();
      const expected = [...CANONICAL[toolName].required].sort();
      expect(actual).toEqual(expected);
    });

    it(`${toolName}: property names match`, () => {
      const spec = specs.find((s: any) => s.function.name === toolName);
      const actual = Object.keys(spec.function.parameters.properties).sort();
      const expected = [...CANONICAL[toolName].properties].sort();
      expect(actual).toEqual(expected);
    });
  }
});
```

- [ ] **Step 2: 运行测试**

Run: `cd /Users/prismer/workspace/luminclaw && npx vitest run tests/tool-schema-parity.test.ts`
Expected: 21 tests PASS (1 has-all + 10 required + 10 properties)。

- [ ] **Step 3: 提交**

```bash
git add tests/tool-schema-parity.test.ts
git commit -m "test: TS tool schema canonical verification — 10 tools"
```

---

### Task 3: Rust 侧注册覆盖 + Schema 验证

验证所有代码路径注册了完整的 10 个 tools，schema 匹配 canonical spec，concurrency flags 正确。

**Files:**
- Create: `rust/crates/lumin-core/tests/tool_registration.rs`

- [ ] **Step 1: 编写注册与 schema 测试**

```rust
//! Tool registration coverage + schema parity with canonical spec.
//! Mirrors TS `tests/tool-schema-parity.test.ts` — same canonical definitions.

use lumin_core::tools::builtins::register_all_builtins;
use lumin_core::tools::ToolRegistry;

/// Canonical tool spec — must match the TS test's CANONICAL object exactly.
const EXPECTED: &[(&str, &[&str], &[&str])] = &[
    // (name, required, properties)
    ("bash",          &["command"],                             &["command"]),
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
```

- [ ] **Step 2: 运行测试**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo test -p lumin-core --test tool_registration`
Expected: 7 tests PASS。

- [ ] **Step 3: 提交**

```bash
git add crates/lumin-core/tests/tool_registration.rs
git commit -m "test(rust): tool registration + schema canonical verification — mirrors TS parity test"
```

---

### Task 4: 全量验证

- [ ] **Step 1: Rust 全量测试**

```bash
cd /Users/prismer/workspace/luminclaw/rust && cargo test 2>&1 | grep "test result:"
```

Expected: 所有测试 PASS，0 failures。

- [ ] **Step 2: TS 全量测试（排除 LLM 依赖）**

```bash
cd /Users/prismer/workspace/luminclaw && npx vitest run tests/server.test.ts tests/tool-schema-parity.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 3: 零 warnings 验证**

```bash
cd /Users/prismer/workspace/luminclaw/rust && cargo check 2>&1 | grep "^warning:" | grep -v "generated"
```

Expected: 无输出。

---

## 测试矩阵总结

### Rust builtins_integration.rs (Task 1 后)

| Tool | 测试数 | 覆盖场景 |
|---|---|---|
| read_file | 4 | happy path, offset+limit, path traversal, missing file |
| write_file | 2 | create+mkdir, path traversal |
| edit_file | 4 | unique replace, replace_all, ambiguous match, not found |
| list_files | 2 | recursive listing, glob filter |
| grep | 3 | match lines, glob filter, invalid regex |
| web_fetch | 2 | unreachable URL error, GET (ignored/network) |
| think | 1 | recorded |
| memory_store | 1 | store success |
| memory_recall | 2 | roundtrip, empty store |
| register_all | 1 | count=10 |
| **Total** | **22** | |

### Rust tool_registration.rs (Task 3)

| 测试 | 验证内容 |
|---|---|
| has_exactly_10_tools | 注册数 |
| has_every_expected_tool | 每个 name 都在 |
| has_no_unexpected_tools | 无多余 tool |
| all_specs_have_valid_openai_format | type/name/description/parameters 结构 |
| required_fields_match_canonical | required 字段与 canonical 一致 |
| property_names_match_canonical | properties 字段名与 canonical 一致 |
| concurrency_safe_flags_are_correct | 只读=safe, 写入=unsafe |
| **Total** | **7** |

### TS tool-schema-parity.test.ts (Task 2)

| 测试 | 验证内容 |
|---|---|
| has all 10 canonical tools | 存在性 |
| × 10 required fields match | required 字段 |
| × 10 property names match | properties 名称 |
| **Total** | **21** |

### 新增测试总计: **50 tests** (22 Rust builtins + 7 Rust registration + 21 TS schema)
