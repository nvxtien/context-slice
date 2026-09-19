# ContextSlice v0.6 — Developer Context & Token Efficiency Benchmark

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice is not primarily an “agent optimization” product.

Its product goal is:

> Help developers send less code, fewer irrelevant files, and fewer tokens into an AI coding assistant while preserving the information required to complete the task correctly.

ContextSlice v0.1 through v0.5 are already implemented and validated.

Current validated capabilities include:

- MCP server over stdio
- Java parsing via Tree-sitter
- deterministic symbol indexing
- stable canonical symbol IDs
- ambiguity-safe lookup
- semantic call resolution
- incremental SQLite cache
- Git-aware diff analysis
- token budgeting
- minimum sufficient context
- required-fact evaluation
- real-repository benchmarking
- semantic call recall/precision evaluation

Current validated metrics:

- retrieval recall: 100%
- required-fact recall: 100%
- semantic call recall: 100%
- semantic call precision: 100%
- false-negative edge rate: 0%
- false-positive edge rate: 0%
- semantic resolution harm: 0%
- semantic fact loss: 0%
- median token reduction across the current real-repository benchmark: 95.05%

JDT/LSP remains deferred because current evidence does not justify adding compiler dependencies.

---

## 1. Primary objective

The purpose of v0.6 is:

> Quantify how much ContextSlice reduces developer context-window usage and token consumption when working with AI coding assistants, while preserving task correctness.

This phase is about developer-facing efficiency.

The central question is not:

> Does ContextSlice make the coding agent smarter?

The central question is:

> How much less context does the developer need to send to the coding assistant when using ContextSlice?

---

## 2. Product positioning

Use this positioning consistently in code comments, benchmark reports, README, and examples:

> ContextSlice helps developers reduce context-window usage and token consumption when working with coding assistants such as Codex and Claude Code.

Avoid phrasing such as:

- “ContextSlice makes the agent more efficient”
- “ContextSlice optimizes agent intelligence”
- “ContextSlice improves the model”
- “ContextSlice compresses the model context”

Prefer:

- “reduces developer-provided context”
- “reduces input tokens”
- “avoids unnecessary whole-file context”
- “constructs minimum sufficient code context”
- “preserves required information while shrinking context”

---

## 3. Developer workflow

The intended workflow is:

```text
Developer task
      ↓
ContextSlice
      ↓
minimum sufficient code context
      ↓
Codex / Claude / other coding assistant
```

Without ContextSlice:

```text
Developer task
      ↓
manual file selection / grep / whole-file copy
      ↓
large context window
      ↓
coding assistant
```

The benchmark must compare these two developer workflows.

---

## 4. Benchmark modes

Define two primary modes.

### Mode A — Manual / Whole-File Context

Simulate a developer preparing context manually.

Typical actions:

- open relevant files
- copy whole classes
- include controller/service/repository/test files
- include surrounding code because the exact relevant symbol is uncertain

Record exactly what context is supplied.

### Mode B — ContextSlice

The developer uses ContextSlice to construct a minimal semantic slice.

Record:

- selected symbols
- source fragments
- semantic metadata
- token estimate
- required facts preserved

Do not compare different tasks between the two modes.

---

## 5. Primary metrics

Add these developer-facing metrics.

### Context Window Reduction

```text
context_window_reduction =
1 - context_tokens_with_contextslice / context_tokens_manual
```

Report as percentage.

### Input Token Reduction

```text
input_token_reduction =
1 - assistant_input_tokens_with_contextslice / assistant_input_tokens_manual
```

Use exact telemetry when available.

Otherwise use the same token estimator for both modes and label it as estimated.

### Whole-File Avoidance

```text
whole_file_avoidance_rate =
whole files avoided
-------------------
whole files in manual baseline
```

### Irrelevant Context Elimination

```text
irrelevant_context_elimination =
baseline tokens not required by ground-truth facts
--------------------------------------------------
baseline tokens
```

This may be approximate.

Document methodology.

### Minimum Sufficient Context

Continue reporting:

```text
minimum_sufficient_budget
```

This remains a core product metric.

---

## 6. Correctness guardrail

Token/context reduction is only successful if task-critical information is preserved.

Release-blocking metrics:

```text
required-fact recall = 100%
retrieval recall = 100%
```

If either drops below 100%, report the failure and do not present the token reduction as successful for that task.

Do not optimize away required information.

---

## 7. Developer effort metrics

Add lightweight developer-effort metrics.

For each mode record:

```text
files manually opened
files copied into context
whole files included
context preparation steps
ContextSlice tool calls
whole-file fallbacks
```

Do not over-interpret wall-clock time unless measured reliably.

The goal is to show whether ContextSlice reduces context preparation burden.

---

## 8. Optional assistant telemetry

Codex/Claude telemetry is useful but optional.

If available, record:

```text
assistant input tokens
assistant output tokens
tool calls
elapsed time
tests passed
patch correctness
```

But v0.6 must not depend on proprietary telemetry.

The core benchmark must work using repository content and deterministic token estimation alone.

---

## 9. Do not compare models

Do not rank Codex vs Claude.

If both are available, compare each assistant only against itself:

```text
Codex manual context
vs
Codex + ContextSlice

Claude manual context
vs
Claude + ContextSlice
```

The subject of evaluation is ContextSlice.

---

## 10. Repository set

Reuse the exact three pinned repositories from v0.5.

Do not change commits.

Keep:

- Spring Petclinic
- Petclinic REST
- Keycloak `services`

This preserves longitudinal comparability.

---

## 11. Task set

Reuse the existing 15 real benchmark tasks.

Do not remove hard tasks.

Add a small set of developer-oriented tasks only if necessary.

Suggested categories:

- explain flow
- locate callers
- impact analysis
- small change
- validation change
- Git diff review

The existing 15 tasks should remain the primary aggregate.

---

## 12. Manual baseline definition

For each task, define a realistic manual context package.

Example:

```text
Task:
Explain owner update flow.

Manual context:
- OwnerController.java
- Owner.java
- OwnerRepository.java
- OwnerValidator.java
- OwnerControllerTests.java
```

The baseline must be reasonable.

Do not inflate it artificially to improve ContextSlice results.

Document why each file is included.

---

## 13. Baseline auditability

Store baseline definitions in machine-readable form.

Suggested:

```text
benchmarks/manual-context.json
```

Example:

```json
{
  "taskId": "petclinic-owner-update",
  "files": [
    "src/.../OwnerController.java",
    "src/.../Owner.java",
    "src/.../OwnerRepository.java"
  ],
  "reasoning": {
    "OwnerController.java": "contains target flow",
    "Owner.java": "contains mutated state",
    "OwnerRepository.java": "contains persistence boundary"
  }
}
```

Keep this separate from ContextSlice retrieval.

---

## 14. Avoid baseline gaming

Do not:

- include obviously unrelated files
- include the entire repository
- include generated directories
- choose larger baseline files only to increase token reduction
- exclude a file from baseline merely because ContextSlice does not need it

The manual baseline should model what a competent developer would reasonably provide when preparing context without ContextSlice.

---

## 15. ContextSlice package definition

For each task record exactly what ContextSlice supplies:

```text
target body
annotations
caller summaries
callee signatures
relevant fields/types
tests if necessary
Git diff context when applicable
```

Do not include hidden ground-truth facts.

The retrieval engine must remain independent from benchmark expectations.

---

## 16. Context composition report

For every task break down ContextSlice tokens by category:

```text
target source
caller context
callee context
annotations
types
tests
diff
metadata
```

This identifies where context-window budget is spent.

Example:

```text
target source: 420
callers: 130
callees: 210
annotations: 24
tests: 310
metadata: 80
total: 1174
```

---

## 17. Developer Context Efficiency

Add a main metric:

```text
Developer Context Efficiency =
required facts preserved
------------------------
context tokens supplied
```

Calculate for:

- manual baseline
- ContextSlice

Use the same required-fact definitions from previous versions.

---

## 18. Context Waste Ratio

Add:

```text
context_waste_ratio =
context tokens not needed for required facts
--------------------------------------------
total context tokens
```

This may be estimated using deterministic mapping from facts to symbols/source regions.

If the estimate is uncertain, label it accordingly.

Do not use an LLM judge as the only method.

---

## 19. Whole-file fallback rate

When ContextSlice cannot provide enough context and a whole-file read becomes necessary, record:

```text
whole_file_fallback_rate =
tasks requiring at least one full-file fallback
-----------------------------------------------
total tasks
```

Also record:

```text
whole_files_fallback_total
```

A fallback is not automatically a failure.

The purpose is to quantify how often minimal slicing is insufficient.

---

## 20. Token estimator

Use the same token estimator for baseline and ContextSlice.

If exact model tokenizer support exists, use it through an abstraction.

Otherwise continue using the deterministic estimator already present.

Reports must clearly distinguish:

```text
estimated tokens
```

from:

```text
observed model input tokens
```

Never mix them.

---

## 21. Multiple assistant context windows

Add optional reporting for common context-window budgets.

For each task report whether manual and ContextSlice context fit within:

```text
8K
16K
32K
64K
128K
```

Example:

```text
Manual context: 21K
- fits 8K: no
- fits 16K: no
- fits 32K: yes

ContextSlice: 1.3K
- fits 8K: yes
```

Do not imply specific product/model limits unless configured externally.

These are benchmark thresholds, not claims about current model offerings.

---

## 22. Context budget pressure

Add a metric:

```text
context_budget_pressure =
context tokens
--------------
configured context budget
```

Run at benchmark thresholds such as:

```text
8K
16K
32K
```

This shows how much of the developer’s available context window is consumed.

---

## 23. Long-task simulation

Add a bounded experiment where multiple related steps share one assistant conversation.

Example:

```text
1. explain flow
2. change validation
3. inspect tests
4. review diff
```

Compare cumulative context consumption:

```text
manual cumulative context
vs
ContextSlice cumulative context
```

Measure how quickly context-window pressure grows.

Do not simulate unlimited sessions.

---

## 24. Repeated-context duplication

Developers often resend the same file repeatedly.

Measure:

```text
duplicate_context_tokens
```

for manual mode across multi-step tasks.

For ContextSlice measure whether symbol-level retrieval avoids duplicate whole-file content.

Add:

```text
duplicate_context_reduction
```

---

## 25. Cache impact on developer workflow

Continue cache measurement, but frame it as responsiveness.

Report:

```text
cold index time
warm lookup latency
single-file refresh time
```

The question is:

> Can ContextSlice provide minimal context quickly enough to fit into an interactive developer workflow?

Avoid claiming productivity improvement solely from latency.

---

## 26. Report generation

Generate:

```text
benchmarks/results/v0.6-developer-context-efficiency.md
benchmarks/results/v0.6-developer-context-efficiency.json
```

Include:

1. Executive summary
2. Product positioning
3. Manual baseline methodology
4. Repository/task set
5. Context-window reduction
6. Input-token reduction
7. Whole-file avoidance
8. Required-fact preservation
9. Minimum sufficient context
10. Context composition
11. Context-window fit thresholds
12. Multi-step cumulative context
13. Whole-file fallback rate
14. Cache responsiveness
15. Optional Codex telemetry
16. Optional Claude telemetry
17. Limitations
18. Next step

---

## 27. Main result table

Include:

```text
| Repo | Task | Manual tokens | ContextSlice tokens | Reduction | Fact recall | Whole files avoided | Min sufficient budget |
|------|------|---------------|---------------------|-----------|-------------|--------------------|-----------------------|
```

---

## 28. Aggregate metrics

Report:

```text
total tasks
overall required-fact recall
overall retrieval recall

median context-window reduction
mean context-window reduction
minimum context-window reduction
maximum context-window reduction

median manual context tokens
median ContextSlice context tokens

whole-file avoidance rate
whole-file fallback rate

median minimum sufficient budget

median developer context efficiency
```

Keep failure cases in the aggregate.

---

## 29. Longitudinal comparison

Include:

```text
| Metric | v0.4 | v0.5 | v0.6 |
|--------|------|------|------|
| Retrieval recall | 100% | 100% | ... |
| Required-fact recall | 100% | 100% | ... |
| Semantic call recall | N/A | 100% | ... |
| Semantic call precision | N/A | 100% | ... |
| Median token/context reduction | 95.05% | ... | ... |
| Whole-file avoidance | N/A | N/A | ... |
| Whole-file fallback rate | N/A | N/A | ... |
```

Do not fabricate unavailable historical metrics.

---

## 30. README positioning update

Update README so the product is clearly described as a developer tool.

Recommended wording:

> ContextSlice helps developers reduce the amount of source code placed into an AI coding assistant’s context window. It builds a task-specific, minimum sufficient code slice so developers can use fewer input tokens and avoid sending irrelevant whole files.

Also include:

> Less code in context. Fewer tokens. Same required information.

Do not position the product primarily as “making agents more efficient.”

---

## 31. CLI / UX terminology

Review user-facing terminology.

Prefer:

```text
context tokens
context budget
minimum sufficient context
whole-file fallback
context reduction
token reduction
developer context
```

Avoid internal jargon in user-facing output where unnecessary.

---

## 32. No major architecture changes

Do not add in v0.6:

- JDT/LSP
- embeddings
- vector database
- cloud service
- multi-language support
- UI dashboard
- hidden LLM calls
- automatic code editing

Allowed changes:

- benchmark harness
- reports
- context composition metrics
- baseline definitions
- developer-facing terminology
- token accounting
- small bugs discovered during evaluation

---

## 33. Definition of done

v0.6 is complete when:

- existing build passes
- all existing tests pass
- v0.4/v0.5 correctness metrics do not regress
- manual context baselines exist for all benchmark tasks
- baseline methodology is documented
- ContextSlice context is recorded per task
- context-window reduction is measured
- token reduction is measured or estimated consistently
- required-fact recall remains 100%
- retrieval recall remains 100%
- whole-file avoidance is measured
- whole-file fallback rate is measured
- context composition is measured
- minimum sufficient context remains reported
- multi-step cumulative context experiment exists
- reports are generated in Markdown and JSON
- README uses developer-oriented product positioning
- optional assistant telemetry is clearly separated from deterministic benchmark results

---

## 34. Final implementation report

At completion output:

```text
STATUS

BUILD / TESTS

PRODUCT POSITIONING

REPOSITORIES / TASKS

MANUAL CONTEXT BASELINE

CONTEXTSLICE CONTEXT

CONTEXT-WINDOW REDUCTION

TOKEN REDUCTION

WHOLE-FILE AVOIDANCE

WHOLE-FILE FALLBACK RATE

REQUIRED-FACT RECALL

RETRIEVAL RECALL

MINIMUM SUFFICIENT CONTEXT

CONTEXT COMPOSITION

MULTI-STEP CUMULATIVE CONTEXT

CACHE RESPONSIVENESS

OPTIONAL CODEX TELEMETRY

OPTIONAL CLAUDE TELEMETRY

KNOWN LIMITATIONS

NEXT STEP
```

Every number must identify whether it is measured, estimated, or unavailable.

---

## 35. Guiding principle

The central question for v0.6 is:

> How much less code does a developer need to send into an AI coding assistant’s context window when using ContextSlice?

The success condition is:

```text
less context
+
fewer input tokens
+
same required information
```

ContextSlice should optimize the developer’s context budget, not attempt to optimize the model itself.
