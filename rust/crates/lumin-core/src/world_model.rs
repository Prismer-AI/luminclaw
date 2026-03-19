//! WorldModel — structured cross-agent context. Mirrors TypeScript `world-model/`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const HANDOFF_BUDGET: usize = 3_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeFact {
    pub key: String,
    pub value: String,
    pub source_agent_id: String,
    pub confidence: String, // "high" | "medium" | "low"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCompletionRecord {
    pub agent_id: String,
    pub task: String,
    pub result_summary: String,
    pub tools_used: Vec<String>,
    pub completed_at: u64,
}

#[derive(Debug, Clone)]
pub struct WorldModel {
    pub task_id: String,
    pub goal: String,
    pub completed_work: Vec<AgentCompletionRecord>,
    pub knowledge_base: Vec<KnowledgeFact>,
    pub active_component: String,
    pub handoff_notes: HashMap<String, String>,
}

impl WorldModel {
    pub fn new(task_id: &str, goal: &str) -> Self {
        Self {
            task_id: task_id.into(),
            goal: goal.into(),
            completed_work: vec![],
            knowledge_base: vec![],
            active_component: String::new(),
            handoff_notes: HashMap::new(),
        }
    }

    /// Build compact handoff context (≤ 3000 chars).
    pub fn build_handoff_context(&self, target_agent_id: &str) -> String {
        let mut parts = Vec::new();

        parts.push(format!("## Task Goal\n{}", &self.goal[..self.goal.len().min(300)]));

        if !self.completed_work.is_empty() {
            parts.push("## Completed Work".into());
            let recent = &self.completed_work[self.completed_work.len().saturating_sub(10)..];
            let older_count = self.completed_work.len().saturating_sub(10);
            if older_count > 0 {
                parts.push(format!("- [{older_count} earlier steps]"));
            }
            for w in recent {
                let task = &w.task[..w.task.len().min(80)];
                let summary = &w.result_summary[..w.result_summary.len().min(120)];
                parts.push(format!("- [{}] {} → {}", w.agent_id, task, summary));
            }
        }

        if !self.knowledge_base.is_empty() {
            parts.push("## Known Facts".into());
            for f in self.knowledge_base.iter().filter(|f| f.confidence != "low").take(20) {
                let val = &f.value[..f.value.len().min(100)];
                parts.push(format!("- {}: {val}", f.key));
            }
        }

        parts.push(format!("## Workspace State\n- Active: {}", if self.active_component.is_empty() { "none" } else { &self.active_component }));

        if let Some(note) = self.handoff_notes.get(target_agent_id) {
            parts.push(format!("## Your Context\n{}", &note[..note.len().min(500)]));
        }

        let mut result = parts.join("\n\n");
        if result.len() > HANDOFF_BUDGET {
            result.truncate(HANDOFF_BUDGET);
            if let Some(pos) = result.rfind('\n') {
                result.truncate(pos);
            }
            result.push_str("\n[... truncated to context budget]");
        }
        result
    }

    /// Fast regex-based fact extraction (zero LLM cost).
    pub fn extract_structured_facts(text: &str, agent_id: &str) -> Vec<KnowledgeFact> {
        let mut facts = Vec::new();

        // File paths
        let path_re = regex_lite::Regex::new(r"/workspace/[\w./-]+").unwrap();
        for (i, m) in path_re.find_iter(text).enumerate() {
            if i >= 5 { break; }
            facts.push(KnowledgeFact {
                key: "file_path".into(),
                value: m.as_str().into(),
                source_agent_id: agent_id.into(),
                confidence: "high".into(),
            });
        }

        facts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_within_budget() {
        let mut model = WorldModel::new("t1", "Write a paper about transformers");
        for i in 0..20 {
            model.completed_work.push(AgentCompletionRecord {
                agent_id: format!("agent-{i}"),
                task: "X".repeat(100),
                result_summary: "Y".repeat(100),
                tools_used: vec!["bash".into()],
                completed_at: 0,
            });
        }
        let ctx = model.build_handoff_context("test");
        assert!(ctx.len() <= 3000);
    }

    #[test]
    fn extract_paths() {
        let facts = WorldModel::extract_structured_facts("File at /workspace/paper/main.tex", "a1");
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].value, "/workspace/paper/main.tex");
    }
}
