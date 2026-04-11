# Builtin Tools Parity + MVP Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix TS `/v1/tools` endpoint inconsistency, then add 7 missing built-in tools to Rust, achieving full TS↔Rust feature parity and passing the 5-task MVP benchmark (T1–T5).

**Architecture:** TS-first development — fix the TS gap first (`/v1/tools` underreporting), then port all builtins to Rust mirroring TS abstractions exactly. Both sides end up with identical tool sets, identical schemas, identical module structure.

**Tech Stack:** TypeScript (Node.js fs/path), Rust (tokio fs, regex-lite, reqwest), vitest, cargo test

---

## Independent Assessment

### Requirements vs TS — Gap Analysis

| Requirement | TS Status | Gap? |
|---|---|---|
| T1: write_file + bash | Agent has both. `builtins.ts:60-78` + `index.ts:110-139` | **No** |
| T2: read_file + edit_file + bash | Agent has all. `builtins.ts:34-56`, `builtins.ts:149-190` | **No** |
| T3: grep | Agent has it. `builtins.ts:233-278` | **No** |
| T4: web_fetch | Agent has it. `builtins.ts:283-316` | **No** |
| T5: memory_store + memory_recall | Agent has both. `index.ts:143-180` | **No** |
| `/v1/tools` lists all tools | **NO** — `server.ts:215-231` only registers bash stub | **YES** |

**TS has one gap:** The `/v1/tools` endpoint (`handleTools()`) creates its own registry with only workspace tools + bash. It does NOT include the 7 builtins, memory_store, memory_recall, or clawhub. This means API consumers see 1 tool when the agent actually uses 11.

The root cause: `ensureInitialized()` in `index.ts` is private and creates the full registry, but `handleTools()` in `server.ts` can't access it. It duplicates a partial registration.

### Requirements vs Rust — Gap Analysis (compared to TS agent runtime)

| Feature | TS Agent | Rust Agent | Gap |
|---|---|---|---|
| bash | `index.ts:110-139` | `tools.rs:154-190` | None |
| read_file | `builtins.ts:34-56` | Missing | **Need to port** |
| write_file | `builtins.ts:60-78` | Missing | **Need to port** |
| list_files | `builtins.ts:119-145` | Missing | **Need to port** |
| edit_file | `builtins.ts:149-190` | Missing | **Need to port** |
| grep | `builtins.ts:233-278` | Missing | **Need to port** |
| web_fetch | `builtins.ts:283-316` | Missing | **Need to port** |
| think | `builtins.ts:320-333` | Missing | **Need to port** |
| memory_store | `index.ts:143-161` | `http.rs:183-211` (inline) | **Need to extract** |
| memory_recall | `index.ts:162-180` | `http.rs:213-237` (inline) | **Need to extract** |
| safePath | `builtins.ts:23-30` | Missing | **Need to port** |
| `/v1/tools` completeness | Broken (1 tool) | Partial (3 tools) | **Both need fix** |
| FallbackProvider | `provider.ts` | `provider.rs` | None (assessment was wrong) |
| Builtins module structure | `tools/builtins.ts` | No equivalent | **Need to create** |
| CLI tool registration | All 11 tools | Only bash | **Need to align** |

### Assessment Correction

| Original Claim | Verdict |
|---|---|
| "缺 Fallback chain" | **WRONG** — `FallbackProvider` exists in `provider.rs` with retry + exponential backoff. `http.rs:170-176` wires it. |

---

## File Map

### Phase 1: TS Fix

| File | Action | Responsibility |
|---|---|---|
| `src/index.ts` | **Modify** | Export `getToolSpecs()` function that returns full tool specs |
| `src/server.ts` | **Modify** | `handleTools()` uses `getToolSpecs()` instead of ad-hoc registry |
| `tests/server.test.ts` | **Modify or create** | Test that `/v1/tools` returns all 10+ tools |

### Phase 2: Rust Alignment

| File | Action | Responsibility |
|---|---|---|
| `rust/crates/lumin-core/src/tools/mod.rs` | **Create** (move from `tools.rs`) | Tool registry + types + `safe_path()` |
| `rust/crates/lumin-core/src/tools/builtins.rs` | **Create** | 7 builtin factories + `register_all_builtins()` — mirrors `tools/builtins.ts` |
| `rust/crates/lumin-core/src/tools/memory_tools.rs` | **Create** | memory_store + memory_recall factories — mirrors `index.ts:143-180` |
| `rust/crates/lumin-core/src/lib.rs` | **Modify** | Module path change (file → dir) |
| `rust/crates/lumin-server/src/http.rs` | **Modify** | Use `register_all_builtins()`, fix warnings |
| `rust/crates/lumin-server/src/main.rs` | **Modify** | Use `register_all_builtins()` in CLI mode |
| `rust/crates/lumin-core/tests/builtins_integration.rs` | **Create** | Integration tests for all builtins |

### Phase 3: Verification

| File | Action | Responsibility |
|---|---|---|
| `tests/benchmark/run_mvp.sh` | **Create** | Automated T1–T5 benchmark runner |

---

## Phase 1: Fix TS `/v1/tools` Inconsistency

---

### Task 1: Export tool spec listing from index.ts

Expose a function that returns the complete tool set without running the agent.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `getToolSpecs()` export**

Add after the `ensureInitialized()` function (after line 196 in `src/index.ts`):

```typescript
/**
 * Get the full tool spec list (OpenAI format) — used by the /v1/tools endpoint.
 * Ensures tools are initialized, then returns specs from the shared registry.
 * This avoids the server duplicating tool registration logic.
 */
export async function getToolSpecs(enabledModules?: string[]): Promise<{ specs: ReturnType<ToolRegistry['getSpecs']>; count: number }> {
  const { tools } = await ensureInitialized(enabledModules);
  const specs = tools.getSpecs();
  return { specs, count: specs.length };
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/prismer/workspace/luminclaw && npx tsc --noEmit`
Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export getToolSpecs() for consistent tool listing"
```

---

### Task 2: Update server.ts handleTools to use shared registry

Replace the ad-hoc tool registration with the shared `getToolSpecs()`.

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Replace handleTools implementation**

Replace lines 215-231 in `src/server.ts`:

```typescript
async function handleTools(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { ToolRegistry } = await import('./tools.js');
  const { loadWorkspaceToolsFromPlugin, createTool } = await import('./tools/index.js');

  const tools = new ToolRegistry();
  const cfg = loadConfig();
  const enabledModules = cfg.modules.enabled.length > 0 ? cfg.modules.enabled : undefined;
  const { tools: workspaceTools } = await loadWorkspaceToolsFromPlugin(cfg.workspace.pluginPath, enabledModules);
  tools.registerMany(workspaceTools);

  // Include bash
  tools.register(createTool('bash', 'Execute bash command', { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, async () => ''));

  const specs = tools.getSpecs();
  json(res, 200, { tools: specs, count: specs.length });
}
```

With:

```typescript
async function handleTools(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { getToolSpecs } = await import('./index.js');
  const cfg = loadConfig();
  const enabledModules = cfg.modules.enabled.length > 0 ? cfg.modules.enabled : undefined;
  const { specs, count } = await getToolSpecs(enabledModules);
  json(res, 200, { tools: specs, count });
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/prismer/workspace/luminclaw && npx tsc --noEmit`
Expected: Compiles.

- [ ] **Step 3: Run existing tests**

Run: `cd /Users/prismer/workspace/luminclaw && npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "fix: /v1/tools now returns all registered tools via shared registry"
```

---

### Task 3: Test that /v1/tools returns complete tool list

**Files:**
- Modify or create: `tests/server.test.ts`

- [ ] **Step 1: Write the test**

If `tests/server.test.ts` exists, add to it. Otherwise create:

```typescript
import { describe, it, expect } from 'vitest';

describe('/v1/tools completeness', () => {
  it('getToolSpecs returns all builtin tools', async () => {
    const { getToolSpecs } = await import('../src/index.js');
    const { specs, count } = await getToolSpecs();

    const names = specs.map((s: any) => s.function.name);

    // Core builtins that must always be present
    const required = ['bash', 'read_file', 'write_file', 'list_files', 'edit_file', 'grep', 'web_fetch', 'think', 'memory_store', 'memory_recall'];
    for (const name of required) {
      expect(names, `missing tool: ${name}`).toContain(name);
    }
    expect(count).toBeGreaterThanOrEqual(required.length);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/prismer/workspace/luminclaw && npx vitest run tests/server.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/server.test.ts
git commit -m "test: verify /v1/tools returns all builtin tools"
```

---

## Phase 2: Align Rust to TS

---

### Task 4: Restructure Rust `tools.rs` into `tools/` module

Mirror the TS directory structure: `tools/builtins.ts` → `tools/builtins.rs`.

**Files:**
- Rename: `crates/lumin-core/src/tools.rs` → `crates/lumin-core/src/tools/mod.rs`

- [ ] **Step 1: Create tools directory and move file**

```bash
cd /Users/prismer/workspace/luminclaw/rust/crates/lumin-core/src
mkdir -p tools
mv tools.rs tools/mod.rs
```

- [ ] **Step 2: Verify compilation unchanged**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo test -p lumin-core --lib -- tools::`
Expected: All 38 existing tool tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/prismer/workspace/luminclaw/rust
git add -A crates/lumin-core/src/tools/ crates/lumin-core/src/
git commit -m "refactor(rust): move tools.rs to tools/mod.rs — mirrors TS tools/ dir"
```

---

### Task 5: Add `safe_path()` — mirrors TS `safePath()`

Path traversal prevention. TS reference: `src/tools/builtins.ts:23-30`.

**Files:**
- Modify: `rust/crates/lumin-core/src/tools/mod.rs`

- [ ] **Step 1: Write failing tests**

Add inside the existing `#[cfg(test)] mod tests { ... }` block in `tools/mod.rs`:

```rust
// ── path safety tests (mirrors TS safePath in builtins.ts:23-30) ──

#[test]
fn safe_path_resolves_relative() {
    let result = super::safe_path("src/main.rs", "/workspace");
    assert_eq!(result.unwrap(), std::path::PathBuf::from("/workspace/src/main.rs"));
}

#[test]
fn safe_path_rejects_traversal() {
    let result = super::safe_path("../etc/passwd", "/workspace");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("traversal"));
}

#[test]
fn safe_path_rejects_absolute_escape() {
    let result = super::safe_path("/etc/passwd", "/workspace");
    assert!(result.is_err());
}

#[test]
fn safe_path_allows_workspace_root() {
    let result = super::safe_path(".", "/workspace");
    assert_eq!(result.unwrap(), std::path::PathBuf::from("/workspace"));
}

#[test]
fn safe_path_normalizes_dot_segments() {
    let result = super::safe_path("src/../src/main.rs", "/workspace");
    assert_eq!(result.unwrap(), std::path::PathBuf::from("/workspace/src/main.rs"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo test -p lumin-core --lib -- tools::tests::safe_path`
Expected: FAIL — `safe_path` not found.

- [ ] **Step 3: Implement safe_path**

Add above `impl ToolRegistry` in `tools/mod.rs`:

```rust
use std::path::PathBuf;

/// Resolve a user-supplied path to an absolute path within the workspace.
/// Returns Err if the resolved path escapes the workspace root.
/// Mirrors TS `safePath()` in `tools/builtins.ts:23-30`.
pub fn safe_path(user_path: &str, workspace_dir: &str) -> Result<PathBuf, String> {
    let base = PathBuf::from(workspace_dir)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(workspace_dir));
    let candidate = if PathBuf::from(user_path).is_absolute() {
        PathBuf::from(user_path)
    } else {
        base.join(user_path)
    };

    // Normalize by resolving . and .. components (mirrors path.resolve in TS)
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::ParentDir => { normalized.pop(); }
            std::path::Component::CurDir => {}
            other => normalized.push(other),
        }
    }

    if !normalized.starts_with(&base) {
        return Err(format!("Path traversal rejected: {user_path}"));
    }
    Ok(normalized)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo test -p lumin-core --lib -- tools::tests::safe_path`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/prismer/workspace/luminclaw/rust
git add crates/lumin-core/src/tools/mod.rs
git commit -m "feat(rust): add safe_path — mirrors TS safePath()"
```

---

### Task 6: `builtins.rs` — file I/O tools (read_file, write_file, edit_file)

Mirrors TS `tools/builtins.ts:34-190`. Identical parameter schemas, identical output format.

**Files:**
- Create: `rust/crates/lumin-core/src/tools/builtins.rs`
- Modify: `rust/crates/lumin-core/src/tools/mod.rs` (add `pub mod builtins;`)

- [ ] **Step 1: Create builtins.rs with read_file**

```rust
// crates/lumin-core/src/tools/builtins.rs
//! Built-in tools — 7 pure Rust tools, mirrors TS `tools/builtins.ts`.

use crate::tools::{Tool, ToolRegistry, safe_path};
use serde_json::Value;
use std::sync::Arc;

/// Create the read_file tool.
/// Mirrors TS `builtins.ts:34-56`.
pub fn create_read_file_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "read_file".into(),
        description: "Read a file from the workspace. Returns file content with line numbers.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to workspace root" },
                "offset": { "type": "number", "description": "Start line (1-based, default: 1)" },
                "limit": { "type": "number", "description": "Max lines to return (default: 2000)" }
            },
            "required": ["path"]
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let user_path = args["path"].as_str().unwrap_or("");
                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                let content = match tokio::fs::read_to_string(&resolved).await {
                    Ok(c) => c,
                    Err(e) => return format!("Error: {e}"),
                };
                let lines: Vec<&str> = content.lines().collect();
                let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
                let limit = args["limit"].as_u64().unwrap_or(2000) as usize;
                let start = offset - 1;
                let end = lines.len().min(start + limit);
                if start >= lines.len() {
                    return format!("Error: offset {offset} exceeds file length ({} lines)", lines.len());
                }
                lines[start..end]
                    .iter()
                    .enumerate()
                    .map(|(i, line)| format!("{}\t{line}", start + i + 1))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}
```

- [ ] **Step 2: Add write_file tool**

Append to `builtins.rs`. Mirrors TS `builtins.ts:60-78`:

```rust
/// Create the write_file tool.
/// Mirrors TS `builtins.ts:60-78`.
pub fn create_write_file_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "write_file".into(),
        description: "Write content to a file in the workspace. Creates parent directories if needed.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to workspace root" },
                "content": { "type": "string", "description": "Content to write" }
            },
            "required": ["path", "content"]
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let user_path = args["path"].as_str().unwrap_or("");
                let content = args["content"].as_str().unwrap_or("");
                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                if let Some(parent) = resolved.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        return format!("Error creating directory: {e}");
                    }
                }
                match tokio::fs::write(&resolved, content).await {
                    Ok(()) => format!("Wrote {} bytes to {user_path}", content.len()),
                    Err(e) => format!("Error: {e}"),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}
```

- [ ] **Step 3: Add edit_file tool**

Append to `builtins.rs`. Mirrors TS `builtins.ts:149-190`:

```rust
/// Create the edit_file tool.
/// Mirrors TS `builtins.ts:149-190`.
pub fn create_edit_file_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "edit_file".into(),
        description: "Edit a file by replacing an exact string match. The old_string must appear exactly once in the file (unless replace_all is true).".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path relative to workspace root" },
                "old_string": { "type": "string", "description": "Exact string to find (must be unique in file)" },
                "new_string": { "type": "string", "description": "Replacement string" },
                "replace_all": { "type": "boolean", "description": "Replace all occurrences (default: false)" }
            },
            "required": ["path", "old_string", "new_string"]
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let user_path = args["path"].as_str().unwrap_or("");
                let old_str = args["old_string"].as_str().unwrap_or("");
                let new_str = args["new_string"].as_str().unwrap_or("");
                let replace_all = args["replace_all"].as_bool().unwrap_or(false);

                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                let content = match tokio::fs::read_to_string(&resolved).await {
                    Ok(c) => c,
                    Err(e) => return format!("Error: {e}"),
                };
                if !content.contains(old_str) {
                    return format!("Error: old_string not found in {user_path}");
                }
                let count = content.matches(old_str).count();
                if !replace_all && count > 1 {
                    return format!(
                        "Error: old_string found {count} times in {user_path}. Use replace_all: true or provide a more specific string."
                    );
                }
                let updated = content.replace(old_str, new_str);
                match tokio::fs::write(&resolved, &updated).await {
                    Ok(()) => format!("Replaced {count} occurrence(s) in {user_path}"),
                    Err(e) => format!("Error writing: {e}"),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}
```

- [ ] **Step 4: Wire module**

Add to `tools/mod.rs`:

```rust
pub mod builtins;
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo check -p lumin-core`
Expected: Compiles.

- [ ] **Step 6: Commit**

```bash
cd /Users/prismer/workspace/luminclaw/rust
git add crates/lumin-core/src/tools/builtins.rs crates/lumin-core/src/tools/mod.rs
git commit -m "feat(rust): add read_file, write_file, edit_file — mirrors TS builtins.ts"
```

---

### Task 7: `builtins.rs` — search + utility tools (list_files, grep, web_fetch, think)

Mirrors TS `tools/builtins.ts:86-333`. Same schemas, same output format.

**Files:**
- Modify: `rust/crates/lumin-core/src/tools/builtins.rs`

- [ ] **Step 1: Add list_files + helpers**

Append to `builtins.rs`. Mirrors TS `builtins.ts:86-145`:

```rust
/// Create the list_files tool.
/// Mirrors TS `builtins.ts:119-145`.
pub fn create_list_files_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "list_files".into(),
        description: "List files in the workspace. Supports glob patterns (e.g., \"**/*.ts\").".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path relative to workspace root (default: \".\")" },
                "pattern": { "type": "string", "description": "Glob pattern to filter files (e.g., \"**/*.ts\")" },
                "maxDepth": { "type": "number", "description": "Max directory depth (default: 10)" }
            }
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let user_path = args["path"].as_str().unwrap_or(".");
                let max_depth = args["maxDepth"].as_u64().unwrap_or(10) as usize;
                let pattern = args["pattern"].as_str().map(|s| s.to_string());
                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };
                let mut files = Vec::new();
                list_files_recursive(&resolved, &resolved, max_depth, 0, &mut files);
                let filtered: Vec<String> = match &pattern {
                    Some(pat) => files.into_iter().filter(|f| glob_match(pat, f)).collect(),
                    None => files,
                };
                if filtered.is_empty() {
                    return "No files found.".into();
                }
                let max_entries = 500;
                let truncated = filtered.len() > max_entries;
                let mut output: String = filtered[..filtered.len().min(max_entries)].join("\n");
                if truncated {
                    output.push_str(&format!("\n\n... and {} more files", filtered.len() - max_entries));
                }
                output
            })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}

/// Recursive directory listing — mirrors TS `listFilesRecursive` (builtins.ts:86-107).
fn list_files_recursive(
    dir: &std::path::Path, base: &std::path::Path,
    max_depth: usize, depth: usize, results: &mut Vec<String>,
) {
    if depth > max_depth { return; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && depth > 0 { continue; }
        if name == "node_modules" || name == ".git" { continue; }
        let rel = entry.path().strip_prefix(base)
            .unwrap_or(entry.path().as_path())
            .to_string_lossy().to_string();
        if entry.path().is_dir() {
            results.push(format!("{rel}/"));
            list_files_recursive(&entry.path(), base, max_depth, depth + 1, results);
        } else {
            results.push(rel);
        }
    }
}

/// Simple glob match — mirrors TS `globMatch` (builtins.ts:110-117).
fn glob_match(pattern: &str, path: &str) -> bool {
    let regex_str = regex_lite::escape(pattern)
        .replace(r"\*\*", "<<GLOBSTAR>>")
        .replace(r"\*", "[^/]*")
        .replace("<<GLOBSTAR>>", ".*");
    regex_lite::Regex::new(&format!("^{regex_str}$"))
        .map(|re| re.is_match(path))
        .unwrap_or(false)
}
```

- [ ] **Step 2: Add grep + helpers**

Append to `builtins.rs`. Mirrors TS `builtins.ts:194-278`:

```rust
/// Create the grep tool.
/// Mirrors TS `builtins.ts:233-278`.
pub fn create_grep_tool(workspace_dir: String) -> Tool {
    let dir = workspace_dir;
    Tool {
        name: "grep".into(),
        description: "Search file contents in the workspace using a regex pattern. Returns matching lines with file paths and line numbers.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regex pattern to search for" },
                "path": { "type": "string", "description": "Directory or file to search (default: workspace root)" },
                "glob": { "type": "string", "description": "File glob filter (e.g., \"*.ts\")" },
                "maxResults": { "type": "number", "description": "Max matches to return (default: 50)" }
            },
            "required": ["pattern"]
        }),
        execute: Arc::new(move |args: Value, _ctx| {
            let dir = dir.clone();
            Box::pin(async move {
                let pattern_str = args["pattern"].as_str().unwrap_or("");
                let user_path = args["path"].as_str().unwrap_or(".");
                let max_results = args["maxResults"].as_u64().unwrap_or(50) as usize;
                let glob_filter = args["glob"].as_str().map(|s| s.to_string());

                let regex = match regex_lite::Regex::new(pattern_str) {
                    Ok(r) => r,
                    Err(e) => return format!("Error: invalid regex: {e}"),
                };
                let resolved = match safe_path(user_path, &dir) {
                    Ok(p) => p,
                    Err(e) => return e,
                };

                let mut results = Vec::new();
                grep_recursive(&resolved, &std::path::PathBuf::from(&dir), &regex, max_results, &mut results, 0);

                let filtered: Vec<_> = match &glob_filter {
                    Some(g) => results.into_iter().filter(|(file, _, _)| {
                        glob_match(g, file) || glob_match(g, file.rsplit('/').next().unwrap_or(file))
                    }).collect(),
                    None => results,
                };

                if filtered.is_empty() {
                    return "No matches found.".into();
                }
                filtered.iter()
                    .map(|(file, line, text)| format!("{file}:{line}\t{text}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}

/// Recursive grep — mirrors TS `grepRecursive` (builtins.ts:194-231).
fn grep_recursive(
    dir: &std::path::Path, base: &std::path::Path, regex: &regex_lite::Regex,
    max_results: usize, results: &mut Vec<(String, usize, String)>, depth: usize,
) {
    if depth > 20 || results.len() >= max_results { return; }
    if dir.is_file() {
        grep_file(dir, base, regex, max_results, results);
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if results.len() >= max_results { return; }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "node_modules" || name == ".git" { continue; }
        if name.starts_with('.') && depth > 0 { continue; }
        let path = entry.path();
        if path.is_dir() {
            grep_recursive(&path, base, regex, max_results, results, depth + 1);
        } else {
            grep_file(&path, base, regex, max_results, results);
        }
    }
}

fn grep_file(
    path: &std::path::Path, base: &std::path::Path, regex: &regex_lite::Regex,
    max_results: usize, results: &mut Vec<(String, usize, String)>,
) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let rel = path.strip_prefix(base).unwrap_or(path).to_string_lossy().to_string();
    for (i, line) in content.lines().enumerate() {
        if results.len() >= max_results { return; }
        if regex.is_match(line) {
            results.push((rel.clone(), i + 1, line.to_string()));
        }
    }
}
```

- [ ] **Step 3: Add web_fetch**

Append to `builtins.rs`. Mirrors TS `builtins.ts:283-316`:

```rust
/// Create the web_fetch tool.
/// Mirrors TS `builtins.ts:283-316`.
pub fn create_web_fetch_tool() -> Tool {
    Tool {
        name: "web_fetch".into(),
        description: "Fetch a URL and return the response body. Supports GET/POST with optional headers and body.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "URL to fetch" },
                "method": { "type": "string", "description": "HTTP method (default: GET)", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"] },
                "headers": { "type": "object", "description": "Request headers" },
                "body": { "type": "string", "description": "Request body (for POST/PUT/PATCH)" },
                "maxBytes": { "type": "number", "description": "Max response bytes to return (default: 100000)" }
            },
            "required": ["url"]
        }),
        execute: Arc::new(|args: Value, _ctx| {
            Box::pin(async move {
                let url = args["url"].as_str().unwrap_or("");
                let method = args["method"].as_str().unwrap_or("GET");
                let max_bytes = args["maxBytes"].as_u64().unwrap_or(100_000) as usize;

                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(30))
                    .build()
                    .unwrap_or_default();

                let mut req = match method {
                    "POST" => client.post(url),
                    "PUT" => client.put(url),
                    "PATCH" => client.patch(url),
                    "DELETE" => client.delete(url),
                    _ => client.get(url),
                };

                if let Some(headers) = args["headers"].as_object() {
                    for (key, val) in headers {
                        if let Some(v) = val.as_str() {
                            req = req.header(key.as_str(), v);
                        }
                    }
                }

                if method != "GET" {
                    if let Some(body) = args["body"].as_str() {
                        req = req.body(body.to_string());
                    }
                }

                match req.send().await {
                    Ok(resp) => {
                        let status = format!("HTTP {} {}",
                            resp.status().as_u16(),
                            resp.status().canonical_reason().unwrap_or(""));
                        let text = resp.text().await.unwrap_or_default();
                        let truncated = if text.len() > max_bytes {
                            format!("{}\n\n... (truncated)", &text[..max_bytes])
                        } else {
                            text
                        };
                        format!("{status}\n\n{truncated}")
                    }
                    Err(e) => format!("Error: {e}"),
                }
            })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}
```

- [ ] **Step 4: Add think**

Append to `builtins.rs`. Mirrors TS `builtins.ts:320-333`:

```rust
/// Create the think tool (scratchpad for reasoning).
/// Mirrors TS `builtins.ts:320-333`.
pub fn create_think_tool() -> Tool {
    Tool {
        name: "think".into(),
        description: "A scratchpad for reasoning. Use this to think through complex problems step by step before acting. The thought is recorded but not shown to the user.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "thought": { "type": "string", "description": "Your reasoning or analysis" }
            },
            "required": ["thought"]
        }),
        execute: Arc::new(|_args: Value, _ctx| {
            Box::pin(async { "Thought recorded.".to_string() })
        }),
        is_concurrency_safe: Some(Arc::new(|_| true)),
    }
}
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo check -p lumin-core`
Expected: Compiles.

- [ ] **Step 6: Commit**

```bash
cd /Users/prismer/workspace/luminclaw/rust
git add crates/lumin-core/src/tools/builtins.rs
git commit -m "feat(rust): add list_files, grep, web_fetch, think — mirrors TS builtins.ts"
```

---

### Task 8: `memory_tools.rs` + `register_all_builtins()`

Extract memory tools from inline http.rs. Add single registration entry point.
Mirrors TS `index.ts:143-180` for memory tools, `index.ts:95-184` for full registration.

**Files:**
- Create: `rust/crates/lumin-core/src/tools/memory_tools.rs`
- Modify: `rust/crates/lumin-core/src/tools/mod.rs` (add module)
- Modify: `rust/crates/lumin-core/src/tools/builtins.rs` (add `register_all_builtins`)

- [ ] **Step 1: Create memory_tools.rs**

```rust
// crates/lumin-core/src/tools/memory_tools.rs
//! Memory tools — mirrors TS `index.ts:143-180`.

use crate::memory::MemoryStore;
use crate::tools::Tool;
use std::sync::Arc;

/// Create the memory_store tool.
/// Mirrors TS `index.ts:143-161`.
pub fn create_memory_store_tool(workspace_dir: String) -> Tool {
    let wd = workspace_dir;
    Tool {
        name: "memory_store".into(),
        description: "Store a memory entry for later recall. Use to save important facts, decisions, code snippets, or action items.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "The memory content to store" },
                "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional tags for categorization" }
            },
            "required": ["content"]
        }),
        execute: Arc::new(move |args, _ctx| {
            let wd = wd.clone();
            Box::pin(async move {
                let mem = MemoryStore::new(&wd);
                let content = args["content"].as_str().unwrap_or("");
                let tags: Vec<&str> = args["tags"].as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                    .unwrap_or_default();
                match mem.store(content, &tags) {
                    Ok(_) => "Memory stored successfully.".into(),
                    Err(e) => format!("Error: {e}"),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}

/// Create the memory_recall tool.
/// Mirrors TS `index.ts:162-180`.
pub fn create_memory_recall_tool(workspace_dir: String) -> Tool {
    let wd = workspace_dir;
    Tool {
        name: "memory_recall".into(),
        description: "Search stored memories by keywords. Returns relevant past entries sorted by relevance.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Keywords to search for in memories" },
                "maxChars": { "type": "number", "description": "Max characters to return (default: 4000)" }
            },
            "required": ["query"]
        }),
        execute: Arc::new(move |args, _ctx| {
            let wd = wd.clone();
            Box::pin(async move {
                let mem = MemoryStore::new(&wd);
                let query = args["query"].as_str().unwrap_or("");
                let max_chars = args["maxChars"].as_u64().unwrap_or(4000) as usize;
                match mem.recall(query, max_chars) {
                    Some(result) => result,
                    None => "No matching memories found.".into(),
                }
            })
        }),
        is_concurrency_safe: None,
    }
}
```

- [ ] **Step 2: Add module declaration and register_all_builtins**

Add to `tools/mod.rs`:

```rust
pub mod memory_tools;
```

Append to `tools/builtins.rs`:

```rust
/// Register all built-in tools: 7 builtins + bash + memory_store + memory_recall.
/// Single entry point used by both CLI and server — mirrors TS `ensureInitialized()` in `index.ts:62-196`.
pub fn register_all_builtins(registry: &mut ToolRegistry, workspace_dir: &str) {
    let wd = workspace_dir.to_string();
    registry.register(super::create_bash_tool(wd.clone()));
    registry.register(create_read_file_tool(wd.clone()));
    registry.register(create_write_file_tool(wd.clone()));
    registry.register(create_edit_file_tool(wd.clone()));
    registry.register(create_list_files_tool(wd.clone()));
    registry.register(create_grep_tool(wd.clone()));
    registry.register(create_web_fetch_tool());
    registry.register(create_think_tool());
    registry.register(super::memory_tools::create_memory_store_tool(wd.clone()));
    registry.register(super::memory_tools::create_memory_recall_tool(wd));
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo check -p lumin-core`
Expected: Compiles.

- [ ] **Step 4: Commit**

```bash
cd /Users/prismer/workspace/luminclaw/rust
git add crates/lumin-core/src/tools/memory_tools.rs crates/lumin-core/src/tools/builtins.rs crates/lumin-core/src/tools/mod.rs
git commit -m "feat(rust): add memory_tools + register_all_builtins — mirrors TS index.ts"
```

---

### Task 9: Wire builtins into Rust server and CLI

Replace all inline tool registration with `register_all_builtins()`.

**Files:**
- Modify: `rust/crates/lumin-server/src/http.rs`
- Modify: `rust/crates/lumin-server/src/main.rs`

- [ ] **Step 1: Update http.rs — chat handler**

Replace lines 178-237 in `http.rs` (inline bash + memory_store + memory_recall) with:

```rust
    // Set up tools (all builtins — matching TS ensureInitialized)
    let mut tools = ToolRegistry::new();
    lumin_core::tools::builtins::register_all_builtins(&mut tools, &state.config.workspace.dir);
```

- [ ] **Step 2: Update http.rs — list_tools handler**

Replace lines 317-359 with:

```rust
pub async fn list_tools(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let mut tools = ToolRegistry::new();
    lumin_core::tools::builtins::register_all_builtins(&mut tools, &state.config.workspace.dir);
    let specs = tools.get_specs();
    Json(serde_json::json!({ "tools": specs, "count": specs.len() }))
}
```

- [ ] **Step 3: Update http.rs — dual-loop handler**

Replace lines 139-141 (inside tokio::spawn) with:

```rust
                let mut tools = ToolRegistry::new();
                lumin_core::tools::builtins::register_all_builtins(&mut tools, &config.workspace.dir);
```

- [ ] **Step 4: Update main.rs — CLI mode**

Replace line 69 (`tools.register(lumin_core::tools::create_bash_tool(...))`) with:

```rust
            lumin_core::tools::builtins::register_all_builtins(&mut tools, &config.workspace.dir);
```

- [ ] **Step 5: Clean up unused imports**

Remove now-unused imports from `http.rs`: `MemoryStore`, `Tool` (if no longer directly used).

- [ ] **Step 6: Verify full workspace compilation**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo check`
Expected: Compiles.

- [ ] **Step 7: Commit**

```bash
cd /Users/prismer/workspace/luminclaw/rust
git add crates/lumin-server/src/http.rs crates/lumin-server/src/main.rs
git commit -m "refactor(rust): wire register_all_builtins into server + CLI — matches TS"
```

---

### Task 10: Fix all Rust compiler warnings

**Files:**
- Multiple files across both crates

- [ ] **Step 1: Run cargo fix**

```bash
cd /Users/prismer/workspace/luminclaw/rust
cargo fix --allow-dirty --lib -p lumin-core
cargo fix --allow-dirty --bin lumin-server -p lumin-server
```

- [ ] **Step 2: Handle remaining warnings manually**

For dead code like `ArtifactRequest.url`, prefix with `_` or add `#[allow(dead_code)]` with comment.

- [ ] **Step 3: Verify zero warnings**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo check 2>&1 | grep "^warning:"`
Expected: No warning lines.

- [ ] **Step 4: Commit**

```bash
cd /Users/prismer/workspace/luminclaw/rust
git add -A
git commit -m "chore(rust): fix all compiler warnings"
```

---

### Task 11: Integration tests for Rust builtins

**Files:**
- Create: `rust/crates/lumin-core/tests/builtins_integration.rs`

- [ ] **Step 1: Write integration tests**

```rust
// crates/lumin-core/tests/builtins_integration.rs
//! Integration tests for built-in tools — verifies Rust matches TS behavior.

use lumin_core::tools::builtins::*;
use lumin_core::tools::{ToolContext, ToolRegistry};
use tempfile::TempDir;

fn make_ctx(dir: &str) -> ToolContext {
    ToolContext {
        workspace_dir: dir.into(),
        session_id: "test".into(),
        agent_id: "test".into(),
        emit: None,
    }
}

// ── read_file (mirrors TS builtins.ts:34-56) ──

#[tokio::test]
async fn read_file_returns_numbered_lines() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("hello.txt"), "line1\nline2\nline3\n").unwrap();
    let tool = create_read_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"path": "hello.txt"}), &ctx).await;
    assert!(result.contains("1\tline1"));
    assert!(result.contains("2\tline2"));
    assert!(result.contains("3\tline3"));
}

#[tokio::test]
async fn read_file_with_offset_and_limit() {
    let tmp = TempDir::new().unwrap();
    let content: String = (1..=10).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n");
    std::fs::write(tmp.path().join("ten.txt"), &content).unwrap();
    let tool = create_read_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"path": "ten.txt", "offset": 3, "limit": 2}), &ctx).await;
    assert!(result.contains("3\tline3"));
    assert!(result.contains("4\tline4"));
    assert!(!result.contains("5\tline5"));
}

#[tokio::test]
async fn read_file_rejects_path_traversal() {
    let tmp = TempDir::new().unwrap();
    let tool = create_read_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"path": "../../../etc/passwd"}), &ctx).await;
    assert!(result.contains("traversal"));
}

// ── write_file (mirrors TS builtins.ts:60-78) ──

#[tokio::test]
async fn write_file_creates_file_and_dirs() {
    let tmp = TempDir::new().unwrap();
    let tool = create_write_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({"path": "sub/dir/test.txt", "content": "hello world"}),
        &ctx,
    ).await;
    assert!(result.contains("Wrote 11 bytes"));
    assert_eq!(std::fs::read_to_string(tmp.path().join("sub/dir/test.txt")).unwrap(), "hello world");
}

// ── edit_file (mirrors TS builtins.ts:149-190) ──

#[tokio::test]
async fn edit_file_replaces_unique_string() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("code.py"), "def fib(n):\n    return n\n").unwrap();
    let tool = create_edit_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({
            "path": "code.py",
            "old_string": "return n",
            "new_string": "return fib(n-1) + fib(n-2) if n > 1 else n"
        }),
        &ctx,
    ).await;
    assert!(result.contains("Replaced 1"));
    let content = std::fs::read_to_string(tmp.path().join("code.py")).unwrap();
    assert!(content.contains("fib(n-1)"));
}

#[tokio::test]
async fn edit_file_rejects_ambiguous_match() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("dup.txt"), "foo bar foo baz foo").unwrap();
    let tool = create_edit_file_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(
        serde_json::json!({"path": "dup.txt", "old_string": "foo", "new_string": "qux"}),
        &ctx,
    ).await;
    assert!(result.contains("3 times"));
}

// ── list_files (mirrors TS builtins.ts:119-145) ──

#[tokio::test]
async fn list_files_finds_files() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("a.rs"), "").unwrap();
    std::fs::create_dir_all(tmp.path().join("src")).unwrap();
    std::fs::write(tmp.path().join("src/b.rs"), "").unwrap();
    let tool = create_list_files_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({}), &ctx).await;
    assert!(result.contains("a.rs"));
    assert!(result.contains("src/"));
}

// ── grep (mirrors TS builtins.ts:233-278) ──

#[tokio::test]
async fn grep_finds_matching_lines() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("code.py"), "def hello():\n    pass\ndef world():\n    pass\n").unwrap();
    let tool = create_grep_tool(tmp.path().to_string_lossy().to_string());
    let ctx = make_ctx(&tmp.path().to_string_lossy());
    let result = (tool.execute)(serde_json::json!({"pattern": "def "}), &ctx).await;
    assert!(result.contains("code.py:1"));
    assert!(result.contains("def hello()"));
    assert!(result.contains("code.py:3"));
    assert!(result.contains("def world()"));
}

// ── think (mirrors TS builtins.ts:320-333) ──

#[tokio::test]
async fn think_returns_recorded() {
    let tool = create_think_tool();
    let ctx = make_ctx("/tmp");
    let result = (tool.execute)(serde_json::json!({"thought": "test reasoning"}), &ctx).await;
    assert_eq!(result, "Thought recorded.");
}

// ── web_fetch (network required) ──

#[tokio::test]
async fn web_fetch_gets_httpbin_json() {
    let tool = create_web_fetch_tool();
    let ctx = make_ctx("/tmp");
    let result = (tool.execute)(serde_json::json!({"url": "https://httpbin.org/json"}), &ctx).await;
    assert!(result.contains("HTTP 200"), "got: {result}");
    assert!(result.contains("slideshow"), "got: {result}");
}

// ── register_all_builtins ──

#[test]
fn register_all_builtins_registers_10_tools() {
    let mut registry = ToolRegistry::new();
    register_all_builtins(&mut registry, "/tmp/workspace");
    assert_eq!(registry.size(), 10);
    assert!(registry.has("bash"));
    assert!(registry.has("read_file"));
    assert!(registry.has("write_file"));
    assert!(registry.has("edit_file"));
    assert!(registry.has("list_files"));
    assert!(registry.has("grep"));
    assert!(registry.has("web_fetch"));
    assert!(registry.has("think"));
    assert!(registry.has("memory_store"));
    assert!(registry.has("memory_recall"));
}
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/prismer/workspace/luminclaw/rust && cargo test -p lumin-core --test builtins_integration`
Expected: All 12 tests PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/prismer/workspace/luminclaw/rust
git add crates/lumin-core/tests/builtins_integration.rs
git commit -m "test(rust): integration tests for all builtins — verifies TS behavior parity"
```

---

## Phase 3: End-to-End Verification

---

### Task 12: MVP benchmark script

Manual verification aid for T1–T5 against a running LLM.

**Files:**
- Create: `tests/benchmark/run_mvp.sh`

- [ ] **Step 1: Create benchmark script**

```bash
#!/usr/bin/env bash
# MVP Benchmark — 5 tasks to verify agent tool completeness.
# Tests both TS and Rust servers (configurable via BASE_URL).
#
# Usage: ./tests/benchmark/run_mvp.sh [base_url]
#   default: http://localhost:3001

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
PASS=0
FAIL=0
RESULTS=()

send_chat() {
    local msg="$1"
    local session="${2:-bench-$(date +%s)}"
    curl -s -X POST "${BASE_URL}/v1/chat" \
        -H "Content-Type: application/json" \
        -d "{\"content\": \"${msg}\", \"session_id\": \"${session}\"}" \
        2>/dev/null
}

check() {
    local name="$1" condition="$2"
    if eval "$condition"; then
        echo "  ✓ ${name}"
        PASS=$((PASS+1))
        RESULTS+=("PASS: ${name}")
    else
        echo "  ✗ ${name}"
        FAIL=$((FAIL+1))
        RESULTS+=("FAIL: ${name}")
    fi
}

echo "═══════════════════════════════════════════════"
echo "  MVP Benchmark — luminclaw"
echo "  Target: ${BASE_URL}"
echo "═══════════════════════════════════════════════"

# Pre-check
echo ""
echo "→ Pre-check: /health"
HEALTH=$(curl -s "${BASE_URL}/health")
check "server is running" 'echo "$HEALTH" | grep -q "ok"'

echo "→ Pre-check: /v1/tools"
TOOLS=$(curl -s "${BASE_URL}/v1/tools")
TOOL_COUNT=$(echo "$TOOLS" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])" 2>/dev/null || echo "0")
check ">=10 tools registered (got ${TOOL_COUNT})" '[ "$TOOL_COUNT" -ge 10 ]'

echo ""
echo "─── T1: Create Python project ───"
rm -rf /tmp/bench/
SESSION="bench-t1-$(date +%s)"
RESP=$(send_chat "在 /tmp/bench/ 下创建一个 Python 项目，包含 main.py 和 test_main.py，main.py 实现 fibonacci 函数，test 要通过。创建完后用 bash 运行 python -m pytest /tmp/bench/test_main.py -v" "$SESSION")
echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('response','')[:200])" 2>/dev/null || true
check "main.py exists" '[ -f /tmp/bench/main.py ]'
check "test_main.py exists" '[ -f /tmp/bench/test_main.py ]'
check "pytest passes" 'python3 -m pytest /tmp/bench/test_main.py -v 2>/dev/null'

echo ""
echo "─── T2: Read + Edit file ───"
SESSION="bench-t2-$(date +%s)"
RESP=$(send_chat "读取 /tmp/bench/main.py，把 fibonacci 改成迭代实现，保留测试不变。改完之后用 bash 跑 python -m pytest /tmp/bench/test_main.py -v 确认测试通过" "$SESSION")
echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('response','')[:200])" 2>/dev/null || true
check "main.py was modified" 'grep -qE "for|while|iterative|loop" /tmp/bench/main.py 2>/dev/null'
check "pytest still passes" 'python3 -m pytest /tmp/bench/test_main.py -v 2>/dev/null'

echo ""
echo "─── T3: Grep for functions ───"
SESSION="bench-t3-$(date +%s)"
RESP=$(send_chat "在 /tmp/bench/ 中搜索所有包含 'def ' 的文件，列出函数名" "$SESSION")
RESP_TEXT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('response',''))" 2>/dev/null || echo "")
check "found function names" 'echo "$RESP_TEXT" | grep -qi "fib\|test"'

echo ""
echo "─── T4: Fetch URL ───"
SESSION="bench-t4-$(date +%s)"
RESP=$(send_chat "获取 https://httpbin.org/json 的内容，提取 slideshow.title 的值" "$SESSION")
RESP_TEXT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('response',''))" 2>/dev/null || echo "")
check "extracted slideshow title" 'echo "$RESP_TEXT" | grep -qi "sample\|slideshow"'

echo ""
echo "─── T5: Memory store + recall ───"
SESSION="bench-t5-$(date +%s)"
send_chat "记住我叫张三" "$SESSION" > /dev/null
RESP=$(send_chat "回忆我的名字" "$SESSION")
RESP_TEXT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('response',''))" 2>/dev/null || echo "")
check "recalled name" 'echo "$RESP_TEXT" | grep -q "张三"'

echo ""
echo "═══════════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "═══════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
exit $FAIL
```

- [ ] **Step 2: Make executable and commit**

```bash
mkdir -p tests/benchmark
chmod +x tests/benchmark/run_mvp.sh
git add tests/benchmark/run_mvp.sh
git commit -m "test: add MVP benchmark script for T1-T5 (works with both TS and Rust)"
```

---

### Task 13: Full verification

- [ ] **Step 1: TS — compile and test**

```bash
cd /Users/prismer/workspace/luminclaw && npx tsc && npm test
```

Expected: All tests pass.

- [ ] **Step 2: Rust — clean build, zero warnings**

```bash
cd /Users/prismer/workspace/luminclaw/rust && cargo build 2>&1
```

Expected: Zero warnings.

- [ ] **Step 3: Rust — all tests pass**

```bash
cd /Users/prismer/workspace/luminclaw/rust && cargo test
```

Expected: All tests pass (existing ~584 + new 12 + 5 safe_path = ~601).

- [ ] **Step 4: Parity check — /v1/tools**

Start both servers and compare:

```bash
# TS server
cd /Users/prismer/workspace/luminclaw && node dist/cli.js serve --port 3001 &
TS_PID=$!
sleep 2

# Rust server
cd /Users/prismer/workspace/luminclaw/rust && cargo run --bin lumin-server -- serve --port 3002 &
RS_PID=$!
sleep 2

echo "=== TS tools ==="
curl -s http://localhost:3001/v1/tools | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'Count: {d[\"count\"]}')
for t in sorted(d['tools'], key=lambda x: x['function']['name']):
    print(f'  - {t[\"function\"][\"name\"]}')"

echo "=== Rust tools ==="
curl -s http://localhost:3002/v1/tools | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'Count: {d[\"count\"]}')
for t in sorted(d['tools'], key=lambda x: x['function']['name']):
    print(f'  - {t[\"function\"][\"name\"]}')"

kill $TS_PID $RS_PID
```

Expected: Both list the same 10 core tools (TS may have additional workspace/clawhub tools).

---

## Summary

| Phase | Tasks | What |
|---|---|---|
| **Phase 1: Fix TS** | 1–3 | Export `getToolSpecs()`, fix `/v1/tools` endpoint, add test |
| **Phase 2: Align Rust** | 4–11 | Module restructure, safe_path, 7 builtins, memory extraction, server wiring, warnings, tests |
| **Phase 3: Verify** | 12–13 | MVP benchmark script, full parity check |

| Metric | Before | After |
|---|---|---|
| TS `/v1/tools` count | 1 (bash only) | 11 (all builtins + memory + clawhub) |
| Rust `/v1/tools` count | 3 | 10 |
| Rust compiler warnings | 13 | 0 |
| Rust test count | 584 | **616** (581 unit + 28 integration + 7 registration) |
| TS test count (new) | 0 | **42** (20 server + 21 schema + 1 tools) |
| Feature parity | 7 tools missing in Rust | **Full parity** (10/10 schema match) |

---

## Closure: MVP Benchmark Results (2026-04-12)

### LLM: deepseek-ai/gpt-oss-120b via OpenAI-compatible endpoint

### Rust Server (v0.1.0-rust) — T1 through T5

| Task | Description | Tools Used | Iterations | Duration | Result |
|---|---|---|---|---|---|
| **T1** | Create Python fibonacci + tests | write_file, edit_file, bash | 6 | 8,166ms | **PASS** — 3 pytest assertions pass |
| **T2** | Read + edit to iterative + verify | read_file, edit_file, bash | — | — | **PASS** — iterative impl, 3 tests pass |
| **T3** | Grep for function definitions | grep | 2 | 1,495ms | **PASS** — found 4 functions (fibonacci, test_fibonacci_base_cases, test_fibonacci_sequence, test_fibonacci_negative) |
| **T4** | Fetch URL + extract JSON | web_fetch | 2 | 2,542ms | **PASS** — extracted `"Sample Slide Show"` |
| **T5** | Memory store + recall (multi-turn) | memory_store, memory_recall | — | ~2,500ms | **PASS** — recalled `张三` across turns |

### TS Server (v0.3.1) — T1 through T5

| Task | Result |
|---|---|
| **T1** | **PASS** — 3 pytest pass |
| **T2** | **PASS** — 3 pytest pass |
| **T3** | **PASS** — function names listed |
| **T4** | **PASS** — slideshow title extracted |
| **T5** | **PASS** — `张三` recalled |

### Parity Conclusion

Both runtimes pass all 5 MVP benchmark tasks using the same LLM. Rust achieves functional equivalence with TS for all 10 built-in tools.

### Post-implementation Review Findings

| Category | Finding | Status |
|---|---|---|
| **Critical** | ws.rs / loop_single / loop_dual only registered bash | **Fixed** (commit `32903eb`) |
| **Schema** | Rust bash missing `timeout` param | **Fixed** (commit `3dda621`) |
| **Known limitation** | safe_path doesn't resolve symlinks | Matches TS behavior — accepted |
| **Known limitation** | grep/list_files use blocking I/O in async | Matches TS behavior — future optimization |
| **Out of scope** | clawhub tool not ported to Rust | Separate feature work |

### Commit Log (16 commits)

```
3dda621 fix(rust): align bash tool schema with TS — add timeout parameter
c232936 test(rust): boundary tests — edit replace_all, glob filters, error cases, memory roundtrip
9e9ed2b test(rust): tool registration + schema canonical verification
d48429f test: TS tool schema canonical verification — 10 tools
32903eb fix(rust): wire register_all_builtins into ws.rs + loop_single + loop_dual
b26d343 test: add MVP benchmark script for T1-T5 (works with both TS and Rust)
5b16517 test(rust): integration tests for all builtins — verifies TS behavior parity
5933d26 chore(rust): fix all compiler warnings
e09dc0f refactor(rust): wire register_all_builtins into server + CLI — matches TS
0513b64 feat(rust): add memory_tools + register_all_builtins — mirrors TS index.ts
6525c2c feat(rust): add list_files, grep, web_fetch, think — mirrors TS builtins.ts
7b56741 feat(rust): add read_file, write_file, edit_file — mirrors TS builtins.ts
335743d feat(rust): add safe_path — mirrors TS safePath()
3270d71 refactor(rust): move tools.rs to tools/mod.rs — mirrors TS tools/ dir
211e060 test(server): verify /v1/tools returns complete tool list
72123d6 fix(server): /v1/tools returns all registered tools via shared registry
```

**Plan status: CLOSED** ✅
