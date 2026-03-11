---
name: research-workflow
description: End-to-end research workflow best practices — paper writing, data analysis, experiments, and peer review
---

# Research Workflow Skill

## Description

Best practices for common research workflows. This skill does NOT add new tools — all workspace tools are available to every agent. Instead, it provides **workflow guidance** on how to use tools effectively for different research tasks.

## Research Notes — MANDATORY Protocol

**Every research action MUST produce a timestamped note entry.** This is NON-NEGOTIABLE. If you performed an action (read a paper, ran an experiment, made a writing decision, searched literature) and did NOT call `update_notes`, you violated the protocol. Go back and record the note before proceeding.

### Timestamp format

Every `update_notes` call MUST begin the appended content with a timestamp heading:

```
## [YYYY-MM-DD HH:MM] <Note Category>
```

Example:
```
## [2026-03-02 14:23] Reading Notes — TransUNet
- Core contribution: hybrid CNN-Transformer for medical image segmentation
- Key result: 77.48% DSC on Synapse, +2.8% over vanilla U-Net
- Limitation: needs large pretraining data for Transformer component
- Relevance: baseline for our Section 4.2 comparison
```

### Note categories (use in heading)
- `Reading Notes — <Paper/Source>` — after reading each paper or source
- `Decision Log` — after any design/scope/methodology decision
- `Experiment Log — <Experiment Name>` — after each experiment run
- `Observation` — when noticing patterns, anomalies, or surprises
- `Synthesis` — when connecting ideas across papers or results
- `Progress Update` — milestone reached, blockers, next steps
- `Writing Decision` — why a section was structured a certain way, what was cut and why
- `Revision Note` — during paper revision, what was changed and why

### Enforcement rules
- Call `update_notes` with `mode: "append"` — NEVER overwrite
- Note IMMEDIATELY after the action — do not batch "I'll write notes later"
- If a workflow step below says **→ NOTE**, you MUST call `update_notes` before moving to the next step
- Minimum: one note per research action. More is better.
- Notes are for YOUR future self — include enough context to understand weeks later
- Link notes to artifacts: "See Figure 3 in gallery", "Related to Section 4.2 in paper"

## Paper Writing Workflow (Research / Technical Paper)

### When to use
User asks to write a conference paper, workshop paper, technical report, or short-form research paper (typically 4–10 pages).

### Recommended flow

1. **Plan** — `update_tasks` to create a visible task plan with sections as subtasks
   **→ NOTE**: `## [timestamp] Planning — <Paper Title>` — record central thesis, target venue, section plan, key claims to support

2. **Understand context** — `get_workspace_state` to check current workspace state

3. **Research** — `context_search` for web sources, `arxiv_to_prompt` for arXiv papers
   **→ NOTE after EACH paper/source**: `## [timestamp] Reading Notes — <Paper Title>` — main contribution, methodology, results, relevance to your paper, strengths/limitations

4. **Outline** — organize paper structure in notes
   **→ NOTE**: `## [timestamp] Outline Draft` — full section structure, map sources to sections, list claims that need evidence, identify gaps

5. **Write** — `latex_project` to create LaTeX files with a conference template (CVPR, NeurIPS, ACL, IEEE, etc.)
   **→ NOTE after each section written**: `## [timestamp] Writing Decision — <Section>` — formulation choices, what was included/excluded and why, open issues

6. **Compile** — `latex_project_compile` to produce PDF
   **→ NOTE**: `## [timestamp] Progress Update` — compile result, page count, remaining work

7. **Track progress** — `update_task` after each major step

### Paper structure guidance

**Standard structure** (adjust per venue):
- **Abstract** (150–250 words): Problem → Gap → Method → Key result → Impact
- **Introduction** (1–1.5 pages): Motivation → Problem statement → Contributions list → Paper outline
- **Related Work** (0.5–1 page): Organized by theme, not chronologically. End each paragraph by positioning your work
- **Method** (2–3 pages): Formalize problem → Describe approach → Algorithm/architecture details → Complexity analysis
- **Experiments** (2–3 pages): Setup (datasets, baselines, metrics) → Main results table → Ablation study → Qualitative examples
- **Conclusion** (0.5 page): Recap contributions → Limitations → Future work

**Writing quality checklist**:
- Each section starts with a brief roadmap sentence ("In this section, we describe...")
- Every claim is backed by a citation or experimental evidence
- Figures and tables are referenced in text before they appear
- Notation is introduced before first use and stays consistent
- Contributions in the introduction match what the paper actually delivers

### Key principles
- ALWAYS use a conference template — never bare `\documentclass{article}`
- ALWAYS outline in notes before writing LaTeX
- ALWAYS compile after writing — users expect to see a PDF
- ALWAYS take notes — if you wrote a section and didn't call `update_notes`, go back and record your writing decisions
- Use `update_operation_status` for long operations (compilation, search)
- Write the abstract LAST — it should summarize the actual content, not the plan

## Survey / Review Paper Workflow

### When to use
User asks to write a survey, literature review, systematic review, tutorial paper, or SoK (Systematization of Knowledge).

### Recommended flow

1. **Scope definition** — `update_tasks` to define: (a) research questions the survey answers, (b) inclusion/exclusion criteria, (c) target venues and time range
   **→ NOTE**: `## [timestamp] Scope Definition` — research questions, what is in/out of scope and why, target paper count and page budget (see volume calibration below)

2. **Literature collection** — Iterative search:
   - `context_search` with multiple query formulations (synonyms, related terms)
   - `arxiv_to_prompt` to read key papers in detail
   - Follow citation chains: read a paper → search its references and citing papers
   - Aim for comprehensive coverage — surveys are judged by completeness
   **→ NOTE after EACH paper**: `## [timestamp] Reading Notes — <Paper Title>`
   - Paper: title, authors, year, venue
   - Core method / contribution (1–2 sentences)
   - Key results and datasets used
   - Strengths and limitations
   - Which taxonomy category it belongs to
   - Connections to other papers already read

3. **Taxonomy design** — build a classification scheme
   **→ NOTE**: `## [timestamp] Taxonomy Design` — classification hierarchy, comparison dimensions, identified gaps/trends/under-explored areas, why this taxonomy over alternatives

4. **Outline** — plan the full paper structure
   **→ NOTE**: `## [timestamp] Survey Outline` — section plan with page budgets, figure/table list, which papers go in which section

5. **Write** — `latex_project` with an appropriate template (IEEE TPAMI, ACM Computing Surveys, or conference survey track)
   **→ NOTE after each category section**: `## [timestamp] Writing Decision — <Category>` — how methods were ordered, what narrative thread connects them, what was omitted and why

6. **Comparison tables** — Use `jupyter_execute` or `data_load` to generate comparison tables and trend charts from collected data
   **→ NOTE**: `## [timestamp] Benchmark Analysis` — key findings from comparison, which methods are Pareto-optimal, surprising results, fairness caveats

7. **Visualize** — `jupyter_execute` to create taxonomy diagrams, timeline charts, or performance comparison plots → `update_gallery`

8. **Synthesis** — write cross-cutting analysis
   **→ NOTE**: `## [timestamp] Synthesis` — cross-cutting themes, contradictions between papers, consensus vs controversy, field trajectory

9. **Compile** — `latex_project_compile` to produce PDF
   **→ NOTE**: `## [timestamp] Progress Update` — compile result, total pages, paper count, remaining work

10. **Track progress** — `update_task` after each major section

### Volume calibration — match depth to topic

NOT all surveys are the same size. Before writing, assess the topic's scope and choose the appropriate tier:

| Topic scope | Example | Paper count | Pages | Depth |
|-------------|---------|-------------|-------|-------|
| **Narrow / Focused** | "Attention mechanisms in medical image segmentation" | 20–40 | 8–15 | Deep dive per paper, detailed algorithm comparison |
| **Medium / Subfield** | "Graph neural networks for recommendation" | 40–80 | 15–25 | Representative methods per category, selective deep dives |
| **Broad / Field-level** | "Large language models" | 100–300+ | 25–50+ | Taxonomy-driven, cover families of methods, cite extensively but describe selectively |

**How to decide:**
- Count papers found in the literature collection phase → this determines tier
- If >100 papers, you CANNOT describe each one — group into method families, describe the representative/seminal work in detail, and cite the rest
- If <30 papers, you MUST go deep — each paper deserves 1–2 paragraphs of analysis
- Adjust page budget per section accordingly — don't write a 5-page taxonomy for a 20-paper survey

### Survey structure guidance

**Recommended structure** (adjust proportions by volume tier):
- **Abstract**: Scope → Number of papers reviewed → Key findings → Taxonomy preview
- **Introduction** (1.5–3 pages): Motivation → Why this survey is needed NOW (what changed recently?) → Research questions → Scope and methodology (inclusion/exclusion criteria, search strategy, time range) → Contributions → Paper organization
- **Background** (1–3 pages): Core concepts, formal problem definition, shared evaluation protocols. Write enough so a reader outside the subfield can follow the rest.
- **Taxonomy / Classification** (1–2 pages): Present your organizational framework with a visual taxonomy diagram. Explain WHY you chose this taxonomy over alternatives.
- **Detailed Review by Category** (main body): One section per taxonomy branch — see "How to write about each method" below.
- **Benchmark & Evaluation** (2–4 pages): Dedicated section (not scattered across categories) — see "Benchmark analysis" below.
- **Open Problems & Future Directions** (1–3 pages): Unsolved challenges, emerging trends, promising research directions. Be specific — "more data" is not a future direction.
- **Conclusion** (0.5–1 page): Key takeaways, recommendations for practitioners and researchers.

### How to write about each method (CRITICAL)

When describing a paper/method in the survey body, follow this structure — do NOT just list papers:

1. **What problem does it solve?** — State the specific limitation or gap this method addresses. "Method X was proposed to solve the problem of Y, which prior approaches Z1, Z2 failed to handle because..."
2. **What is the innovation?** — Describe the core technical novelty in 2–4 sentences. What is the key idea that distinguishes it? A new loss function? A new architecture? A new training strategy? Be precise.
3. **How does it relate to prior methods?** — Explicitly state the logical relationship:
   - **Extension**: "Builds on [Method A] by adding..."
   - **Alternative**: "Takes a fundamentally different approach from [Method A] by..."
   - **Combination**: "Combines the strengths of [Method A] and [Method B]..."
   - **Refinement**: "Addresses the limitation of [Method A] where..."
4. **Key results** — Report quantitative results on standard benchmarks: dataset, metric, performance. Use concrete numbers, not "achieves state-of-the-art."
5. **Limitations** — Every method has them. What does it NOT handle? What assumptions does it make? Where does it fail?

**Example of GOOD survey writing:**

> TransUNet (Chen et al., 2021) addresses the loss of global context in pure CNN encoders for medical image segmentation. The key innovation is a hybrid architecture that uses a CNN (ResNet-50) to extract local features, then feeds patch-embedded feature maps into a Vision Transformer to capture long-range dependencies, before upsampling with a cascaded decoder. This extends the prior U-Net framework by replacing the bottleneck with a Transformer encoder, unlike ViT-based methods (Dosovitskiy et al., 2021) that tokenize raw pixels and lose fine spatial detail. On the Synapse multi-organ dataset, TransUNet achieves 77.48% mean DSC, outperforming both the vanilla U-Net (74.68%) and pure-Transformer baselines (71.29%). However, it requires significantly more compute than U-Net due to the Transformer component, and its performance degrades on small datasets (<100 images) where the Transformer cannot be pretrained effectively.

**Example of BAD survey writing (avoid this):**

> Chen et al. (2021) proposed TransUNet, which combines CNN and Transformer for medical image segmentation. It achieves good results on the Synapse dataset. *(← No problem statement, no innovation detail, no relationship to prior work, no specific numbers, no limitations)*

### Benchmark analysis (CRITICAL)

Surveys MUST include rigorous benchmark analysis, not just a table of numbers:

1. **Standard benchmarks table** — Create a comprehensive comparison table:
   - Rows: methods (chronological within each category)
   - Columns: datasets × metrics (e.g., CIFAR-10 Acc, ImageNet Top-1, COCO mAP)
   - Mark the best result per column. Include year of publication.
   - Use `jupyter_execute` or `data_load` to generate — don't typeset manually
2. **Performance trend analysis** — Plot how SOTA evolves over time:
   - X-axis: year, Y-axis: metric → `jupyter_execute` to create line charts → `update_gallery`
   - Identify inflection points: "Performance plateaued from 2019-2020, then jumped with the introduction of [method family]"
3. **Apples-to-apples fairness** — Note when results are NOT directly comparable:
   - Different training data, pretraining, data augmentation, hardware
   - "Results reported under different settings; direct comparison should be interpreted with caution"
4. **Efficiency-accuracy tradeoff** — If relevant, include a scatter plot:
   - X-axis: FLOPs or parameters, Y-axis: accuracy
   - Reveals which methods are Pareto-optimal
5. **Cross-dataset generalization** — Do methods that win on Dataset A also win on Dataset B? Note discrepancies.

### Logical flow between methods

The survey body should read as a **narrative**, not a list. Connect methods with explicit logical transitions:

- **Chronological evolution**: "Following the success of [A], researchers explored [B] which..." → "This line of work was further advanced by [C]..."
- **Problem-solution chains**: "While [A] solved X, it introduced a new problem Y. [B] was proposed specifically to address Y by..."
- **Paradigm shifts**: "The above methods all assume Z. [D] challenged this assumption by showing that..."
- **Convergence**: "Interestingly, [E] from the NLP community and [F] from the CV community arrived at similar architectures independently, suggesting..."

At the end of EACH category section, include a **mini-summary** (2–3 sentences): what this family of methods achieves, what common limitations remain, and how the next category addresses them — creating a bridge to the next section.

### Survey-specific principles
- Define clear inclusion/exclusion criteria upfront — document them in the paper
- Use a structured comparison table with consistent dimensions across all papers
- Include a visual taxonomy (tree diagram or concept map) — readers rely on it for navigation
- Cover both seminal works and recent advances — surveys must show historical evolution
- Be balanced — present all major approaches fairly, even if you have a preference
- Highlight consensus AND controversy in the field
- Track paper counts: "We review N papers published between YYYY and YYYY"
- NEVER just list papers — every method description must answer: what problem, what innovation, what relationship to prior work, what results, what limitations
- Benchmark tables are mandatory — a survey without quantitative comparison is incomplete

## Long Paper Writing Workflow

### When to use
User asks to write a thesis chapter, journal paper (10+ pages), monograph section, or any long-form academic document that requires multi-session planning.

### Phase 1: Planning & Structuring
1. **Define scope** — `update_tasks` with a high-level plan:
   - Central thesis or research question
   - Target venue/format (journal, thesis, book chapter) and page budget
   - Planned sections with estimated page counts
   **→ NOTE**: `## [timestamp] Planning — <Paper Title>` — central thesis, venue, page budget, section plan, narrative arc, target audience

2. **Literature mapping** — Build a structured bibliography:
   - `context_search` + `arxiv_to_prompt` for each major topic area
   **→ NOTE after EACH paper**: `## [timestamp] Reading Notes — <Paper Title>` — key insight, relevance to your work, which section it supports, disagreements with other sources

3. **Detailed outline** — `update_notes` (append) with a multi-level outline:
   - Section → Subsection → Key points per paragraph
   - Mark which claims need citations, experiments, or figures
   - Identify dependencies between sections (what must be written first)
   **→ NOTE**: `## [timestamp] Detailed Outline` — the full outline plus dependency analysis

4. **Figure planning**
   **→ NOTE**: `## [timestamp] Figure Plan` — list all figures/tables needed, assign each to a section, describe what each should show

### Phase 2: Section-by-Section Writing
5. **Write in logical order** — NOT necessarily top-to-bottom:
   - **Method section first** — the core contribution; everything else supports it
   - **Experiments next** — validates the method; may reveal missing method details
   - **Related work** — easier to write once you know your own positioning
   - **Introduction** — write after method + experiments clarify the story
   - **Abstract and conclusion** — write LAST
6. **Per-section workflow**:
   - `update_task` to mark current section as in-progress
   - `latex_project` to write the section (one file per section for long papers: `method.tex`, `experiments.tex`, etc.)
   - **→ NOTE**: `## [timestamp] Writing Decision — <Section>` — formulation choices, what was cut and why, open issues to revisit
   - `latex_project_compile` after each section to catch errors early
   - `update_task` to mark complete
7. **Cross-references** — Maintain consistent `\label{}` / `\ref{}` usage across files

### Phase 3: Integration & Polish
8. **Assemble** — Ensure `main.tex` includes all section files in correct order
9. **Consistency pass** — Check notation, terminology, and style across sections
10. **Figure generation** — `jupyter_execute` for all plots and data visualizations → `update_gallery`
11. **Bibliography** — Verify all citations are complete and consistent
12. **Final compile** — `latex_project_compile` for the complete document
13. **Self-review**
    **→ NOTE**: `## [timestamp] Self-Review` — checklist: does abstract match content? All figures/tables referenced? Contribution clearly stated and delivered? Limitations honestly discussed? Remaining issues for next revision.

### Multi-file LaTeX organization (for papers >10 pages)
```
main.tex          % \input{} all section files, preamble, bibliography
abstract.tex      % Abstract
introduction.tex  % Introduction + contributions
related.tex       % Related work
background.tex    % Preliminaries / background
method.tex        % Proposed method
experiments.tex   % Experimental setup + results
conclusion.tex    % Conclusion + future work
appendix.tex      % Supplementary material
references.bib    % BibTeX entries
figures/          % Figure files
```

### Long paper principles
- Break writing into manageable sessions — one section per task cycle
- Compile frequently — don't accumulate 20 pages of uncompiled LaTeX
- Keep a running "TODO" list in notes for cross-section issues (missing citations, inconsistent notation)
- Use `\input{}` for multi-file organization — never put 30+ pages in a single .tex file
- Budget pages explicitly: if the venue allows 15 pages, plan how many pages per section upfront
- Write the "story" first (what is the narrative arc?) before diving into technical details
- ALWAYS take notes after each section — a section without a writing-decision note is incomplete

## Paper Revision & Rebuttal Workflow

### When to use
User asks to revise a paper based on reviewer feedback, write a rebuttal, or prepare a camera-ready version.

### Recommended flow

1. **Organize feedback**
   **→ NOTE**: `## [timestamp] Reviewer Feedback Summary` — categorize by: Major concerns / Minor concerns / Questions / Suggestions. Prioritize: must-change vs. should-change vs. nice-to-have

2. **Plan revisions** — `update_tasks` with one task per major revision item
   **→ NOTE**: `## [timestamp] Revision Strategy` — how each concern will be addressed: what to change, what experiments to add, what arguments to make

3. **Rebuttal draft** — `latex_project` for a point-by-point response:
   - Quote each reviewer comment
   - State what was changed and where (with page/line numbers)
   - For disagreements, provide evidence and respectful counterarguments

4. **Apply revisions** — `latex_project` to modify the paper, use `\textcolor{blue}{...}` or `\changes{}` to highlight changes
   **→ NOTE after each revision**: `## [timestamp] Revision Note — <Reviewer #, Comment #>` — what was changed, where, and why this addresses the concern

5. **Re-run experiments** if needed — `jupyter_execute` for additional baselines or ablations
   **→ NOTE**: `## [timestamp] Experiment Log — <Experiment>` — configuration, results, how they address reviewer concerns

6. **Compile** — `latex_project_compile` to produce revised PDF
   **→ NOTE**: `## [timestamp] Diff Check` — verify each promised change is reflected, rebuttal claims match actual revision, list any remaining gaps

### Key principles
- Address EVERY reviewer comment — even minor ones. Ignoring comments is the #1 cause of re-rejection
- Be respectful and grateful in rebuttals, even for unfair reviews
- "We have revised Section X as follows..." is stronger than "We disagree because..."
- Add experiments or analyses that reviewers request when feasible — this shows good faith

## Data Analysis Workflow

### When to use
User asks to analyze data, create plots, explore datasets, or run statistical tests.

### Recommended flow

1. **Plan** — `update_tasks`
   **→ NOTE**: `## [timestamp] Analysis Plan` — research questions, datasets to use, analyses to perform, expected output

2. **Load data** — `data_load` or `data_list` to inspect available datasets
   **→ NOTE**: `## [timestamp] Data Quality — <Dataset>` — dataset size, columns, types, missing values, potential issues spotted

3. **Explore** — `jupyter_execute` for exploratory analysis (distributions, correlations, missing values)
   **→ NOTE after each exploration step**: `## [timestamp] Observation` — patterns found, anomalies, hypotheses formed, surprises

4. **Visualize** — `jupyter_execute` to create charts, then `update_gallery` to display

5. **Analyze** — statistical tests, modeling, comparisons
   **→ NOTE**: `## [timestamp] Analysis Results` — test results, effect sizes, interpretation, caveats, confidence intervals

6. **Summary report**
   **→ NOTE**: `## [timestamp] Synthesis` — coherent narrative synthesizing all findings, actionable conclusions

7. **Track progress** — `update_task` after each step

### Key principles
- Always inspect data quality before modeling
- Use proper statistical tests (not just eyeballing)
- Include confidence intervals and significance levels
- Save visualizations to gallery for easy review
- Record observations in notes BEFORE moving to the next analysis step — fleeting insights are easily lost

## ML Experiment Workflow

### When to use
User asks to train a model, run experiments, reproduce a paper, or benchmark algorithms.

### Recommended flow

1. **Plan** — `update_tasks` with experiment design
   **→ NOTE**: `## [timestamp] Experiment Design` — hypothesis, independent/dependent variables, baselines, metrics, datasets, hyperparameter choices and rationale

2. **Survey** — `arxiv_to_prompt` or `context_search` for related work and baselines
   **→ NOTE after EACH paper**: `## [timestamp] Reading Notes — <Paper>` — what baselines exist, what metrics are standard, what datasets are used

3. **Implement** — `jupyter_execute` for data loading, model building, training
   **→ NOTE after EACH experiment run**: `## [timestamp] Experiment Log — <Run Name>`
   - Configuration: hyperparameters, seed, dataset split, hardware
   - Results: metrics, training time, convergence behavior
   - Observations: what worked, what didn't, what to try next

4. **Evaluate** — Compare to baselines with proper metrics and ablations
   **→ NOTE**: `## [timestamp] Analysis — <Comparison>` — why method A beat B, failure cases, sensitivity analysis takeaways

5. **Visualize** — Plot training curves, comparison tables via `update_gallery`

6. **Write up** — `latex_project` for conference paper, or `update_notes` (append) for summary

### Key principles
- Always include baselines for comparison
- Use proper train/validation/test splits
- Report results with standard deviations or confidence intervals
- Document hyperparameters and random seeds
- Maintain a running experiment log in notes — it is invaluable when writing the paper later

## Peer Review Workflow

### When to use
User asks to review a paper, provide feedback, or assess technical quality.

### Recommended flow

1. **Load** — `load_pdf` or `arxiv_to_prompt` to read the paper
   **→ NOTE**: `## [timestamp] First Pass — <Paper Title>` — what is the paper about, claimed contribution, initial reaction to clarity and quality

2. **Technical check** — Verify methodology, proofs, experimental setup
   **→ NOTE**: `## [timestamp] Technical Analysis` — correctness issues, missing details, questionable assumptions, strong technical points

3. **Literature check** — `context_search` for missing related work
   **→ NOTE**: `## [timestamp] Literature Check` — missing references found, how they affect the paper's positioning

4. **Final review report**
   **→ NOTE**: `## [timestamp] Review Report — <Paper Title>`
   - Summary (2–3 sentences)
   - Strengths (bullet list)
   - Weaknesses (bullet list, ordered by severity)
   - Questions for authors
   - Minor issues (typos, formatting)
   - Overall recommendation and confidence score

### Key principles
- Be constructive — suggest improvements, not just criticisms
- Separate minor issues from fundamental concerns
- Check reproducibility (are details sufficient to replicate?)
- Verify claims against evidence presented
- Build the review incrementally in notes — each reading pass adds a new section

## General Best Practices

1. **Always start multi-step tasks with `update_tasks`** — users see progress in the Task Panel
2. **ALWAYS take timestamped notes** — `update_notes` (append) with `## [YYYY-MM-DD HH:MM] <Category>` heading after every significant action. A workflow step without a note is incomplete. This is the #1 rule.
3. **After `context_search`, summarize what was found** in both the response text AND in notes
4. **Use `update_operation_status`** for any operation taking >5 seconds
5. **Switch components explicitly** when the user should see a different view
6. **Compile LaTeX after writing** — never leave the user without a PDF
7. **Notes accumulate, never overwrite** — always use `mode: "append"` so the full research trail is preserved
8. **Self-check**: before completing a task, scroll through your notes — if any action is missing its note entry, go back and add it now
