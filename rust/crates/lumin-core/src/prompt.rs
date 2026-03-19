//! PromptBuilder — dynamic system prompt assembly.
//! Mirrors TypeScript `prompt.ts`: loads SOUL.md, TOOLS.md, AGENTS.md, USER.md,
//! skills, memory, runtime info, and assembles them by priority.

use std::path::Path;
use std::fs;

/// A named section with priority (higher = earlier in prompt).
#[derive(Debug, Clone)]
pub struct PromptSection {
    pub id: String,
    pub content: String,
    pub priority: f32,
}

pub struct PromptBuilder {
    workspace_dir: String,
    sections: Vec<PromptSection>,
}

impl PromptBuilder {
    pub fn new(workspace_dir: &str) -> Self {
        Self { workspace_dir: workspace_dir.into(), sections: Vec::new() }
    }

    /// Load identity from SOUL.md (priority 10 — highest).
    pub fn load_identity(&mut self) {
        if let Some(content) = self.read_file("SOUL.md") {
            self.sections.push(PromptSection {
                id: "identity".into(),
                content: format!("## Identity\n\n{content}"),
                priority: 10.0,
            });
        } else {
            self.sections.push(PromptSection {
                id: "identity".into(),
                content: "## Identity\n\nYou are a research assistant — an AI-powered academic research companion.".into(),
                priority: 10.0,
            });
        }
    }

    /// Load agent config from AGENTS.md (priority 9).
    pub fn load_agent_config(&mut self) {
        if let Some(content) = self.read_file("AGENTS.md") {
            self.sections.push(PromptSection {
                id: "agent-config".into(),
                content: format!("## Agent Configuration\n\n{content}"),
                priority: 9.0,
            });
        }
    }

    /// Load tools reference from TOOLS.md (priority 8).
    pub fn load_tools_ref(&mut self) {
        if let Some(content) = self.read_file("TOOLS.md") {
            self.sections.push(PromptSection {
                id: "tools-ref".into(),
                content: format!("## Tool Reference\n\n{content}"),
                priority: 8.0,
            });
        }
    }

    /// Set agent-specific instructions (priority 7).
    pub fn set_agent_instructions(&mut self, instructions: &str) {
        self.sections.push(PromptSection {
            id: "agent-instructions".into(),
            content: format!("## Instructions\n\n{instructions}"),
            priority: 7.0,
        });
    }

    /// Load user profile from USER.md (priority 3.5).
    pub fn load_user_profile(&mut self) {
        if let Some(content) = self.read_file("USER.md") {
            self.sections.push(PromptSection {
                id: "user-profile".into(),
                content: format!("## User Profile\n\n{content}"),
                priority: 3.5,
            });
        }
    }

    /// Add skill sections (priority 5).
    pub fn add_skill_sections(&mut self, skills: Vec<(String, String)>) {
        for (name, content) in skills {
            self.sections.push(PromptSection {
                id: format!("skill-{name}"),
                content: format!("## Skill: {name}\n\n{content}"),
                priority: 5.0,
            });
        }
    }

    /// Set workspace context from plugin (priority 4).
    pub fn set_workspace_context(&mut self, context: &str) {
        self.sections.push(PromptSection {
            id: "workspace".into(),
            content: format!("## Workspace\n\n{context}"),
            priority: 4.0,
        });
    }

    /// Add memory context (priority 6).
    pub fn add_memory_context(&mut self, memory: &str) {
        if !memory.is_empty() {
            self.sections.push(PromptSection {
                id: "memory".into(),
                content: format!("## Recent Memory\n\n{memory}"),
                priority: 6.0,
            });
        }
    }

    /// Add runtime info (priority 3).
    pub fn add_runtime_info(&mut self, agent_id: Option<&str>, model: Option<&str>, tool_count: Option<usize>) {
        let mut parts = vec!["## Runtime Info".to_string()];
        if let Some(id) = agent_id { parts.push(format!("- Agent: {id}")); }
        if let Some(m) = model { parts.push(format!("- Model: {m}")); }
        if let Some(c) = tool_count { parts.push(format!("- Available tools: {c}")); }
        parts.push(format!("- Runtime: lumin-rust v0.1.0"));
        self.sections.push(PromptSection {
            id: "runtime".into(),
            content: parts.join("\n"),
            priority: 3.0,
        });
    }

    /// Add an arbitrary section.
    pub fn add_section(&mut self, section: PromptSection) {
        self.sections.push(section);
    }

    /// Build the final prompt — sections sorted by priority (descending).
    pub fn build(&self) -> String {
        let mut sorted = self.sections.clone();
        sorted.sort_by(|a, b| b.priority.partial_cmp(&a.priority).unwrap_or(std::cmp::Ordering::Equal));
        sorted.iter().map(|s| s.content.as_str()).collect::<Vec<_>>().join("\n\n---\n\n")
    }

    fn read_file(&self, name: &str) -> Option<String> {
        let path = Path::new(&self.workspace_dir).join(name);
        fs::read_to_string(path).ok().filter(|s| !s.trim().is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn build_with_defaults() {
        let dir = "/tmp/lumin-prompt-test";
        let _ = fs::create_dir_all(dir);
        fs::write(format!("{dir}/SOUL.md"), "You are TestBot.").unwrap();
        fs::write(format!("{dir}/TOOLS.md"), "# Tools\nUse bash.").unwrap();

        let mut b = PromptBuilder::new(dir);
        b.load_identity();
        b.load_tools_ref();
        b.set_agent_instructions("Help with research.");
        b.add_runtime_info(Some("researcher"), Some("kimi"), Some(5));

        let prompt = b.build();
        assert!(prompt.contains("TestBot"));
        assert!(prompt.contains("bash"));
        assert!(prompt.contains("Help with research"));
        assert!(prompt.contains("lumin-rust"));

        // Identity (priority 10) comes before runtime (priority 3)
        let identity_pos = prompt.find("TestBot").unwrap();
        let runtime_pos = prompt.find("lumin-rust").unwrap();
        assert!(identity_pos < runtime_pos);

        let _ = fs::remove_dir_all(dir);
    }
}
