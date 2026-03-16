/**
 * Memory Recall Benchmark — real LLM integration test.
 *
 * Measures long-term memory recall across multiple compaction cycles:
 *   1. Seeds 12 unique facts in conversation via real LLM calls
 *   2. Triggers compaction + memory flush per cycle (real LLM extraction)
 *   3. Measures keyword recall from FileMemoryBackend after each cycle
 *   4. Measures LLM recall (with memory context injection) at the end
 *   5. Outputs recall curve + per-fact survival matrix + JSON results
 *
 * Uses provider.chat() + compaction functions directly (avoids agent.ts
 * module-level Zod 4 incompatibility). Tests the REAL LLM-based memory
 * extraction, compaction, and recall pipeline.
 *
 * Requires real LLM gateway. Skips gracefully when unavailable.
 * Run: npx vitest run tests/memory-recall-benchmark.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { OpenAICompatibleProvider, type Message } from '../src/provider.js';
import { MemoryStore } from '../src/memory.js';
import { Session } from '../src/session.js';
import { memoryFlushBeforeCompaction, compactConversation } from '../src/compaction.js';

// ── Config ──

const BASE_URL = process.env.OPENAI_API_BASE_URL || 'http://34.60.178.0:3000/v1';
const API_KEY = process.env.OPENAI_API_KEY || 'sk-JNQdVfQyeTmPqdrKl0oDe2lcocVgWzt9IhBjHtGaP13fFBUX';
const MODEL = process.env.AGENT_DEFAULT_MODEL || 'us-kimi-k2.5';

const SYSTEM_PROMPT = `You are a meticulous research assistant. Your primary responsibilities:
1. Remember and acknowledge all important facts shared with you
2. When asked about previously discussed information, provide precise details
3. Be concise but accurate in your responses`;

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

interface FactEntry {
  id: string;
  category: string;
  seed: string;
  keywords: string[];
  verification: string;
  expectedFragment: string;
}

interface MemoryRecallResult {
  factId: string;
  found: boolean;
  bestScore: number;
}

interface LLMRecallResult {
  factId: string;
  recalled: boolean;
  responseSnippet: string;
}

interface CycleResult {
  cycle: number;
  factsSeeded: string[];
  allFactsTested: string[];
  memoryRecallRate: number;
  memoryDetails: MemoryRecallResult[];
  compactionSummaryLength: number;
  memoryFlushLength: number;
  durationMs: number;
}

interface BenchmarkResult {
  startTime: string;
  endTime: string;
  totalDurationMs: number;
  model: string;
  factCount: number;
  cycleCount: number;
  cycles: CycleResult[];
  finalLLMRecall: {
    results: LLMRecallResult[];
    recallRate: number;
  };
  memoryRecallCurve: number[];
  chart: string;
}

// ── Fact Corpus (12 facts, 4 cycles × 3) ──

const FACT_CORPUS: FactEntry[] = [
  // Cycle 1
  {
    id: 'F01', category: 'numeric',
    seed: 'The calibration coefficient for our spectrometer is exactly 0.03847.',
    keywords: ['calibration', 'spectrometer', 'coefficient', '0.03847'],
    verification: 'What is the exact calibration coefficient for our spectrometer?',
    expectedFragment: '0.03847',
  },
  {
    id: 'F02', category: 'person',
    seed: 'Professor Yolanda Marchetti from the University of Bologna supervises this project.',
    keywords: ['yolanda', 'marchetti', 'bologna', 'supervises'],
    verification: 'Who is the professor supervising this project and which university are they from?',
    expectedFragment: 'marchetti',
  },
  {
    id: 'F03', category: 'path',
    seed: 'Our primary dataset is stored at /data/experiments/2026-crystallography/run-47b.parquet.',
    keywords: ['crystallography', 'run-47b', 'parquet', 'dataset'],
    verification: 'What is the file path to our primary dataset?',
    expectedFragment: 'run-47b',
  },
  // Cycle 2
  {
    id: 'F04', category: 'decision',
    seed: 'We decided to use the Fourier-Bessel decomposition method instead of wavelet transform for signal analysis.',
    keywords: ['fourier-bessel', 'decomposition', 'wavelet', 'signal'],
    verification: 'Which decomposition method did we choose for signal analysis?',
    expectedFragment: 'fourier-bessel',
  },
  {
    id: 'F05', category: 'numeric',
    seed: 'The maximum training batch size is 2048 samples with a learning rate of 3.7e-5.',
    keywords: ['batch', '2048', 'learning', '3.7e-5'],
    verification: 'What batch size and learning rate are we using for training?',
    expectedFragment: '2048',
  },
  {
    id: 'F06', category: 'config',
    seed: 'The Redis cache timeout is set to 7200 seconds and the connection pool has 24 workers.',
    keywords: ['redis', '7200', 'workers', 'cache'],
    verification: 'What is the Redis cache timeout and how many workers are in the pool?',
    expectedFragment: '7200',
  },
  // Cycle 3
  {
    id: 'F07', category: 'person',
    seed: 'Dr. Takeshi Yamamoto at Kyoto University developed the chlorophyll extraction protocol we adapted.',
    keywords: ['takeshi', 'yamamoto', 'kyoto', 'chlorophyll'],
    verification: 'Who developed the chlorophyll extraction protocol and where are they from?',
    expectedFragment: 'yamamoto',
  },
  {
    id: 'F08', category: 'architecture',
    seed: 'Our microservice topology routes events through Apache Pulsar with 5 partitions per topic on namespace prismer-bio.',
    keywords: ['pulsar', 'partitions', 'prismer-bio', 'microservice'],
    verification: 'What message broker do we use and what is the namespace?',
    expectedFragment: 'pulsar',
  },
  {
    id: 'F09', category: 'deadline',
    seed: 'The ICML 2027 submission deadline is January 23rd, and we need the ablation study complete by January 10th.',
    keywords: ['icml', '2027', 'january', 'ablation'],
    verification: 'When is the ICML 2027 submission deadline?',
    expectedFragment: 'january',
  },
  // Cycle 4
  {
    id: 'F10', category: 'formula',
    seed: 'The diffusion coefficient formula we use is D = kT / (6 * pi * eta * r) where eta is dynamic viscosity.',
    keywords: ['diffusion', 'viscosity', 'formula', 'coefficient'],
    verification: 'What is the diffusion coefficient formula we are using?',
    expectedFragment: 'viscosity',
  },
  {
    id: 'F11', category: 'version',
    seed: 'We pinned PyTorch to version 2.4.1 and CUDA toolkit 12.6 to avoid the gradient accumulation bug in 2.5.0.',
    keywords: ['pytorch', '2.4.1', 'cuda', 'gradient'],
    verification: 'What version of PyTorch did we pin and why?',
    expectedFragment: '2.4.1',
  },
  {
    id: 'F12', category: 'credential',
    seed: 'The GCP project ID for our compute cluster is prismer-research-42 in region us-central1-f.',
    keywords: ['prismer-research-42', 'us-central1-f', 'compute', 'cluster'],
    verification: 'What is our GCP project ID and compute region?',
    expectedFragment: 'prismer-research-42',
  },
];

const CYCLE_COUNT = 4;
const FACTS_PER_CYCLE = 3;

// ── Helpers ──

async function seedFacts(
  provider: OpenAICompatibleProvider,
  facts: FactEntry[],
): Promise<Message[]> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  for (const fact of facts) {
    const userMsg: Message = {
      role: 'user',
      content: `I want to record an important fact for our research: ${fact.seed} Please acknowledge this.`,
    };
    messages.push(userMsg);

    try {
      const response = await provider.chat({
        messages: [...messages],
        model: MODEL,
        maxTokens: 256,
      });
      messages.push({ role: 'assistant', content: response.text });
    } catch (err) {
      // If LLM fails, add a synthetic acknowledgment to keep conversation flowing
      console.error(`  [seed] ${fact.id} LLM call failed:`, err instanceof Error ? err.message : err);
      messages.push({ role: 'assistant', content: `Acknowledged: ${fact.seed}` });
    }
  }

  return messages;
}

async function measureMemoryRecall(
  store: MemoryStore,
  facts: FactEntry[],
): Promise<MemoryRecallResult[]> {
  const results: MemoryRecallResult[] = [];
  for (const fact of facts) {
    const query = fact.keywords.join(' ');
    const searchResults = await store.search(query, { maxChars: 8000 });
    const found = searchResults.length > 0;
    const bestScore = found ? Math.max(...searchResults.map(r => r.score)) : 0;
    results.push({ factId: fact.id, found, bestScore });
  }
  return results;
}

async function measureLLMRecall(
  provider: OpenAICompatibleProvider,
  facts: FactEntry[],
  memoryStore: MemoryStore,
): Promise<LLMRecallResult[]> {
  const results: LLMRecallResult[] = [];
  const recentMemory = await memoryStore.loadRecentContext(6000);

  // Build a system prompt with memory context
  let systemWithMemory = SYSTEM_PROMPT;
  if (recentMemory) {
    systemWithMemory += `\n\n## Memory from Previous Sessions\n\n${recentMemory}`;
  }

  // Also search for each fact explicitly and build a recall context
  const allMemoryHits: string[] = [];
  for (const fact of facts) {
    const hits = await memoryStore.search(fact.keywords.join(' '), { maxChars: 2000 });
    for (const hit of hits) {
      if (!allMemoryHits.includes(hit.text)) {
        allMemoryHits.push(hit.text);
      }
    }
  }
  if (allMemoryHits.length > 0) {
    systemWithMemory += `\n\n## Recalled Memory Entries\n\n${allMemoryHits.join('\n\n---\n\n')}`;
  }

  // Ask each verification question in a fresh conversation
  for (const fact of facts) {
    try {
      const response = await provider.chat({
        messages: [
          { role: 'system', content: systemWithMemory },
          { role: 'user', content: `Based on our previous research discussions and any available memory, answer this: ${fact.verification}` },
        ],
        model: MODEL,
        maxTokens: 256,
      });
      const responseLower = response.text.toLowerCase();
      const recalled = responseLower.includes(fact.expectedFragment.toLowerCase());
      results.push({
        factId: fact.id,
        recalled,
        responseSnippet: response.text.slice(0, 200),
      });
    } catch (err) {
      results.push({
        factId: fact.id,
        recalled: false,
        responseSnippet: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

function renderRecallChart(cycles: CycleResult[], finalLLMRate: number): string {
  const BAR_WIDTH = 20;
  const lines: string[] = [
    '',
    'Memory Store Recall by Compaction Cycle',
    '\u2500'.repeat(55),
  ];

  for (const c of cycles) {
    const pct = Math.round(c.memoryRecallRate * 100);
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
    const found = c.memoryDetails.filter(r => r.found).length;
    const total = c.memoryDetails.length;
    lines.push(`Cycle ${c.cycle} \u2502${bar}  ${String(pct).padStart(3)}%  ${found}/${total}`);
  }

  lines.push('\u2500'.repeat(55));
  const llmPct = Math.round(finalLLMRate * 100);
  lines.push(`Final LLM Recall (with memory context):  ${llmPct}%`);
  lines.push('');
  return lines.join('\n');
}

function renderFactTable(cycles: CycleResult[], llmResults: LLMRecallResult[]): string {
  const lines: string[] = [
    '',
    'Per-Fact Survival Matrix:',
    '\u2500'.repeat(55),
    `Fact  \u2502 ${cycles.map(c => `C${c.cycle}`).join('   ')}  \u2502 LLM  \u2502 Score`,
    '\u2500'.repeat(55),
  ];

  for (const fact of FACT_CORPUS) {
    const cycleMarks = cycles.map(c => {
      const detail = c.memoryDetails.find(d => d.factId === fact.id);
      if (!detail) return '  - ';
      return detail.found ? '  \u2713 ' : '  \u2717 ';
    });
    const llm = llmResults.find(r => r.factId === fact.id);
    const llmMark = llm ? (llm.recalled ? '  \u2713 ' : '  \u2717 ') : '  - ';
    // Get best memory score from last cycle
    const lastCycle = cycles[cycles.length - 1];
    const lastDetail = lastCycle?.memoryDetails.find(d => d.factId === fact.id);
    const score = lastDetail ? lastDetail.bestScore.toFixed(2) : ' n/a';
    lines.push(`${fact.id}  \u2502${cycleMarks.join('')}  \u2502${llmMark}\u2502 ${score}`);
  }

  lines.push('\u2500'.repeat(55));
  return lines.join('\n');
}

// ── Test Suite ──

describe.skipIf(!isGatewayReachable())('Memory Recall Benchmark', () => {
  let tmpDir: string;
  let memoryStore: MemoryStore;
  let provider: OpenAICompatibleProvider;
  let benchmarkResult: BenchmarkResult | null = null;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lumin-recall-bench-'));
    memoryStore = new MemoryStore(tmpDir);
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
      writeFileSync(
        join(outDir, 'memory-recall-benchmark.json'),
        JSON.stringify(benchmarkResult, null, 2),
      );
      console.error(benchmarkResult.chart);
      console.error(renderFactTable(
        benchmarkResult.cycles,
        benchmarkResult.finalLLMRecall.results,
      ));
    }
    await memoryStore?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('measures recall across compaction cycles', async () => {
    const startTime = Date.now();
    const cycles: CycleResult[] = [];
    const allSeededFacts: FactEntry[] = [];

    // ── 4 Compaction Cycles ──

    for (let c = 0; c < CYCLE_COUNT; c++) {
      const cycleStart = Date.now();
      const cycleFacts = FACT_CORPUS.slice(c * FACTS_PER_CYCLE, (c + 1) * FACTS_PER_CYCLE);
      cycleFacts.forEach(f => allSeededFacts.push(f));

      console.error(`\n[cycle ${c + 1}] Seeding ${cycleFacts.map(f => f.id).join(', ')}...`);

      // Phase A: Seed facts via real LLM conversation
      const conversationMessages = await seedFacts(provider, cycleFacts);

      // Phase B: Memory flush — LLM extracts key facts from the conversation
      // (Same pipeline as agent.ts context guard: memoryFlushBeforeCompaction)
      const droppedMessages = conversationMessages.slice(1); // skip system prompt
      let memoryFlushLen = 0;
      try {
        // Store facts to memory via the real LLM extraction pipeline
        await memoryFlushBeforeCompaction(provider, droppedMessages, memoryStore, MODEL);
        // Check what was stored
        const recentCtx = await memoryStore.loadRecentContext(10_000);
        memoryFlushLen = recentCtx.length;
        console.error(`  [flush] Memory flush complete (${memoryFlushLen} chars in store)`);
      } catch (err) {
        console.error(`  [flush] Memory flush failed:`, err instanceof Error ? err.message : err);
      }

      // Phase C: Compaction summary (for reference, not stored to memory)
      let compactionLen = 0;
      try {
        const compactionResult = await compactConversation(provider, droppedMessages, MODEL);
        compactionLen = compactionResult.summaryChars;
        console.error(`  [compact] Summary: ${compactionLen} chars, dropped ${compactionResult.droppedCount} msgs`);
      } catch (err) {
        console.error(`  [compact] Compaction failed:`, err instanceof Error ? err.message : err);
      }

      // Phase D: Measure memory store recall for ALL seeded facts so far
      const memoryResults = await measureMemoryRecall(memoryStore, allSeededFacts);
      const recalled = memoryResults.filter(r => r.found).length;
      const total = memoryResults.length;

      const cycleResult: CycleResult = {
        cycle: c + 1,
        factsSeeded: cycleFacts.map(f => f.id),
        allFactsTested: allSeededFacts.map(f => f.id),
        memoryRecallRate: total > 0 ? recalled / total : 0,
        memoryDetails: memoryResults,
        compactionSummaryLength: compactionLen,
        memoryFlushLength: memoryFlushLen,
        durationMs: Date.now() - cycleStart,
      };
      cycles.push(cycleResult);

      console.error(
        `  [result] memory_recall=${recalled}/${total} (${Math.round(cycleResult.memoryRecallRate * 100)}%) ` +
        `duration=${cycleResult.durationMs}ms`,
      );
    }

    // ── Final LLM Recall Measurement ──

    console.error('\n[final] Measuring LLM recall for all 12 facts...');
    const llmResults = await measureLLMRecall(provider, FACT_CORPUS, memoryStore);

    const llmRecallRate = llmResults.filter(r => r.recalled).length / llmResults.length;

    for (const r of llmResults) {
      console.error(`  ${r.factId}: ${r.recalled ? '\u2713' : '\u2717'}`);
    }

    // ── Assemble Results ──

    benchmarkResult = {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      totalDurationMs: Date.now() - startTime,
      model: MODEL,
      factCount: FACT_CORPUS.length,
      cycleCount: CYCLE_COUNT,
      cycles,
      finalLLMRecall: {
        results: llmResults,
        recallRate: llmRecallRate,
      },
      memoryRecallCurve: cycles.map(c => c.memoryRecallRate),
      chart: renderRecallChart(cycles, llmRecallRate),
    };

    // Soft assertions — benchmark, not a strict pass/fail gate
    expect(cycles.length).toBe(CYCLE_COUNT);
    // Memory recall should find at least some facts
    const lastCycleRecall = cycles[cycles.length - 1].memoryRecallRate;
    expect(lastCycleRecall).toBeGreaterThan(0);

    console.error(`\n[done] Total: ${benchmarkResult.totalDurationMs}ms`);
    console.error(`  Memory recall curve: [${benchmarkResult.memoryRecallCurve.map(r => Math.round(r * 100) + '%').join(', ')}]`);
    console.error(`  Final LLM recall: ${Math.round(llmRecallRate * 100)}% (${llmResults.filter(r => r.recalled).length}/${llmResults.length})`);
  }, 600_000); // 10 minute timeout
});
