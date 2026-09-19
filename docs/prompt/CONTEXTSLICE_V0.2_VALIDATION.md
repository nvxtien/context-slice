# ContextSlice v0.2 — Real Repository Validation & Hardening

You are extending **ContextSlice**, a local MCP server that reduces coding-agent context using Tree-sitter-based structural slicing.

ContextSlice v0.1 is already implemented and working with:

- MCP stdio server
- `context.search`
- `context.symbol`
- `context.callers`
- `context.slice`
- `context.diff`
- Java parsing via Tree-sitter
- symbol/call-edge indexing
- annotation and overload recognition
- SQLite cache
- Git diff support
- token budgeting
- repository path safety
- Java/Spring fixture
- automated tests
- benchmark harness

Current verification:

- `npm run build` passes
- `npm test` passes
- benchmark currently reports about **48.89% token reduction**
- MCP server starts successfully over stdio

The next milestone is **not feature expansion**.

The goal of v0.2 is:

> Prove that ContextSlice preserves the information required to solve real coding tasks while reducing the amount of context sent to Codex and Claude.

Do not add LSP/compiler integration yet unless a validation result clearly demonstrates that Tree-sitter-only resolution blocks the benchmark.

---

## 1. Primary objective

Validate these questions:

1. Does ContextSlice preserve all task-critical facts?
2. Does it reduce token usage on real Java repositories?
3. Does it reduce unnecessary file reads and tool calls?
4. Does it maintain or improve patch correctness?
5. Where exactly does Tree-sitter-only resolution fail?
6. Which failures justify future JDT/LSP integration?

The v0.2 result must be evidence-driven.

Do not optimize merely for a higher token-reduction percentage.

---

## 2. Core metrics

Add explicit metrics for every benchmark task.

### Required Fact Recall

Each task must define a list of facts that the agent must know.

Example:

```text
Task:
Understand retryPayment behavior.

Required facts:
- retryPayment is annotated @Transactional
- PaymentController.retry calls retryPayment
- PaymentRetryJob.execute calls retryPayment
- retryPayment calls PaymentRepository.save
- retryPayment publishes PaymentRetryRequested
```

Calculate:

```text
required_fact_recall =
preserved_required_facts / total_required_facts
```

Target:

```text
100% required-fact recall
```

Any token reduction achieved by dropping a required fact is a benchmark failure.

---

### Context Efficiency

Calculate:

```text
Context Efficiency =
required facts preserved
------------------------
estimated input tokens
```

Record it for:

- baseline
- ContextSlice

---

### Task Efficiency

For agent-assisted runs calculate:

```text
Task Efficiency =
successful task
---------------
input tokens
```

Also record:

- input tokens
- output tokens when available
- total estimated context tokens
- tool calls
- whole-file reads
- symbols retrieved
- elapsed time
- build/test result
- patch correctness

---

## 3. Benchmark modes

Support at least these modes.

### Mode A — Whole-file baseline

Simulate a conventional coding-agent context strategy.

Provide the complete files a reasonable developer/agent would likely inspect.

Record:

- files
- characters
- estimated tokens
- required facts present

---

### Mode B — ContextSlice

Retrieve context using:

```text
context.search
context.slice
context.symbol
context.callers
context.diff
```

Record:

- symbols selected
- inclusion reasons
- estimated tokens
- required facts present
- excluded files/symbols

---

### Mode C — Agent baseline

Where practical, run the same task using Codex or Claude without ContextSlice.

Record:

- file reads
- tool calls
- tokens if exposed by the agent/runtime
- resulting patch
- tests

Do not fabricate metrics that the runtime does not expose.

---

### Mode D — Agent + ContextSlice

Run the same task with ContextSlice available and with instructions to prefer semantic retrieval before whole-file reads.

Record the same metrics as Mode C.

---

## 4. Real repository validation

Add validation against at least three repository scales.

### Small repository

Use a well-known Java/Spring project such as Spring Petclinic or another compact Spring application.

Purpose:

- verify basic symbol retrieval,
- controllers/services/repositories,
- annotations,
- tests,
- common Java structure.

---

### Medium repository

Use a real Spring Boot service with enough code to contain:

- interfaces,
- implementations,
- DTOs,
- services,
- repositories,
- tests,
- configuration,
- inheritance,
- overloaded methods.

Prefer a repository with deterministic tests and a manageable setup.

---

### Large repository

Use a bounded module from a large Java codebase such as Keycloak or another mature Java project.

Do not index an enormous monorepo blindly.

Choose a specific module/subtree and document the scope.

Purpose:

- stress indexing,
- duplicate symbol names,
- overload resolution,
- inheritance,
- call-edge ambiguity,
- token budgeting,
- cache behavior.

---

## 5. Benchmark task taxonomy

Each repository should include tasks from several categories.

### A. Locate

Example:

```text
Find all entry points that call method X.
```

Measure caller recall.

---

### B. Explain

Example:

```text
Explain what happens after method X succeeds.
```

Measure whether downstream calls and important annotations survive slicing.

---

### C. Change

Example:

```text
Add validation/idempotency/error handling to method X.
```

Measure whether the slice contains enough context to implement the change correctly.

---

### D. Impact analysis

Example:

```text
Which tests and callers are likely affected by changing method X?
```

Measure dependency/caller recall.

---

### E. Git review

Example:

```text
Explain the semantic impact of this change.
```

Use `context.diff`.

Measure whether changed symbols and relevant surrounding dependencies are included.

---

## 6. Required-fact specification

Add a machine-readable benchmark definition.

Suggested format:

```json
{
  "id": "petclinic-owner-update",
  "repository": "spring-petclinic",
  "task": "Explain what is affected when owner contact details are updated.",
  "targetSymbol": "OwnerController.processUpdateOwnerForm",
  "requiredFacts": [
    {
      "id": "calls-save",
      "description": "The method persists the Owner through the repository/service layer."
    },
    {
      "id": "validation",
      "description": "Validation behavior must be preserved."
    }
  ]
}
```

The benchmark harness must explicitly mark whether each required fact is present in the produced slice.

Start with deterministic matching where possible.

Do not use an LLM judge as the only correctness mechanism.

---

## 7. Hardening tests

Expand beyond the current minimal test set.

At minimum add cases for:

- nested classes,
- static nested classes,
- interfaces,
- abstract classes,
- inheritance,
- interface implementations,
- overloaded methods,
- overloaded constructors,
- static imports,
- method references,
- lambdas,
- records,
- enums,
- generic methods,
- generic classes,
- chained calls,
- anonymous classes,
- same method name in multiple classes,
- same class name in different packages,
- malformed/incomplete Java,
- Spring annotations,
- repository interfaces,
- test classes,
- unresolved calls.

Each test should assert exact expected behavior.

Do not merely assert that the parser did not crash.

---

## 8. Ambiguity and confidence

Tree-sitter does not provide full Java type resolution.

v0.2 must make uncertainty visible.

Every call edge should expose confidence such as:

```text
exact
probable
unresolved
```

Use `exact` only when it is structurally justified.

Examples where confidence should decrease:

- overloaded methods,
- same method names across types,
- inherited methods,
- interface dispatch,
- chained calls with unknown receiver types.

Never silently select an arbitrary callee.

---

## 9. Failure corpus

Create a dedicated corpus of cases where Tree-sitter-only resolution is expected to struggle.

Example directory:

```text
tests/fixtures/java-resolution/
```

Include examples such as:

```java
interface PaymentRepository {
    void save(Payment payment);
}

class JpaPaymentRepository implements PaymentRepository {
    public void save(Payment payment) { ... }
}
```

and:

```java
service.save(entity);
```

where the receiver type may not be derivable syntactically.

For each case record:

- expected limitation,
- current behavior,
- confidence,
- whether it impacts required-fact recall.

This corpus becomes the evidence base for deciding whether v0.3 needs JDT/LSP.

---

## 10. Cache validation

Add measurable cache tests.

Measure:

### Cold index

```text
empty cache
→ full parse/index
```

### Warm index

```text
no file changed
→ zero or near-zero reparsing
```

### Single-file update

```text
one Java file changed
→ only affected file/symbols refreshed
```

Record:

- files scanned
- files parsed
- symbols updated
- elapsed time

Do not report cache success merely because SQLite exists.

Prove that unchanged files avoid reparsing.

---

## 11. Token-budget stress tests

Test `context.slice` at multiple budgets:

```text
256
512
1024
2048
4096
8192
```

For each budget record:

- included facts,
- missing required facts,
- included symbols,
- token estimate.

Determine the **minimum sufficient budget** for each task.

Add metric:

```text
minimum_sufficient_budget
```

This is more useful than maximizing compression.

---

## 12. Retrieval explanations

Every slice should remain explainable.

For each included item record:

```text
symbol
reason
score
estimated tokens
relationship to target
confidence
```

Example:

```text
PaymentRetryJob.execute
reason: direct-caller
distance: 1
confidence: probable
estimatedTokens: 42
```

For excluded high-ranking candidates, optionally record why they were omitted:

```text
budget
low relevance
duplicate information
unresolved relation
```

Keep this metadata machine-readable.

---

## 13. Benchmark report

Generate a report artifact after benchmark execution.

Suggested:

```text
benchmarks/results/latest.md
```

Include a table like:

```text
| Repo | Task | Baseline tokens | Slice tokens | Reduction | Required fact recall | Min sufficient budget |
|------|------|-----------------|--------------|-----------|----------------------|-----------------------|
| ...  | ...  | ...             | ...          | ...       | ...                  | ...                   |
```

Also summarize:

- median token reduction,
- worst-case token reduction,
- best-case token reduction,
- required-fact recall,
- indexing latency,
- cache-hit latency,
- unresolved-call rate.

Do not report only the best benchmark.

---

## 14. Agent comparison report

If Codex and/or Claude runs are available, add a separate comparison.

Example:

```text
| Agent | Mode | Input tokens | Tool calls | Whole-file reads | Tests | Patch correct |
|-------|------|--------------|------------|------------------|-------|---------------|
| Codex | baseline | ... | ... | ... | pass | yes |
| Codex | ContextSlice | ... | ... | ... | pass | yes |
| Claude | baseline | ... | ... | ... | pass | yes |
| Claude | ContextSlice | ... | ... | ... | pass | yes |
```

Do not rank models.

The purpose is to evaluate ContextSlice, not compare model quality.

---

## 15. Regression gates

Add benchmark regression checks.

The test suite should fail or clearly warn if:

- required-fact recall drops,
- a known caller disappears,
- a slice exceeds its budget,
- ambiguity is incorrectly reported as exact,
- cache reparses unchanged files unexpectedly,
- token usage increases materially without preserving additional required facts.

Avoid brittle checks for tiny timing differences.

---

## 16. No premature LSP integration

Do not implement JDT/LSP merely because call resolution is imperfect.

First quantify:

```text
unresolved call rate
ambiguous call rate
required facts lost due to unresolved calls
tasks failed because of missing type resolution
```

Only recommend JDT/LSP if the evidence shows that missing compiler-grade resolution materially harms real tasks.

The final report must state whether the data supports moving to LSP in v0.3.

---

## 17. Documentation updates

Update README with a new validation section covering:

- what v0.1 measured,
- current ~48.89% fixture token reduction,
- why token reduction alone is insufficient,
- required-fact recall,
- real-repository benchmark methodology,
- known Tree-sitter limitations,
- measured cache behavior,
- measured real-repository results.

Do not present 48.89% as a general product claim.

Clearly label the fixture/task on which it was measured.

---

## 18. Definition of done

ContextSlice v0.2 is complete when:

- existing v0.1 functionality still works,
- build passes,
- automated tests pass,
- test coverage includes the hardening cases above,
- at least three repository scales are benchmarked,
- every benchmark task has required facts,
- required-fact recall is reported,
- token reduction is reported,
- minimum sufficient budget is reported,
- cache behavior is measured,
- unresolved/ambiguous calls are quantified,
- at least one real Git diff task is benchmarked,
- benchmark result markdown is generated,
- README is updated,
- final report explicitly states whether LSP/JDT is justified for v0.3.

---

## 19. Final implementation report

At completion output:

```text
STATUS

VALIDATED REPOSITORIES

TESTS

TOKEN RESULTS

REQUIRED-FACT RECALL

CACHE RESULTS

TREE-SITTER LIMITATIONS

AGENT COMPARISON

REGRESSIONS

LSP/JDT DECISION

NEXT STEP
```

For every number, identify where it came from.

Do not claim:

- production readiness,
- universal token reduction,
- compiler-grade call resolution,
- improved model quality,

unless the evidence directly supports it.

---

## 20. Guiding principle

Use this rule throughout v0.2:

> A smaller context is only better if it preserves everything required to solve the task correctly.

The objective is not maximum compression.

The objective is **minimum sufficient context**.
