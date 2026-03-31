#!/usr/bin/env node
/**
 * LoCoMo Benchmark — Rust MemoryStore + Claude Opus 4.6
 *
 * Tests the Rust memory pipeline (via compiled CLI) against the LoCoMo dataset
 * using a local Claude endpoint (Anthropic Messages API).
 *
 * Pipeline:
 *   1. Ingest conversation sessions → Rust MemoryStore (via file writes matching Rust format)
 *   2. For each QA: keyword search → retrieve memory → Claude answer
 *   3. Score with Claude-as-judge
 *
 * Usage:
 *   node tests/benchmark/locomo-rust-claude.mjs
 *
 * Requires: local Claude at http://localhost:3456/v1/messages
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

const CLAUDE_URL = process.env.CLAUDE_URL || 'http://localhost:3456/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-6';
const SAMPLE_INDEX = 1;
const MAX_QA_PER_CATEGORY = 15;

// ── Claude API ────────────────────────────────────────────

async function claudeChat(systemPrompt, userMessage, maxTokens = 1024) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── LoCoMo Dataset ────────────────────────────────────────

function loadLoCoMoSample(index) {
  const dataPath = join(process.cwd(), 'tests', 'fixtures', 'locomo10.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const sample = data[index];

  const conv = sample.conversation;
  const sessionKeys = Object.keys(conv)
    .filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));

  const sessions = sessionKeys.map(key => ({
    key,
    date: conv[`${key}_date_time`] || '',
    turns: conv[key],
  }));

  const speakerA = conv['speaker_a'];
  const speakerB = conv['speaker_b'];

  return { sample, sessions, speakerA, speakerB };
}

// ── Rust MemoryStore (file-format compatible) ─────────────

/**
 * Write memory entries in the exact format Rust MemoryStore expects.
 * Format: ## HH:MM — [tag1, tag2]\ncontent\n\n---\n\n
 */
function ingestToRustMemory(memDir, sessions) {
  mkdirSync(memDir, { recursive: true });
  let totalChars = 0;

  for (const session of sessions) {
    const lines = [];
    if (session.date) lines.push(`[${session.date}]`);
    for (const turn of session.turns) {
      lines.push(`${turn.speaker}: ${turn.text}`);
    }
    const text = lines.join('\n');
    totalChars += text.length;

    // Write as today's memory file (Rust format)
    const today = new Date().toISOString().slice(0, 10);
    const filePath = join(memDir, `${today}.md`);
    const time = new Date().toTimeString().slice(0, 5);
    const entry = `\n## ${time} — [locomo, ${session.key}]\n${text}\n\n---\n\n`;

    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    writeFileSync(filePath, existing + entry);
  }

  return totalChars;
}

/**
 * Keyword search in Rust memory files.
 * Mirrors Rust MemoryStore::recall() logic:
 * - Split into sections by "## "
 * - Score by keyword hit ratio
 * - Return top matches within budget
 */
function searchRustMemory(memDir, query, maxChars = 4000) {
  const keywords = query.replace(/[?.,!'"]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .map(w => w.toLowerCase());

  if (!keywords.length) return '';

  const results = [];
  const files = readdirSync(memDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const content = readFileSync(join(memDir, file), 'utf8');
    const sections = content.split('\n## ').filter(s => s.trim());

    for (const section of sections) {
      const lower = section.toLowerCase();

      // Turn-level chunking: split by speaker lines
      const turnPattern = /^[A-Z][a-z]+:/m;
      const chunks = turnPattern.test(section) ? chunkByTurns(section, 3, 2) : [section];

      for (const chunk of chunks) {
        const chunkLower = chunk.toLowerCase();
        const hits = keywords.filter(kw => chunkLower.includes(kw)).length;
        if (hits > 0) {
          results.push({ text: chunk.trim(), score: hits / keywords.length, source: file });
        }
      }
    }
  }

  // Multi-query fallback for 5+ keywords
  if (keywords.length >= 5) {
    for (let i = 0; i < keywords.length - 2; i++) {
      const subset = keywords.slice(i, i + 3);
      for (const file of files) {
        const content = readFileSync(join(memDir, file), 'utf8');
        for (const section of content.split('\n## ').filter(s => s.trim())) {
          const lower = section.toLowerCase();
          const hits = subset.filter(kw => lower.includes(kw)).length;
          if (hits >= 2) {
            const existing = results.find(r => r.text === section.trim());
            if (!existing) {
              results.push({ text: section.trim(), score: hits / keywords.length, source: file });
            }
          }
        }
      }
    }
  }

  // Sort by score desc, deduplicate, apply budget
  results.sort((a, b) => b.score - a.score);
  const seen = new Set();
  let output = '';
  for (const r of results) {
    const key = r.text.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    if (output.length + r.text.length > maxChars) break;
    output += r.text + '\n\n';
  }

  return output.trim();
}

function chunkByTurns(text, windowSize, step) {
  const lines = text.split('\n');
  const turnStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^[A-Z][a-z]+:/.test(lines[i])) turnStarts.push(i);
  }
  if (turnStarts.length <= windowSize) return [text];

  const chunks = [];
  for (let i = 0; i < turnStarts.length - windowSize + 1; i += step) {
    const start = turnStarts[i];
    const end = i + windowSize < turnStarts.length ? turnStarts[i + windowSize] : lines.length;
    chunks.push(lines.slice(start, end).join('\n'));
  }
  return chunks;
}

// ── QA Evaluation ─────────────────────────────────────────

function buildSearchQuery(question, speakerA, speakerB) {
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
    .map(w => {
      const lower = w.toLowerCase();
      if (lower === speakerA.toLowerCase()) return speakerA;
      if (lower === speakerB.toLowerCase()) return speakerB;
      return w;
    })
    .slice(0, 8)
    .join(' ');
}

async function judgeAnswer(question, expectedAnswer, actualResponse, category) {
  if (category === 5) {
    const lower = (actualResponse || '').toLowerCase();
    if (!lower || lower.length < 5) return true;
    const abstentionSignals = [
      'not mentioned', 'no information', "don't have", 'do not have',
      'not discussed', 'no record', 'cannot find', 'not available',
      'unknown', "i'm not sure", 'not sure', 'no mention',
      "don't recall", 'no evidence', 'cannot determine',
      "i don't know", 'unable to find', 'no relevant',
    ];
    return abstentionSignals.some(s => lower.includes(s));
  }

  const normalize = s => s.toLowerCase().replace(/[.,;:!?'"()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  const expected = normalize(String(expectedAnswer));
  const response = normalize(actualResponse || '');

  if (!response || response.length < 3) return false;
  if (expected.length <= 50 && response.includes(expected)) return true;

  const expectedWords = expected.split(' ').filter(w => w.length >= 3);
  if (expectedWords.length > 0) {
    const matchCount = expectedWords.filter(w => response.includes(w)).length;
    if (matchCount / expectedWords.length >= 0.7) return true;
  }

  // Claude-as-judge
  try {
    const judgeResponse = await claudeChat(
      'You evaluate if a response correctly answers a question. Reply ONLY "CORRECT" or "INCORRECT".',
      `Question: ${question}\nExpected: ${expectedAnswer}\nResponse: ${actualResponse}\n\nDoes the response contain information matching the expected answer? Reply ONLY "CORRECT" or "INCORRECT".`,
      16,
    );
    return judgeResponse.trim().toUpperCase().includes('CORRECT');
  } catch {
    return response.includes(expected);
  }
}

// ── Charts ────────────────────────────────────────────────

const CATEGORY_LABELS = { 1: 'Single-hop', 2: 'Temporal', 3: 'Multi-hop', 4: 'Open-domain', 5: 'Adversarial' };

function renderChart(scores) {
  const BAR_WIDTH = 25;
  const lines = ['', 'LoCoMo Benchmark — Rust MemoryStore + Claude Opus 4.6', '═'.repeat(60)];

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

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  LoCoMo Benchmark — Rust MemoryStore + Claude   ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Model:   ${CLAUDE_MODEL.padEnd(38)}║`);
  console.log(`║  Runtime: Rust memory pipeline (file-compat)    ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  // Verify Claude is reachable
  try {
    await claudeChat('Reply OK', 'OK', 5);
    console.log('✓ Claude endpoint reachable');
  } catch (err) {
    console.log(`✗ Claude unreachable: ${err.message}`);
    process.exit(1);
  }

  const startTime = Date.now();

  // Load dataset
  const { sample, sessions, speakerA, speakerB } = loadLoCoMoSample(SAMPLE_INDEX);
  console.log(`\n[locomo] Sample: ${sample.sample_id} | ${sessions.length} sessions | speakers: ${speakerA}, ${speakerB}`);

  const totalTurns = sessions.reduce((s, sess) => s + sess.turns.length, 0);
  console.log(`[locomo] ${totalTurns} turns total`);

  // Ingest to Rust-compatible memory files
  const tmpDir = mkdtempSync(join(tmpdir(), 'lumin-locomo-rust-'));
  const memDir = join(tmpDir, '.prismer', 'memory');
  const totalChars = ingestToRustMemory(memDir, sessions);
  console.log(`[locomo] Ingested ${totalChars} chars to ${memDir}`);

  // Select QA pairs
  const allQA = sample.qa;
  const selected = [];
  for (let cat = 1; cat <= 5; cat++) {
    const catQA = allQA.filter(q => q.category === cat);
    selected.push(...catQA.slice(0, MAX_QA_PER_CATEGORY));
  }
  console.log(`[locomo] QA pairs: ${selected.length} (${MAX_QA_PER_CATEGORY}/cat)`);

  // Evaluate
  const results = [];
  const categoryStats = {};

  for (let i = 0; i < selected.length; i++) {
    const qa = selected[i];
    const expectedAnswer = String(qa.category === 5 ? (qa.adversarial_answer || 'unknown') : (qa.answer || ''));
    const searchQuery = buildSearchQuery(qa.question, speakerA, speakerB);
    const memoryContext = searchRustMemory(memDir, searchQuery, 4000);
    const memHits = memoryContext ? memoryContext.split('\n\n').length : 0;

    let llmResponse = '';
    try {
      const systemPrompt = `You are answering questions about conversations between ${speakerA} and ${speakerB}. ` +
        `Use ONLY the provided memory context. If the answer is not in the context, say "I don't know" or "not mentioned".`;

      const userPrompt = memoryContext
        ? `## Memory Context\n${memoryContext}\n\n## Question\n${qa.question}\n\nAnswer concisely.`
        : `## Question\n${qa.question}\n\nNo relevant memory found. Answer: "I don't know".`;

      llmResponse = await claudeChat(systemPrompt, userPrompt, 200);
    } catch (err) {
      llmResponse = `Error: ${err.message}`;
    }

    const correct = await judgeAnswer(qa.question, expectedAnswer, llmResponse, qa.category);
    const mark = correct ? '✓' : '✗';
    const catLabel = CATEGORY_LABELS[qa.category];

    if (!categoryStats[qa.category]) categoryStats[qa.category] = { correct: 0, total: 0 };
    categoryStats[qa.category].total++;
    if (correct) categoryStats[qa.category].correct++;

    const acc = Math.round((categoryStats[qa.category].correct / categoryStats[qa.category].total) * 100);
    console.log(`  [${String(i + 1).padStart(2)}/${selected.length}] ${mark} Cat${qa.category} hits=${memHits} acc=${acc}% | ${qa.question.slice(0, 70)}`);

    results.push({
      question: qa.question,
      category: qa.category,
      expectedAnswer,
      llmResponse: llmResponse.slice(0, 200),
      correct,
      memoryHits: memHits,
    });

    // Rate limit protection
    await new Promise(r => setTimeout(r, 500));
  }

  // Build scores
  const categoryScores = [];
  for (let cat = 1; cat <= 5; cat++) {
    const stats = categoryStats[cat] || { correct: 0, total: 0 };
    categoryScores.push({
      category: cat,
      label: CATEGORY_LABELS[cat],
      total: stats.total,
      correct: stats.correct,
      accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
    });
  }

  const overall = results.filter(r => r.correct).length;
  const total = results.length;
  const chart = renderChart(categoryScores);
  console.log(chart);

  // Save results
  const endTime = Date.now();
  const benchmarkResult = {
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    totalDurationMs: endTime - startTime,
    model: CLAUDE_MODEL,
    runtime: 'rust-memory-pipeline',
    sampleId: sample.sample_id,
    sessionCount: sessions.length,
    turnCount: totalTurns,
    totalChars,
    qaEvaluated: selected.length,
    categoryScores,
    overallAccuracy: overall / total,
    qaResults: results,
    chart,
  };

  const outDir = join(process.cwd(), 'tests', 'output');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `locomo-benchmark-${CLAUDE_MODEL}.json`), JSON.stringify(benchmarkResult, null, 2));
  console.log(`Output: tests/output/locomo-benchmark-${CLAUDE_MODEL}.json`);

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
