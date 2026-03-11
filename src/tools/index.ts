/**
 * Tool index — loader for modular workspace tools + built-in bash
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
