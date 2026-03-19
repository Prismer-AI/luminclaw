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
}
