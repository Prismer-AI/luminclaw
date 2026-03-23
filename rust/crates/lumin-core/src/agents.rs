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

    // ── builtin_agents ──

    #[test]
    fn builtin_agents_has_6_agents() {
        let agents = builtin_agents();
        assert_eq!(agents.len(), 6);
    }

    #[test]
    fn builtin_agents_ids_are_correct() {
        let agents = builtin_agents();
        let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["researcher", "latex-expert", "data-analyst", "literature-scout", "compaction", "summarizer"]
        );
    }

    #[test]
    fn researcher_is_primary_with_all_tools() {
        let agents = builtin_agents();
        let researcher = agents.iter().find(|a| a.id == "researcher").unwrap();
        assert_eq!(researcher.mode, AgentMode::Primary);
        assert!(researcher.tools.is_none()); // None = all tools
        assert_eq!(researcher.max_iterations, Some(40));
        assert_eq!(researcher.name, "Research Assistant");
    }

    #[test]
    fn subagents_have_restricted_tool_lists() {
        let agents = builtin_agents();

        let latex = agents.iter().find(|a| a.id == "latex-expert").unwrap();
        assert_eq!(latex.mode, AgentMode::Subagent);
        let tools = latex.tools.as_ref().unwrap();
        assert!(tools.contains(&"latex_compile".to_string()));
        assert!(tools.contains(&"bash".to_string()));
        assert_eq!(latex.max_iterations, Some(20));

        let data = agents.iter().find(|a| a.id == "data-analyst").unwrap();
        assert_eq!(data.mode, AgentMode::Subagent);
        let tools = data.tools.as_ref().unwrap();
        assert!(tools.contains(&"jupyter_execute".to_string()));
        assert!(tools.contains(&"bash".to_string()));
        assert_eq!(data.max_iterations, Some(20));

        let lit = agents.iter().find(|a| a.id == "literature-scout").unwrap();
        assert_eq!(lit.mode, AgentMode::Subagent);
        let tools = lit.tools.as_ref().unwrap();
        assert!(tools.contains(&"arxiv_search".to_string()));
        assert!(tools.contains(&"load_pdf".to_string()));
        assert_eq!(lit.max_iterations, Some(15));
    }

    #[test]
    fn hidden_agents_have_empty_tool_lists() {
        let agents = builtin_agents();

        let compaction = agents.iter().find(|a| a.id == "compaction").unwrap();
        assert_eq!(compaction.mode, AgentMode::Hidden);
        assert_eq!(compaction.tools.as_ref().unwrap().len(), 0);
        assert_eq!(compaction.max_iterations, Some(1));

        let summarizer = agents.iter().find(|a| a.id == "summarizer").unwrap();
        assert_eq!(summarizer.mode, AgentMode::Hidden);
        assert_eq!(summarizer.tools.as_ref().unwrap().len(), 0);
        assert_eq!(summarizer.max_iterations, Some(1));
    }

    // ── AgentRegistry register and get ──

    #[test]
    fn registry_register_and_get() {
        let mut reg = AgentRegistry::new();
        let config = AgentConfig {
            id: "test-agent".into(),
            name: "Test Agent".into(),
            mode: AgentMode::Primary,
            system_prompt: "You are a test agent.".into(),
            model: None,
            tools: None,
            max_iterations: Some(10),
        };
        reg.register(config);

        let retrieved = reg.get("test-agent");
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, "test-agent");
        assert_eq!(retrieved.unwrap().name, "Test Agent");
    }

    #[test]
    fn registry_get_returns_none_for_unknown() {
        let reg = AgentRegistry::new();
        assert!(reg.get("nonexistent").is_none());
    }

    // ── list ──

    #[test]
    fn list_returns_all_agents() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());
        let all = reg.list(None);
        assert_eq!(all.len(), 6);
    }

    #[test]
    fn list_filters_by_primary_mode() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        let primary = reg.list(Some(&AgentMode::Primary));
        assert_eq!(primary.len(), 1);
        assert_eq!(primary[0].id, "researcher");
    }

    #[test]
    fn list_filters_by_subagent_mode() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        let subagents = reg.list(Some(&AgentMode::Subagent));
        assert_eq!(subagents.len(), 3);
        let ids: Vec<&str> = subagents.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"latex-expert"));
        assert!(ids.contains(&"data-analyst"));
        assert!(ids.contains(&"literature-scout"));
    }

    #[test]
    fn list_filters_by_hidden_mode() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        let hidden = reg.list(Some(&AgentMode::Hidden));
        assert_eq!(hidden.len(), 2);
        let ids: Vec<&str> = hidden.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"compaction"));
        assert!(ids.contains(&"summarizer"));
    }

    // ── get_delegatable_agents ──

    #[test]
    fn get_delegatable_agents_returns_only_subagent_ids() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());
        let delegatable = reg.get_delegatable_agents();

        assert_eq!(delegatable.len(), 3);
        assert!(delegatable.contains(&"latex-expert"));
        assert!(delegatable.contains(&"data-analyst"));
        assert!(delegatable.contains(&"literature-scout"));
        // Should NOT contain primary or hidden
        assert!(!delegatable.contains(&"researcher"));
        assert!(!delegatable.contains(&"compaction"));
        assert!(!delegatable.contains(&"summarizer"));
    }

    // ── resolve_from_mention ──

    #[test]
    fn resolve_from_mention_with_valid_mention() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        let result = reg.resolve_from_mention("@latex-expert compile this paper");
        assert!(result.is_some());
        let (id, msg) = result.unwrap();
        assert_eq!(id, "latex-expert");
        assert_eq!(msg, "compile this paper");
    }

    #[test]
    fn resolve_from_mention_data_analyst() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        let result = reg.resolve_from_mention("@data-analyst plot sine wave");
        assert!(result.is_some());
        let (id, msg) = result.unwrap();
        assert_eq!(id, "data-analyst");
        assert_eq!(msg, "plot sine wave");
    }

    #[test]
    fn resolve_from_mention_returns_none_for_no_mention() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        assert!(reg.resolve_from_mention("just a regular message").is_none());
    }

    #[test]
    fn resolve_from_mention_returns_none_for_unknown_agent() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        assert!(reg.resolve_from_mention("@unknown-agent do something").is_none());
    }

    #[test]
    fn resolve_from_mention_returns_none_for_hidden_agent() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        assert!(reg.resolve_from_mention("@compaction summarize this").is_none());
        assert!(reg.resolve_from_mention("@summarizer title this").is_none());
    }

    #[test]
    fn resolve_from_mention_returns_none_without_message_content() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        // No space after agent ID — find(char::is_whitespace) returns None
        assert!(reg.resolve_from_mention("@latex-expert").is_none());
    }

    #[test]
    fn resolve_from_mention_returns_none_for_empty_string() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());
        assert!(reg.resolve_from_mention("").is_none());
    }

    #[test]
    fn resolve_from_mention_trims_message_content() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());

        let result = reg.resolve_from_mention("@latex-expert   compile this  ");
        assert!(result.is_some());
        let (_, msg) = result.unwrap();
        assert_eq!(msg, "compile this");
    }

    // ── AgentRegistry default ──

    #[test]
    fn registry_default_is_empty() {
        let reg = AgentRegistry::default();
        assert!(reg.list(None).is_empty());
    }

    // ── register_many ──

    #[test]
    fn register_many_registers_all() {
        let mut reg = AgentRegistry::new();
        reg.register_many(builtin_agents());
        assert_eq!(reg.list(None).len(), 6);

        // Can retrieve each by ID
        assert!(reg.get("researcher").is_some());
        assert!(reg.get("latex-expert").is_some());
        assert!(reg.get("data-analyst").is_some());
        assert!(reg.get("literature-scout").is_some());
        assert!(reg.get("compaction").is_some());
        assert!(reg.get("summarizer").is_some());
    }
}
