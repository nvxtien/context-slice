# ContextSlice v0.5 — Semantic Call Resolution Evaluation

You are extending **ContextSlice**, a local MCP server that reduces coding-agent context using deterministic structural analysis and semantic slicing.

ContextSlice v0.1 through v0.4 are already implemented and validated.

Current v0.4 results across three pinned Java repositories:

- Spring Petclinic
- Petclinic REST
- Keycloak `services`

Validation results:

- retrieval recall: 100% across 15/15 benchmark tasks
- symbol-index failure rate: 0%
- symbol fact loss rate: 0%
- required-fact recall: 100%
- median token reduction: 95.05%
- build passes
- tests: 9/9 pass
- cache schema versioned to 0.4
- no evidence yet that JDT/LSP is required

Known remaining limitations are primarily semantic:

- interface dispatch
- inherited methods
- overridden methods
- chained/fluent calls
- anonymous classes
- framework-generated behavior
- Spring repository/proxy behavior

The purpose of v0.5 is not to add JDT/LSP.

The purpose is:

> Measure how much semantic call-resolution uncertainty actually matters to real coding tasks, and improve only what can be resolved deterministically without introducing a compiler/LSP dependency.

---

## 1. Primary objective

Evaluate semantic call resolution quality independently from symbol indexing.

Answer:

1. How many call edges are exact?
2. How many are probable?
3. How many remain unresolved?
4. How many expected semantic edges are missed?
5. How many incorrect edges are produced?
6. Do semantic-resolution failures cause required-fact loss?
7. Do they cause benchmark-task degradation?
8. Which categories of Java dispatch cause the failures?
9. Which failures can be fixed with local deterministic analysis?
10. Which failures genuinely require compiler-grade type resolution?

Do not infer the need for JDT from unresolved-call rate alone.

---

## 2. Keep v0.4 baseline intact

The v0.4 properties must not regress:

```text
retrieval recall = 100%
required-fact recall = 100%
symbol-index failure rate = 0%
symbol fact loss rate = 0%
```

Any regression in these metrics is a release blocker.

---

## 3. New metrics

Add the following metrics.

### Semantic Call Recall

```text
semantic_call_recall =
expected semantic call edges found
----------------------------------
total expected semantic call edges
```

### Semantic Call Precision

```text
semantic_call_precision =
correct semantic call edges found
---------------------------------
all semantic call edges returned
```

### False Negative Edge Rate

```text
false_negative_edge_rate =
expected edges not found
------------------------
expected edges
```

### False Positive Edge Rate

```text
false_positive_edge_rate =
incorrect edges returned
------------------------
all edges returned
```

### Semantic Resolution Harm Rate

```text
semantic_resolution_harm_rate =
tasks where semantic resolution caused a required fact to be lost
-----------------------------------------------------------------
total tasks
```

### Semantic Resolution Fact-Loss Rate

```text
semantic_resolution_fact_loss_rate =
required facts lost because semantic call resolution failed
-----------------------------------------------------------
total required facts
```

---

## 4. Confidence model

Keep explicit call-edge confidence.

Use:

```text
EXACT
PROBABLE
UNRESOLVED
```

Define criteria precisely.

### EXACT

Use only when resolution is structurally certain.

Examples may include:

- direct same-class method call with unique target
- constructor call with uniquely matching syntactic signature
- static call with explicit type receiver and unique target
- explicit `super.method(...)` where target is structurally known

### PROBABLE

Use when there is strong but incomplete evidence.

Examples:

- receiver variable has a syntactically declared type
- interface method maps to one visible implementation in current scope
- inherited method lookup has one plausible declaration

### UNRESOLVED

Use when multiple plausible targets remain or type information is insufficient.

Never upgrade confidence merely to improve metrics.

---

## 5. Ground truth

Create independent semantic-call ground truth.

Do not derive expected edges from ContextSlice.

Use one or more of:

- direct source inspection
- compiler/LSP used externally as a validator only
- tests
- repository architecture knowledge documented per task
- manual verification

Ground truth must be stored separately from production retrieval.

Suggested file:

```text
benchmarks/semantic-calls.json
```

---

## 6. Semantic call fixture corpus

Create:

```text
tests/fixtures/semantic-calls/
```

Include isolated cases for:

- same-class calls
- static calls
- constructor calls
- overloaded methods
- interface dispatch
- single implementation
- multiple implementations
- inherited methods
- overridden methods
- `super.method()`
- chained calls
- fluent APIs
- generic receiver types
- lambdas
- method references
- anonymous classes
- nested classes
- default interface methods
- static imports
- repository interfaces
- Spring service/repository patterns

Each fixture must define expected edges and expected confidence.

---

## 7. Same-class resolution

Harden exact resolution for:

```java
class A {
    void x() {
        y();
    }

    void y() {}
}
```

If only one compatible `y` exists in the same class, resolution should be exact.

Handle overloads conservatively.

Do not use only argument count when parameter syntax can distinguish candidates.

---

## 8. Explicit type receiver resolution

Support cases like:

```java
PaymentService service;

service.retry(paymentId);
```

If the field/local/parameter type is directly declared and the target type is indexed, attempt deterministic lookup.

If multiple overloads remain plausible:

```text
PROBABLE or UNRESOLVED
```

Do not fabricate exactness.

---

## 9. Static call resolution

Support:

```java
Objects.requireNonNull(value);
```

and explicit project static calls.

If the receiver is a type name and the target declaration is indexed uniquely, allow exact resolution.

Static-import-only calls may remain unresolved unless import analysis makes the target deterministic.

---

## 10. Constructor resolution

Resolve:

```java
new Payment(...)
```

against indexed constructors.

Use syntactic argument count/types only when reliable.

Do not force a constructor match if overloads remain ambiguous.

---

## 11. Interface dispatch

Test:

```java
PaymentRepository repository;
repository.save(payment);
```

and:

```java
interface PaymentRepository { ... }

class JpaPaymentRepository implements PaymentRepository { ... }
```

Record separately:

- interface declaration edge
- implementation candidates
- confidence

Do not collapse interface and implementation into one target.

For v0.5, it is acceptable for the semantic target to remain:

```text
PaymentRepository.save
```

if that is sufficient for context retrieval.

Measure whether implementation resolution is actually required by benchmark facts.

---

## 12. Inheritance

Support deterministic parent lookup when structurally visible.

Example:

```java
class Child extends Parent {
    void x() {
        inheritedMethod();
    }
}
```

If `inheritedMethod` is uniquely declared in an indexed parent and no local override exists, classify appropriately.

Do not invent inherited declarations in the child index.

---

## 13. Overrides

For:

```java
class Parent {
    void save() {}
}

class Child extends Parent {
    @Override
    void save() {}
}
```

Keep parent and child symbols distinct.

When resolving:

```java
child.save();
```

prefer the child declaration if the receiver type is known as `Child`.

If runtime dispatch is not statically knowable, do not claim more than static source-level semantics.

---

## 14. Fluent and chained calls

Evaluate:

```java
repository.findById(id)
    .map(this::convert)
    .orElseThrow(...);
```

Tree-sitter can parse the chain but receiver types may be unknown.

At minimum preserve:

- chain structure
- called method names
- order

Do not invent exact semantic targets for every hop.

Measure whether unresolved chain targets actually reduce required-fact recall.

---

## 15. Lambdas and method references

Handle source structures such as:

```java
items.stream().map(this::convert)
```

and:

```java
items.forEach(item -> process(item));
```

The called local symbol `convert` or `process` should be discoverable when structurally deterministic.

Do not attempt full stream/library generic type inference.

---

## 16. Anonymous classes

Evaluate:

```java
new Listener() {
    @Override
    public void onEvent(Event event) {
        handle(event);
    }
};
```

Do not create unstable public symbol IDs for anonymous types.

But internal call extraction should preserve `handle(event)` where possible.

Document limitations.

---

## 17. Spring repository methods

Evaluate Spring patterns such as:

```java
interface OwnerRepository extends Repository<Owner, Integer> {
    Collection<Owner> findByLastName(String lastName);
}
```

Distinguish:

- explicitly declared repository methods
- inherited repository methods
- convention-derived/generated methods

Do not fabricate method bodies or runtime implementation symbols.

A declared repository method can be indexed normally.

Framework-generated behavior should be labeled as external/framework-provided.

---

## 18. Framework boundary representation

Add a compact way to represent calls whose implementation is outside indexed source.

Example:

```text
OwnerRepository.findById
target-kind: DECLARED_INTERFACE_METHOD
runtime-implementation: FRAMEWORK_PROVIDED
confidence: EXACT_DECLARATION / UNRESOLVED_IMPLEMENTATION
```

This is preferable to pretending the call is unresolved in every sense.

Separate:

```text
declaration resolution
```

from:

```text
runtime implementation resolution
```

---

## 19. Declaration vs runtime target

Introduce explicit terminology.

For each call edge, when useful, distinguish:

```text
declaredTarget
runtimeTarget
```

Example:

```text
declaredTarget = PaymentRepository.save
runtimeTarget = unknown
```

ContextSlice primarily needs the declared target for retrieval.

Do not require runtime dispatch resolution unless benchmark evidence says it is necessary.

This distinction is central to v0.5.

---

## 20. Semantic edge model

Extend the call-edge model conceptually to include:

```ts
interface SemanticCallEdge {
  callerId: string;
  calleeName: string;

  declaredTargetId?: string;
  runtimeTargetIds?: string[];

  confidence: "exact" | "probable" | "unresolved";

  resolutionKind:
    | "same-type"
    | "explicit-receiver"
    | "static"
    | "constructor"
    | "inherited"
    | "interface"
    | "method-reference"
    | "lambda"
    | "framework-declared"
    | "unresolved";

  evidence: string[];
}
```

Exact shape may differ.

Keep evidence inspectable.

---

## 21. Explainability

Every resolved semantic edge should explain why.

Example:

```text
PaymentController.retry
  -> PaymentService.retryPayment

confidence: EXACT
resolutionKind: explicit-receiver

evidence:
- field paymentService declared as PaymentService
- one matching retryPayment(String) symbol indexed
```

For unresolved calls:

```text
confidence: UNRESOLVED

reason:
- receiver type unknown
- 3 matching save(...) methods indexed
```

---

## 22. Real-repository evaluation

Reuse the exact same 3 pinned repositories and 15 tasks from v0.4.

Do not change commits.

Do not remove tasks.

Measure new semantic-call metrics without compromising existing benchmark comparability.

---

## 23. Add semantic-call benchmark tasks

In addition to the 15 existing tasks, define a bounded set of call-resolution-specific checks.

Target approximately:

```text
15 existing tasks
+
10–20 semantic edge checks
```

These checks should cover:

- direct exact calls
- interface declarations
- inherited methods
- overloaded calls
- fluent chains
- framework boundaries

Keep them small and independently verifiable.

---

## 24. Failure attribution

For semantic call failures use categories:

```text
RECEIVER_TYPE_UNKNOWN
OVERLOAD_AMBIGUITY
INTERFACE_DISPATCH
INHERITANCE
RUNTIME_DISPATCH
FRAMEWORK_GENERATED
CHAIN_TYPE_UNKNOWN
METHOD_REFERENCE
ANONYMOUS_CLASS
PARSER
INDEX
UNKNOWN
```

Every false negative and false positive should have an attribution.

---

## 25. Required-fact preservation

Rerun required-fact evaluation.

Release-blocking target:

```text
required-fact recall = 100%
```

If semantic call changes reduce fact recall, revert or fix them.

Do not trade retrieval correctness for prettier call graphs.

---

## 26. Token impact

Measure whether semantic resolution changes context size.

Report:

```text
v0.4 median token reduction
v0.5 median token reduction
```

A small token increase is acceptable if additional context is genuinely required.

Avoid flooding slices with all possible runtime targets.

Prefer declared targets and compact ambiguity metadata.

---

## 27. JDT/LSP decision gate

At the end of v0.5 answer:

```text
Do unresolved semantic edges cause practical task harm?
```

Recommend JDT/LSP only if:

1. required facts are lost because semantic resolution is insufficient,
2. the lost facts matter to task correctness,
3. the problem repeats across multiple real tasks/repositories,
4. local deterministic analysis cannot reasonably fix it.

Suggested quantitative evidence:

```text
semantic_resolution_fact_loss_rate >= 5%
```

or repeated task failures attributable to missing type information.

If:

```text
semantic call recall < 100%
but
required-fact recall = 100%
semantic resolution harm = 0%
```

then do not add JDT.

---

## 28. No compiler dependency in v0.5

Do not add:

- Eclipse JDT
- JDT LS
- Maven compiler model
- Gradle compiler model
- JavaParser symbol solver
- Spoon
- Soot
- WALA
- CodeQL
- LSP client

These may be used externally for validation only if clearly separated from production ContextSlice.

The production implementation must remain Tree-sitter-based during v0.5.

---

## 29. Tests

Expand automated tests for semantic-call resolution.

At minimum test:

- same-class exact call
- explicit typed receiver
- static call
- constructor call
- overload ambiguity
- interface declaration
- single implementation
- multiple implementations
- inherited method
- overridden method
- `super` call
- lambda-local call
- method reference
- fluent chain
- anonymous class
- Spring repository declared method
- framework-provided implementation boundary

Tests should assert:

- target
- confidence
- resolution kind
- evidence

---

## 30. Cache/schema

If semantic edge storage changes, bump cache schema to:

```text
0.5
```

Old incompatible caches must rebuild automatically.

No manual user cleanup should be required.

---

## 31. Diagnostics

Add semantic-resolution diagnostics:

```text
call_edges_total
call_edges_exact
call_edges_probable
call_edges_unresolved

resolution_kind_counts

false_positive_edges
false_negative_edges

semantic_call_recall
semantic_call_precision

semantic_resolution_harm_rate
semantic_resolution_fact_loss_rate
```

Report per repository and overall.

---

## 32. Reports

Generate:

```text
benchmarks/results/v0.5-semantic-call-resolution.md
benchmarks/results/v0.5-semantic-call-resolution.json
```

Include:

1. Executive summary
2. v0.4 baseline
3. semantic edge model
4. fixture corpus
5. exact/probable/unresolved rates
6. recall/precision
7. false positives/negatives
8. failure attribution
9. real-repository results
10. required-fact preservation
11. token impact
12. framework boundaries
13. JDT/LSP decision
14. next step

---

## 33. Comparison table

Include:

```text
| Metric | v0.4 | v0.5 |
|--------|------|------|
| Retrieval recall | 100% | ... |
| Required-fact recall | 100% | ... |
| Median token reduction | 95.05% | ... |
| Semantic call recall | N/A | ... |
| Semantic call precision | N/A | ... |
| Semantic resolution harm | N/A | ... |
| Semantic resolution fact loss | N/A | ... |
```

Use `N/A` for metrics not measured in v0.4.

---

## 34. README update

Update README with:

- distinction between symbol resolution and semantic call resolution
- declared target vs runtime target
- confidence model
- measured semantic-call results
- known framework limitations
- JDT/LSP decision

Do not advertise compiler-grade call resolution.

---

## 35. Definition of done

v0.5 is complete when:

- build passes
- expanded semantic-call tests pass
- v0.4 regression metrics remain intact
- semantic-call ground truth is independent
- semantic call recall is measured
- semantic call precision is measured
- false-positive rate is measured
- false-negative rate is measured
- exact/probable/unresolved counts are reported
- semantic resolution harm is measured
- semantic resolution fact loss is measured
- 3 pinned repositories are rerun
- existing 15 tasks remain in aggregate
- reports are generated
- README is updated
- JDT/LSP decision is evidence-based
- no compiler/LSP dependency is added to production ContextSlice

---

## 36. Final implementation report

At completion output:

```text
STATUS

BUILD / TESTS

V0.4 REGRESSION

SEMANTIC EDGE MODEL

SEMANTIC CALL RECALL

SEMANTIC CALL PRECISION

FALSE POSITIVES / NEGATIVES

EXACT / PROBABLE / UNRESOLVED

REQUIRED-FACT RECALL

TOKEN REDUCTION

FRAMEWORK BOUNDARIES

SEMANTIC RESOLUTION HARM

SEMANTIC FACT LOSS

JDT/LSP DECISION

KNOWN LIMITATIONS

NEXT STEP
```

Every number must identify its source.

---

## 37. Guiding principle

The central question for v0.5 is not:

> Can ContextSlice build a perfect Java call graph?

It is:

> Can ContextSlice resolve enough semantic call structure to construct the minimum sufficient context required by real coding tasks?

Prefer compact, explainable, task-sufficient semantics over compiler completeness.
