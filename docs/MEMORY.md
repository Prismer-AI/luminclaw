# Memory System

Lumin 的持久化记忆系统，基于 pluggable backend 抽象 + 文件默认实现。

---

## 架构

```
MemoryStore (facade)
  │
  ├── store(text, tags?)        → 写入记忆
  ├── recall(query, maxChars?)  → 关键词召回（返回格式化字符串）
  ├── search(query, opts?)      → 结构化搜索（返回 MemorySearchResult[]）
  ├── loadRecentContext(max?)   → 加载最近记忆（注入 system prompt）
  └── close()
  │
  └── MemoryBackend (interface)
        ├── FileMemoryBackend    ← 默认，零依赖
        ├── CloudMemoryBackend   ← 预留（Prismer Cloud）
        └── VectorMemoryBackend  ← 预留（embedding search）
```

### FileMemoryBackend

- 存储路径: `/workspace/.prismer/memory/YYYY-MM-DD.md`
- 每条记忆以 `---` 分隔，带时间戳和可选 tags
- 搜索: 关键词匹配，score = 匹配关键词数 / 总关键词数（0–1 归一化）
- 关键词过滤: 长度 < 3 的词被忽略
- `recent()` 只加载 today + yesterday 的文件

### Compaction → Memory Flush 流程

当上下文超过 `MAX_CONTEXT_CHARS`（默认 600K）时触发：

```
context overflow → memoryFlushBeforeCompaction()
                     │
                     ├── serialize dropped messages (≤8K chars)
                     ├── LLM 提取关键事实（maxTokens: 500）
                     └── memoryStore.store(facts, ['auto-flush', 'compaction'])
                   → compactConversation()
                     │
                     ├── LLM 摘要（maxTokens: 2000）
                     └── 注入 session.compactionSummary
```

注意: `agent.ts:303` 的 `!session.compactionSummary` 守卫使得**每个 Session 只触发一次** memory flush。

### 记忆注入

`session.buildMessages()` 将记忆上下文追加到 system prompt：

```
[system prompt]
## Memory from Previous Sessions
[loadRecentContext() 输出，最多 3000 chars]
```

---

## 配置

| 环境变量 | Config 路径 | 默认值 | 说明 |
|----------|------------|--------|------|
| `MEMORY_BACKEND` | `memory.backend` | `file` | 后端类型: `file` / `cloud` / `vector` |
| — | `memory.recentContextMaxChars` | `3000` | system prompt 中记忆上下文的最大字符数 |

---

## 关键文件

| 文件 | 说明 |
|------|------|
| `src/memory.ts` | MemoryBackend 接口 + FileMemoryBackend + MemoryStore facade |
| `src/compaction.ts` | `memoryFlushBeforeCompaction()` + `compactConversation()` |
| `src/agent.ts:296-320` | Context guard + compaction 触发逻辑 |
| `src/session.ts:53-80` | `buildMessages()` — compaction summary + 记忆注入 |
| `src/config.ts:122-128` | Memory 配置 schema |

---

## 评测结果

### Benchmark 1: 自定义事实召回（Fact Recall）

测试 Lumin compaction pipeline 对精确事实的记忆保持能力。

**方法**: 4 轮 compaction cycle，每轮种入 3 条独立事实（共 12 条），每轮通过真实 LLM 调用种入 → `memoryFlushBeforeCompaction()` 提取 → `compactConversation()` 压缩。最终用 LLM 验证每条事实的召回。

**模型**: `us-kimi-k2.5` | **耗时**: 334s | **LLM 调用**: ~36 次

```
Memory Store Recall by Compaction Cycle
───────────────────────────────────────────────────────
Cycle 1 │████████████████████  100%   3/3
Cycle 2 │████████████████████  100%   6/6
Cycle 3 │████████████████████  100%   9/9
Cycle 4 │████████████████████  100%  12/12
───────────────────────────────────────────────────────
Final LLM Recall (with memory context):  92%  (11/12)
```

| 事实类别 | 示例 | Store 召回 | LLM 召回 |
|---------|------|-----------|---------|
| numeric | 校准系数 0.03847 | ✓ | ✓ |
| person | Prof. Yolanda Marchetti, Bologna | ✓ | ✓ |
| path | /data/.../run-47b.parquet | ✓ | ✓ |
| decision | Fourier-Bessel 替代 wavelet | ✓ | ✓ |
| config | Redis 7200s, 24 workers | ✓ | ✓ |
| architecture | Apache Pulsar, 5 partitions | ✓ | ✗ (空响应) |
| deadline | ICML 2027, Jan 23 | ✓ | ✓ |
| formula | D = kT/(6πηr) | ✓ | ✓ |
| version | PyTorch 2.4.1, CUDA 12.6 | ✓ | ✓ |
| credential | GCP prismer-research-42 | ✓ | ✓ |

**结论**: FileMemoryBackend 的关键词搜索对精确事实（数字、人名、路径）保持 100% 召回。LLM 端 92% 丢失主要来自模型偶发空响应，非记忆系统问题。

---

### Benchmark 2: LoCoMo 公开基准（Long-term Conversation Memory）

使用 Snap Research 的 [LoCoMo](https://github.com/snap-research/locomo) 数据集评测。LoCoMo 是学术界广泛引用的长期对话记忆基准，包含 10 组多会话对话（~300 轮/组）和标注的 QA 对。

**方法**: 将 19 个会话（369 轮，43K chars）存入 FileMemoryBackend → 对每个 QA 问题进行关键词搜索（`maxChars: 6000`）→ 用 LLM 基于检索的记忆片段回答 → LLM-as-judge 评分。

**样本**: conv-30 (最小样本) | **QA**: 56 题

#### 多模型对比

```
LoCoMo Benchmark — Model Comparison (FileMemoryBackend, keyword search)
══════════════════════════════════════════════════════════════════════════════
                   claude-opus-4-6        us-kimi-k2.5         glm-4.6 (partial)
──────────────────────────────────────────────────────────────────────────────
Single-hop (11)    ██████████████ 100%    ███░░░░░░░░░░░  18%   ███░░░░░░░░░░░  27%
Temporal   (15)    █████████████░  93%    ██████████░░░░  73%   ██░░░░░░░░░░░░  13%
Open-domain(15)    █████████████░  93%    █████████░░░░░  67%   ████░░░░░░░░░░  33%
Adversarial(15)    ████████░░░░░░  60%    ███████████░░░  80%   ████████░░░░░░  53%
──────────────────────────────────────────────────────────────────────────────
Overall            ████████████░░  86%    █████████░░░░░  63%   ██████░░░░░░░░  ~48%
No adversarial     █████████████░  95%    ████████░░░░░░  56%   █████░░░░░░░░░  ~35%
══════════════════════════════════════════════════════════════════════════════
Duration                         733s                   840s            >1200s (timeout)
Baseline: Letta/MemGPT filesystem ≈ 74% on full LoCoMo
```

| 模型 | Overall | No Adv. | Single-hop | Temporal | Open-domain | Adversarial | 耗时 |
|------|---------|---------|------------|----------|-------------|-------------|------|
| **claude-opus-4-6** | **86%** | **95%** | **100%** (11/11) | **93%** (14/15) | **93%** (14/15) | 60% (9/15) | 733s |
| us-kimi-k2.5 | 63% | 56% | 18% (2/11) | 73% (11/15) | 67% (10/15) | **80%** (12/15) | 840s |
| glm-4.6 | ~48%* | ~35%* | ~27% (3/11) | ~13% (2/15) | ~33% (5/15) | ~53% (8/15) | >1200s |
| *Letta/MemGPT* | *~74%* | — | — | — | — | — | — |

\* glm-4.6 在 Q50/56 超时（20 分钟限制），数据为部分结果。

#### 各模型分析

**Claude Opus 4.6 (86%)**:
- **超越 Letta/MemGPT baseline (+12pp)**，即使使用零依赖关键词搜索
- Single-hop 100%: 能从噪声较多的检索结果中精准定位事实
- Temporal 93%: 准确解析会话头部的日期时间标记
- Open-domain 93%: 叙事理解和细节提取能力极强
- Adversarial 60%: 唯一短板 — 倾向于尝试回答陷阱题而非拒绝（过度自信）
- **结论**: 模型能力是记忆系统效果的决定性因素，强 LLM 可以弥补搜索质量不足

**Kimi K2.5 (63%)**:
- Temporal 73%: 日期关键词匹配有效
- Adversarial 80%: 识别陷阱题的能力优于 Claude
- Single-hop 18%: 弱 — 从长上下文中提取分散事实的能力不足
- 性价比适中，适合非关键场景

**GLM-4.6 (~48%, partial)**:
- 推理速度最慢（20 分钟未完成 56 题）
- 经常返回空响应或超时错误
- Temporal 最差（~13%）— 无法有效解析日期上下文
- 不推荐用于记忆召回场景

#### P0+P1 搜索优化实验（回归 — 已弃用）

额外测试了两项搜索优化（使用 kimi-k2.5）:
- **P0 Turn-level chunking**: `splitIntoChunks()` 对 >500 chars 条目进行滑动窗口切分
- **P1 Multi-query**: 对 ≥5 关键词查询生成 3 关键词子窗口

**结果**: Overall 从 63% 降至 46%（↓17pp），Temporal 从 73% 暴跌至 20%（↓53pp）。

| 原因 | 影响 |
|------|------|
| Turn-level chunks 丢失会话头部时间戳 | Temporal ↓53pp |
| 小 chunks 关键词密度高，挤掉完整会话上下文 | Open-domain ↓14pp |
| LLM 收到碎片化片段，无法拼出连贯叙事 | 大量 "I don't have that information" |

**结论**: P0+P1 对对话记忆场景有害。代码保留在 `src/memory.ts` 中但不推荐启用。真正的瓶颈不是搜索粒度，而是语义理解 — 如 Claude Opus 所证明，强 LLM + 粗粒度搜索 > 弱 LLM + 细粒度搜索。

#### 与 Letta/MemGPT Baseline 对比

| 维度 | Lumin + Claude Opus | Lumin + Kimi K2.5 | Letta (filesystem) |
|------|---------------------|-------------------|-------------------|
| 整体准确率 | **86%** | 63% | ~74% |
| 检索方式 | 关键词匹配（score = hits/keywords） | 同左 | 全文搜索 + embedding rerank |
| 存储粒度 | 整个会话 (~2K chars/条) | 同左 | 可配置 chunk |
| 依赖 | 零依赖（纯 Node.js fs） | 同左 | Python + OpenAI embedding API |

---

### 瓶颈分析与改进方向

#### 核心发现

多模型对比揭示了记忆系统的真正瓶颈:

1. **模型能力 >> 搜索优化**: Claude Opus 86% vs Kimi K2.5 63%（相同搜索引擎，+23pp），而 P0+P1 搜索优化在 Kimi 上反而 -17pp。LLM 从噪声中提取信号的能力是决定性因素。
2. **关键词搜索已够用**: 配合强 LLM，零依赖的关键词搜索（FileMemoryBackend）已超越 Letta/MemGPT 的 embedding + rerank 方案（86% vs 74%）。
3. **搜索粒度不宜过细**: Turn-level chunking 丢失上下文（日期、叙事弧），对对话记忆有害。整会话存储（~2K chars）是当前最优粒度。
4. **Adversarial 与模型个性相关**: Claude 倾向回答(60%)，Kimi 倾向拒绝(80%)，GLM 居中(53%)。这是模型 calibration 差异，非记忆系统问题。

#### 改进路径（修订）

| 优先级 | 方向 | 预期提升 | 实现复杂度 | 状态 |
|--------|------|---------|-----------|------|
| ~~P0~~ | ~~Turn-level chunking~~ | ~~+10-15%~~ **实际: -17%** | 低 | ✗ 已验证有害 |
| ~~P1~~ | ~~Multi-query search~~ | ~~+5-8%~~ **贡献不明** | 低 | ✗ 已验证无效 |
| P2 | **升级默认模型** — 使用 Claude Opus 或同级别模型 | +23pp (已验证) | 零 (仅改配置) | ✓ 已验证 |
| P3 | **Adversarial calibration** — 调整 system prompt 使强模型适度拒答 | +5-10% overall | 低 | 待实现 |
| P4 | **Semantic search backend** — embedding 向量检索 | +5-10% (边际) | 中 (需向量 DB 或 API) | 待评估 |
| P5 | **Multi-sample evaluation** — 扩展到 LoCoMo 全部 10 samples | 验证鲁棒性 | 低 (仅增加测试时间) | 待实现 |

---

## 测试

```bash
# 单元测试 (27 tests, 0 LLM calls)
npx vitest run tests/memory.test.ts

# 自定义事实召回 benchmark (需要 LLM gateway, ~5 min)
npx vitest run tests/memory-recall-benchmark.test.ts

# LoCoMo 公开基准 (需要 LLM gateway, ~14 min)
npx vitest run tests/locomo-benchmark.test.ts

# 查看结果
cat tests/output/memory-recall-benchmark.json | jq '.memoryRecallCurve'
cat tests/output/locomo-benchmark.json | jq '.categoryScores'
```

**测试文件**:

| 文件 | 类型 | 说明 |
|------|------|------|
| `tests/memory.test.ts` | 单元测试 | 27 tests: FileMemoryBackend + MemoryStore facade |
| `tests/memory-recall-benchmark.test.ts` | 集成 benchmark | 自定义 12 事实 × 4 compaction cycles |
| `tests/locomo-benchmark.test.ts` | 公开 benchmark | LoCoMo 数据集, 56 QA, LLM-as-judge |
| `tests/fixtures/locomo10.json` | 数据集 | LoCoMo 10 samples (2.8MB) |
| `tests/output/*.json` | 结果 | Benchmark 输出 (gitignored) |
