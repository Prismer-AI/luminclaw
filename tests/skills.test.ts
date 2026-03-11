/**
 * Tests for SkillLoader — SKILL.md loading, frontmatter parsing, caching
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SkillLoader } from '../src/skills.js';

const TEST_DIR = join(process.cwd(), '.test-workspace-skills');
const SKILLS_DIR = join(TEST_DIR, 'skills');

function writeSkill(name: string, content: string) {
  const dir = join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
}

beforeEach(() => {
  mkdirSync(SKILLS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('SkillLoader', () => {
  describe('frontmatter parsing', () => {
    it('parses name and description from YAML frontmatter', () => {
      writeSkill('test-skill', `---
name: test-skill
description: "A test skill for verification"
---
# Test Skill
Body content here.`);

      const loader = new SkillLoader([SKILLS_DIR]);
      const skills = loader.scan();
      expect(skills).toHaveLength(1);
      expect(skills[0].meta.name).toBe('test-skill');
      expect(skills[0].meta.description).toBe('A test skill for verification');
      expect(skills[0].body).toContain('Body content here.');
    });

    it('parses user-invocable flag', () => {
      writeSkill('invocable', `---
name: invocable
description: "Invocable skill"
user-invocable: true
---
Invocable body.`);

      const loader = new SkillLoader([SKILLS_DIR]);
      const skills = loader.scan();
      expect(skills[0].meta.userInvocable).toBe(true);
    });

    it('uses directory name as fallback when no name in frontmatter', () => {
      writeSkill('my-skill', `---
description: "No name field"
---
Body.`);

      const loader = new SkillLoader([SKILLS_DIR]);
      const skills = loader.scan();
      expect(skills[0].meta.name).toBe('my-skill');
    });

    it('handles SKILL.md without frontmatter', () => {
      writeSkill('plain', '# Plain Skill\nNo frontmatter here.');

      const loader = new SkillLoader([SKILLS_DIR]);
      const skills = loader.scan();
      expect(skills[0].meta.name).toBe('plain');
      expect(skills[0].body).toContain('No frontmatter here.');
    });

    it('handles description with quotes', () => {
      writeSkill('quoted', `---
name: quoted
description: "Skill with 'inner' quotes"
---
Body.`);

      const loader = new SkillLoader([SKILLS_DIR]);
      const skills = loader.scan();
      expect(skills[0].meta.description).toContain('inner');
    });
  });

  describe('directory scanning', () => {
    it('scans multiple directories', () => {
      const dir2 = join(TEST_DIR, 'skills2');
      mkdirSync(join(dir2, 'skill-a'), { recursive: true });
      writeFileSync(join(dir2, 'skill-a', 'SKILL.md'), '---\nname: skill-a\ndescription: A\n---\nBody A');

      writeSkill('skill-b', '---\nname: skill-b\ndescription: B\n---\nBody B');

      const loader = new SkillLoader([SKILLS_DIR, dir2]);
      const skills = loader.scan();
      expect(skills).toHaveLength(2);
    });

    it('deduplicates by name across directories', () => {
      const dir2 = join(TEST_DIR, 'skills2');
      mkdirSync(join(dir2, 'dupe'), { recursive: true });
      writeFileSync(join(dir2, 'dupe', 'SKILL.md'), '---\nname: dupe\ndescription: From dir2\n---\nDir2 body');

      writeSkill('dupe', '---\nname: dupe\ndescription: From dir1\n---\nDir1 body');

      const loader = new SkillLoader([SKILLS_DIR, dir2]);
      const skills = loader.scan();
      expect(skills).toHaveLength(1);
      // First directory wins
      expect(skills[0].body).toContain('Dir1 body');
    });

    it('skips nonexistent directories gracefully', () => {
      const loader = new SkillLoader(['/nonexistent/path', SKILLS_DIR]);
      writeSkill('exists', '---\nname: exists\ndescription: test\n---\nBody');
      const skills = loader.scan();
      expect(skills).toHaveLength(1);
    });

    it('skips directories without SKILL.md', () => {
      mkdirSync(join(SKILLS_DIR, 'no-skill'), { recursive: true });
      writeFileSync(join(SKILLS_DIR, 'no-skill', 'README.md'), 'Not a skill.');
      writeSkill('valid', '---\nname: valid\ndescription: test\n---\nBody');

      const loader = new SkillLoader([SKILLS_DIR]);
      const skills = loader.scan();
      expect(skills).toHaveLength(1);
      expect(skills[0].meta.name).toBe('valid');
    });

    it('skips files (not directories) in skill directory', () => {
      writeFileSync(join(SKILLS_DIR, 'not-a-dir.txt'), 'Just a file.');
      writeSkill('valid', '---\nname: valid\ndescription: test\n---\nBody');

      const loader = new SkillLoader([SKILLS_DIR]);
      expect(loader.scan()).toHaveLength(1);
    });
  });

  describe('caching', () => {
    it('caches results within TTL', () => {
      writeSkill('cached', '---\nname: cached\ndescription: test\n---\nBody');
      const loader = new SkillLoader([SKILLS_DIR], 40_000, 10_000);

      // First access — scans
      expect(loader.getSkills()).toHaveLength(1);

      // Add another skill — should NOT be seen (cached)
      writeSkill('new-skill', '---\nname: new-skill\ndescription: test\n---\nBody');
      expect(loader.getSkills()).toHaveLength(1);
    });

    it('invalidate() forces re-scan', () => {
      writeSkill('first', '---\nname: first\ndescription: test\n---\nBody');
      const loader = new SkillLoader([SKILLS_DIR], 40_000, 60_000);

      expect(loader.getSkills()).toHaveLength(1);

      writeSkill('second', '---\nname: second\ndescription: test\n---\nBody');
      loader.invalidate();
      expect(loader.getSkills()).toHaveLength(2);
    });

    it('count property uses cached skills', () => {
      writeSkill('a', '---\nname: a\ndescription: test\n---\nBody');
      writeSkill('b', '---\nname: b\ndescription: test\n---\nBody');
      const loader = new SkillLoader([SKILLS_DIR]);
      expect(loader.count).toBe(2);
    });
  });

  describe('toPromptSections', () => {
    it('converts skills to PromptSections', () => {
      writeSkill('skill-1', '---\nname: skill-1\ndescription: test\n---\n# Skill 1\nInstructions here.');
      const loader = new SkillLoader([SKILLS_DIR]);
      const sections = loader.toPromptSections();
      expect(sections).toHaveLength(1);
      expect(sections[0].id).toBe('skill-1');
      expect(sections[0].priority).toBe(5);
      expect(sections[0].content).toContain('Instructions here.');
    });

    it('skips empty bodies', () => {
      writeSkill('empty', '---\nname: empty\ndescription: test\n---\n');
      const loader = new SkillLoader([SKILLS_DIR]);
      expect(loader.toPromptSections()).toHaveLength(0);
    });

    it('enforces total char budget across skills', () => {
      writeSkill('big-1', `---\nname: big-1\ndescription: test\n---\n${'A'.repeat(500)}`);
      writeSkill('big-2', `---\nname: big-2\ndescription: test\n---\n${'B'.repeat(500)}`);
      writeSkill('big-3', `---\nname: big-3\ndescription: test\n---\n${'C'.repeat(500)}`);

      // Budget of 800 chars should fit big-1 fully, truncate big-2, skip big-3
      const loader = new SkillLoader([SKILLS_DIR], 800);
      const sections = loader.toPromptSections();
      expect(sections.length).toBeLessThanOrEqual(2);

      // First skill should be complete
      const firstContent = sections[0].content;
      expect(firstContent.length).toBe(500);
    });

    it('returns empty array when no skills', () => {
      const loader = new SkillLoader(['/nonexistent']);
      expect(loader.toPromptSections()).toEqual([]);
    });
  });
});
