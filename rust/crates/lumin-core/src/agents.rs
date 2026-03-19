//! Agent Registry — mirrors TypeScript `agents.ts`.
//! Built-in academic agents with sub-agent delegation support.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentMode { Primary, Subagent, Hidden }

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub mode: AgentMode,
    pub system_prompt: String,
    pub model: Option<String>,
    pub tools: Option<Vec<String>>,  // None = all tools
    pub max_iterations: Option<u32>,
}

pub struct AgentRegistry {
    agents: HashMap<String, AgentConfig>,
}

impl AgentRegistry {
    pub fn new() -> Self { Self { agents: HashMap::new() } }

    pub fn register(&mut self, config: AgentConfig) {
        self.agents.insert(config.id.clone(), config);
    }

    pub fn register_many(&mut self, configs: Vec<AgentConfig>) {
        for c in configs { self.register(c); }
    }

    pub fn get(&self, id: &str) -> Option<&AgentConfig> {
        self.agents.get(id)
    }

    pub fn list(&self, mode: Option<&AgentMode>) -> Vec<&AgentConfig> {
        self.agents.values()
            .filter(|a| mode.map_or(true, |m| &a.mode == m))
            .collect()
    }

    /// Parse @-mention: "@latex-expert compile this" → Some(("latex-expert", "compile this"))
    pub fn resolve_from_mention<'a>(&'a self, content: &'a str) -> Option<(&'a str, &'a str)> {
        if !content.starts_with('@') { return None; }
        let rest = &content[1..];
        let space = rest.find(char::is_whitespace)?;
        let agent_id = &rest[..space];
        let agent = self.agents.get(agent_id)?;
        if agent.mode == AgentMode::Hidden { return None; }
        Some((agent_id, rest[space..].trim()))
    }

    /// Get sub-agent IDs for the delegate tool enum.
    pub fn get_delegatable_agents(&self) -> Vec<&str> {
        self.list(Some(&AgentMode::Subagent)).iter().map(|a| a.id.as_str()).collect()
    }
}

impl Default for AgentRegistry {
    fn default() -> Self { Self::new() }
}

/// 6 built-in academic agents matching the TypeScript BUILTIN_AGENTS.
pub fn builtin_agents() -> Vec<AgentConfig> {
    vec![
        AgentConfig {
            id: "researcher".into(),
            name: "Research Assistant".into(),
            mode: AgentMode::Primary,
            system_prompt: "You are a research assistant — an AI-powered academic research companion.\n\
                You help researchers with paper discovery, reading, data analysis, writing, and peer review.\n\
                You have access to specialized sub-agents that you can delegate tasks to:\n\
                - @latex-expert: LaTeX document writing and compilation\n\
                - @data-analyst: Jupyter notebooks, data analysis, and visualization\n\
                - @literature-scout: Paper search, PDF reading, and literature review\n\
                When a task clearly falls within a sub-agent's expertise, use the \"delegate\" tool to hand it off.\n\
                For general questions, answer directly.\n\
                Always be precise, cite sources when available, and prefer reproducible methods.".into(),
            model: None,
            tools: None,
            max_iterations: Some(40),
        },
        AgentConfig {
            id: "latex-expert".into(),
            name: "LaTeX Expert".into(),
            mode: AgentMode::Subagent,
            system_prompt: "You are a LaTeX expert specializing in academic paper writing.\n\
                You can compile LaTeX documents, manage project files, and help with formatting.\n\
                Supported templates: CVPR, NeurIPS, ICML, ACL, IEEE, arXiv.".into(),
            model: None,
            tools: Some(vec!["latex_compile".into(), "latex_project".into(), "switch_component".into(), "update_content".into(), "bash".into()]),
            max_iterations: Some(20),
        },
        AgentConfig {
            id: "data-analyst".into(),
            name: "Data Analyst".into(),
            mode: AgentMode::Subagent,
            system_prompt: "You are a data analyst specializing in scientific computing and visualization.\n\
                Preferred libraries: numpy, pandas, matplotlib, seaborn, scipy, scikit-learn.".into(),
            model: None,
            tools: Some(vec!["jupyter_execute".into(), "jupyter_notebook".into(), "switch_component".into(), "update_content".into(), "bash".into()]),
            max_iterations: Some(20),
        },
        AgentConfig {
            id: "literature-scout".into(),
            name: "Literature Scout".into(),
            mode: AgentMode::Subagent,
            system_prompt: "You are a literature scout specializing in academic paper discovery and analysis.\n\
                Organize literature reviews by theme, not chronologically.".into(),
            model: None,
            tools: Some(vec!["arxiv_search".into(), "load_pdf".into(), "context_search".into(), "switch_component".into(), "bash".into()]),
            max_iterations: Some(15),
        },
        AgentConfig {
            id: "compaction".into(),
            name: "Compaction Agent".into(),
            mode: AgentMode::Hidden,
            system_prompt: "Summarize the following conversation into key facts and decisions.\n\
                Be concise. Preserve: important findings, code snippets, file paths, decisions made, and action items.".into(),
            model: None,
            tools: Some(vec![]),
            max_iterations: Some(1),
        },
        AgentConfig {
            id: "summarizer".into(),
            name: "Title Summarizer".into(),
            mode: AgentMode::Hidden,
            system_prompt: "Generate a concise title (5-10 words) for this conversation.\n\
                Output only the title, nothing else.".into(),
            model: None,
            tools: Some(vec![]),
            max_iterations: Some(1),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_agents_count() {
        let agents = builtin_agents();
        assert_eq!(agents.len(), 6);
    }

    #[test]
    fn resolve_mention() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        let result = reg.resolve_from_mention("@latex-expert compile this paper");
        assert!(result.is_some());
        let (id, msg) = result.unwrap();
        assert_eq!(id, "latex-expert");
        assert_eq!(msg, "compile this paper");
    }

    #[test]
    fn hidden_agents_not_mentionable() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());
        assert!(reg.resolve_from_mention("@compaction summarize").is_none());
    }

    #[test]
    fn delegatable_agents() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());
        let delegatable = reg.get_delegatable_agents();
        assert_eq!(delegatable.len(), 3);
        assert!(delegatable.contains(&"latex-expert"));
    }
}
