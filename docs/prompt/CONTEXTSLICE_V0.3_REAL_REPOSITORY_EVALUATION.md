# ContextSlice v0.3 — Real Repository Evaluation

You are extending **ContextSlice**, a local MCP server that reduces coding-agent context through deterministic structural analysis and semantic slicing.

ContextSlice v0.1 and v0.2 are already implemented.

Current validated capabilities include:

- MCP server over stdio
- `context.search`
- `context.symbol`
- `context.callers`
- `context.slice`
- `context.diff`
- Java parsing via Tree-sitter
- symbol and call-edge indexing
- annotation and overload recognition
- SQLite incremental cache
- Git-aware diff analysis
- token budgeting
- repository path safety
- machine-readable benchmark tasks
- budget sweep from 256 to 8192 tokens
- required-fact recall
- context efficiency
- minimum sufficient budget
- failure corpus
- slice inclusion metadata
- generated benchmark report

Current v0.2 validation results:

- build passes
- tests: 6/6 pass
- cold cache: 4 files parsed
- warm cache: 0 files parsed, 4 cache hits
- required-fact recall: 100% on fixture
- token reduction: 29.84% on fixture v0.2
- unresolved call rate: 0.8
- ambiguous call rate: 0.1333

Real repositories and agent comparisons are still pending.

Do not treat the fixture metrics above as representative of real Java projects.

---

## 1. Goal

The sole goal of v0.3 is:

> Evaluate ContextSlice on real Java repositories and determine whether Tree-sitter-only analysis is sufficient for practical coding-agent context retrieval.

Do not add JDT, LSP, embeddings, vector search, or other major architecture changes during this phase.

This phase is evaluation-first.

The output must provide evidence for or against adding compiler-grade resolution in the next version.

---

## 2. Key questions

Answer these questions using real repository data:

1. What token reduction does ContextSlice achieve on real Java repositories?
2. Does it preserve 100% of required task facts?
3. What is the minimum sufficient token budget for typical tasks?
4. How often are method calls unresolved?
5. How often are method calls ambiguous?
6. How often do unresolved or ambiguous calls actually cause missing required facts?
7. How often do missing required facts cause a task to become unsolvable or unsafe?
8. How well does the incremental cache behave on larger repositories?
9. Does ContextSlice reduce whole-file reads for coding agents?
10. Does current evidence justify JDT/LSP integration?

Do not infer the JDT/LSP decision from unresolved-call rate alone.

---

## 3. Repository set

Evaluate exactly three repository scales.

Use pinned commits for reproducibility.

Record:

- repository URL
- commit SHA
- selected module/subtree
- Java file count
- LOC if practical
- indexing scope

### Repository A — Small

Preferred:

```text
Spring Petclinic
```

or another compact and conventional Spring Boot application if Petclinic cannot be used.

The repository should contain:

- controllers
- services or repositories
- entities
- validation
- tests
- Spring annotations

---

### Repository B — Medium

Choose a real Java/Spring repository with richer architecture.

Good characteristics:

- multiple packages/modules
- interfaces and implementations
- services
- repositories
- DTOs
- events
- tests
- inheritance
- overloaded methods

Prefer a repository that can be built and tested locally without complex infrastructure.

Document why the selected repository is representative.

---

### Repository C — Large

Use a bounded module from a mature Java repository.

Preferred candidate:

```text
Keycloak
```

Do not index the entire repository unless it is clearly practical.

Select one bounded module/subtree with meaningful internal dependencies.

Document the selected scope.

---

## 4. Reproducibility

All real repository evaluations must be reproducible.

Create a configuration file such as:

```text
benchmarks/repositories.json
```

Suggested structure:

```json
[
  {
    "id": "spring-petclinic",
    "url": "...",
    "commit": "...",
    "scope": ".",
    "size": "small"
  }
]
```

Never benchmark moving branches such as `main` without recording the exact commit SHA.

If repositories are cloned by scripts, make the process idempotent.

Avoid committing third-party repositories into ContextSlice itself.

---

## 5. Task count

Create approximately five tasks per repository.

Target:

```text
3 repositories × 5 tasks = 15 tasks
```

The exact count may vary slightly if a repository does not support a meaningful task category.

Each task must be grounded in actual code.

---

## 6. Task categories

Include the following categories across the repository set.

### Locate

Example:

```text
Find every direct entry point that invokes method X.
```

Required facts should include the known callers.

---

### Explain

Example:

```text
Explain the execution flow starting from controller method X.
```

Required facts should include important calls, annotations, and state changes.

---

### Change

Example:

```text
Add a validation or idempotency condition to method X.
```

Do not necessarily modify the upstream repository permanently.

A benchmark may evaluate whether sufficient context exists to implement the change.

---

### Impact analysis

Example:

```text
Which callers, tests, and dependencies are likely affected if method X changes?
```

---

### Git diff

Use a real historical commit where possible.

Example:

```text
Explain the semantic impact of this change.
```

Run `context.diff` against the selected commit range.

---

## 7. Task specification

Extend the existing machine-readable task format.

Each task should contain at least:

```json
{
  "id": "repo-task-id",
  "repository": "repo-id",
  "category": "explain",
  "task": "Explain ...",
  "targetSymbol": "...",
  "requiredFacts": [
    {
      "id": "fact-1",
      "description": "...",
      "verification": {
        "type": "symbol-present"
      }
    }
  ]
}
```

Prefer deterministic verification.

Allowed verification strategies may include:

- expected symbol present
- expected caller present
- expected annotation present
- expected call edge present
- expected file present
- expected source fragment present

Do not use an LLM judge as the sole fact validator.

---

## 8. Ground-truth creation

Required facts must be established independently from ContextSlice.

Use one or more of:

- direct source inspection
- repository tests
- Git history
- compiler/LSP tools used only as external validation
- manually verified call relationships

Do not define ground truth from ContextSlice output itself.

Otherwise required-fact recall becomes circular.

Document how each task's ground truth was established.

---

## 9. Metrics per task

Record:

```text
baseline_tokens
slice_tokens
token_reduction_percent

required_facts_total
required_facts_preserved
required_fact_recall

minimum_sufficient_budget

symbols_included
files_touched_by_context
whole_files_required

unresolved_calls_seen
ambiguous_calls_seen

missing_facts_due_to_resolution
missing_facts_due_to_budget
missing_facts_due_to_ranking
missing_facts_due_to_parser

cold_index_ms
warm_query_ms
```

Where a metric is unavailable, record:

```text
N/A
```

Do not invent data.

---

## 10. Resolution-impact metric

Add a critical metric:

```text
resolution_harm_rate =
tasks where unresolved/ambiguous calls caused a required fact to be lost
-----------------------------------------------------------------------
total benchmark tasks
```

Also record:

```text
resolution_fact_loss_rate =
required facts lost specifically because of call/type resolution
-----------------------------------------------------------------
total required facts
```

These metrics are more important for the JDT decision than raw unresolved-call rate.

---

## 11. Failure attribution

Every missing required fact must be categorized.

Use one of:

```text
PARSER
SYMBOL_INDEX
CALL_RESOLUTION
RANKING
TOKEN_BUDGET
DIFF_MAPPING
GROUND_TRUTH_ERROR
UNKNOWN
```

Do not report only:

```text
required fact missing
```

The point of v0.3 is to identify why.

---

## 12. Minimum sufficient context

For each task continue the existing budget sweep:

```text
256
512
1024
2048
4096
8192
```

Determine the lowest budget with:

```text
required_fact_recall = 100%
```

Call it:

```text
minimum_sufficient_budget
```

If 100% recall cannot be achieved at 8192 tokens, mark:

```text
UNSATISFIED
```

and identify the root cause.

Do not increase the budget indefinitely to hide retrieval failures.

---

## 13. Baseline definition

Use a transparent baseline.

For each task define the likely whole-file context required without ContextSlice.

Record exactly which files are included.

Example:

```text
baseline:
- OwnerController.java
- OwnerRepository.java
- Owner.java
- OwnerValidator.java
- OwnerControllerTests.java
```

Calculate baseline token estimate using the same tokenizer/heuristic used for ContextSlice.

Do not compare different token estimators.

---

## 14. Repository-level metrics

Aggregate per repository:

```text
task_count
median_token_reduction
mean_token_reduction
min_token_reduction
max_token_reduction

required_fact_recall

median_minimum_sufficient_budget

unresolved_call_rate
ambiguous_call_rate

resolution_harm_rate
resolution_fact_loss_rate

cold_index_time
warm_query_latency
cache_hit_rate
```

Include both median and worst-case behavior.

Do not headline only the best repository.

---

## 15. Overall metrics

Across all repositories report:

```text
total_tasks
total_required_facts

overall_required_fact_recall

median_token_reduction
p25_token_reduction
p75_token_reduction

median_minimum_sufficient_budget

resolution_harm_rate
resolution_fact_loss_rate

parser_failure_count
ranking_failure_count
budget_failure_count
resolution_failure_count
```

If the sample is too small for meaningful percentile interpretation, state that explicitly.

---

## 16. Agent comparison

Agent comparison is useful but secondary.

If Codex and/or Claude telemetry is available, run selected benchmark tasks in:

```text
baseline mode
ContextSlice mode
```

Do not require both agents to complete v0.3.

For each available agent record:

```text
tool calls
whole-file reads
ContextSlice calls
input tokens if exposed
elapsed time
tests/build
patch correctness
```

Do not compare Codex against Claude.

The comparison is:

```text
agent without ContextSlice
vs
same agent with ContextSlice
```

If telemetry is unavailable, record that fact and continue the repository evaluation.

Do not block v0.3 on agent telemetry.

---

## 17. Context policy for agent runs

For ContextSlice-enabled agent runs use a clear policy:

```text
Before reading a complete source file, use ContextSlice to locate and retrieve the relevant symbol/context.

Read a whole file only when:
- ContextSlice reports insufficient context,
- exact surrounding source is required,
- or retrieval cannot identify the relevant symbol.
```

Record every whole-file fallback.

Metric:

```text
whole_file_fallback_rate
```

---

## 18. Cache evaluation

Measure cache behavior separately for all three repositories.

### Cold

Delete ContextSlice cache.

Run indexing.

Record:

```text
files scanned
files parsed
symbols indexed
call edges indexed
duration
```

### Warm

Run indexing again without source changes.

Expected:

```text
files parsed ≈ 0
```

Record cache hits.

### Single-file modification

Modify or temporarily patch one Java file in the benchmark checkout.

Run re-indexing.

Record:

```text
files reparsed
symbols invalidated
edges rebuilt
duration
```

Restore the repository afterward.

Do not permanently modify third-party benchmark repositories.

---

## 19. Tree-sitter limitation analysis

For each repository collect representative examples of:

- unresolved calls
- ambiguous overloaded calls
- interface dispatch
- inherited methods
- fluent/chained calls
- Spring-generated behavior
- repository method inference

For each example answer:

```text
Did this prevent finding a required fact?
Did this cause task failure?
Would compiler-grade type resolution fix it?
```

Do not assume the answer is yes.

---

## 20. JDT/LSP decision gate

At the end of v0.3 evaluate whether to add JDT/LSP.

Recommend compiler-grade resolution for v0.4 only if evidence shows repeated practical harm.

Strong evidence includes:

```text
1. required facts are lost,

AND

2. the loss is attributable to missing type/call resolution,

AND

3. the failure occurs across multiple real tasks or repositories.
```

A useful quantitative trigger is:

```text
resolution_fact_loss_rate >= 5%
```

or repeated task failures caused by resolution.

This threshold is guidance, not an automatic rule.

Do not add JDT merely because unresolved-call rate is high.

Example:

```text
unresolved calls = 45%
required-fact recall = 100%
resolution harm = 0%
```

This does not justify JDT.

---

## 21. Report generation

Generate:

```text
benchmarks/results/v0.3-real-repositories.md
```

Also generate machine-readable results:

```text
benchmarks/results/v0.3-real-repositories.json
```

Markdown report must include:

1. Executive summary
2. Repository definitions
3. Tasks
4. Token results
5. Required-fact recall
6. Minimum sufficient budgets
7. Cache behavior
8. Call-resolution statistics
9. Failure attribution
10. Agent comparison if available
11. Tree-sitter limitations
12. JDT/LSP decision
13. Next step

---

## 22. Recommended result table

Include:

```text
| Repo | Task | Baseline tokens | Slice tokens | Reduction | Fact recall | Min budget | Resolution harm |
|------|------|-----------------|--------------|-----------|-------------|------------|-----------------|
```

Add repository aggregate tables separately.

---

## 23. README update

Update README after evaluation.

Clearly separate:

### Fixture results

Current v0.2 fixture numbers such as:

```text
29.84% token reduction
100% required-fact recall
```

from:

### Real repository results

Never mix them into one general claim.

If real repository results differ significantly from the fixture, explain the difference.

---

## 24. Avoid benchmark gaming

Do not:

- hand-tune ranking separately for every task
- exclude difficult tasks because they reduce the headline metric
- inflate the whole-file baseline artificially
- lower required facts to improve recall
- use ContextSlice output to define ground truth
- omit failed tasks from aggregate metrics
- report only successful repository results

Any benchmark exclusion must be documented.

---

## 25. Implementation constraints

Do not perform large architecture rewrites.

Allowed changes:

- benchmark harness improvements
- metrics collection
- deterministic fact verification
- bug fixes revealed by real repositories
- parser/index correctness fixes
- cache instrumentation
- report generation
- small ranking fixes if generally applicable

Do not add:

- JDT
- language server integration
- embeddings
- vector DB
- LLM-based retrieval
- multi-language support
- UI
- remote service

unless required merely to fix an existing bug and explicitly justified.

---

## 26. Definition of done

v0.3 is complete when:

- three real repository scales are evaluated
- repository commits are pinned
- approximately 15 real tasks are defined
- ground truth is independent of ContextSlice
- every task has required facts
- every task has token metrics
- required-fact recall is measured
- minimum sufficient budget is measured
- missing facts are attributed to root causes
- cache cold/warm/update behavior is measured
- unresolved and ambiguous call rates are measured
- resolution harm is measured
- resolution fact loss is measured
- reports are generated in Markdown and JSON
- README distinguishes fixture and real-repository results
- JDT/LSP decision is evidence-based
- build and tests pass after all benchmark changes

Agent telemetry is optional and must not block completion.

---

## 27. Final implementation report

At completion output:

```text
STATUS

REPOSITORIES

TASKS

BUILD / TESTS

TOKEN REDUCTION

REQUIRED-FACT RECALL

MINIMUM SUFFICIENT BUDGET

CACHE

UNRESOLVED / AMBIGUOUS CALLS

RESOLUTION HARM

FAILURE ATTRIBUTION

AGENT COMPARISON

JDT/LSP DECISION

KNOWN LIMITATIONS

NEXT STEP
```

Every metric must identify its source.

Do not claim general production readiness.

---

## 28. Guiding principle

The central question for v0.3 is not:

> How many calls can Tree-sitter resolve?

It is:

> Does missing resolution prevent ContextSlice from delivering the minimum sufficient context required to solve real coding tasks?

Optimize for evidence.

Do not expand architecture until the data says it is necessary.
