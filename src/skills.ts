/**
 * SkillLoader — loads SKILL.md files from filesystem directories
 *
 * Scans configured directories for SKILL.md files with YAML frontmatter,
 * converts them to PromptSections for injection into the system prompt.
 *
 * SKILL.md format:
 *   ---
 *   name: skill-name
 *   description: "One-line description"
 *   ---
 *   # Skill body (markdown)
 *
 * Directory structure:
 *   /workspace/skills/<name>/SKILL.md
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptSection } from './prompt.js';

// ── Types ────────────────────────────────────────────────

export interface SkillMeta {
  name: string;
  description: string;
  userInvocable?: boolean;
}

export interface LoadedSkill {
  meta: SkillMeta;
  body: string;       // Markdown body after frontmatter
  dir: string;        // Directory containing SKILL.md
}

// ── Default Scan Directories ─────────────────────────────

function getDefaultSkillDirs(): string[] {
  const workspaceDir = process.env.WORKSPACE_DIR || './workspace';
  return [
    `${workspaceDir}/skills`,                 // Workspace-local skills
  ];
}

// ── Frontmatter Parser (zero dependencies) ───────────────

function parseFrontmatter(raw: string): { meta: SkillMeta; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { meta: { name: '', description: '' }, body: raw };
  }

  const lines = match[1].split('\n');
  let name = '';
  let description = '';
  let userInvocable = false;

  for (const line of lines) {
    const m = line.match(/^(name|description|user-invocable):\s*"?(.+?)"?\s*$/);
    if (m) {
      if (m[1] === 'name') name = m[2];
      if (m[1] === 'description') description = m[2];
      if (m[1] === 'user-invocable') userInvocable = m[2] === 'true';
    }
  }

  return { meta: { name, description, userInvocable }, body: match[2] };
}

// ── SkillLoader ──────────────────────────────────────────

export class SkillLoader {
  private skills: LoadedSkill[] = [];
  private lastScanMs = 0;
  private cacheTtlMs: number;

  constructor(
    private dirs: string[] = getDefaultSkillDirs(),
    private maxTotalChars = 40_000,
    cacheTtlMs = 30_000,
  ) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /** Scan directories for SKILL.md files */
  scan(): LoadedSkill[] {
    const skills: LoadedSkill[] = [];
    const seen = new Set<string>();

    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;

      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const skillDir = join(dir, entry);
          if (!statSync(skillDir).isDirectory()) continue;

          const skillFile = join(skillDir, 'SKILL.md');
          if (!existsSync(skillFile)) continue;

          try {
            const raw = readFileSync(skillFile, 'utf-8');
            const { meta, body } = parseFrontmatter(raw);

            // Use directory name as fallback name
            const name = meta.name || entry;
            if (seen.has(name)) continue; // Deduplicate by name
            seen.add(name);

            skills.push({ meta: { ...meta, name }, body, dir: skillDir });
          } catch { /* Skip unreadable skill files */ }
        }
      } catch { /* Skip inaccessible directories */ }
    }

    return skills;
  }

  /** Get skills (with cache) */
  getSkills(): LoadedSkill[] {
    const now = Date.now();
    if (now - this.lastScanMs > this.cacheTtlMs) {
      this.skills = this.scan();
      this.lastScanMs = now;
    }
    return this.skills;
  }

  /** Convert loaded skills to PromptSections for PromptBuilder */
  toPromptSections(): PromptSection[] {
    const skills = this.getSkills();
    if (skills.length === 0) return [];

    const sections: PromptSection[] = [];
    let totalChars = 0;

    for (const skill of skills) {
      const content = skill.body.trim();
      if (!content) continue;

      // Enforce total budget
      if (totalChars + content.length > this.maxTotalChars) {
        // Truncate this skill to fit remaining budget
        const remaining = this.maxTotalChars - totalChars;
        if (remaining > 200) {
          sections.push({
            id: skill.meta.name,
            content: content.slice(0, remaining - 30) + '\n\n[... truncated ...]',
            priority: 5,
          });
        }
        break;
      }

      sections.push({
        id: skill.meta.name,
        content,
        priority: 5,
      });
      totalChars += content.length;
    }

    return sections;
  }

  /** Force refresh on next access */
  invalidate(): void {
    this.lastScanMs = 0;
  }

  /** Get skill count */
  get count(): number {
    return this.getSkills().length;
  }
}
