/**
 * ClawHub tool — pure JS skill management (no external CLI dependency).
 *
 * **Subcommands:** `search`, `install`, `update`, `list`.
 *
 * After install/update, invalidates the {@link SkillLoader} cache
 * so new skills are picked up in the next agent prompt.
 *
 * Skills are stored in `{workspaceDir}/skills/{name}/` — each must
 * contain a `SKILL.md` file with YAML frontmatter.
 *
 * @module tools/clawhub
 */

import type { Tool, ToolContext } from '../tools.js';
import type { SkillLoader } from '../skills.js';

// ── Built-in skill registry (fallback when no remote registry) ──

const BUILTIN_REGISTRY: Record<string, { description: string; repo: string }> = {
  'research-paper': {
    description: 'Academic paper search and analysis workflows',
    repo: 'https://github.com/prismer-ai/skill-research-paper.git',
  },
  'code-review': {
    description: 'Code review and quality analysis',
    repo: 'https://github.com/prismer-ai/skill-code-review.git',
  },
  'data-analysis': {
    description: 'Data analysis with Python and visualization',
    repo: 'https://github.com/prismer-ai/skill-data-analysis.git',
  },
};

export function createClawHubTool(skillLoader?: SkillLoader): Tool {
  const workspaceDir = process.env.WORKSPACE_DIR || './workspace';
  const skillsDir = `${workspaceDir}/skills`;

  return {
    name: 'clawhub',
    description:
      'Search, install, update, and list agent skills from ClawHub. ' +
      'Subcommands: search <query>, install <slug-or-git-url>, update [--all|<slug>], list.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['search', 'install', 'update', 'list'],
          description: 'The clawhub subcommand',
        },
        args: {
          type: 'string',
          description: 'Arguments (search query, skill slug or git URL, --all flag, etc.)',
        },
      },
      required: ['command'],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
      const command = args.command as string;
      const cmdArgs = ((args.args as string) ?? '').trim();
      const { execSync } = await import('node:child_process');
      const { existsSync, readdirSync, readFileSync, statSync: fstatSync } = await import('node:fs');
      const { join } = await import('node:path');

      try {
        switch (command) {
          // ── search ──────────────────────────────────
          case 'search': {
            if (!cmdArgs) return 'Usage: clawhub search <query>';

            const query = cmdArgs.toLowerCase();
            const results: string[] = [];

            for (const [slug, info] of Object.entries(BUILTIN_REGISTRY)) {
              if (slug.includes(query) || info.description.toLowerCase().includes(query)) {
                results.push(`  ${slug} — ${info.description}`);
              }
            }

            if (results.length === 0) {
              return `No skills found matching "${cmdArgs}". Available skills:\n` +
                Object.entries(BUILTIN_REGISTRY)
                  .map(([s, i]) => `  ${s} — ${i.description}`)
                  .join('\n');
            }

            return `Found ${results.length} skill(s):\n${results.join('\n')}`;
          }

          // ── install ─────────────────────────────────
          case 'install': {
            if (!cmdArgs) return 'Usage: clawhub install <slug-or-git-url>';

            let repoUrl: string;
            let slug: string;

            // If it looks like a URL, use directly
            if (cmdArgs.startsWith('http') || cmdArgs.startsWith('git@')) {
              repoUrl = cmdArgs;
              // Extract slug from URL: https://github.com/user/skill-name.git → skill-name
              slug = cmdArgs.split('/').pop()?.replace(/\.git$/, '') || cmdArgs;
            } else {
              // Look up in registry
              const entry = BUILTIN_REGISTRY[cmdArgs];
              if (entry) {
                repoUrl = entry.repo;
                slug = cmdArgs;
              } else {
                // Try as a GitHub shorthand: user/repo
                if (cmdArgs.includes('/')) {
                  repoUrl = `https://github.com/${cmdArgs}.git`;
                  slug = cmdArgs.split('/').pop() || cmdArgs;
                } else {
                  return `Unknown skill "${cmdArgs}". Use \`clawhub search\` to find available skills, ` +
                    `or provide a full git URL.`;
                }
              }
            }

            const targetDir = join(skillsDir, slug);

            if (existsSync(targetDir)) {
              return `Skill "${slug}" is already installed at ${targetDir}. Use \`clawhub update ${slug}\` to update.`;
            }

            // git clone --depth=1
            execSync(`git clone --depth=1 "${repoUrl}" "${targetDir}"`, {
              timeout: 60_000,
              encoding: 'utf8',
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            });

            // Remove .git to save space
            execSync(`rm -rf "${targetDir}/.git"`, { encoding: 'utf8' });

            // Verify SKILL.md exists
            const skillMd = join(targetDir, 'SKILL.md');
            const hasSkill = existsSync(skillMd);

            // Invalidate cache
            skillLoader?.invalidate();

            return `✓ Installed "${slug}" to ${targetDir}\n` +
              `  SKILL.md: ${hasSkill ? 'found' : 'NOT found (skill may not load)'}`;
          }

          // ── update ──────────────────────────────────
          case 'update': {
            if (cmdArgs === '--all' || !cmdArgs) {
              // Update all installed skills
              if (!existsSync(skillsDir)) return 'No skills directory found.';

              const dirs = readdirSync(skillsDir).filter(d => {
                try { return fstatSync(join(skillsDir, d)).isDirectory(); }
                catch { return false; }
              });

              if (dirs.length === 0) return 'No skills installed.';

              const results: string[] = [];
              for (const d of dirs) {
                const gitDir = join(skillsDir, d, '.git');
                if (existsSync(gitDir)) {
                  try {
                    execSync(`cd "${join(skillsDir, d)}" && git pull --ff-only`, {
                      timeout: 30_000,
                      encoding: 'utf8',
                    });
                    results.push(`  ✓ ${d} — updated`);
                  } catch {
                    results.push(`  ✗ ${d} — update failed (no .git or network error)`);
                  }
                } else {
                  results.push(`  - ${d} — skipped (not a git repo)`);
                }
              }

              skillLoader?.invalidate();
              return `Updated ${dirs.length} skill(s):\n${results.join('\n')}`;
            } else {
              // Update specific skill
              const targetDir = join(skillsDir, cmdArgs);
              if (!existsSync(targetDir)) {
                return `Skill "${cmdArgs}" not found. Use \`clawhub list\` to see installed skills.`;
              }

              const gitDir = join(targetDir, '.git');
              if (!existsSync(gitDir)) {
                return `Skill "${cmdArgs}" was installed without git — cannot update. Reinstall with \`clawhub install\`.`;
              }

              execSync(`cd "${targetDir}" && git pull --ff-only`, {
                timeout: 30_000,
                encoding: 'utf8',
              });

              skillLoader?.invalidate();
              return `✓ Updated "${cmdArgs}"`;
            }
          }

          // ── list ────────────────────────────────────
          case 'list': {
            if (!existsSync(skillsDir)) return 'No skills directory found.';

            const dirs = readdirSync(skillsDir).filter(d => {
              try { return fstatSync(join(skillsDir, d)).isDirectory(); }
              catch { return false; }
            });

            if (dirs.length === 0) return 'No skills installed.';

            const lines: string[] = [];
            for (const d of dirs) {
              const skillMd = join(skillsDir, d, 'SKILL.md');
              if (existsSync(skillMd)) {
                try {
                  const raw = readFileSync(skillMd, 'utf-8');
                  const descMatch = raw.match(/description:\s*"?(.+?)"?\s*$/m);
                  const desc = descMatch ? descMatch[1] : '(no description)';
                  lines.push(`  ${d} — ${desc}`);
                } catch {
                  lines.push(`  ${d} — (error reading SKILL.md)`);
                }
              } else {
                lines.push(`  ${d} — (no SKILL.md)`);
              }
            }

            return `Installed skills (${dirs.length}):\n${lines.join('\n')}`;
          }

          default:
            return `Unknown command "${command}". Available: search, install, update, list`;
        }
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        return `Error: ${e.stderr || e.message || String(err)}`.slice(0, 5_000);
      }
    },
  };
}
