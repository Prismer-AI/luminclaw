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
