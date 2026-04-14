/**
 * WorldModel builder — handoff context and knowledge extraction.
 *
 * @module world-model/builder
 */

import type { WorldModel, KnowledgeFact, AgentCompletionRecord } from './types.js';
import type { Provider } from '../provider.js';
import { createLogger } from '../log.js';

const log = createLogger('world-model');

const HANDOFF_BUDGET = 3_000; // chars

// ── Factory ───────────────────────────────────────────────

export function createWorldModel(taskId: string, goal: string): WorldModel {
  return {
    taskId,
    goal,
    completedWork: [],
    workspaceState: {
      activeComponent: '',
      openFiles: [],
      recentArtifacts: [],
      componentSummaries: new Map(),
    },
    knowledgeBase: [],
    agentHandoffNotes: new Map(),
  };
}

// ── Handoff Context ───────────────────────────────────────

/**
 * Build a compact context string (≤ 3,000 chars) for injecting into a
 * sub-agent's system prompt. Replaces the old "last-4-messages" approach.
 */
export function buildHandoffContext(model: WorldModel, targetAgentId: string): string {
  const parts: string[] = [];

  parts.push(`## Task Goal\n${model.goal.slice(0, 300)}`);

  if (model.completedWork.length > 0) {
    parts.push('## Completed Work');
    const recent = model.completedWork.slice(-10);
    const older = model.completedWork.slice(0, -10);

    if (older.length > 0) {
      parts.push(`- [${older.length} earlier steps — see MemoryStore for details]`);
    }
    recent.forEach(w =>
      parts.push(`- [${w.agentId}] ${w.task.slice(0, 80)} → ${w.resultSummary.slice(0, 120)}`)
    );
  }

  if (model.knowledgeBase.length > 0) {
    parts.push('## Known Facts');
    model.knowledgeBase
      .filter(f => f.confidence !== 'low')
      .slice(0, 20)
      .forEach(f => parts.push(`- ${f.key}: ${String(f.value).slice(0, 100)}`));
  }

  parts.push('## Workspace State');
  parts.push(`- Active: ${model.workspaceState.activeComponent || 'none'}`);
  model.workspaceState.componentSummaries.forEach((summary, type) =>
    parts.push(`- ${type}: ${summary}`)
  );

  const note = model.agentHandoffNotes.get(targetAgentId);
  if (note) parts.push(`## Your Context\n${note.slice(0, 500)}`);

  let result = parts.join('\n\n');
  if (result.length > HANDOFF_BUDGET) {
    result = result.slice(0, HANDOFF_BUDGET);
    const lastNewline = result.lastIndexOf('\n');
    result = result.slice(0, lastNewline) + '\n[... truncated to context budget]';
  }
  return result;
}

// ── Knowledge Extraction ──────────────────────────────────

/**
 * Fast regex extraction — runs synchronously, zero LLM cost.
 * Extracts file paths and numeric measurements from text.
 */
export function extractStructuredFacts(text: string, agentId: string = 'unknown'): KnowledgeFact[] {
  const facts: KnowledgeFact[] = [];

  // File paths: /workspace/foo/bar.ext
  const paths = text.match(/\/workspace\/[\w./-]+/g) ?? [];
  paths.slice(0, 5).forEach(p =>
    facts.push({ key: 'file_path', value: p, sourceAgentId: agentId, confidence: 'high' })
  );

  // Numbers with units
  const counts = text.match(/\b(\d+(?:\.\d+)?)\s*(citations?|sections?|cells?|rows?|MB|KB|GB|pages?|files?)\b/gi) ?? [];
  counts.slice(0, 5).forEach(m =>
    facts.push({ key: 'measurement', value: m, sourceAgentId: agentId, confidence: 'medium' })
  );

  return facts;
}

/**
 * Background knowledge extraction — fire-and-forget.
 * Fast regex path runs always; LLM extraction runs only when toolsUsed > 3.
 */
export async function extractKnowledgeBackground(
  result: { text: string; toolsUsed: string[]; compactionSummary?: string | null },
  task: string,
  agentId: string,
  worldModel: WorldModel,
  provider?: Provider,
): Promise<void> {
  // Fast path: regex extraction (always runs)
  const fastFacts = extractStructuredFacts(result.text, agentId);
  fastFacts.forEach(f => worldModel.knowledgeBase.push(f));

  // Slow path: LLM extraction (only for substantial work)
  if (result.toolsUsed.length > 3 && provider) {
    try {
      const input = [
        `Task: ${task}`,
        `Agent output:\n${result.text.slice(0, 2000)}`,
        result.compactionSummary ? `Prior context:\n${result.compactionSummary.slice(0, 1000)}` : '',
      ].filter(Boolean).join('\n\n');

      const response = await provider.chat({
        messages: [
          { role: 'system', content: 'Extract key facts as JSON array: [{"key":"...","value":"...","confidence":"high|medium"}]. Max 5 facts. Be concise.' },
          { role: 'user', content: input },
        ],
        maxTokens: 500,
      });

      try {
        const parsed = JSON.parse(response.text);
        if (Array.isArray(parsed)) {
          parsed.slice(0, 5).forEach((f: { key: string; value: string; confidence?: string }) => {
            worldModel.knowledgeBase.push({
              key: f.key,
              value: f.value,
              sourceAgentId: agentId,
              confidence: (f.confidence as 'high' | 'medium' | 'low') ?? 'medium',
            });
          });
        }
      } catch { /* LLM returned non-JSON, ignore */ }
    } catch (err) {
      log.warn('extractKnowledge failed (non-fatal)', { error: err });
      worldModel.knowledgeBase.push({
        key: `agent_${agentId}_status`,
        value: `completed task "${task.slice(0, 80)}" (extraction failed)`,
        sourceAgentId: agentId,
        confidence: 'low',
      });
    }
  }
}

/**
 * Record a sub-agent's completion in the WorldModel.
 */
export function recordCompletion(
  worldModel: WorldModel,
  record: AgentCompletionRecord,
): void {
  worldModel.completedWork.push(record);
}

// ── Knowledge Serialization ───────────────────────────────

const CONFIDENCE_ORDER: Record<KnowledgeFact['confidence'], number> = {
  high: 0, medium: 1, low: 2,
};

export function serializeKnowledgeBaseForMemory(facts: KnowledgeFact[]): string {
  const sorted = [...facts].sort(
    (a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence],
  );
  return sorted.map(f => `${f.key}: ${f.value}`).join('\n');
}
