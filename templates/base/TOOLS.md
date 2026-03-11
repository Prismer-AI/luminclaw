# TOOLS

> **Plugin Version:** 0.10.0 | **Total Tools:** 39

## Available Workspace Tools

### LaTeX Project
- **latex_project**: Manage multi-file LaTeX projects — list, read, write, delete files
- **latex_project_compile**: Compile LaTeX project to PDF (auto-switches to LaTeX editor)

### Jupyter (PREFERRED for Python + Visualization)
- **jupyter_execute**: Execute Python code in Jupyter kernel (auto-switches to Jupyter). **ALWAYS use this for matplotlib/seaborn/plotly plots, pandas, numpy, data analysis, and ML experiments.** Jupyter captures rich outputs (images, HTML, tables). After plotting, call `update_gallery` with the base64 image to save to gallery.
- **jupyter_notebook**: Create, read, update, delete, or list notebooks
- **update_notebook**: Add or update notebook cells without executing (auto-switches)

### PDF
- **load_pdf**: Load PDF document in viewer (auto-switches to PDF reader)
- **navigate_pdf**: Navigate PDF reader to specific page or region

### Notes
- **update_notes**: Update Notes editor with Markdown content (auto-switches). Writes to `/workspace/notes/` and syncs to frontend. Supports `mode: "replace"` (default) or `"append"`, and optional `path` for multi-note workflows.
- **list_notes**: List all notes in `/workspace/notes/` with metadata (path, title, size, last modified)
- **get_note_index**: Get heading structure (TOC) of a note file
- **insert_note_image**: Append a markdown image reference to the current note

### Research (Cloud SDK — pre-configured, no API key needed)
- **context_search**: Semantic web search via Prismer Cloud SDK (HQCC compressed, cached results free). **This is your primary search tool.**
- **context_load**: Load URL content via Prismer Cloud SDK. Use when you have a specific URL. Cached content is free.
- **arxiv_to_prompt**: Convert arXiv paper to LLM-readable text
- **get_paper_context**: Get context from loaded papers (metadata, summary, full text)

> **IMPORTANT: Do NOT use OpenClaw built-in `web_search` — it requires a Brave API key which is not configured. Always use `context_search` for web search and `context_load` for URL content retrieval. These are pre-configured and work out of the box.**
>
> Full Cloud SDK documentation: https://prismer.cloud/docs/Skill.md

### Browser
- **browser_open**: Open a URL in the agent browser (auto-switches, returns screenshot)
- **browser_navigate**: Navigate browser to a different URL
- **browser_click**: Click an element by CSS selector
- **browser_fill**: Fill a form input with text
- **browser_snapshot**: Take a screenshot of current page
- **browser_get_text**: Get text content from page or element
- **browser_close**: Close the browser session

### Gallery
- **update_gallery**: Add images to the workspace gallery (auto-switches, auto-persisted)

### Code (Terminal-only, NO image output)
- **code_execute**: Execute Python/Node.js in container terminal — text output ONLY, no image/plot support. Use for shell scripts, file operations, CLI tools. **Do NOT use for plotting — use jupyter_execute instead.**
- **update_code**: Push source files to the Code Playground editor (auto-switches)

### Data Analysis
- **data_list**: List available data files in workspace
- **data_load**: Load CSV/XLSX/JSON/Parquet/TSV into AG Grid viewer (auto-switches)
- **data_query**: Filter or query data in grid using Pandas code
- **data_save**: Save current DataFrame to a workspace file

### File Access
- **read_workspace_file**: Read a file from /workspace/ (supports utf-8 and base64 encoding)
- **list_workspace_uploads**: List user-uploaded files in workspace

### Workspace Awareness
- **get_workspace_state**: Get current workspace state (files, editors, tasks, activity). **Always call before starting complex tasks.**

### Task & Progress Management
- **update_task**: Create or update a single task in the Task Panel
- **update_tasks**: Batch create/update multiple tasks — **preferred for multi-step workflows**
- **update_operation_status**: Report progress of long-running operations (progress bar on active component)

### User Interaction
- **request_action**: Present interactive choices (button groups, choice cards) via chat
- **request_user_confirmation**: Pause and ask user a question (confirm/choice/input)

### UI Control
- **switch_component**: Switch active workspace component
- **send_ui_directive**: Send raw UI directive for advanced control

## Tool Usage Guidelines

### Communication Principle — Chat vs Notes

**Chat messages are for conclusions. Notes are for details.**

- **Chat panel**: Keep messages short and conclusive — results, summaries, confirmations, questions. Think of chat as a status channel.
- **Notes (`update_notes`)**: Use for any substantial content — research findings, detailed analysis, step-by-step explanations, long-form writing, structured data, reference material.

**Rule of thumb:** If your response would exceed 3-4 short paragraphs, write it to Notes instead and reply in chat with a brief summary pointing to the note.

**Long-running tasks:** Use Tasks + Notes together — Tasks track progress, Notes hold the content.
1. **Plan**: Create task cards via `update_tasks` with the step breakdown, and write the outline/skeleton to Notes via `update_notes`.
2. **Execute**: For each step, update the task card status/progress (`update_task`) AND fill in the corresponding Notes section (`update_notes`).
3. **Chat = status only**: Brief progress in chat — "Step 2/5 done, moving to data analysis..."

The user sees task progress in the Task Panel and detailed output in Notes simultaneously.

**Examples:**
| User request | Chat response | Notes action |
|---|---|---|
| "Search for AI agent frameworks" | "Found 5 major frameworks — details written to Notes." | `update_notes` with full comparison table, pros/cons, links |
| "Summarize this paper" | "Key finding: X improves Y by 30%. Full summary in Notes." | `update_notes` with structured summary, methodology, results |
| "What's 2+2?" | "4" | — (no notes needed) |
| "Draft a project proposal" | "Proposal drafted in Notes — review and edit as needed." | `update_notes` with the full proposal |
| "Explain how transformers work" | "Explanation written to Notes." | `update_notes` with detailed explanation, diagrams, formulas |

### Auto-Switch Behavior
Tools marked "auto-switches" automatically change the active workspace view. No need to call `switch_component` separately.

### Best Practices
1. **Call `get_workspace_state` first** — understand what files exist and which editor is active before acting
2. **Plan multi-step workflows** — use `update_tasks` at the start to create a visible task plan
3. **Report progress** — use `update_operation_status` during compilation, execution, and other long operations
4. **LaTeX workflow**: Use `latex_project` to write files → `latex_project_compile` to compile
5. **Jupyter workflow**: Use `update_notebook` to set up cells → `jupyter_execute` to run code
6. **Notes workflow**: Use `update_notes` with `mode: "append"` to add content without overwriting
7. **Data workflow**: Use `data_load` → `data_query` → `data_save` for analysis pipelines
8. **Error recovery**: When compilation/execution fails, report error via `update_operation_status`, fix the issue, and retry
9. Files are automatically persisted — no manual sync needed

### Research Strategy — Web Content Retrieval

> **CRITICAL: NEVER use `web_search` (OpenClaw built-in). It requires a Brave API key which is NOT configured. Use `context_search` instead — it is pre-configured via Prismer Cloud SDK.**

**Priority order for fetching web content:**

1. **`context_search`** (ALWAYS USE FIRST) — Semantic web search via Prismer Cloud SDK. Returns HQCC-compressed, LLM-optimized content. Fast, cached results are free. No API key needed.
2. **`context_load`** (For specific URLs) — Load URL content via Cloud SDK. Cached content is free. No API key needed.
3. **`browser_open` + `browser_get_text`** (Last resort) — Open URL in agent browser and extract text. Use ONLY when context tools return errors. Browser is slower.

**When to use which:**
- Need to research a topic? → `context_search` first
- Have a specific URL to read? → `context_load` first
- `context_search`/`context_load` returned an error? → Fall back to `browser_open` + `browser_get_text`
- Need to interact with a webpage (click, fill forms)? → `browser_open` + `browser_click`/`browser_fill` (context tools are read-only)

**Do NOT use browser for simple content retrieval when context tools are available.**
**Do NOT use `web_search` — it will fail. Use `context_search` instead.**

Cloud SDK documentation: https://prismer.cloud/docs/Skill.md

### Error Recovery — Jupyter vs Code Playground

When `jupyter_execute` returns an error:

| Error Code | Meaning | Action |
|---|---|---|
| `JUPYTER_UNREACHABLE` | Jupyter not running | Retry once after 3s. Fall back to `code_execute` for non-visualization only. |
| `CONNECTION_FAILED` | Container network issue | Check container. Do not retry. |
| `REQUEST_TIMEOUT` | Execution too slow | Simplify code. Retry with simpler version. |
| `EXECUTION_ERROR` | Python syntax/runtime error | Fix code and retry `jupyter_execute`. Do NOT fall back. |
| `OPERATION_FAILED` | Jupyter returned failure | Check error details. Retry once. |

**Golden rule:** For plotting/visualization tasks, ALWAYS retry `jupyter_execute` before considering `code_execute`. Code Playground cannot capture images.

### Visualization & Plotting — CRITICAL Routing Rule
**ALWAYS use `jupyter_execute` for ANY task involving charts, plots, figures, images, 绘图, 可视化, 图表.** Never use `code_execute` for visualization — it only captures terminal text, not images. When the user says "绘制/画/绘图/plot/draw/visualize", always route to `jupyter_execute`.

**Correct workflow for "plot X and save to gallery":**
```
1. jupyter_execute  →  Python code with matplotlib/seaborn/plotly
2. Read base64 image from Jupyter cell output (image/png in outputs)
3. update_gallery   →  { images: [{ title, url: "data:image/png;base64,..." }] }
```

**Wrong workflow (DO NOT do this):**
```
❌ code_execute → matplotlib → plt.savefig() → image lost (terminal can't display images)
```
