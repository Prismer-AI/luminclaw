/**
 * PromptBuilder — dynamic system prompt assembly from composable sections
 *
 * Replaces static prompts in agents.ts with a builder that loads:
 *   - SOUL.md (identity/persona, fallback to built-in)
 *   - TOOLS.md (tool reference documentation)
 *   - Workspace context (from generateWorkspaceMd plugin export)
 *   - Skills (from SkillLoader, Phase B)
 *   - Runtime metadata (date, model, workspace info)
 *
 * Sections are ordered by priority. If total exceeds maxChars,
 * lowest-priority sections are truncated.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────

export interface PromptSection {
  id: string;
  content: string;
  priority: number; // higher = kept when truncating
}

export interface PromptBuilderConfig {
  workspaceDir?: string;
  maxChars?: number; // default 80000 (~20K tokens)
}

// ── Priority Constants ───────────────────────────────────

const PRIORITY = {
  identity: 10,
  agent_config: 9,     // AGENTS.md — workspace agent configuration
  tools_ref: 8,
  agent_instructions: 7,
  memory: 6,
  skills: 5,
  workspace_context: 4,
  user_profile: 3.5,   // USER.md — user preferences and context
  runtime: 3,
} as const;

// ── Default Identity (fallback when no SOUL.md) ──────────

const DEFAULT_IDENTITY = `You are a research assistant — an AI-powered academic research companion.
You help researchers with paper discovery, reading, data analysis, writing, and peer review.
You have access to specialized tools for LaTeX, Jupyter, PDF viewing, notes, and more.
When a task requires a specific tool, use it directly. Be precise and cite sources when available.`;

// ── PromptBuilder ────────────────────────────────────────

export class PromptBuilder {
  private sections = new Map<string, PromptSection>();
  private maxChars: number;
  private workspaceDir: string;

  constructor(config: PromptBuilderConfig = {}) {
    this.maxChars = config.maxChars ?? 80_000;
    this.workspaceDir = config.workspaceDir ?? '/workspace';
  }

  /** Add or replace a section */
  addSection(section: PromptSection): void {
    this.sections.set(section.id, section);
  }

  /** Build the final system prompt string */
  build(): string {
    // Sort by priority (highest first)
    const sorted = Array.from(this.sections.values())
      .sort((a, b) => b.priority - a.priority);

    // Accumulate sections, truncate if over budget
    const parts: string[] = [];
    let totalChars = 0;

    for (const section of sorted) {
      const remaining = this.maxChars - totalChars;
      if (remaining <= 0) break;

      if (section.content.length <= remaining) {
        parts.push(section.content);
        totalChars += section.content.length;
      } else {
        // Truncate this section to fit
        parts.push(section.content.slice(0, remaining - 50) + '\n\n[... truncated ...]');
        totalChars += remaining;
      }
    }

    return parts.join('\n\n');
  }

  /** Load identity from IDENTITY.md > SOUL.md > built-in default */
  loadIdentity(): void {
    let content = DEFAULT_IDENTITY;

    // IDENTITY.md takes precedence (role-specific, more detailed)
    const identityPath = join(this.workspaceDir, 'IDENTITY.md');
    const soulPath = join(this.workspaceDir, 'SOUL.md');

    if (existsSync(identityPath)) {
      try {
        content = readFileSync(identityPath, 'utf-8').trim();
      } catch { /* use default */ }
    } else if (existsSync(soulPath)) {
      try {
        content = readFileSync(soulPath, 'utf-8').trim();
      } catch { /* use default */ }
    }

    this.addSection({
      id: 'identity',
      content,
      priority: PRIORITY.identity,
    });
  }

  /** Load agent configuration from AGENTS.md */
  loadAgentConfig(): void {
    const agentsPath = join(this.workspaceDir, 'AGENTS.md');
    if (!existsSync(agentsPath)) return;

    try {
      const content = readFileSync(agentsPath, 'utf-8').trim();
      if (content) {
        this.addSection({
          id: 'agent_config',
          content: `## Agent Configuration\n\n${content}`,
          priority: PRIORITY.agent_config,
        });
      }
    } catch { /* skip */ }
  }

  /** Load user profile from USER.md */
  loadUserProfile(): void {
    const userPath = join(this.workspaceDir, 'USER.md');
    if (!existsSync(userPath)) return;

    try {
      const content = readFileSync(userPath, 'utf-8').trim();
      if (content) {
        this.addSection({
          id: 'user_profile',
          content: `## User Profile\n\n${content}`,
          priority: PRIORITY.user_profile,
        });
      }
    } catch { /* skip */ }
  }

  /** Load tools reference from TOOLS.md */
  loadToolsRef(): void {
    const toolsPath = join(this.workspaceDir, 'TOOLS.md');
    if (!existsSync(toolsPath)) return;

    try {
      const content = readFileSync(toolsPath, 'utf-8').trim();
      if (content) {
        this.addSection({
          id: 'tools_ref',
          content: `## Tool Reference\n\n${content}`,
          priority: PRIORITY.tools_ref,
        });
      }
    } catch { /* skip */ }
  }

  /** Set agent-specific instructions (from AgentConfig.systemPrompt) */
  setAgentInstructions(instructions: string): void {
    if (!instructions) return;
    this.addSection({
      id: 'agent_instructions',
      content: instructions,
      priority: PRIORITY.agent_instructions,
    });
  }

  /** Inject workspace context markdown (from generateWorkspaceMd) */
  setWorkspaceContext(workspaceMd: string): void {
    if (!workspaceMd) return;
    this.addSection({
      id: 'workspace_context',
      content: `## Workspace Context\n\n${workspaceMd}`,
      priority: PRIORITY.workspace_context,
    });
  }

  /** Add skill sections (from SkillLoader) */
  addSkillSections(skills: PromptSection[]): void {
    for (const skill of skills) {
      // Prefix skill IDs to avoid collision
      this.addSection({
        ...skill,
        id: `skill:${skill.id}`,
        priority: PRIORITY.skills,
      });
    }
  }

  /** Add runtime metadata section */
  addRuntimeInfo(meta: {
    agentId?: string;
    model?: string;
    workspaceId?: string;
    toolCount?: number;
    nodeVersion?: string;
  }): void {
    const lines = [
      '## Runtime Info',
      `- Date: ${new Date().toISOString().split('T')[0]}`,
      `- Time: ${new Date().toLocaleTimeString('en-US', { hour12: false })}`,
    ];

    if (meta.agentId) lines.push(`- Agent: ${meta.agentId}`);
    if (meta.model) lines.push(`- Model: ${meta.model}`);
    if (meta.workspaceId) lines.push(`- Workspace: ${meta.workspaceId}`);
    if (meta.toolCount) lines.push(`- Tools available: ${meta.toolCount}`);
    if (meta.nodeVersion) lines.push(`- Node.js: ${meta.nodeVersion}`);

    this.addSection({
      id: 'runtime',
      content: lines.join('\n'),
      priority: PRIORITY.runtime,
    });
  }

  /** Get the number of sections */
  get sectionCount(): number {
    return this.sections.size;
  }
}
