//! WorldModel — structured cross-agent context. Mirrors TypeScript `world-model/`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const HANDOFF_BUDGET: usize = 3_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFact {
    pub key: String,
    pub value: String,
    pub source_agent_id: String,
    pub confidence: String, // "high" | "medium" | "low"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompletionRecord {
    pub agent_id: String,
    pub task: String,
    pub result_summary: String,
    pub tools_used: Vec<String>,
    pub artifacts_produced: Vec<String>,
    pub completed_at: u64,
}

#[derive(Debug, Clone)]
pub struct WorldModel {
    pub task_id: String,
    pub goal: String,
    pub completed_work: Vec<AgentCompletionRecord>,
    pub knowledge_base: Vec<KnowledgeFact>,
    pub active_component: String,
    pub open_files: Vec<String>,
    pub recent_artifacts: Vec<String>,
    pub component_summaries: HashMap<String, String>,
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
            open_files: vec![],
            recent_artifacts: vec![],
            component_summaries: HashMap::new(),
            handoff_notes: HashMap::new(),
        }
    }

    /// Record agent completion.
    pub fn record_completion(&mut self, record: AgentCompletionRecord) {
        self.completed_work.push(record);
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

        // Workspace state
        let mut ws_parts = vec![format!("## Workspace State\n- Active: {}", if self.active_component.is_empty() { "none" } else { &self.active_component })];
        if !self.open_files.is_empty() {
            ws_parts.push(format!("- Open files: {}", self.open_files.join(", ")));
        }
        if !self.recent_artifacts.is_empty() {
            ws_parts.push(format!("- Recent artifacts: {}", self.recent_artifacts.join(", ")));
        }
        for (comp, summary) in &self.component_summaries {
            ws_parts.push(format!("- {comp}: {}", &summary[..summary.len().min(80)]));
        }
        parts.push(ws_parts.join("\n"));

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
    /// Extracts file paths and measurements.
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

        // Measurements (e.g., "42 citations", "3.14 sections")
        let meas_re = regex_lite::Regex::new(
            r"\b(\d+(?:\.\d+)?)\s*(citations?|sections?|pages?|figures?|tables?|equations?|references?|words?|paragraphs?|chapters?|experiments?|results?|iterations?|epochs?|samples?|tokens?|parameters?|layers?)\b"
        ).unwrap();
        for (i, m) in meas_re.find_iter(text).enumerate() {
            if i >= 5 { break; }
            facts.push(KnowledgeFact {
                key: "measurement".into(),
                value: m.as_str().into(),
                source_agent_id: agent_id.into(),
                confidence: "medium".into(),
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
                artifacts_produced: vec![],
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

    #[test]
    fn extract_measurements() {
        let facts = WorldModel::extract_structured_facts("Found 42 citations and 3 figures", "a1");
        assert!(facts.len() >= 2);
        assert!(facts.iter().any(|f| f.key == "measurement" && f.value.contains("42 citations")));
        assert!(facts.iter().any(|f| f.key == "measurement" && f.value.contains("3 figures")));
    }

    #[test]
    fn handoff_includes_workspace_state() {
        let mut model = WorldModel::new("t1", "Test");
        model.open_files = vec!["main.tex".into()];
        model.component_summaries.insert("editor".into(), "LaTeX editing in progress".into());
        let ctx = model.build_handoff_context("agent-1");
        assert!(ctx.contains("main.tex"));
        assert!(ctx.contains("editor"));
    }

    // ── Additional tests for TS parity ──

    #[test]
    fn world_model_new_initializes_empty_fields() {
        let model = WorldModel::new("task-1", "Write a paper about AI");
        assert_eq!(model.task_id, "task-1");
        assert_eq!(model.goal, "Write a paper about AI");
        assert!(model.completed_work.is_empty());
        assert!(model.knowledge_base.is_empty());
        assert!(model.active_component.is_empty());
        assert!(model.open_files.is_empty());
        assert!(model.recent_artifacts.is_empty());
        assert!(model.component_summaries.is_empty());
        assert!(model.handoff_notes.is_empty());
    }

    #[test]
    fn record_completion_appends_records() {
        let mut model = WorldModel::new("t1", "Test");
        assert!(model.completed_work.is_empty());

        model.record_completion(AgentCompletionRecord {
            agent_id: "agent-1".into(),
            task: "First task".into(),
            result_summary: "Done".into(),
            tools_used: vec!["bash".into()],
            artifacts_produced: vec![],
            completed_at: 1000,
        });
        assert_eq!(model.completed_work.len(), 1);

        model.record_completion(AgentCompletionRecord {
            agent_id: "agent-2".into(),
            task: "Second task".into(),
            result_summary: "Also done".into(),
            tools_used: vec!["read_file".into()],
            artifacts_produced: vec![],
            completed_at: 2000,
        });
        assert_eq!(model.completed_work.len(), 2);
        assert_eq!(model.completed_work[0].agent_id, "agent-1");
        assert_eq!(model.completed_work[1].agent_id, "agent-2");
    }

    #[test]
    fn build_handoff_context_includes_goal() {
        let model = WorldModel::new("t1", "Analyze dataset");
        let ctx = model.build_handoff_context("test-agent");
        assert!(ctx.contains("Analyze dataset"));
    }

    #[test]
    fn build_handoff_context_includes_completed_work() {
        let mut model = WorldModel::new("t1", "Test goal");
        model.record_completion(AgentCompletionRecord {
            agent_id: "data-analyst".into(),
            task: "Run statistical analysis".into(),
            result_summary: "Found 3 significant correlations".into(),
            tools_used: vec!["bash".into()],
            artifacts_produced: vec![],
            completed_at: 0,
        });

        let ctx = model.build_handoff_context("other-agent");
        assert!(ctx.contains("data-analyst"));
        assert!(ctx.contains("Run statistical analysis"));
        assert!(ctx.contains("3 significant correlations"));
    }

    #[test]
    fn build_handoff_context_includes_knowledge_facts() {
        let mut model = WorldModel::new("t1", "Test");
        model.knowledge_base.push(KnowledgeFact {
            key: "correlation_count".into(),
            value: "3".into(),
            source_agent_id: "data-analyst".into(),
            confidence: "high".into(),
        });

        let ctx = model.build_handoff_context("test-agent");
        assert!(ctx.contains("correlation_count"));
        assert!(ctx.contains("3"));
    }

    #[test]
    fn build_handoff_context_filters_low_confidence_facts() {
        let mut model = WorldModel::new("t1", "Test");
        model.knowledge_base.push(KnowledgeFact {
            key: "high_fact".into(),
            value: "visible".into(),
            source_agent_id: "a".into(),
            confidence: "high".into(),
        });
        model.knowledge_base.push(KnowledgeFact {
            key: "low_fact".into(),
            value: "hidden".into(),
            source_agent_id: "a".into(),
            confidence: "low".into(),
        });

        let ctx = model.build_handoff_context("test");
        assert!(ctx.contains("visible"));
        assert!(!ctx.contains("hidden"));
    }

    #[test]
    fn build_handoff_context_includes_agent_specific_notes() {
        let mut model = WorldModel::new("t1", "Research");
        model.handoff_notes.insert("latex-expert".into(), "Use CVPR template, 2-column format".into());

        let ctx = model.build_handoff_context("latex-expert");
        assert!(ctx.contains("CVPR template"));
        assert!(ctx.contains("2-column format"));
    }

    #[test]
    fn build_handoff_context_no_notes_for_other_agent() {
        let mut model = WorldModel::new("t1", "Research");
        model.handoff_notes.insert("latex-expert".into(), "Use CVPR template".into());

        let ctx = model.build_handoff_context("data-analyst");
        // Should NOT contain the latex-expert's handoff note
        assert!(!ctx.contains("CVPR template"));
    }

    #[test]
    fn build_handoff_context_respects_3000_char_budget() {
        let mut model = WorldModel::new("t1", &"A".repeat(500));

        // Add lots of completed work
        for i in 0..20 {
            model.record_completion(AgentCompletionRecord {
                agent_id: format!("agent-{i}"),
                task: format!("Task {i}: {}", "X".repeat(100)),
                result_summary: format!("Result {i}: {}", "Y".repeat(100)),
                tools_used: vec!["bash".into()],
                artifacts_produced: vec![],
                completed_at: 0,
            });
        }

        // Add lots of facts
        for i in 0..30 {
            model.knowledge_base.push(KnowledgeFact {
                key: format!("fact_{i}"),
                value: "Z".repeat(80),
                source_agent_id: "test".into(),
                confidence: "high".into(),
            });
        }

        let ctx = model.build_handoff_context("test-agent");
        assert!(ctx.len() <= 3000 + 50); // allow small margin for the truncation message
        assert!(ctx.contains("[... truncated to context budget]"));
    }

    #[test]
    fn extract_structured_facts_with_no_matches_returns_empty() {
        let facts = WorldModel::extract_structured_facts("Hello world, nothing special here", "agent-1");
        assert!(facts.is_empty());
    }

    #[test]
    fn extract_structured_facts_limits_to_5_per_category() {
        let paths: Vec<String> = (0..10).map(|i| format!("/workspace/file{i}.txt")).collect();
        let text = paths.join(" ");
        let facts = WorldModel::extract_structured_facts(&text, "agent-1");
        let path_facts: Vec<_> = facts.iter().filter(|f| f.key == "file_path").collect();
        assert!(path_facts.len() <= 5);
    }

    #[test]
    fn extract_structured_facts_extracts_multiple_paths() {
        let facts = WorldModel::extract_structured_facts(
            "Created file at /workspace/paper/main.tex and /workspace/data/results.csv",
            "agent-1",
        );
        let paths: Vec<_> = facts.iter().filter(|f| f.key == "file_path").collect();
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].value, "/workspace/paper/main.tex");
        assert_eq!(paths[1].value, "/workspace/data/results.csv");
        assert_eq!(paths[0].confidence, "high");
    }

    #[test]
    fn extract_structured_facts_extracts_measurements() {
        let facts = WorldModel::extract_structured_facts(
            "Found 47 citations across 8 sections, total 3 figures",
            "agent-1",
        );
        let measurements: Vec<_> = facts.iter().filter(|f| f.key == "measurement").collect();
        assert!(measurements.len() >= 2);
    }

    #[test]
    fn multiple_records_accumulate() {
        let mut model = WorldModel::new("t1", "Big project");
        for i in 0..5 {
            model.record_completion(AgentCompletionRecord {
                agent_id: format!("agent-{i}"),
                task: format!("task-{i}"),
                result_summary: format!("result-{i}"),
                tools_used: vec![],
                artifacts_produced: vec![],
                completed_at: i as u64,
            });
        }
        assert_eq!(model.completed_work.len(), 5);
        for i in 0..5 {
            assert_eq!(model.completed_work[i].agent_id, format!("agent-{i}"));
        }
    }

    #[test]
    fn handoff_with_empty_workspace_state() {
        let model = WorldModel::new("t1", "Empty state test");
        let ctx = model.build_handoff_context("agent-1");
        // Should contain the goal
        assert!(ctx.contains("Empty state test"));
        // Active should be "none"
        assert!(ctx.contains("none"));
        // Should not contain open files or artifacts sections
        assert!(!ctx.contains("Open files:"));
        assert!(!ctx.contains("Recent artifacts:"));
    }
}
