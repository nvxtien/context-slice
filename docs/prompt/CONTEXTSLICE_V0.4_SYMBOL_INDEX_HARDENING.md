# ContextSlice v0.4 — Symbol Index Reliability & Recall Hardening

You are extending **ContextSlice**, a local MCP server that reduces coding-agent context through deterministic structural analysis and semantic slicing.

ContextSlice v0.1 through v0.3 are already implemented and validated.

Current real-repository evaluation results from v0.3:

- 3 pinned Java repositories
  - Spring Petclinic: 50 Java files
  - Petclinic REST: 109 Java files
  - Keycloak `services`: 419 Java files
- 15 grounded benchmark tasks
- build passes
- tests: 6/6 pass
- required-fact recall: 93.94%
- median token reduction: 95.05%
- resolution harm: 0%
- resolution fact-loss: 0%
- incremental cache behaves correctly:
  - cold: full parse
  - warm: 0 files parsed
  - single-file update: 1 file parsed
- agent telemetry: unavailable
- one benchmark task failed because of `SYMBOL_INDEX`
- failed task remained in aggregate metrics
- current evidence does not justify JDT/LSP integration

The purpose of v0.4 is not feature expansion.

The purpose is:

> Make symbol discovery, symbol identity, indexing, and retrieval reliable enough that missing required facts are no longer caused by index defects.

Do not add JDT, LSP, embeddings, vector search, or an LLM retrieval layer in this phase.

---

## 1. Primary objective

Increase correctness of symbol indexing and retrieval.

Focus on these questions:

1. Can every benchmark-required symbol be indexed?
2. Are symbol IDs stable and collision-free?
3. Are overloads uniquely represented?
4. Are nested types represented correctly?
5. Are symbols with the same simple name in different packages kept distinct?
6. Can symbols be found by simple name, qualified name, and signature?
7. Can callers/callees reference the correct symbol when multiple candidates exist?
8. Does ranking retrieve the right symbol without silently guessing?
9. What percentage of required symbols can ContextSlice retrieve?
10. Which remaining failures are truly caused by missing type information?

---

## 2. New core metric — Retrieval Recall

Add:

```text
retrieval_recall =
required_symbols_retrieved
--------------------------
required_symbols_in_ground_truth
```

Measure per task, per repository, and overall.

Required symbols are symbols whose presence is necessary to preserve the benchmark's required facts.

Do not derive required symbols from ContextSlice output.

Ground truth must remain independent.

---

## 3. Symbol Index Failure Rate

Add:

```text
symbol_index_failure_rate =
tasks impacted by missing, duplicated, or incorrectly identified symbols
-----------------------------------------------------------------------
total benchmark tasks
```

Also add:

```text
symbol_fact_loss_rate =
required facts lost due specifically to symbol-index defects
------------------------------------------------------------
total required facts
```

Keep this separate from:

- parser failures
- call-resolution failures
- ranking failures
- token-budget failures

---

## 4. Failure attribution refinement

Expand failure attribution.

Use at least:

```text
PARSER
SYMBOL_NOT_INDEXED
SYMBOL_ID_COLLISION
SYMBOL_AMBIGUITY
SYMBOL_LOOKUP
SYMBOL_RANKING
CALL_RESOLUTION
TOKEN_BUDGET
DIFF_MAPPING
GROUND_TRUTH_ERROR
UNKNOWN
```

Do not collapse all symbol-related failures into one generic `SYMBOL_INDEX` bucket.

The point of v0.4 is to determine exactly where indexing breaks.

---

## 5. Symbol identity

Define a stable symbol identity model.

A symbol ID should distinguish at least:

```text
repository-relative file path
package
enclosing type chain
symbol kind
symbol name
parameter types or parameter syntax for callable symbols
```

For methods and constructors, overloads must never share the same symbol ID.

A reasonable conceptual identity is:

```text
<package>::<enclosing-type-chain>::<kind>::<name>(<parameter-signature>)
```

Examples:

```text
org.example.payment::PaymentService::method::retryPayment(String)

org.example.payment::PaymentService::method::retryPayment(String,boolean)

org.example.payment::PaymentService::constructor::PaymentService(PaymentRepository)
```

The actual implementation may use a hash.

If hashing is used, persist the readable canonical identity too.

---

## 6. Nested types

Correctly support:

- inner classes
- static nested classes
- nested interfaces
- nested enums
- nested records
- deeply nested types

Example:

```java
class Outer {
    static class Inner {
        void run() {}
    }
}
```

The symbol identity for `run` must include the full enclosing type chain.

Do not flatten nested symbols into the package namespace.

---

## 7. Same simple name across packages

Add fixtures such as:

```text
com.example.user.UserService
com.example.admin.UserService
```

and:

```text
com.example.foo.Result
com.example.bar.Result
```

Verify:

- both are indexed
- qualified lookup returns exactly one
- simple-name lookup returns ambiguity
- ranking does not silently choose one unless context strongly disambiguates it

---

## 8. Overloads

Harden indexing for:

- overloaded methods
- overloaded constructors
- varargs
- arrays
- generics
- primitive vs boxed parameters
- same parameter count with different types

Examples:

```java
save(User user)
save(List<User> users)
save(User... users)
save(long id)
save(Long id)
```

Each must have a unique identity.

Tests must assert exact non-collision.

---

## 9. Generic signatures

Support indexing for signatures such as:

```java
<T> T convert(Object value, Class<T> type)

List<Order> findOrders(List<Long> ids)

Map<String, List<User>> groupUsers(...)
```

Do not require full semantic type resolution.

The parser should preserve enough syntax to distinguish overloads and render useful signatures.

---

## 10. Constructors

Ensure constructors are indexed consistently.

Test:

- no-arg constructors
- overloaded constructors
- generic enclosing classes
- nested classes
- records and canonical constructors where represented by the grammar

Constructor IDs must be distinct from methods.

---

## 11. Interface and implementation symbols

Index interface declarations and implementation declarations separately.

Example:

```java
interface PaymentRepository {
    void save(Payment payment);
}

class JpaPaymentRepository implements PaymentRepository {
    public void save(Payment payment) {}
}
```

The interface method and implementation method are separate symbols.

Do not merge them without compiler-grade evidence.

If a relationship is syntactically visible through `implements`, record it as a relationship, not as symbol identity.

---

## 12. Inheritance

Index:

- superclass names
- implemented interfaces
- declared methods in parent and child classes

Do not pretend inherited methods are physically declared in the child.

If lookup searches for a method on a subclass and only a parent declaration exists, return that fact explicitly.

Avoid inventing synthetic child symbols.

---

## 13. Static methods and imports

Add tests for:

- static methods
- static imports
- wildcard static imports

Example:

```java
import static java.util.Objects.requireNonNull;
```

A call:

```java
requireNonNull(value);
```

may remain unresolved without type/compiler resolution.

That is acceptable.

The important part is that index lookup must not create a false symbol mapping.

---

## 14. Records and enums

Add explicit indexing tests for:

- record declaration
- record components
- methods declared inside records
- enum declaration
- enum constants if currently represented
- methods declared inside enums

Do not over-model language constructs unless needed.

Focus on symbol discoverability and identity.

---

## 15. Anonymous classes and lambdas

Do not create unstable public symbol identities for anonymous classes or lambdas unless necessary.

If they contain methods relevant to call extraction, preserve local structure internally.

But avoid exposing brittle synthetic names as normal searchable symbols.

Document the chosen behavior.

---

## 16. Stable IDs across indexing runs

Add a regression test:

```text
same repository
same file contents
reindex
→ same symbol IDs
```

Also test:

```text
unrelated file changes
→ IDs of untouched symbols remain unchanged
```

A file content hash should not be part of canonical symbol identity.

Otherwise IDs become unstable on trivial edits.

---

## 17. Symbol lookup API behavior

Harden `context.symbol`.

Lookup order should be explicit.

Recommended logic:

1. exact stable symbol ID
2. exact qualified canonical identity
3. exact qualified symbol name
4. exact signature
5. exact simple name
6. fuzzy/name search

If multiple matches exist:

```text
return ambiguity
```

Do not silently return the first match.

Return compact candidate information:

```text
id
qualifiedName
signature
filePath
kind
```

---

## 18. Search ranking

Harden `context.search` ranking.

Relevant signals may include:

- exact simple-name match
- exact qualified-name match
- signature match
- file-name match
- package match
- enclosing type match
- task-intent lexical overlap
- caller/callee proximity

Avoid arbitrary tie breaking.

If scores are equal, use deterministic ordering such as canonical symbol identity.

Add regression tests for ranking stability.

---

## 19. Retrieval correctness benchmark

Extend the benchmark task definitions with expected symbols.

Example:

```json
{
  "id": "petclinic-task-x",
  "requiredSymbols": [
    {
      "canonical": "org.springframework.samples.petclinic.owner::OwnerController::method::processUpdateOwnerForm(...)",
      "role": "target"
    }
  ]
}
```

For every benchmark task report:

```text
required_symbols_total
required_symbols_retrieved
retrieval_recall
```

This is in addition to required-fact recall.

---

## 20. Search stress corpus

Create a dedicated symbol-index stress fixture.

Suggested:

```text
tests/fixtures/symbol-index/
```

Include:

- duplicate simple class names across packages
- duplicate method names
- overloads
- constructors
- nested types
- generics
- records
- enums
- interfaces and implementations
- inheritance
- malformed source
- same filename in different directories

The fixture should intentionally create ambiguity.

---

## 21. Real-repository regression

Reuse the same 3 pinned repositories and 15 tasks from v0.3.

Do not change repository commits merely to improve metrics.

Run the entire v0.3 benchmark again after symbol-index hardening.

Compare:

```text
v0.3 vs v0.4
```

Report at minimum:

- required-fact recall
- retrieval recall
- median token reduction
- symbol index failure rate
- symbol fact loss rate
- resolution harm
- resolution fact loss

Do not remove the previously failing task.

---

## 22. Regression goal

Target:

```text
symbol_index_failure_rate = 0%
```

and:

```text
symbol_fact_loss_rate = 0%
```

If not achieved, report exact remaining failures.

Do not hide failures by loosening required facts.

---

## 23. Interaction with token reduction

Do not sacrifice correctness to preserve 95.05% median token reduction.

Priority order is:

```text
1. required-fact recall
2. retrieval recall
3. symbol correctness
4. deterministic ambiguity handling
5. token reduction
```

A small reduction in compression is acceptable if correctness improves.

---

## 24. JDT/LSP decision remains deferred

Do not add JDT/LSP during v0.4.

After fixing symbol indexing, re-evaluate whether remaining failures are caused by missing semantic type resolution.

Decision logic:

```text
if symbol-index failures disappear:
    keep Tree-sitter-only architecture

else if remaining failures require type information:
    collect evidence for JDT/LSP

else:
    continue fixing parser/index/ranking
```

Do not use unresolved-call rate alone as justification.

---

## 25. Tests

Increase test coverage substantially beyond the current 6 tests.

At minimum add targeted tests for:

- stable IDs
- overload uniqueness
- constructor uniqueness
- nested-type identity
- same simple name in different packages
- ambiguous simple-name lookup
- exact qualified lookup
- generic signatures
- inheritance declarations
- interface declarations
- record indexing
- enum indexing
- deterministic search ranking
- malformed source handling
- unchanged-ID behavior after unrelated file edits

Tests must assert exact behavior, not only successful execution.

---

## 26. Cache compatibility

Any index schema changes must be versioned.

If the symbol identity model changes:

- bump index schema/version
- invalidate incompatible cache safely
- rebuild automatically

Never attempt to interpret old symbol IDs under a new identity model without migration logic.

Deleting the cache must remain safe.

---

## 27. Observability

Add lightweight index diagnostics.

Suggested metrics:

```text
files_indexed
symbols_indexed
methods_indexed
constructors_indexed
classes_indexed
interfaces_indexed
records_indexed
enums_indexed
duplicate_simple_names
ambiguous_lookups
symbol_id_collisions
```

A real symbol ID collision should be treated as an error.

---

## 28. Reports

Generate:

```text
benchmarks/results/v0.4-symbol-index-hardening.md
benchmarks/results/v0.4-symbol-index-hardening.json
```

Include:

1. Summary
2. Symbol identity model
3. New tests
4. Stress corpus results
5. Real repository regression
6. Retrieval recall
7. Required-fact recall
8. Symbol index failure rate
9. Token reduction comparison
10. Remaining failures
11. JDT/LSP evidence check
12. Next step

---

## 29. Comparison table

Include:

```text
| Metric | v0.3 | v0.4 |
|--------|------|------|
| Required-fact recall | 93.94% | ... |
| Retrieval recall | N/A | ... |
| Median token reduction | 95.05% | ... |
| Symbol index failure rate | >0 | ... |
| Symbol fact loss rate | ... | ... |
| Resolution harm | 0% | ... |
| Resolution fact loss | 0% | ... |
```

Do not fabricate unavailable v0.3 metrics.

Use `N/A` where necessary.

---

## 30. README update

Update README with:

- v0.4 purpose
- symbol identity rules
- retrieval recall
- ambiguity behavior
- updated benchmark results
- known remaining limitations

Keep fixture results and real-repository results clearly separated.

---

## 31. Definition of done

v0.4 is complete when:

- build passes
- expanded tests pass
- symbol IDs are stable
- overloads do not collide
- nested types are distinct
- same-name symbols across packages are distinct
- ambiguous lookups are explicit
- exact qualified lookup works
- retrieval recall is measured
- all 15 real tasks are rerun
- symbol-related failures are precisely attributed
- symbol index failure rate is reported
- symbol fact loss rate is reported
- benchmark reports are generated
- README is updated
- no JDT/LSP is added
- remaining failures are documented honestly

---

## 32. Final implementation report

At completion output:

```text
STATUS

BUILD / TESTS

SYMBOL ID MODEL

INDEX DIAGNOSTICS

RETRIEVAL RECALL

REQUIRED-FACT RECALL

TOKEN REDUCTION

SYMBOL INDEX FAILURE RATE

SYMBOL FACT LOSS RATE

REAL-REPOSITORY REGRESSION

REMAINING FAILURES

JDT/LSP EVIDENCE

KNOWN LIMITATIONS

NEXT STEP
```

Every metric must identify its source.

---

## 33. Guiding principle

The central question for v0.4 is:

> Can ContextSlice reliably identify and retrieve the right symbols before any more sophisticated semantic machinery is added?

Fix identity, indexing, ambiguity, and lookup first.

Only add compiler-grade resolution if symbol indexing is no longer the source of failure.
