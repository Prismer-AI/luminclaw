# Lite Mode — Available Tools

> **Mode:** Lite | **Plugin Version:** 0.10.0 | **Total Tools:** 23
>
> You are running in **Lite Mode**. Only Notes, Browser, Tasks, and Context tools are available.
> Do NOT attempt to use LaTeX, Jupyter, PDF, Code Playground, Data Grid, or Gallery tools — they are not registered.

## Notes Tools (PRIMARY)

### update_notes
Update the Notes editor (ai-editor) with **Markdown** content. Auto-switches to Notes.

**Parameters:**
- `content` (required): Markdown content string. **ALWAYS use Markdown syntax** (headings with `#`, lists with `-`, bold with `**`). Never use raw HTML tags — they will render as literal text.
- `mode` (optional): "replace" (default) | "append" — Use `append` to add content without overwriting user edits

**Examples:**
```
update_notes({ content: "# Research Notes\n\n## Key Findings\n- Finding 1\n- Finding 2" })
update_notes({ content: "\n## New Section\nAdded content", mode: "append" })
```

### list_notes
List all notes in the workspace with metadata (path, title, size, last modified). Notes are markdown files in `/workspace/notes/`.

**Parameters:**
- `pattern` (optional): Glob pattern to filter notes (default: "*.md")

**Example:**
```
list_notes({})
list_notes({ pattern: "research*" })
```

### get_note_index
Get the heading structure (table of contents) of a note. Returns all markdown headings with their levels and line numbers.

**Parameters:**
- `path` (required): Note file path relative to /workspace/notes/ (e.g., "research.md")

**Example:**
```
get_note_index({ path: "research.md" })
```

### insert_note_image
Insert an image reference into the current note. Appends a markdown image tag at the end of the note content.

**Parameters:**
- `imageUrl` (required): URL or relative path of the image
- `altText` (optional): Alt text for the image (default: "image")
- `caption` (optional): Optional caption below the image

**Example:**
```
insert_note_image({ imageUrl: "uploads/chart.png", altText: "Results chart", caption: "Figure 1: Experimental results" })
```

## Browser Tools

### browser_open
Open a URL in the agent browser. Returns a screenshot of the page.

**Parameters:**
- `url` (required): The URL to navigate to

### browser_navigate
Navigate the browser to a different URL.

**Parameters:**
- `url` (required): The URL to navigate to

### browser_click
Click an element on the page.

**Parameters:**
- `selector` (required): CSS selector of the element to click

### browser_fill
Fill a form input with text.

**Parameters:**
- `selector` (required): CSS selector of the input element
- `value` (required): Text to fill in

### browser_snapshot
Take a screenshot of the current browser page.

**No parameters required.**

### browser_get_text
Get text content from the page or a specific element.

**Parameters:**
- `selector` (optional): CSS selector (default: full page text)

### browser_close
Close the browser session.

**No parameters required.**

## Context & Research Tools

### context_search
Semantic web search via Cloud SDK (HQCC compression).

**Parameters:**
- `query` (required): Search query string

### context_load
Load URL content via Cloud SDK (cached, HQCC format).

**Parameters:**
- `url` (required): URL to load
- `format` (optional): "text" | "markdown" | "json"

## File Access Tools

### read_workspace_file
Read a file from the workspace. When users attach files in chat, they are synced to `/workspace/uploads/{filename}`. Use `list_workspace_uploads` first to discover available files.

**Parameters:**
- `path` (required): Relative path from /workspace/ (e.g. "uploads/data.csv")
- `encoding` (optional): "utf-8" (default) or "base64" for binary files
- `maxBytes` (optional): Max file size in bytes (default: 1MB)

### list_workspace_uploads
List all user-uploaded files in the workspace. Returns paths, sizes, and modification dates.

**No parameters required.**

## Workspace Awareness

### get_workspace_state
Get current workspace state including files, editors, tasks, and recent activity.
**Always call this before starting a complex task** to understand what the user is working on.

**Parameters:**
- `include` (optional): Array of sections to include. Options: `files`, `editors`, `tasks`, `messages`, `timeline`. Default: all.

**Example:**
```
get_workspace_state({})
get_workspace_state({ include: ["files", "editors"] })
```

## Task & Progress Management

### update_task
Create or update a single task in the Task Panel.

**Parameters:**
- `id` (optional): Task ID. Auto-generated if omitted. Reuse to update existing tasks.
- `title` (required): Short task title
- `status` (required): "pending" | "running" | "completed" | "error"
- `description` (optional): Longer description
- `progress` (optional): 0-100 percentage
- `subtasks` (optional): Array of `{id, title, status}` for sub-steps

### update_tasks
Create or update multiple tasks at once. **Preferred for multi-step workflows.**

**Parameters:**
- `tasks` (required): Array of task objects, each with `{id, title, status, progress?, description?, subtasks?}`

### update_operation_status
Report the progress of a long-running operation. Shows a progress bar on the active component.

**Parameters:**
- `component` (required): Target component ("ai-editor" or "agent-browser")
- `operation` (required): Operation name
- `status` (required): "running" | "completed" | "error"
- `progress` (optional): Completion percentage (0-100)
- `message` (optional): Human-readable status message

## User Interaction Tools

### request_action
Present interactive choices to the user via the chat ActionBar.

**Parameters:**
- `messageId` (optional): Attach to an existing chat message
- `components` (required): Array of interactive UI components

**Supported component types:**
- `button-group`: Row of action buttons with `{id, label, variant}`
- `choice-card`: Card with title and selectable options `{id, label, description}`

### request_user_confirmation
Pause execution and ask the user a question. The agent waits for the user's response before continuing.

**Parameters:**
- `prompt` (required): Question or description for the user
- `confirmationType` (required): "confirm" | "choice" | "input"
- `options` (optional): Array of `{id, label}` for choice type

## UI Control Tools

### switch_component
Switch the active workspace component. **In Lite Mode, only two components are available.**

**Parameters:**
- `component` (required): Target component name
  - **ai-editor** — Notes editor
  - **agent-browser** — Web browser
- `data` (optional): Initial data for component

### send_ui_directive
Send a raw UI directive for advanced control. Prefer dedicated tools above.

**Parameters:**
- `type` (required): Directive type
- `payload` (required): Directive payload object

**Available directives in Lite Mode:**
- SWITCH_COMPONENT — Switch to ai-editor or agent-browser
- UPDATE_NOTES — Update Notes editor (`{content, mode}`)
- SHOW_NOTIFICATION — Show notification (`{title, message, type}`)
- TASK_UPDATE — Create/update tasks
- UPDATE_TASKS — Batch update tasks
- OPERATION_STATUS — Report progress

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

### Best Practices
1. **Call `get_workspace_state` first** — understand what files exist and which editor is active before acting
2. **Plan multi-step workflows** — use `update_tasks` at the start to create a visible task plan
3. **Report progress** — use `update_operation_status` during long operations
4. **Notes workflow**: Use `update_notes` with `mode: "append"` to add content without overwriting
5. **Research workflow**: Use `context_search` to find sources → `context_load` to read them → `update_notes` to write findings
6. **Browser workflow**: Use `browser_open` to visit pages → `browser_get_text` to extract content → `update_notes` to save findings
7. Files are automatically persisted — no manual sync needed

### Unavailable Tools (Lite Mode)
The following tools are NOT available in Lite Mode. Do not attempt to use them:
- ~~latex_project~~, ~~latex_project_compile~~ (LaTeX)
- ~~jupyter_execute~~, ~~jupyter_notebook~~, ~~update_notebook~~ (Jupyter)
- ~~load_pdf~~, ~~navigate_pdf~~, ~~get_paper_context~~, ~~arxiv_to_prompt~~ (PDF/arXiv)
- ~~code_execute~~, ~~update_code~~, ~~preview_html~~, ~~configure_code_playground~~ (Code)
- ~~data_list~~, ~~data_load~~, ~~data_query~~, ~~data_save~~ (Data)
- ~~update_gallery~~ (Gallery)
