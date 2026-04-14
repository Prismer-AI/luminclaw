/**
 * LoCoMo Benchmark — public long-term memory evaluation.
 *
 * Uses the LoCoMo dataset (Snap Research, https://github.com/snap-research/locomo)
 * to evaluate Lumin's memory pipeline against a standardized benchmark.
 *
 * 5 QA categories:
 *   Cat 1: Single-hop factual (who/what)
 *   Cat 2: Temporal reasoning (when)
 *   Cat 3: Multi-hop inference (why/would)
 *   Cat 4: Open-domain narrative (details)
 *   Cat 5: Adversarial (unanswerable — correct answer is "unknown")
 *
 * Pipeline:
 *   1. Store all conversation sessions to FileMemoryBackend (same as Letta approach)
 *   2. For each QA: keyword search → retrieve relevant memory → LLM answer
 *   3. Score with LLM-as-judge (non-adversarial) or abstention detection (adversarial)
 *
 * Baseline: Letta/MemGPT filesystem approach ≈ 74% on full LoCoMo.
 *
 * Requires real LLM gateway. Skips gracefully when unavailable.
 * Run: npx vitest run tests/locomo-benchmark.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { MemoryStore } from '../src/memory.js';
import { FileMemoryBackend } from '../src/memory-file-backend.js';

// ── Config ──

const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'us-kimi-k2.5';

// Sample 1 (conv-30) — smallest: 19 sessions, 369 turns, 43K chars, 105 QA pairs
const SAMPLE_INDEX = 1;
const MAX_QA_PER_CATEGORY = 15;

// ── Gateway Reachability ──

function isGatewayReachable(): boolean {
  try {
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${BASE_URL.replace('/v1', '')}/health"`,
      { encoding: 'utf8', timeout: 10_000 },
    );
    return result.trim() === '200' || result.trim() === '404';
  } catch {
    return false;
  }
}

// ── Types ──

interface LoCoMoTurn { speaker: string; dia_id: string; text: string }
interface LoCoMoQA {
  question: string;
  answer?: string | number;
  adversarial_answer?: string;
  evidence: string[];
  category: number;
}
interface LoCoMoSample {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: LoCoMoQA[];
}
interface QAResult {
  question: string;
  category: number;
  expectedAnswer: string;
  llmResponse: string;
  correct: boolean;
  memoryHits: number;
  memoryBestScore: number;
}
interface CategoryScore {
  category: number;
  label: string;
  total: number;
  correct: number;
  accuracy: number;
}
interface LoCoMoBenchmarkResult {
  startTime: string;
  endTime: string;
  totalDurationMs: number;
  model: string;
  sampleId: string;
  sessionCount: number;
  turnCount: number;
  totalChars: number;
  memoryStoreChars: number;
  qaEvaluated: number;
  categoryScores: CategoryScore[];
  overallAccuracy: number;
  overallAccuracyNoAdversarial: number;
  qaResults: QAResult[];
  chart: string;
}

const CATEGORY_LABELS: Record<number, string> = {
  1: 'Single-hop',
  2: 'Temporal',
  3: 'Multi-hop',
  4: 'Open-domain',
  5: 'Adversarial',
};

// ── Dataset Loader ──

function loadLoCoMoSample(index: number) {
  const dataPath = join(process.cwd(), 'tests', 'fixtures', 'locomo10.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf-8')) as LoCoMoSample[];
  const sample = data[index];

  const conv = sample.conversation as Record<string, unknown>;
  const sessionKeys = Object.keys(conv)
    .filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));

  const sessions = sessionKeys.map(key => ({
    key,
    date: (conv[`${key}_date_time`] as string) || '',
    turns: conv[key] as LoCoMoTurn[],
  }));

  const speakerA = conv['speaker_a'] as string;
  const speakerB = conv['speaker_b'] as string;

  return { sample, sessions, speakerA, speakerB };
}

// ── Memory Ingestion (Direct Storage — Letta approach) ──

/**
 * Store each session's conversation as a memory entry.
 * This mirrors the Letta/MemGPT "append-only journal" approach:
 * store everything, rely on search for recall.
 */
async function ingestSessionToMemory(
  memoryStore: MemoryStore,
  session: { key: string; date: string; turns: LoCoMoTurn[] },
): Promise<number> {
  // Format the session as a readable conversation log
  const lines: string[] = [];
  if (session.date) {
    lines.push(`[${session.date}]`);
  }
  for (const turn of session.turns) {
    lines.push(`${turn.speaker}: ${turn.text}`);
  }
  const text = lines.join('\n');

  // Store with session metadata as tags
  await memoryStore.store(text, ['locomo', session.key]);
  return text.length;
}

// ── QA Helpers ──

function selectQAPairs(qa: LoCoMoQA[], maxPerCat: number): LoCoMoQA[] {
  const selected: LoCoMoQA[] = [];
  for (let cat = 1; cat <= 5; cat++) {
    const catQA = qa.filter(q => q.category === cat);
    selected.push(...catQA.slice(0, maxPerCat));
  }
  return selected;
}

/**
 * Build search query from question — extract significant words for keyword search.
 */
function buildSearchQuery(question: string, speakerA: string, speakerB: string): string {
  // Remove common question words, keep content words ≥ 3 chars
  const stopWords = new Set([
    'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
    'did', 'does', 'was', 'were', 'has', 'have', 'had', 'the', 'and', 'for',
    'that', 'this', 'with', 'from', 'about', 'into', 'after', 'before',
    'would', 'could', 'should', 'will', 'still', 'also', 'been', 'being',
  ]);

  return question
    .replace(/[?.,!'"]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w.toLowerCase()))
    // Replace speaker references with actual names for better keyword matching
    .map(w => {
      const lower = w.toLowerCase();
      if (lower === speakerA.toLowerCase()) return speakerA;
      if (lower === speakerB.toLowerCase()) return speakerB;
      return w;
    })
    .slice(0, 8) // Keep top 8 keywords
    .join(' ');
}

async function judgeAnswer(
  provider: OpenAICompatibleProvider,
  question: string,
  expectedAnswer: string,
  actualResponse: string,
  category: number,
): Promise<boolean> {
  // Adversarial: correct if model abstains (says "I don't know" etc.)
  // These questions deliberately swap subjects or ask about things that never happened
  if (category === 5) {
    const lower = actualResponse.toLowerCase();
    // Empty response counts as abstention for adversarial
    if (!lower || lower.length < 5) return true;
    const abstentionSignals = [
      'not mentioned', 'no information', "don't have", 'do not have',
      'not discussed', 'no record', 'cannot find', 'not available',
      'unknown', "i'm not sure", 'not sure', 'no mention',
      "wasn't discussed", "wasn't mentioned", 'not in our',
      "don't recall", 'no evidence', 'not evident', 'cannot determine',
      'not clear', 'no specific', "i don't know", 'unable to find',
      'no conversation', 'not addressed', "doesn't mention",
      "doesn't appear", 'not found', 'no relevant',
    ];
    return abstentionSignals.some(s => lower.includes(s));
  }

  // Normalize for comparison — strip punctuation, collapse whitespace
  const normalize = (s: string) => s.toLowerCase().replace(/[.,;:!?'"()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  const expected = normalize(String(expectedAnswer));
  const response = normalize(actualResponse);

  // Empty response = wrong
  if (!response || response.length < 3) return false;

  // Quick substring check (avoid LLM call when obvious match)
  if (expected.length <= 50 && response.includes(expected)) {
    return true;
  }
  // Check if key words from expected answer appear in response
  const expectedWords = expected.split(' ').filter(w => w.length >= 3);
  if (expectedWords.length > 0) {
    const matchCount = expectedWords.filter(w => response.includes(w)).length;
    if (matchCount / expectedWords.length >= 0.7) return true;
  }

  // LLM-as-judge for ambiguous cases
  try {
    const judgeResponse = await provider.chat({
      messages: [
        {
          role: 'system',
          content: 'You evaluate if a response correctly answers a question. Reply ONLY "CORRECT" or "INCORRECT".',
        },
        {
          role: 'user',
          content: `Question: ${question}\nExpected: ${expectedAnswer}\nResponse: ${actualResponse}\n\nDoes the response contain information matching the expected answer? Consider paraphrasing as correct. Reply ONLY "CORRECT" or "INCORRECT".`,
        },
      ],
      model: MODEL,
      maxTokens: 16,
    });
    return judgeResponse.text.trim().toUpperCase().includes('CORRECT');
  } catch {
    return response.includes(expected);
  }
}

// ── Charts ──

function renderCategoryChart(scores: CategoryScore[]): string {
  const BAR_WIDTH = 25;
  const lines: string[] = [
    '',
    'LoCoMo Benchmark — Category Accuracy',
    '═'.repeat(60),
  ];

  for (const s of scores) {
    const pct = Math.round(s.accuracy * 100);
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    lines.push(`${s.label.padEnd(12)} │${bar}  ${String(pct).padStart(3)}%  ${s.correct}/${s.total}`);
  }

  lines.push('═'.repeat(60));
  const overall = scores.reduce((a, s) => a + s.correct, 0);
  const total = scores.reduce((a, s) => a + s.total, 0);
  lines.push(`Overall:      ${Math.round((overall / total) * 100)}%  (${overall}/${total})`);

  const noAdv = scores.filter(s => s.category !== 5);
  const noAdvOk = noAdv.reduce((a, s) => a + s.correct, 0);
  const noAdvTotal = noAdv.reduce((a, s) => a + s.total, 0);
  lines.push(`No adversar.: ${Math.round((noAdvOk / noAdvTotal) * 100)}%  (${noAdvOk}/${noAdvTotal})`);

  lines.push('─'.repeat(60));
  lines.push('Baseline: Letta/MemGPT filesystem ≈ 74% on full LoCoMo');
  lines.push('');
  return lines.join('\n');
}

// ── Test Suite ──

describe.skipIf(!isGatewayReachable())('LoCoMo Benchmark', () => {
  let tmpDir: string;
  let memoryStore: MemoryStore;
  let provider: OpenAICompatibleProvider;
  let benchmarkResult: LoCoMoBenchmarkResult | null = null;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lumin-locomo-bench-'));
    memoryStore = new MemoryStore(new FileMemoryBackend(tmpDir));
    provider = new OpenAICompatibleProvider({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      defaultModel: MODEL,
    });
  }, 30_000);

  afterAll(async () => {
    if (benchmarkResult) {
      const outDir = join(process.cwd(), 'tests', 'output');
      mkdirSync(outDir, { recursive: true });
      const modelSlug = MODEL.replace(/[/.:]/g, '-');
      writeFileSync(
        join(outDir, `locomo-benchmark-${modelSlug}.json`),
        JSON.stringify(benchmarkResult, null, 2),
      );
      // Also write to default path for backward compat
      writeFileSync(
        join(outDir, 'locomo-benchmark.json'),
        JSON.stringify(benchmarkResult, null, 2),
      );
      console.error(benchmarkResult.chart);
    }
    await memoryStore?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('evaluates memory recall on LoCoMo dataset', async () => {
    const startTime = Date.now();

    // ── Load Dataset ──

    const { sample, sessions, speakerA, speakerB } = loadLoCoMoSample(SAMPLE_INDEX);

    let totalTurns = 0;
    let totalChars = 0;
    sessions.forEach(s => {
      totalTurns += s.turns.length;
      s.turns.forEach(t => totalChars += t.text.length);
    });

    console.error(`\n[locomo] Sample: ${sample.sample_id} | ${sessions.length} sessions | ${totalTurns} turns | ${totalChars} chars`);
    console.error(`[locomo] Speakers: ${speakerA} (user), ${speakerB} (assistant)`);
    console.error(`[locomo] QA pairs: ${sample.qa.length} total`);

    // ── Phase 1: Ingest all sessions into memory (0 LLM calls) ──

    console.error('\n[ingest] Storing all sessions to memory...');
    let totalStoredChars = 0;

    for (const session of sessions) {
      const chars = await ingestSessionToMemory(memoryStore, session);
      totalStoredChars += chars;
    }

    const memoryCtx = await memoryStore.loadRecentContext(200_000);
    console.error(`[ingest] Done: ${sessions.length} sessions → ${totalStoredChars} chars stored (${memoryCtx.length} chars in context)`);

    // ── Phase 2: Evaluate QA with memory-augmented LLM ──

    const selectedQA = selectQAPairs(sample.qa, MAX_QA_PER_CATEGORY);
    console.error(`\n[eval] Evaluating ${selectedQA.length} QA pairs (${MAX_QA_PER_CATEGORY}/cat max)...\n`);

    const qaResults: QAResult[] = [];
    let evaluated = 0;

    for (const qa of selectedQA) {
      evaluated++;
      const expectedAnswer = qa.category === 5
        ? (qa.adversarial_answer || 'unanswerable')
        : String(qa.answer ?? '');

      // Search memory for relevant conversation segments
      const searchQuery = buildSearchQuery(qa.question, speakerA, speakerB);
      const memoryHits = await memoryStore.search(searchQuery, { maxChars: 6000 });

      // Build context from memory hits
      let systemPrompt = `You are an assistant with access to conversation logs between ${speakerA} and ${speakerB}. Answer questions based ONLY on these conversations. If the answer is not in the conversations, say "I don't have that information."`;

      if (memoryHits.length > 0) {
        const retrievedMemory = memoryHits.map(h => h.text).join('\n\n---\n\n');
        systemPrompt += `\n\n## Retrieved Conversation Segments\n\n${retrievedMemory}`;
      } else {
        systemPrompt += '\n\n[No relevant conversation segments found in memory.]';
      }

      try {
        const response = await provider.chat({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${qa.question}\n\nAnswer concisely and directly. Do not think step-by-step, just give the answer.` },
          ],
          model: MODEL,
          maxTokens: 1024,
        });

        const correct = await judgeAnswer(provider, qa.question, expectedAnswer, response.text, qa.category);

        qaResults.push({
          question: qa.question,
          category: qa.category,
          expectedAnswer,
          llmResponse: response.text.slice(0, 300),
          correct,
          memoryHits: memoryHits.length,
          memoryBestScore: memoryHits.length > 0 ? Math.max(...memoryHits.map(h => h.score)) : 0,
        });

        const mark = correct ? '✓' : '✗';
        if (evaluated % 5 === 0 || !correct) {
          const correctSoFar = qaResults.filter(r => r.correct).length;
          console.error(`  [${String(evaluated).padStart(2)}/${selectedQA.length}] ${mark} Cat${qa.category} hits=${memoryHits.length} acc=${Math.round((correctSoFar / qaResults.length) * 100)}% | ${qa.question.slice(0, 60)}`);
        }
      } catch (err) {
        console.error(`  [${evaluated}/${selectedQA.length}] ✗ ERROR: ${err instanceof Error ? err.message : String(err)}`);
        qaResults.push({
          question: qa.question,
          category: qa.category,
          expectedAnswer,
          llmResponse: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
          correct: false,
          memoryHits: memoryHits.length,
          memoryBestScore: memoryHits.length > 0 ? Math.max(...memoryHits.map(h => h.score)) : 0,
        });
      }
    }

    // ── Phase 3: Compute scores ──

    const categoryScores: CategoryScore[] = [];
    for (let cat = 1; cat <= 5; cat++) {
      const catResults = qaResults.filter(r => r.category === cat);
      const correct = catResults.filter(r => r.correct).length;
      categoryScores.push({
        category: cat,
        label: CATEGORY_LABELS[cat],
        total: catResults.length,
        correct,
        accuracy: catResults.length > 0 ? correct / catResults.length : 0,
      });
    }

    const overallCorrect = qaResults.filter(r => r.correct).length;
    const overallAccuracy = overallCorrect / qaResults.length;
    const nonAdvResults = qaResults.filter(r => r.category !== 5);
    const nonAdvCorrect = nonAdvResults.filter(r => r.correct).length;
    const overallAccuracyNoAdversarial = nonAdvResults.length > 0 ? nonAdvCorrect / nonAdvResults.length : 0;

    // Memory search coverage
    const hitsDistribution = qaResults.reduce((acc, r) => {
      acc[r.memoryHits > 0 ? 'withHits' : 'noHits']++;
      return acc;
    }, { withHits: 0, noHits: 0 });

    const chart = renderCategoryChart(categoryScores);

    benchmarkResult = {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      totalDurationMs: Date.now() - startTime,
      model: MODEL,
      sampleId: sample.sample_id,
      sessionCount: sessions.length,
      turnCount: totalTurns,
      totalChars,
      memoryStoreChars: totalStoredChars,
      qaEvaluated: qaResults.length,
      categoryScores,
      overallAccuracy,
      overallAccuracyNoAdversarial,
      qaResults,
      chart,
    };

    // Print results
    console.error('\n' + '─'.repeat(60));
    for (const s of categoryScores) {
      console.error(`  Cat ${s.category} (${s.label.padEnd(11)}): ${String(s.correct).padStart(2)}/${s.total} = ${Math.round(s.accuracy * 100)}%`);
    }
    console.error('─'.repeat(60));
    console.error(`  Overall:        ${overallCorrect}/${qaResults.length} = ${Math.round(overallAccuracy * 100)}%`);
    console.error(`  No adversarial: ${nonAdvCorrect}/${nonAdvResults.length} = ${Math.round(overallAccuracyNoAdversarial * 100)}%`);
    console.error(`  Memory coverage: ${hitsDistribution.withHits}/${qaResults.length} questions had search hits`);
    console.error(`  Duration: ${Math.round(benchmarkResult.totalDurationMs / 1000)}s`);

    // Soft assertions
    expect(qaResults.length).toBeGreaterThan(0);
    expect(totalStoredChars).toBeGreaterThan(0);
  }, 1_200_000); // 20 minute timeout
});
