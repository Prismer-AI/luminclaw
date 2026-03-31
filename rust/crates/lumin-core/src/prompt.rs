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
                content: "## Identity\n\nYou are a Prismer research assistant — an AI-powered academic research companion.\nYou help researchers with paper discovery, reading, data analysis, writing, and peer review.\nYou have access to specialized tools for LaTeX, Jupyter, PDF viewing, notes, and more.\nWhen a task requires a specific tool, use it directly. Be precise and cite sources when available.\nYou maintain conversation context across messages in the same session.".into(),
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

    #[test]
    fn default_identity_contains_prismer_assistant() {
        let dir = "/tmp/lumin-prompt-no-soul";
        let _ = fs::create_dir_all(dir);
        // Ensure SOUL.md does NOT exist
        let _ = fs::remove_file(format!("{dir}/SOUL.md"));

        let mut b = PromptBuilder::new(dir);
        b.load_identity();

        let prompt = b.build();
        assert!(
            prompt.contains("Prismer research assistant"),
            "Default identity should contain 'Prismer research assistant'"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn priority_ordering_identity_over_agent_config_over_tools_over_runtime() {
        let dir = "/tmp/lumin-prompt-priority";
        let _ = fs::create_dir_all(dir);
        fs::write(format!("{dir}/SOUL.md"), "IDENTITY_MARKER").unwrap();
        fs::write(format!("{dir}/AGENTS.md"), "AGENT_CONFIG_MARKER").unwrap();
        fs::write(format!("{dir}/TOOLS.md"), "TOOLS_REF_MARKER").unwrap();

        let mut b = PromptBuilder::new(dir);
        b.load_identity();        // priority 10
        b.load_agent_config();    // priority 9
        b.load_tools_ref();       // priority 8
        b.add_runtime_info(Some("test"), None, None);  // priority 3

        let prompt = b.build();

        let identity_pos = prompt.find("IDENTITY_MARKER").unwrap();
        let config_pos = prompt.find("AGENT_CONFIG_MARKER").unwrap();
        let tools_pos = prompt.find("TOOLS_REF_MARKER").unwrap();
        let runtime_pos = prompt.find("Runtime Info").unwrap();

        assert!(identity_pos < config_pos, "identity (10) before agent_config (9)");
        assert!(config_pos < tools_pos, "agent_config (9) before tools (8)");
        assert!(tools_pos < runtime_pos, "tools (8) before runtime (3)");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn add_section_with_custom_priority() {
        let dir = "/tmp/lumin-prompt-custom";
        let _ = fs::create_dir_all(dir);

        let mut b = PromptBuilder::new(dir);
        b.add_runtime_info(None, None, None);  // priority 3

        b.add_section(PromptSection {
            id: "custom".into(),
            content: "CUSTOM_HIGH_PRIORITY".into(),
            priority: 100.0,
        });

        b.add_section(PromptSection {
            id: "custom-low".into(),
            content: "CUSTOM_LOW_PRIORITY".into(),
            priority: 1.0,
        });

        let prompt = b.build();
        let high_pos = prompt.find("CUSTOM_HIGH_PRIORITY").unwrap();
        let runtime_pos = prompt.find("Runtime Info").unwrap();
        let low_pos = prompt.find("CUSTOM_LOW_PRIORITY").unwrap();

        assert!(high_pos < runtime_pos, "high priority custom before runtime");
        assert!(runtime_pos < low_pos, "runtime before low priority custom");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn add_memory_context_skips_empty_string() {
        let dir = "/tmp/lumin-prompt-memory";
        let _ = fs::create_dir_all(dir);

        let mut b = PromptBuilder::new(dir);
        b.add_memory_context("");
        let prompt = b.build();
        assert!(!prompt.contains("Recent Memory"), "empty memory should not add a section");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn add_memory_context_adds_non_empty() {
        let dir = "/tmp/lumin-prompt-memory2";
        let _ = fs::create_dir_all(dir);

        let mut b = PromptBuilder::new(dir);
        b.add_memory_context("User prefers Rust.");
        let prompt = b.build();
        assert!(prompt.contains("Recent Memory"));
        assert!(prompt.contains("User prefers Rust."));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn add_skill_sections_adds_multiple() {
        let dir = "/tmp/lumin-prompt-skills";
        let _ = fs::create_dir_all(dir);

        let mut b = PromptBuilder::new(dir);
        b.add_skill_sections(vec![
            ("latex".into(), "Compile LaTeX documents.".into()),
            ("jupyter".into(), "Run Jupyter notebooks.".into()),
        ]);

        let prompt = b.build();
        assert!(prompt.contains("Skill: latex"));
        assert!(prompt.contains("Compile LaTeX documents."));
        assert!(prompt.contains("Skill: jupyter"));
        assert!(prompt.contains("Run Jupyter notebooks."));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn add_skill_sections_empty_is_noop() {
        let dir = "/tmp/lumin-prompt-skills-empty";
        let _ = fs::create_dir_all(dir);

        let mut b = PromptBuilder::new(dir);
        b.add_skill_sections(vec![]);
        let prompt = b.build();
        assert!(!prompt.contains("Skill:"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn set_workspace_context_adds_section() {
        let dir = "/tmp/lumin-prompt-workspace";
        let _ = fs::create_dir_all(dir);

        let mut b = PromptBuilder::new(dir);
        b.set_workspace_context("Project uses Next.js 14.");

        let prompt = b.build();
        assert!(prompt.contains("Workspace"));
        assert!(prompt.contains("Project uses Next.js 14."));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn set_agent_instructions_adds_section() {
        let dir = "/tmp/lumin-prompt-instructions";
        let _ = fs::create_dir_all(dir);

        let mut b = PromptBuilder::new(dir);
        b.set_agent_instructions("Always respond in JSON format.");

        let prompt = b.build();
        assert!(prompt.contains("Instructions"));
        assert!(prompt.contains("Always respond in JSON format."));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn user_profile_loads_when_present() {
        let dir = "/tmp/lumin-prompt-user";
        let _ = fs::create_dir_all(dir);
        fs::write(format!("{dir}/USER.md"), "Name: Alice\nRole: PhD student").unwrap();

        let mut b = PromptBuilder::new(dir);
        b.load_user_profile();

        let prompt = b.build();
        assert!(prompt.contains("User Profile"));
        assert!(prompt.contains("Alice"));
        assert!(prompt.contains("PhD student"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn build_empty_builder_returns_empty() {
        let dir = "/tmp/lumin-prompt-empty";
        let _ = fs::create_dir_all(dir);

        let b = PromptBuilder::new(dir);
        let prompt = b.build();
        assert!(prompt.is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sections_separated_by_divider() {
        let dir = "/tmp/lumin-prompt-divider";
        let _ = fs::create_dir_all(dir);

        let mut b = PromptBuilder::new(dir);
        b.add_section(PromptSection {
            id: "a".into(),
            content: "Section A".into(),
            priority: 10.0,
        });
        b.add_section(PromptSection {
            id: "b".into(),
            content: "Section B".into(),
            priority: 5.0,
        });

        let prompt = b.build();
        assert!(prompt.contains("---"), "sections should be separated by ---");
        // Verify ordering
        let a_pos = prompt.find("Section A").unwrap();
        let b_pos = prompt.find("Section B").unwrap();
        assert!(a_pos < b_pos);

        let _ = fs::remove_dir_all(dir);
    }
}
