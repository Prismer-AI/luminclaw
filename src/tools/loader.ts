/**
 * Tool Loader — bridges existing prismer-workspace tools into the Lumin
 * {@link ToolRegistry}.
 *
 * The 40+ academic tools are defined in
 * `docker/plugin/prismer-workspace/src/tools.ts` and expose:
 *   - `setConfig(config)` — inject Cloud IM credentials + workspace config
 *   - `toolDefinitions` — `Array<{ name, description, parameters }>`
 *   - `executeTool(name, params)` — `Promise<ToolResult>`
 *   - `generateWorkspaceMd(state)` — workspace context markdown
 *   - `TOOL_MODULES / expandModules` — module-based filtering
 *
 * This loader dynamically imports the plugin, converts tools to the
 * Lumin {@link Tool} interface, and exposes `generateWorkspaceMd` for
 * the {@link PromptBuilder}.
 *
 * @module tools/loader
 */

import type { Tool, ToolContext, ToolEvent } from '../tools.js';
import { createLogger } from '../log.js';

const log = createLogger('tool-loader');

// ── Types matching prismer-workspace exports ─────────────

export interface WorkspaceToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WorkspaceToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type WorkspaceToolExecutor = (
  name: string,
  params: unknown,
) => Promise<WorkspaceToolResult>;

/** Config passed to the workspace plugin's setConfig() */
export interface WorkspacePluginConfig {
  apiBaseUrl?: string;
  agentId?: string;
  workspaceId?: string;
  // Cloud IM credentials for directive delivery
  imBaseUrl?: string;
  imConversationId?: string;
  imToken?: string;
}

/** Result of loading workspace tools from plugin */
export interface PluginLoadResult {
  tools: Tool[];
  generateWorkspaceMd?: (state: unknown) => string;
}

// ── Loader ───────────────────────────────────────────────

/**
 * Convert prismer-workspace tool definitions + executor into Lumin Tools.
 */
export function loadWorkspaceTools(
  definitions: WorkspaceToolDef[],
  executor: WorkspaceToolExecutor,
  filter?: Set<string>,
): Tool[] {
  return definitions
    .filter(def => !filter || filter.has(def.name))
    .map(def => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
        const result = await executor(def.name, args);

        if (result.success) {
          return JSON.stringify(result.data ?? { ok: true });
        } else {
          return JSON.stringify({ error: result.error ?? 'Unknown error' });
        }
      },
    }));
}

/**
 * Dynamically load workspace tools from the installed plugin path.
 *
 * Key flow:
 *   1. Import plugin module
 *   2. Call setConfig() with Cloud IM credentials + workspace config
 *   3. Apply module filtering (if enabledModules specified)
 *   4. Return tools + generateWorkspaceMd function
 *
 * Returns empty result if plugin not available (graceful degradation).
 */
export async function loadWorkspaceToolsFromPlugin(
  pluginPath: string = '',
  enabledModules?: string[],
  pluginConfig?: WorkspacePluginConfig,
): Promise<PluginLoadResult> {
  if (!pluginPath) {
    log.debug('no plugin path configured, skipping plugin load');
    return { tools: [] };
  }

  try {
    const mod = await import(pluginPath);
    const { toolDefinitions, executeTool, setConfig, generateWorkspaceMd } = mod;

    if (!toolDefinitions || !executeTool) {
      log.warn('plugin missing exports', { pluginPath });
      return { tools: [] };
    }

    // Initialize plugin config BEFORE loading tools
    // This enables Cloud IM directive delivery (sendDirectiveViaCloudIM)
    if (setConfig && pluginConfig) {
      setConfig({
        containerProxyUrl: 'http://localhost:3000',
        apiBaseUrl: pluginConfig.apiBaseUrl ?? 'http://host.docker.internal:3000',
        agentId: pluginConfig.agentId ?? 'default',
        workspaceId: pluginConfig.workspaceId ?? '',
        hasLocalLatex: true,
        hasJupyter: true,
        imBaseUrl: pluginConfig.imBaseUrl,
        imConversationId: pluginConfig.imConversationId,
        imToken: pluginConfig.imToken,
      });
      log.debug('plugin config set', { im: !!pluginConfig.imBaseUrl });
    }

    // Apply module filtering if specified
    let filter: Set<string> | undefined;
    if (enabledModules) {
      try {
        const { expandModules } = await import(
          pluginPath.replace('/tools.js', '/modules.js')
        );
        if (expandModules) {
          filter = expandModules(enabledModules);
        }
      } catch { /* module filtering unavailable */ }
    }

    const tools = loadWorkspaceTools(toolDefinitions, executeTool, filter);
    log.info('loaded tools from plugin', { count: tools.length });
    return { tools, generateWorkspaceMd };
  } catch (err) {
    log.warn('plugin not available', { pluginPath, error: String(err) });
    return { tools: [] };
  }
}

// createTool has moved to ../tools.ts — re-export for backward compatibility.
export { createTool } from '../tools.js';
