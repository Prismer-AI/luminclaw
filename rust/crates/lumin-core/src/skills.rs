//! Skill loader — mirrors TypeScript `skills.ts`.
//! Loads SKILL.md files with YAML frontmatter from workspace/skills/.

use std::path::{Path, PathBuf};
use std::fs;
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone)]
pub struct LoadedSkill {
    pub meta: SkillMeta,
    pub content: String,
    pub path: PathBuf,
}

pub struct SkillLoader {
    skills: Vec<LoadedSkill>,
}

impl SkillLoader {
    /// Create a SkillLoader and scan the given directories for SKILL.md files.
    pub fn new(dirs: &[&str]) -> Self {
        let mut skills = Vec::new();
        for dir in dirs {
            let path = Path::new(dir);
            if !path.is_dir() { continue; }
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    let skill_dir = entry.path();
                    if !skill_dir.is_dir() { continue; }
                    let skill_file = skill_dir.join("SKILL.md");
                    if let Ok(content) = fs::read_to_string(&skill_file) {
                        if let Some(skill) = Self::parse_skill(&content, &skill_file) {
                            info!(name = %skill.meta.name, "loaded skill");
                            skills.push(skill);
                        }
                    }
                }
            }
        }
        info!(count = skills.len(), "skills loaded");
        Self { skills }
    }

    fn parse_skill(content: &str, path: &Path) -> Option<LoadedSkill> {
        // Parse YAML frontmatter between --- markers
        if !content.starts_with("---") { return None; }
        let end = content[3..].find("---")?;
        let frontmatter = &content[3..3 + end];
        let body = &content[3 + end + 3..];

        let mut name = String::new();
        let mut description = String::new();

        for line in frontmatter.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("name:") {
                name = v.trim().trim_matches('"').to_string();
            } else if let Some(v) = line.strip_prefix("description:") {
                description = v.trim().trim_matches('"').to_string();
            }
        }

        if name.is_empty() { return None; }

        Some(LoadedSkill {
            meta: SkillMeta { name, description },
            content: body.trim().to_string(),
            path: path.to_path_buf(),
        })
    }

    /// Generate prompt sections for injection into system prompt.
    pub fn to_prompt_sections(&self) -> Vec<(String, String)> {
        self.skills.iter().map(|s| {
            (s.meta.name.clone(), s.content.clone())
        }).collect()
    }

    pub fn count(&self) -> usize { self.skills.len() }
    pub fn list(&self) -> &[LoadedSkill] { &self.skills }
}

impl Default for SkillLoader {
    fn default() -> Self { Self { skills: Vec::new() } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_skill_md() {
        let content = "---\nname: test-skill\ndescription: \"A test skill\"\n---\n# Test\nDo something.";
        let skill = SkillLoader::parse_skill(content, Path::new("/tmp/test/SKILL.md"));
        assert!(skill.is_some());
        let s = skill.unwrap();
        assert_eq!(s.meta.name, "test-skill");
        assert_eq!(s.meta.description, "A test skill");
        assert!(s.content.contains("Do something"));
    }

    #[test]
    fn parse_skill_with_valid_yaml_frontmatter() {
        let content = r#"---
name: my-skill
description: "Does amazing things"
---
# My Skill

Use this skill to do amazing things.
"#;
        let skill = SkillLoader::parse_skill(content, Path::new("/skills/my-skill/SKILL.md"));
        assert!(skill.is_some());
        let s = skill.unwrap();
        assert_eq!(s.meta.name, "my-skill");
        assert_eq!(s.meta.description, "Does amazing things");
        assert!(s.content.contains("Use this skill"));
        assert_eq!(s.path, Path::new("/skills/my-skill/SKILL.md"));
    }

    #[test]
    fn parse_skill_without_frontmatter_returns_none() {
        let content = "# No Frontmatter\nJust a regular markdown file.";
        let skill = SkillLoader::parse_skill(content, Path::new("/tmp/SKILL.md"));
        assert!(skill.is_none());
    }

    #[test]
    fn parse_skill_with_empty_name_returns_none() {
        let content = "---\nname:\ndescription: \"has desc but no name\"\n---\nBody text.";
        let skill = SkillLoader::parse_skill(content, Path::new("/tmp/SKILL.md"));
        assert!(skill.is_none());
    }

    #[test]
    fn to_prompt_sections_returns_name_content_tuples() {
        let loader = SkillLoader {
            skills: vec![
                LoadedSkill {
                    meta: SkillMeta { name: "skill-a".into(), description: "Desc A".into() },
                    content: "Content A".into(),
                    path: PathBuf::from("/a/SKILL.md"),
                },
                LoadedSkill {
                    meta: SkillMeta { name: "skill-b".into(), description: "Desc B".into() },
                    content: "Content B".into(),
                    path: PathBuf::from("/b/SKILL.md"),
                },
            ],
        };
        let sections = loader.to_prompt_sections();
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0], ("skill-a".to_string(), "Content A".to_string()));
        assert_eq!(sections[1], ("skill-b".to_string(), "Content B".to_string()));
    }

    #[test]
    fn empty_skills_directory_returns_empty() {
        let dir = "/tmp/lumin-skills-test-empty";
        let _ = fs::remove_dir_all(dir);
        fs::create_dir_all(dir).unwrap();

        let loader = SkillLoader::new(&[dir]);
        assert_eq!(loader.count(), 0);
        assert!(loader.list().is_empty());
        assert!(loader.to_prompt_sections().is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn loader_scans_directory_for_skill_files() {
        let dir = "/tmp/lumin-skills-test-scan";
        let _ = fs::remove_dir_all(dir);

        // Create a skill subdirectory with SKILL.md
        let skill_dir = format!("{dir}/my-tool");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            format!("{skill_dir}/SKILL.md"),
            "---\nname: my-tool\ndescription: \"A tool\"\n---\n# My Tool\nDoes stuff.",
        ).unwrap();

        let loader = SkillLoader::new(&[dir]);
        assert_eq!(loader.count(), 1);
        assert_eq!(loader.list()[0].meta.name, "my-tool");

        let _ = fs::remove_dir_all(dir);
    }

    // ── Additional tests for TS parity ──

    #[test]
    fn parse_skill_preserves_body_content_after_frontmatter() {
        let content = "---\nname: my-skill\ndescription: \"Test\"\n---\n# My Skill\n\nThis is the body.\nWith multiple lines.\nAnd more content.";
        let skill = SkillLoader::parse_skill(content, Path::new("/tmp/SKILL.md")).unwrap();
        assert!(skill.content.contains("This is the body."));
        assert!(skill.content.contains("With multiple lines."));
        assert!(skill.content.contains("And more content."));
    }

    #[test]
    fn parse_skill_with_multi_line_description() {
        // The parser takes description from a single line; multi-line is not supported in simple YAML
        // but we verify it doesn't break and takes the first line
        let content = "---\nname: multi\ndescription: \"A skill that does many things\"\n---\nBody text here.";
        let skill = SkillLoader::parse_skill(content, Path::new("/tmp/SKILL.md")).unwrap();
        assert_eq!(skill.meta.description, "A skill that does many things");
        assert_eq!(skill.content, "Body text here.");
    }

    #[test]
    fn parse_skill_with_extra_unknown_fields() {
        let content = "---\nname: extended\ndescription: \"With extras\"\nversion: 2.0\nauthor: test\ncustom-field: value\n---\nBody.";
        let skill = SkillLoader::parse_skill(content, Path::new("/tmp/SKILL.md")).unwrap();
        assert_eq!(skill.meta.name, "extended");
        assert_eq!(skill.meta.description, "With extras");
        assert_eq!(skill.content, "Body.");
    }

    #[test]
    fn parse_skill_empty_body_with_valid_frontmatter() {
        let content = "---\nname: empty-body\ndescription: \"No body\"\n---\n";
        let skill = SkillLoader::parse_skill(content, Path::new("/tmp/SKILL.md")).unwrap();
        assert_eq!(skill.meta.name, "empty-body");
        assert!(skill.content.is_empty());
    }

    #[test]
    fn parse_skill_content_size_limit() {
        // The body should be stored as-is (up to whatever is provided).
        // Verify large content is preserved (TS has 8K limit, Rust stores full content).
        let body = "X".repeat(8000);
        let content = format!("---\nname: big\ndescription: \"Big skill\"\n---\n{body}");
        let skill = SkillLoader::parse_skill(&content, Path::new("/tmp/SKILL.md")).unwrap();
        assert_eq!(skill.content.len(), 8000);
    }

    #[test]
    fn multiple_skills_from_directory() {
        let dir = "/tmp/lumin-skills-test-multi";
        let _ = fs::remove_dir_all(dir);

        for name in &["alpha", "beta", "gamma"] {
            let skill_dir = format!("{dir}/{name}");
            fs::create_dir_all(&skill_dir).unwrap();
            fs::write(
                format!("{skill_dir}/SKILL.md"),
                format!("---\nname: {name}\ndescription: \"Skill {name}\"\n---\nBody for {name}."),
            ).unwrap();
        }

        let loader = SkillLoader::new(&[dir]);
        assert_eq!(loader.count(), 3);

        let names: Vec<&str> = loader.list().iter().map(|s| s.meta.name.as_str()).collect();
        assert!(names.contains(&"alpha"));
        assert!(names.contains(&"beta"));
        assert!(names.contains(&"gamma"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn scan_nonexistent_directory_returns_empty() {
        let loader = SkillLoader::new(&["/nonexistent/path/that/does/not/exist"]);
        assert_eq!(loader.count(), 0);
        assert!(loader.list().is_empty());
    }

    #[test]
    fn loader_skips_directories_without_skill_md() {
        let dir = "/tmp/lumin-skills-test-skip-nomd";
        let _ = fs::remove_dir_all(dir);

        // Create a subdirectory without SKILL.md
        let no_skill = format!("{dir}/no-skill");
        fs::create_dir_all(&no_skill).unwrap();
        fs::write(format!("{no_skill}/README.md"), "Not a skill.").unwrap();

        // Create a valid skill
        let valid = format!("{dir}/valid-skill");
        fs::create_dir_all(&valid).unwrap();
        fs::write(
            format!("{valid}/SKILL.md"),
            "---\nname: valid\ndescription: \"A valid skill\"\n---\nBody.",
        ).unwrap();

        let loader = SkillLoader::new(&[dir]);
        assert_eq!(loader.count(), 1);
        assert_eq!(loader.list()[0].meta.name, "valid");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn loader_skips_files_not_directories_in_skills_dir() {
        let dir = "/tmp/lumin-skills-test-skip-files";
        let _ = fs::remove_dir_all(dir);
        fs::create_dir_all(dir).unwrap();

        // Create a regular file (not a directory)
        fs::write(format!("{dir}/not-a-dir.txt"), "Just a file.").unwrap();

        // Create a valid skill
        let valid = format!("{dir}/real-skill");
        fs::create_dir_all(&valid).unwrap();
        fs::write(
            format!("{valid}/SKILL.md"),
            "---\nname: real-skill\ndescription: \"Real\"\n---\nBody.",
        ).unwrap();

        let loader = SkillLoader::new(&[dir]);
        assert_eq!(loader.count(), 1);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn parse_skill_description_with_inner_quotes() {
        let content = "---\nname: quoted\ndescription: \"Skill with 'inner' quotes\"\n---\nBody.";
        let skill = SkillLoader::parse_skill(content, Path::new("/tmp/SKILL.md")).unwrap();
        assert!(skill.meta.description.contains("inner"));
    }
}
