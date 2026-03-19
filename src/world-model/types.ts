/**
 * WorldModel types — structured cross-agent context maintained by the HIL.
 *
 * @module world-model/types
 */

export interface KnowledgeFact {
  key: string;
  value: string;
  sourceAgentId: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AgentCompletionRecord {
  agentId: string;
  task: string;
  resultSummary: string;
  toolsUsed: string[];
  artifactsProduced: string[];
  completedAt: number;
}

export interface WorkspaceState {
  activeComponent: string;
  openFiles: string[];
  recentArtifacts: string[];
  /** Level 1 (brief) summaries from each component's serialize(). */
  componentSummaries: Map<string, string>;
}

export interface WorldModel {
  taskId: string;
  goal: string;
  completedWork: AgentCompletionRecord[];
  workspaceState: WorkspaceState;
  knowledgeBase: KnowledgeFact[];
  agentHandoffNotes: Map<string, string>;
}
