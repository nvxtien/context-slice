# ContextSlice v1.2 — Context Composition Hardening & Sibling Context Recall

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice v1.1 is complete and validated for Java, TypeScript, and TSX.

Current v1.1 TypeScript benchmark results:

- semantic call recall: 100%
- semantic call precision: 100%
- retrieval recall: 100%
- required-fact recall: 95.56% (43/45)
- median context reduction: 83.32%
- whole-file fallback: 6.67%
- 2 required facts were missed because they were sibling members of the target class and were not included in the method-centred slice
- tsserver was not added because 0/45 required facts were lost due to missing type inference

Current Java benchmark regression:

- required-fact recall: 100%
- retrieval recall: 100%
- median context reduction: 94.55%

The purpose of v1.2 is:

> Improve context composition around a target symbol so ContextSlice preserves relevant sibling state and behavior without falling back to whole-class or whole-file context.

This milestone is not about parser expansion, language support, or compiler integration.

It is about composing the right minimum sufficient context.

---

## 1. Primary objective

Fix the v1.1 composition gap.

The main failure pattern is:

```text
target method
    ↓
slice includes target + callers + callees
    ↓
relevant sibling field/method in same class omitted
    ↓
required fact lost
```

v1.2 should include relevant same-enclosing-type context when evidence shows it is task-critical.

Do not include the entire class by default.

---

## 2. Mandatory benchmark rule

No v1.2 change is complete without a reproducible benchmark.

Every composition change must be evaluated against the v1.1 baseline.

Required baseline:

```text
TypeScript required-fact recall: 95.56%
TypeScript retrieval recall: 100%
TypeScript median context reduction: 83.32%
TypeScript whole-file fallback: 6.67%

Java required-fact recall: 100%
Java retrieval recall: 100%
Java median context reduction: 94.55%
```

Every implementation report must include:

- before
- after
- regression delta
- failure attribution

Do not claim improvement from tests alone.

---

## 3. v1.2 success criteria

Primary target:

```text
TypeScript required-fact recall = 100%
```

Guardrails:

```text
retrieval recall = 100%
semantic call recall must not regress
semantic call precision must not regress
Java required-fact recall = 100%
Java retrieval recall = 100%
```

Context-efficiency guardrail:

Do not achieve recall by simply including whole classes or files.

The milestone succeeds only if context remains materially smaller than the manual whole-file baseline.

---

## 4. New metric — Sibling Context Recall

Add:

```text
sibling_context_recall =
required sibling facts preserved
--------------------------------
total required sibling facts
```

A sibling fact is a required fact represented by a member of the same enclosing class/type as the target but outside the target symbol body.

Examples:

- field used indirectly
- sibling helper method
- getter/setter relevant to state
- constructor dependency
- adjacent state mutation method

Report:

- per task
- per repository
- overall

---

## 5. New metric — Enclosing-Type Expansion Cost

Measure the token cost added by same-type expansion.

```text
enclosing_type_expansion_tokens
```

Also report:

```text
expansion_cost_ratio =
same-type expansion tokens
--------------------------
total slice tokens
```

This prevents hidden context inflation.

---

## 6. Composition strategy

Extend the context planner with a dedicated same-enclosing-type composition phase.

Conceptually:

```text
target
  ↓
direct dependencies
  ↓
callers/callees
  ↓
relevant same-type members
  ↓
tests/config if needed
```

Same-type members should only be included with evidence.

Do not default to all siblings.

---

## 7. Evidence for sibling inclusion

A sibling member may be included when one or more of these signals exist:

- target directly reads/writes the sibling field
- target calls the sibling method
- sibling method reads/writes the same field as target
- sibling method is the only accessor/mutator of a relevant field
- constructor injects a dependency used by target
- target and sibling participate in the same local state transition
- required type/member relationship is structurally visible
- tests directly reference target + sibling behavior
- semantic call graph links the sibling within a small same-type radius

Keep evidence deterministic and inspectable.

---

## 8. Shared-state analysis

Add lightweight same-type shared-state analysis.

Example:

```ts
class Cart {
  private total = 0;

  add(item: Item) {
    this.total += item.price;
  }

  getTotal() {
    return this.total;
  }
}
```

If the task targets `add`, `getTotal` may be relevant because both touch `total`.

Represent:

```text
shared field: total
target writes: total
sibling reads: total
```

Do not attempt whole-program alias analysis.

---

## 9. Field-centric context

Extract and track:

- fields/properties read by target
- fields/properties written by target
- siblings reading those fields
- siblings writing those fields

Use this graph to rank sibling context.

Do not include every field in the class.

---

## 10. Constructor dependency context

For classes with constructor injection:

```ts
class OrderService {
  constructor(
    private readonly repo: OrderRepository,
    private readonly events: EventBus
  ) {}

  create(...) {
    ...
  }
}
```

Include constructor dependency declarations relevant to the target.

Avoid including unrelated constructor parameters.

---

## 11. Accessor/mutator context

For:

```ts
private state: State;

setState(...)
getState(...)
process(...)
```

If the task touches `process` and `state`, accessor/mutator siblings may be relevant.

Use field-sharing evidence.

Do not assume getters/setters are always important.

---

## 12. Same-type helper methods

If the target calls a sibling helper, it is already a direct callee.

The new logic should focus on relevant siblings that are not directly called but still carry required local semantics.

Examples:

- helper used by another transition step
- getter exposing target-mutated state
- sibling handler in same component sharing closure state

---

## 13. TypeScript class sibling context

Support same-type expansion for TypeScript classes.

Measure separately:

- fields
- methods
- getters/setters
- constructor members

Do not treat nested functions as class siblings unless they belong to the target's local lexical context.

---

## 14. TSX component local sibling context

For function components, "siblings" may be local closures rather than class members.

Example:

```tsx
function Checkout() {
  const [state, setState] = useState(...);

  const validate = () => ...;
  const submit = () => ...;

  return ...
}
```

If the target is `submit`, relevant local closures and shared state may need inclusion.

Model lexical sibling context for function components.

Do not dump the entire component body by default.

---

## 15. Lexical shared-state context

Track shared local variables captured by multiple nested callables.

Example:

```ts
function Component() {
  let count = 0;

  const increment = () => { count++; };
  const current = () => count;
}
```

If target is `increment`, `current` may be relevant through shared `count`.

Use conservative structural analysis.

---

## 16. Java same-type context

Apply the same composition framework to Java where appropriate.

Examples:

- private field read/write overlap
- sibling getter/setter
- constructor-injected dependency
- local helper method
- state transition methods

Java benchmark must remain at 100% recall.

The new composition must not inflate Java context unnecessarily.

---

## 17. Enclosing-type radius

Introduce a bounded same-type radius.

Example conceptual levels:

```text
0 = target only
1 = direct same-type dependencies
2 = shared-state siblings
3 = wider same-type candidates
```

The planner should expand progressively.

Do not jump directly to full enclosing type.

---

## 18. Budget-aware sibling selection

Sibling context must obey the existing token budget.

When budget is constrained:

Priority order should be evidence-driven.

Recommended priority:

1. required target source
2. direct dependencies
3. same-type shared-state members
4. relevant callers
5. tests
6. weaker same-type candidates

Exact order may vary based on current planner architecture.

Measure the effect.

---

## 19. Omission explanations

When a sibling candidate is omitted, record why.

Examples:

```text
omitted: weak same-type relevance
omitted: budget exceeded
omitted: duplicate state evidence
```

This supports trust and debugging.

---

## 20. Inclusion metadata

Extend inclusion metadata with reason types such as:

```text
same-type-shared-field
constructor-dependency
state-accessor
lexical-shared-state
same-type-transition
```

Each must include:

- score
- confidence
- estimated tokens
- evidence

---

## 21. Avoid whole-class fallback

Do not solve v1.2 by:

```text
if sibling fact missing:
  include entire class
```

Whole-class inclusion may be allowed only as explicit fallback when minimum sufficient context cannot otherwise be constructed.

Record every occurrence.

---

## 22. Whole-class fallback metric

Add:

```text
whole_class_fallback_rate
```

Target:

```text
0%
```

for the benchmark if practical.

If non-zero, report exact task and reason.

---

## 23. Context inflation metric

Add:

```text
context_inflation =
v1.2 slice tokens - v1.1 slice tokens
```

Report:

- absolute
- percentage
- median
- worst case

The goal is not zero inflation.

The goal is minimal inflation required to restore facts.

---

## 24. Fact recovery efficiency

Add:

```text
fact_recovery_efficiency =
newly recovered required facts
------------------------------
additional context tokens
```

Use this to evaluate whether sibling expansion is efficient.

---

## 25. Baseline replay

Reuse the exact v1.1 pinned repositories and 15 tasks.

Do not alter commits.

Do not remove the two failing fact cases.

Run v1.1 composition logic and v1.2 composition logic against the same tasks if architecture allows.

Otherwise compare against recorded v1.1 baseline.

---

## 26. Add targeted composition tasks

Add a small targeted corpus specifically for sibling context.

Suggested:

```text
tests/fixtures/context-composition/
```

Cover:

- field shared by target and sibling getter
- target + sibling setter
- constructor dependency
- state transition pair
- TSX component with shared closure state
- nested callable shared variable
- Java field-sharing siblings
- unrelated siblings that must not be included

These targeted tests are separate from the 15 real benchmark tasks.

---

## 27. Negative tests

Critical:

Verify unrelated siblings are not pulled in.

Example:

```ts
class Service {
  target() { uses A }
  relevant() { uses A }
  unrelated() { uses Z }
}
```

The planner should prefer `relevant` and omit `unrelated`.

This guards against context inflation.

---

## 28. Large enclosing type test

Use a class/component with many members.

Verify:

- target slice remains compact
- only relevant sibling members are included
- no whole-class dump
- token budget respected

This is release-critical for composition quality.

---

## 29. TSX large-component test

Use at least one large TSX component.

The v1.1 benchmark already exposed large-file parser issues.

Keep a permanent regression for large TSX files.

Measure composition separately from parsing.

---

## 30. File-size regression

Retain the v1.1 fix for large files.

Add/keep regression coverage for files:

```text
>32 KB
>128 KB
>400 KB
```

Do not let composition work reintroduce silent skips.

---

## 31. Required-fact attribution

Every missing fact after v1.2 must be attributed to:

```text
TARGET_SELECTION
CONTEXT_COMPOSITION
TOKEN_BUDGET
SYMBOL_INDEX
CALL_RESOLUTION
IMPORT_RESOLUTION
PARSER
GROUND_TRUTH
UNKNOWN
```

The goal is to eliminate current `CONTEXT_COMPOSITION` misses.

---

## 32. Composition-specific benchmark report

Generate:

```text
benchmarks/results/v1.2-context-composition.md
benchmarks/results/v1.2-context-composition.json
```

Include:

1. v1.1 baseline
2. composition strategy
3. sibling-context recall
4. required-fact recall
5. context reduction
6. context inflation
7. whole-file fallback
8. whole-class fallback
9. minimum sufficient budget
10. fact recovery efficiency
11. Java regression
12. TypeScript regression
13. failure attribution
14. known limitations
15. next step

---

## 33. Mandatory comparison table

Include:

```text
| Metric | v1.1 | v1.2 | Delta |
|--------|------|------|-------|
| TS required-fact recall | 95.56% | ... | ... |
| TS retrieval recall | 100% | ... | ... |
| TS median context reduction | 83.32% | ... | ... |
| TS whole-file fallback | 6.67% | ... | ... |
| Sibling context recall | N/A | ... | ... |
| Whole-class fallback | N/A | ... | ... |
| Java required-fact recall | 100% | ... | ... |
| Java retrieval recall | 100% | ... | ... |
```

Do not omit regressions.

---

## 34. Per-change benchmark discipline

If multiple composition heuristics are introduced, benchmark them independently where practical.

Example:

```text
baseline
+ shared-field rule
+ constructor-dependency rule
+ lexical-shared-state rule
```

Record which rule recovered which fact.

Avoid combining many heuristics and then claiming success without attribution.

---

## 35. Feature retention rule

A composition heuristic should remain only if it satisfies at least one:

- recovers a required fact
- reduces whole-file fallback
- reduces whole-class fallback
- lowers minimum sufficient budget
- materially improves developer context efficiency

without causing unacceptable regression.

If a heuristic adds context but provides no measurable benefit, remove it.

---

## 36. No framework-specific hacks

Do not add special cases such as:

```text
if React component → include all handlers
if Nest service → include all methods
```

Use generic structural evidence.

Framework-specific behavior belongs in future milestones only if separately benchmarked.

---

## 37. No benchmark leakage

Production planner must not access:

- requiredFacts
- expected sibling members
- benchmark answers
- manual baseline

Add a regression check if practical.

---

## 38. Planner explainability

Expose same-type expansion in preview explain mode.

Example:

```text
getTotal()
reason: same-type shared-field
evidence: reads field "total" written by target "add"
tokens: 42
```

This is important because sibling expansion may otherwise look arbitrary.

---

## 39. Preview behavior

Do not overwhelm normal preview output.

Default view remains compact.

Detailed same-type evidence can be shown through existing explain/verbose mode.

---

## 40. Token-budget sweep

Run the same budget sweep:

```text
256
512
1024
2048
4096
8192
```

Measure:

- fact recall
- sibling recall
- context inflation
- minimum sufficient budget

Determine whether v1.2 reduces the budget required to achieve 100% facts.

---

## 41. Minimum sufficient context

Keep this as a central metric.

For every task:

```text
minimum_sufficient_budget =
lowest budget with 100% required-fact recall
```

If v1.2 requires much larger budgets to fix sibling facts, explain why.

---

## 42. Performance

Measure whether composition logic affects preview latency.

Report:

- median preview latency
- worst-case preview latency
- large-class/component case

Do not optimize prematurely.

---

## 43. Cache compatibility

If new composition metadata is not persisted, cache schema may remain unchanged.

If persisted index structures change, bump schema safely.

Do not bump schema without need.

---

## 44. Java/TypeScript parity

The composition engine should be language-agnostic where possible.

Prefer core concepts:

- enclosing symbol
- member
- reads
- writes
- shared state
- lexical sibling
- constructor dependency

over language-specific conditionals.

Language adapters may provide evidence extraction.

---

## 45. Mixed-language repositories

Rerun mixed Java/TypeScript tests.

Ensure new composition metadata does not cause ID collisions or cross-language sibling confusion.

---

## 46. Packaging regression

Rerun package smoke/clean-room checks relevant to changed runtime files.

At minimum:

- build
- tests
- npm pack
- isolated preview smoke

Do not regress v1.1 packaging.

---

## 47. README

Update README only if user-visible behavior changes.

Explain:

> ContextSlice may include relevant sibling members that share state or local semantics with the target, instead of expanding to an entire class/file.

Do not market this as perfect semantic understanding.

---

## 48. Docs

Add or update:

```text
docs/context-composition.md
```

Cover:

- target-centered slicing
- same-type expansion
- shared-state evidence
- lexical sibling context
- budget behavior
- omission behavior
- limitations

---

## 49. Version

Target:

```text
1.2.0
```

if this milestone is released as a feature version.

Do not publish/tag/push automatically.

---

## 50. No public release action

Do not:

- npm publish
- git tag
- GitHub Release
- push release commits

unless explicitly authorized.

---

## 51. Definition of done

v1.2 is complete when:

- build passes
- all tests pass
- existing Java regressions pass
- existing TypeScript regressions pass
- targeted composition tests pass
- sibling context recall is measured
- TypeScript required-fact recall reaches 100% or remaining misses are explicitly justified
- retrieval recall remains 100%
- semantic call metrics do not regress
- context reduction is reported
- context inflation is reported
- whole-file fallback is reported
- whole-class fallback is reported
- minimum sufficient budget is reported
- fact recovery efficiency is reported
- no whole-class dump is used as the normal fix
- large-class/TSX regression passes
- benchmark report is generated
- README/docs updated if needed
- no benchmark leakage
- no framework-specific benchmark hacks
- each new heuristic has measurable benefit

---

## 52. Final implementation report

At completion output:

```text
STATUS

VERSION

BUILD / TESTS

V1.1 BASELINE

COMPOSITION STRATEGY

SIBLING CONTEXT RECALL

REQUIRED-FACT RECALL

RETRIEVAL RECALL

SEMANTIC CALL REGRESSION

CONTEXT REDUCTION

CONTEXT INFLATION

WHOLE-FILE FALLBACK

WHOLE-CLASS FALLBACK

MINIMUM SUFFICIENT BUDGET

FACT RECOVERY EFFICIENCY

JAVA REGRESSION

TYPESCRIPT REGRESSION

LARGE FILE / LARGE COMPONENT

PERFORMANCE

FAILURE ATTRIBUTION

HEURISTICS RETAINED / REMOVED

PACKAGING REGRESSION

KNOWN LIMITATIONS

NEXT STEP
```

Every metric must include benchmark scope.

---

## 53. Guiding principle

The central question for v1.2 is:

> Can ContextSlice recover the local semantics surrounding a target without paying the cost of sending the whole class or file?

The goal is not more context.

The goal is better-composed minimum sufficient context.
