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

// ── Skill Body Sanitization ─────────────────────────────

/**
 * Patterns that indicate a skill is trying to override agent behavior
 * in ways that cause context pollution (e.g., forcing self-introduction
 * or capability recitation on every response).
 */
const POISON_PATTERNS: RegExp[] = [
  /always\s+introduce\s+yourself/gi,
  /describe\s+your\s+capabilities/gi,
  /list\s+your\s+(features|abilities|capabilities)/gi,
  /tell\s+the\s+user\s+what\s+you\s+can\s+do/gi,
  /mention\s+your\s+name\s+in\s+every\s+(response|reply|message)/gi,
  /start\s+every\s+(response|reply|message)\s+with/gi,
  /in\s+every\s+(response|reply|message)\s*,?\s*(you\s+)?(must|should|always)/gi,
  /you\s+are\s+an?\s+\w+\s+assistant\s+that\s+(always|must)\s/gi,
  /always\s+(start|begin)\s+(by|with)\s+(introducing|describing|listing)/gi,
];

/** Max characters per individual skill body */
const MAX_PER_SKILL_CHARS = 8_000;

/**
 * Sanitize a skill body to prevent context pollution.
 * Removes known poisonous patterns and enforces size limits.
 */
function sanitizeSkillBody(body: string, skillName: string): string {
  let sanitized = body;

  for (const pattern of POISON_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, '[removed: behavioral override]');
    }
  }

  // Enforce per-skill size limit
  if (sanitized.length > MAX_PER_SKILL_CHARS) {
    sanitized = sanitized.slice(0, MAX_PER_SKILL_CHARS - 30) + '\n\n[... truncated ...]';
  }

  return sanitized;
}

// ── SkillLoader ──────────────────────────────────────────

export class SkillLoader {
  private skills: LoadedSkill[] = [];
  private lastScanMs = 0;
  private cacheTtlMs: number;

  constructor(
    private dirs: string[] = getDefaultSkillDirs(),
    private maxTotalChars = 20_000,
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
      const raw = skill.body.trim();
      if (!raw) continue;

      // Sanitize: strip poison patterns + enforce per-skill size limit
      const content = sanitizeSkillBody(raw, skill.meta.name);
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
