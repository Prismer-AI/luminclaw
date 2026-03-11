/**
 * Agent Registry — multi-agent definitions with academic specializations.
 *
 * The {@link AgentRegistry} stores {@link AgentConfig} entries for the
 * primary research assistant and its delegatable sub-agents (LaTeX,
 * data analysis, literature scout). Hidden agents (compaction,
 * summarizer) are used internally and not exposed via `@mention`.
 *
 * {@link BUILTIN_AGENTS} provides the default 6-agent configuration.
 *
 * @module agents
 */

// ── Types ────────────────────────────────────────────────

export type AgentMode = 'primary' | 'subagent' | 'hidden';

export interface AgentPermission {
  permission: 'read' | 'write' | 'execute' | 'bash';
  pattern: string;   // glob pattern
  action: 'allow' | 'deny';
}

export interface AgentConfig {
  id: string;
  name: string;
  mode: AgentMode;
  systemPrompt: string;
  model?: string;                      // Override default model
  tools?: string[] | null;             // null = all tools
  permissions?: AgentPermission[];
  maxIterations?: number;              // Override default 40
}

// ── Registry ─────────────────────────────────────────────

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();

  register(config: AgentConfig): void {
    this.agents.set(config.id, config);
  }

  registerMany(configs: AgentConfig[]): void {
    for (const c of configs) {
      this.register(c);
    }
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  list(mode?: AgentMode): AgentConfig[] {
    const all = Array.from(this.agents.values());
    return mode ? all.filter(a => a.mode === mode) : all;
  }

  /** Parse @-mention from user input: "@latex-expert compile this" */
  resolveFromMention(content: string): { agentId: string; message: string } | null {
    const match = content.match(/^@([\w-]+)\s+([\s\S]+)/);
    if (!match) return null;

    const agentId = match[1];
    const agent = this.agents.get(agentId);
    if (!agent || agent.mode === 'hidden') return null;

    return { agentId, message: match[2] };
  }

  /** Get sub-agent IDs for the delegate tool enum */
  getDelegatableAgents(): string[] {
    return this.list('subagent').map(a => a.id);
  }
}

// ── Built-in Academic Agents ─────────────────────────────

export const BUILTIN_AGENTS: AgentConfig[] = [
  {
    id: 'researcher',
    name: 'Research Assistant',
    mode: 'primary',
    systemPrompt: `You are a Prismer research assistant — an AI-powered academic research companion.
You help researchers with paper discovery, reading, data analysis, writing, and peer review.
You have access to specialized sub-agents that you can delegate tasks to:
- @latex-expert: LaTeX document writing and compilation
- @data-analyst: Jupyter notebooks, data analysis, and visualization
- @literature-scout: Paper search, PDF reading, and literature review

When a task clearly falls within a sub-agent's expertise, use the "delegate" tool to hand it off.
For general questions, answer directly.

Always be precise, cite sources when available, and prefer reproducible methods.`,
    tools: null, // All tools
    maxIterations: 40,
  },

  {
    id: 'latex-expert',
    name: 'LaTeX Expert',
    mode: 'subagent',
    systemPrompt: `You are a LaTeX expert specializing in academic paper writing.
You can compile LaTeX documents, manage project files, and help with formatting.
Supported templates: CVPR, NeurIPS, ICML, ACL, IEEE, arXiv.
Always validate LaTeX syntax before compilation.
Use switch_component to show the latex-editor when working on documents.`,
    tools: ['latex_compile', 'latex_project', 'switch_component', 'update_content', 'bash'],
    maxIterations: 20,
  },

  {
    id: 'data-analyst',
    name: 'Data Analyst',
    mode: 'subagent',
    systemPrompt: `You are a data analyst specializing in scientific computing and visualization.
You can execute Jupyter notebook cells, create plots, and analyze datasets.
Preferred libraries: numpy, pandas, matplotlib, seaborn, scipy, scikit-learn.
Use switch_component to show the jupyter-notebook when working with code.
Always include clear axis labels and titles in plots.`,
    tools: ['jupyter_execute', 'jupyter_notebook', 'switch_component', 'update_content', 'bash'],
    maxIterations: 20,
  },

  {
    id: 'literature-scout',
    name: 'Literature Scout',
    mode: 'subagent',
    systemPrompt: `You are a literature scout specializing in academic paper discovery and analysis.
You can search arXiv, load PDFs, and extract key information from papers.
When summarizing papers, include: title, authors, year, key contributions, methodology, and results.
Organize literature reviews by theme, not chronologically.`,
    tools: ['arxiv_search', 'load_pdf', 'context_search', 'switch_component', 'bash'],
    maxIterations: 15,
  },

  {
    id: 'compaction',
    name: 'Compaction Agent',
    mode: 'hidden',
    systemPrompt: `Summarize the following conversation into key facts and decisions.
Be concise. Preserve: important findings, code snippets, file paths, decisions made, and action items.
Output as a structured markdown summary.`,
    tools: [],
    maxIterations: 1,
  },

  {
    id: 'summarizer',
    name: 'Title Summarizer',
    mode: 'hidden',
    systemPrompt: `Generate a concise title (5-10 words) for this conversation.
The title should capture the main topic or goal. Output only the title, nothing else.`,
    tools: [],
    maxIterations: 1,
  },
];
