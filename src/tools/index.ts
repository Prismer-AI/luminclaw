/**
 * Tool index — built-in tools + loader for modular workspace tools
 */

export {
  loadWorkspaceTools,
  loadWorkspaceToolsFromPlugin,
  createTool,
  type WorkspaceToolDef,
  type WorkspaceToolResult,
  type WorkspaceToolExecutor,
  type WorkspacePluginConfig,
  type PluginLoadResult,
} from './loader.js';

export { createClawHubTool } from './clawhub.js';

export { BUILTIN_TOOLS, getBuiltinTools, safePath, createBashTool } from './builtins.js';
