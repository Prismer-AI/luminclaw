//! Workspace config — mirrors TypeScript `workspace.ts`.
//! Loads AGENTS.md and USER.md from workspace directory.

use std::fs;
use std::path::Path;

/// Load workspace configuration files and return their contents.
pub struct WorkspaceConfig {
    pub agents_md: Option<String>,
    pub user_md: Option<String>,
    pub soul_md: Option<String>,
    pub tools_md: Option<String>,
}

impl WorkspaceConfig {
    pub fn load(workspace_dir: &str) -> Self {
        let dir = Path::new(workspace_dir);
        Self {
            agents_md: Self::read_file(dir, "AGENTS.md"),
            user_md: Self::read_file(dir, "USER.md"),
            soul_md: Self::read_file(dir, "SOUL.md"),
            tools_md: Self::read_file(dir, "TOOLS.md"),
        }
    }

    fn read_file(dir: &Path, name: &str) -> Option<String> {
        fs::read_to_string(dir.join(name)).ok().filter(|s| !s.trim().is_empty())
    }

    /// Check if any workspace files are present.
    pub fn has_config(&self) -> bool {
        self.agents_md.is_some() || self.user_md.is_some()
            || self.soul_md.is_some() || self.tools_md.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn load_reads_workspace_files() {
        let dir = "/tmp/lumin-workspace-test-load";
        let _ = fs::create_dir_all(dir);
        fs::write(format!("{dir}/AGENTS.md"), "## Agents\nresearcher: primary").unwrap();
        fs::write(format!("{dir}/USER.md"), "Name: Bob").unwrap();
        fs::write(format!("{dir}/SOUL.md"), "You are a helpful assistant.").unwrap();
        fs::write(format!("{dir}/TOOLS.md"), "# Tools\nbash: run commands").unwrap();

        let config = WorkspaceConfig::load(dir);
        assert!(config.agents_md.is_some());
        assert!(config.agents_md.as_ref().unwrap().contains("researcher"));
        assert!(config.user_md.is_some());
        assert!(config.user_md.as_ref().unwrap().contains("Bob"));
        assert!(config.soul_md.is_some());
        assert!(config.soul_md.as_ref().unwrap().contains("helpful assistant"));
        assert!(config.tools_md.is_some());
        assert!(config.tools_md.as_ref().unwrap().contains("bash"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn has_config_returns_true_when_files_exist() {
        let dir = "/tmp/lumin-workspace-test-has";
        let _ = fs::create_dir_all(dir);
        fs::write(format!("{dir}/AGENTS.md"), "content").unwrap();

        let config = WorkspaceConfig::load(dir);
        assert!(config.has_config());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn has_config_returns_true_with_only_soul_md() {
        let dir = "/tmp/lumin-workspace-test-soul-only";
        let _ = fs::create_dir_all(dir);
        // Remove all config files, only write SOUL.md
        let _ = fs::remove_file(format!("{dir}/AGENTS.md"));
        let _ = fs::remove_file(format!("{dir}/USER.md"));
        let _ = fs::remove_file(format!("{dir}/TOOLS.md"));
        fs::write(format!("{dir}/SOUL.md"), "identity").unwrap();

        let config = WorkspaceConfig::load(dir);
        assert!(config.has_config());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn has_config_returns_false_for_empty_dir() {
        let dir = "/tmp/lumin-workspace-test-empty";
        let _ = fs::create_dir_all(dir);
        // Remove any stale files
        let _ = fs::remove_file(format!("{dir}/AGENTS.md"));
        let _ = fs::remove_file(format!("{dir}/USER.md"));
        let _ = fs::remove_file(format!("{dir}/SOUL.md"));
        let _ = fs::remove_file(format!("{dir}/TOOLS.md"));

        let config = WorkspaceConfig::load(dir);
        assert!(!config.has_config());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn has_config_returns_false_for_nonexistent_dir() {
        let config = WorkspaceConfig::load("/tmp/lumin-workspace-nonexistent-xyz");
        assert!(!config.has_config());
    }

    #[test]
    fn load_ignores_empty_files() {
        let dir = "/tmp/lumin-workspace-test-blank";
        let _ = fs::create_dir_all(dir);
        fs::write(format!("{dir}/AGENTS.md"), "").unwrap();
        fs::write(format!("{dir}/USER.md"), "   \n  ").unwrap(); // whitespace only

        let config = WorkspaceConfig::load(dir);
        assert!(config.agents_md.is_none(), "empty file should be treated as absent");
        assert!(config.user_md.is_none(), "whitespace-only file should be treated as absent");
        assert!(!config.has_config());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_partial_files() {
        let dir = "/tmp/lumin-workspace-test-partial";
        let _ = fs::create_dir_all(dir);
        let _ = fs::remove_file(format!("{dir}/AGENTS.md"));
        let _ = fs::remove_file(format!("{dir}/SOUL.md"));
        let _ = fs::remove_file(format!("{dir}/TOOLS.md"));
        fs::write(format!("{dir}/USER.md"), "Name: Charlie").unwrap();

        let config = WorkspaceConfig::load(dir);
        assert!(config.agents_md.is_none());
        assert!(config.user_md.is_some());
        assert!(config.soul_md.is_none());
        assert!(config.tools_md.is_none());
        assert!(config.has_config());

        let _ = fs::remove_dir_all(dir);
    }
}
