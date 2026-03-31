/**
 * Agent Loop Benchmark — measures SingleLoopAgent vs DualLoopAgent throughput.
 *
 * Uses a mock LLM provider for deterministic, network-free measurement.
 * Compares: iterations/sec, tool call latency, memory usage.
 *
 * Usage: node tests/benchmark/loop-benchmark.mjs
 */

import { performance } from 'node:perf_hooks';

// ── Mock Provider ─────────────────────────────────────────

/** Mock provider that returns N tool calls then a final text response. */
function createMockProvider(toolCallsPerIteration = 1, totalIterations = 5) {
  let callCount = 0;

  return {
    name: () => 'mock',
    chat: async (_request) => {
      callCount++;
      if (callCount <= totalIterations) {
        // ToolCall format: { id, name, arguments: Record<string, unknown> }
        const toolCalls = Array.from({ length: toolCallsPerIteration }, (_, i) => ({
          id: `call-${callCount}-${i}`,
          name: 'echo',
          arguments: { text: `iteration-${callCount}` },
        }));
        return { text: '', toolCalls, usage: { promptTokens: 100, completionTokens: 50 } };
      }
      return { text: `Done after ${callCount - 1} iterations`, usage: { promptTokens: 100, completionTokens: 50 } };
    },
  };
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
}

function stats(arr) {
  if (!arr.length) return { min: 0, p50: 0, p90: 0, p99: 0, max: 0, avg: 0 };
  return {
    min: Math.round(Math.min(...arr) * 100) / 100,
    p50: Math.round(percentile(arr, 50) * 100) / 100,
    p90: Math.round(percentile(arr, 90) * 100) / 100,
    p99: Math.round(percentile(arr, 99) * 100) / 100,
    max: Math.round(Math.max(...arr) * 100) / 100,
    avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100,
  };
}

// ── Benchmark: Raw Agent Loop ─────────────────────────────

async function benchmarkAgentLoop(iterations, toolsPerIter) {
  // Dynamic imports to avoid module-level side effects
  const { PrismerAgent } = await import('../../dist/agent.js');
  const { ToolRegistry } = await import('../../dist/tools.js');
  const { createTool } = await import('../../dist/tools/index.js');
  const { EventBus } = await import('../../dist/sse.js');
  const { ConsoleObserver } = await import('../../dist/observer.js');
  const { AgentRegistry, BUILTIN_AGENTS } = await import('../../dist/agents.js');
  const { Session } = await import('../../dist/session.js');

  const tools = new ToolRegistry();
  tools.register(createTool(
    'echo', 'Echo input',
    { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async (args) => `Echo: ${args.text}`,
  ));

  const agents = new AgentRegistry();
  agents.registerMany(BUILTIN_AGENTS);

  const provider = createMockProvider(toolsPerIter, iterations);
  const bus = new EventBus();
  const observer = new ConsoleObserver();

  const agent = new PrismerAgent({
    provider,
    tools,
    observer,
    agents,
    bus,
    systemPrompt: 'You are a benchmark test agent.',
    model: 'mock',
    maxIterations: iterations + 5,
    agentId: 'benchmark',
    workspaceDir: '/tmp',
  });

  const session = new Session('bench-session');
  const memBefore = process.memoryUsage();
  const start = performance.now();

  const result = await agent.processMessage('Run benchmark', session);

  const elapsed = performance.now() - start;
  const memAfter = process.memoryUsage();
  await observer.flush();

  return {
    elapsed,
    iterations: result.iterations,
    toolsUsed: result.toolsUsed,
    memDelta: {
      rss: Math.round((memAfter.rss - memBefore.rss) / 1024),
      heap: Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024),
    },
  };
}

// ── Benchmark: Loop Factory ───────────────────────────────

async function benchmarkLoopProcessMessage(mode) {
  const { createAgentLoop } = await import('../../dist/loop/factory.js');
  const { EventBus } = await import('../../dist/sse.js');
  const { resetConfig } = await import('../../dist/config.js');

  // Set loop mode
  process.env.LUMIN_LOOP_MODE = mode;
  resetConfig();

  const loop = createAgentLoop(mode);
  const bus = new EventBus();

  const start = performance.now();
  try {
    // This will fail without a real LLM, but we measure the overhead
    await Promise.race([
      loop.processMessage({ content: 'benchmark test', sessionId: 'bench' }, { bus }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
  } catch {
    // Expected — no real LLM provider
  }
  const elapsed = performance.now() - start;

  delete process.env.LUMIN_LOOP_MODE;
  resetConfig();

  return { mode, elapsed, loopMode: loop.mode };
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════╗
║  Lumin Agent Loop Benchmark                      ║
║  Mock provider — no network, deterministic       ║
╚══════════════════════════════════════════════════╝`);

  // Suppress observer output during benchmarks
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;

  // ── Test 1: Raw agent loop throughput ──
  console.log('\n━━━ Test 1: Agent Loop Throughput (mock provider) ━━━');

  const configs = [
    { iterations: 5, tools: 1, label: '5 iter × 1 tool' },
    { iterations: 10, tools: 1, label: '10 iter × 1 tool' },
    { iterations: 20, tools: 1, label: '20 iter × 1 tool' },
    { iterations: 10, tools: 3, label: '10 iter × 3 tools (parallel)' },
    { iterations: 20, tools: 5, label: '20 iter × 5 tools (parallel)' },
  ];

  const results = [];
  for (const cfg of configs) {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const r = await benchmarkAgentLoop(cfg.iterations, cfg.tools);
      runs.push(r);
    }

    const latencies = runs.map(r => r.elapsed);
    const s = stats(latencies);
    const avgItersPerSec = Math.round(cfg.iterations / (s.avg / 1000));
    const avgToolsPerSec = Math.round((cfg.iterations * cfg.tools) / (s.avg / 1000));
    const lastMem = runs[runs.length - 1].memDelta;

    results.push({ label: cfg.label, s, avgItersPerSec, avgToolsPerSec, lastMem });
    console.log(`  ${cfg.label}: avg=${s.avg}ms p50=${s.p50}ms | ${avgItersPerSec} iter/s, ${avgToolsPerSec} tools/s | mem: +${lastMem.heap}KB heap`);
  }

  // ── Test 2: Loop factory overhead ──
  console.log('\n━━━ Test 2: Loop Creation + processMessage Dispatch ━━━');

  for (const mode of ['single', 'dual']) {
    const runs = [];
    for (let i = 0; i < 10; i++) {
      const r = await benchmarkLoopProcessMessage(mode);
      runs.push(r.elapsed);
    }
    const s = stats(runs);
    console.log(`  ${mode}: avg=${s.avg}ms p50=${s.p50}ms p99=${s.p99}ms`);
  }

  // ── Summary table ──
  console.log('\n━━━ Summary ━━━');
  console.log('┌─────────────────────────────────┬──────────┬───────────┬────────────┐');
  console.log('│ Configuration                   │ Avg (ms) │ Iter/sec  │ Tools/sec  │');
  console.log('├─────────────────────────────────┼──────────┼───────────┼────────────┤');
  for (const r of results) {
    console.log(`│ ${r.label.padEnd(31)} │ ${String(r.s.avg).padStart(8)} │ ${String(r.avgItersPerSec).padStart(9)} │ ${String(r.avgToolsPerSec).padStart(10)} │`);
  }
  console.log('└─────────────────────────────────┴──────────┴───────────┴────────────┘');

  // Restore stderr
  process.stderr.write = origStderr;
}

main().catch(console.error);
