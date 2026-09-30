# Java Spring Data `@Query` AST Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `src/languages/java/enterprise/spring-data.ts`'s `queryText()` function (the only annotation-based detection mechanism in this file) from a raw text search to the detect-via-AST/extract-via-regex split every prior phase established — fixing a confirmed real bug where a `@Query(...)` mentioned inside a comment produces a false `REPOSITORY_QUERY` relation.

**Architecture:** `queryText(method)` gains an entry guard checking `method.annotations` for a bare `"Query"` name before running its existing depth-counting, string-literal-aware paren-matching scan (which stays otherwise unchanged) against `method.source`. The scan's own search regex gains a qualified-name-tolerant prefix. No other function in this file changes — `repositoryShape()` and `derivedProperties()` are not annotation-based and are out of scope (see spec's Non-goals).

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test`), tree-sitter-java-backed `parseJava`.

**Spec:** `docs/superpowers/specs/2026-09-30-java-spring-data-ast-migration-design.md`

## Global Constraints

- `queryText()`'s signature stays identical: `(method: SymbolRecord) => string | undefined`. Its two call sites (`extractSpringData()` and `resolveRepositoryQueryPropagation()`) need no change.
- The existing depth-counting/string-literal-aware paren-matching loop inside `queryText()` is already correct and must be preserved verbatim — only the entry guard and the search regex's prefix change.
- `bareName(annotation)` is a locally-duplicated one-line helper (`annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "")`), matching the convention every prior phase (1-4a) established: each enterprise-extractor file keeps its own copy, never a shared import.
- Do not touch `BASE_RE`, `typeArguments()`, `repositoryShape()`, `DERIVED_RE`, `derivedProperties()`, `extractSpringData()`'s loop structure, `resolvePersistsEntity()`, or `resolveRepositoryQueryPropagation()`.
- Full test suite runs must exclude the four pre-existing hang-prone files: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`. In a git worktree, `tests/cli.test.ts` and `tests/package-metadata.test.ts` additionally fail fast (not hang) with 6 known pre-existing failures (ENOENT via `spawnSync`, missing `node_modules` in the worktree) — always expected, never new; do not attempt to fix them.
- `sourceSymbolId: method.id` must stay attributed to the method symbol (unchanged from current code) — this is a standing Review Focus item from every prior phase (attribution must never silently shift to the wrong symbol during a refactor).

## Review Focus

- A `@Query` mentioned inside a method body comment must produce NO relation (the confirmed bug fix) — Task 1's new test pins this.
- A fully-qualified `@org.springframework.data.jpa.repository.Query(...)` must still be detected AND have its argument text correctly extracted — Task 1's new test pins this.
- A real `@Query("...")` on an actual method must continue to produce a relation identical to before (regression pin) — already covered by the existing, unchanged `"@Query captures the raw text verbatim"` test.
- A method with `@Query` but empty/whitespace-only parens (bare `@Query` with no arguments, or `@Query()`) must continue to produce no relation — already implicitly covered by `extractSpringData()`'s `if (!properties && query === undefined) continue;` check combined with `queryText()` returning the trimmed (possibly empty) string; not a new behavior, but Task 1 should verify this isn't accidentally broken by the entry-guard change (existing test `"a plain CRUD-inherited method with no derived-query shape and no @Query produces nothing"` already exercises the no-`@Query`-at-all case — the guard's negative path).
- The propagation resolver (`resolveRepositoryQueryPropagation`) calls `queryText()` on methods from OTHER (plain supertype) interfaces — its existing tests must continue passing unchanged, proving the signature/behavior contract holds across that second call site too.
- Real-repo benchmark numbers must not regress — Task 2 pins this via `npm run benchmark:v14-phase4`.

---

### Task 1: Migrate `queryText()` to detect-via-AST, extract-via-regex

**Files:**
- Modify: `src/languages/java/enterprise/spring-data.ts`
- Test: `tests/java-enterprise-spring-data.test.ts`

**Interfaces:**
- Consumes: `SymbolRecord.annotations` (already populated by `parseJava`, bare `@`-prefixed or fully-qualified annotation name strings — same shape every prior phase read).
- Produces: `queryText(method: SymbolRecord): string | undefined` — same signature as before; callers (`extractSpringData()` line ~100, `resolveRepositoryQueryPropagation()` line ~197) are unchanged and need no edits.

- [ ] **Step 1: Write the failing test for the comment false-positive**

Add to `tests/java-enterprise-spring-data.test.ts`, after the existing `"@Query captures the raw text verbatim"` test (around line 75):

```ts
test("@Query mentioned only in a method body comment produces no relation", () => {
  const repo = `interface OwnerRepository extends JpaRepository<Owner, Integer> {\n    default void touch(int id) {\n        // @Query("SELECT o FROM Owner o")\n        System.out.println("noop");\n    }\n}`;
  const owner = `@Entity\nclass Owner {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/OwnerRepository.java": repo, "src/main/java/Owner.java": owner });
  const method = symbols.find((s) => s.kind === "method" && s.name === "touch")!;
  assert.ok(!relations.some((r) => r.sourceSymbolId === method.id), "a @Query mentioned only in a comment must not produce a relation");
});

test("a fully-qualified @Query annotation still has its text extracted", () => {
  const repo = `interface PetTypeRepository extends JpaRepository<PetType, Integer> {\n    @org.springframework.data.jpa.repository.Query("SELECT ptype FROM PetType ptype ORDER BY ptype.name")\n    java.util.List<PetType> findPetTypes();\n}`;
  const petType = `@Entity\nclass PetType {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/PetTypeRepository.java": repo, "src/main/java/PetType.java": petType });
  const method = symbols.find((s) => s.kind === "method" && s.name === "findPetTypes")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.match(rel.evidence.join(" "), /SELECT ptype FROM PetType/);
});
```

- [ ] **Step 2: Run the new tests to verify they fail/pass-for-the-wrong-reason**

Run: `npx tsx --test tests/java-enterprise-spring-data.test.ts`

Expected: the first new test FAILS (`assert.ok(!relations.some(...))` — the comment currently DOES produce a relation, confirming the bug reproduces here too, matching the spec's own repro). The second new test is expected to already PASS against the current code (the existing plain-source-search regex `/@Query\s*\(/` does not anchor to position 0, so it happens to match inside a fully-qualified name by accident) — this is fine; it becomes a regression pin once Step 3 replaces the mechanism deliberately rather than by accident, per the spec's explicit note on this.

- [ ] **Step 3: Implement the fix**

In `src/languages/java/enterprise/spring-data.ts`, add a `bareName` helper near the top of the file (after the existing `DERIVED_RE` constant, before `typeArguments()`):

```ts
/** Strips a leading "@" and any dotted package prefix, e.g. "@org.springframework...Query" -> "Query". */
function bareName(annotation: string): string {
  return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}
```

Replace the existing `queryText()` function body:

```ts
/** Verbatim @Query(...) argument text (string-literal aware); undefined if absent/unbalanced. */
function queryText(method: SymbolRecord): string | undefined {
  const at = method.source.search(/@Query\s*\(/);
  if (at === -1) return undefined;
  const open = method.source.indexOf("(", at);
  let depth = 0;
  let inString = false;
  for (let i = open; i < method.source.length; i++) {
    const ch = method.source[i];
    if (ch === '"' && method.source[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return method.source.slice(open + 1, i).trim();
  }
  return undefined;
}
```

with:

```ts
/**
 * Verbatim @Query(...) argument text (string-literal aware); undefined if absent/unbalanced.
 * Detection of whether @Query is present happens via SymbolRecord.annotations first -- never
 * via the search regex below on its own, which previously matched inside comments or string
 * literals anywhere in the method's source (a method body, not just its header, can contain
 * arbitrary text). The qualified-name-tolerant prefix mirrors every prior phase's fix for a
 * fully-qualified annotation name.
 */
function queryText(method: SymbolRecord): string | undefined {
  if (!method.annotations.some((a) => bareName(a) === "Query")) return undefined;
  const at = method.source.search(/@(?:[\w.]+\.)?Query\s*\(/);
  if (at === -1) return undefined;
  const open = method.source.indexOf("(", at);
  let depth = 0;
  let inString = false;
  for (let i = open; i < method.source.length; i++) {
    const ch = method.source[i];
    if (ch === '"' && method.source[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return method.source.slice(open + 1, i).trim();
  }
  return undefined;
}
```

- [ ] **Step 4: Run the full Spring Data test file to verify everything passes**

Run: `npx tsx --test tests/java-enterprise-spring-data.test.ts`

Expected: all 14 tests (12 existing + 2 new) PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`

Expected: PASS, with only the 6 known pre-existing worktree-environment failures in `cli.test.ts`/`package-metadata.test.ts` (if running in a worktree) — no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/languages/java/enterprise/spring-data.ts tests/java-enterprise-spring-data.test.ts
git commit -m "feat(java): detect @Query via AST symbols in spring-data.ts"
```

---

### Task 2: Re-run the real-repo benchmark and record results

**Files:**
- Modify (regenerated, not hand-edited): `benchmarks/results/v1.4-phase4-jpa-spring-data.json`
- Modify (regenerated, not hand-edited): `benchmarks/results/v1.4-phase4-jpa-spring-data.md`

**Interfaces:**
- Consumes: the `queryText()` fix from Task 1 (already committed).
- Produces: updated benchmark report files compared against the currently-committed ones from Phase 4a.

- [ ] **Step 1: Record current committed numbers for comparison**

Run: `git show HEAD:benchmarks/results/v1.4-phase4-jpa-spring-data.md | grep -A5 "repository_linkage\|entity_relation"`

Note the current `repository_linkage` and `entity_relation` recall/precision numbers before regenerating — these are the baseline Task 1's change must not regress.

- [ ] **Step 2: Run the benchmark**

Run: `npm run benchmark:v14-phase4`

This regenerates `benchmarks/results/v1.4-phase4-jpa-spring-data.json` and `.md`.

- [ ] **Step 3: Compare against baseline**

Diff the new report against the baseline recorded in Step 1.

- `entity_relation` numbers MUST be byte-identical to the current committed numbers (Task 1 makes no change affecting `jpa-entity.ts`). If they differ, STOP — this indicates test-order or fixture drift unrelated to this task; do not proceed without understanding why.
- `repository_linkage` recall/precision must be equal or better, never worse. "Equal" is a fully expected, acceptable outcome per the spec (the fixed bug is a comment-only false positive; real-repo corpora are not expected to contain commented-out `@Query` text). If a real improvement is found (a corpus repo happens to have a commented-out `@Query`), report the specific improvement explicitly in the commit message and the summary doc (Task 3).
- If `repository_linkage` precision or recall is WORSE than baseline: STOP. Investigate before proceeding — this would mean the migration introduced a real regression, which the spec's acceptance criteria (Definition of Done item 3) does not permit. Do not adjust the benchmark oracle without a controller ruling (see this plan's parent skill's "Rulings, not stalls" section) — unlike Phase 4a, this spec's own bug fix is narrowly scoped and a genuine `repository_linkage` regression here is far more likely to indicate a real implementation bug than an oracle bug.

- [ ] **Step 4: Commit the regenerated reports**

```bash
git add benchmarks/results/v1.4-phase4-jpa-spring-data.json benchmarks/results/v1.4-phase4-jpa-spring-data.md
git commit -m "test(java): regenerate Phase 4b spring-data benchmark report"
```

If the numbers are byte-identical to baseline (the fully expected outcome), commit anyway — the regenerated report is the evidence the acceptance criterion was checked, not just assumed.

---

### Task 3: Write the Phase 4b (and roadmap-closing) summary

**Files:**
- Create: `docs/superpowers/plans/2026-09-30-java-spring-data-ast-migration-summary.md`

**Interfaces:**
- Consumes: Task 1's commit (test evidence), Task 2's benchmark comparison (real-repo evidence).
- Produces: a short follow-up note per the spec's Definition of Done item 4, closing out the entire "AST-ify enterprise extractors" roadmap.

- [ ] **Step 1: Write the summary document**

Create `docs/superpowers/plans/2026-09-30-java-spring-data-ast-migration-summary.md` with this structure (fill in the bracketed evidence from Tasks 1-2's actual results — commit hashes, exact before/after numbers):

```markdown
# Phase 4b Complete: Java Spring Data `@Query` AST Migration

**Spec:** `docs/superpowers/specs/2026-09-30-java-spring-data-ast-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-09-30-java-spring-data-ast-migration.md`

## What changed

`spring-data.ts`'s `queryText()` now detects `@Query` via
`SymbolRecord.annotations` before running its existing depth-counting
extraction regex, instead of searching the method's raw source text
unconditionally. `repositoryShape()` and `derivedProperties()` were
confirmed out of scope (not annotation-based detection) and left
unchanged.

## Bug fixed

A `@Query(...)` mentioned inside a method body comment previously produced
a false `REPOSITORY_QUERY` relation. RED test (Task 1, commit `[hash]`)
confirmed the bug reproduces via the existing code; GREEN after the fix.
[State whether the real-repo benchmark corpus happened to contain this
pattern — expected: no, matching the spec's stated expectation.]

## Real-repo benchmark result

`repository_linkage`: [baseline] -> [new] (recall/precision).
`entity_relation`: byte-identical to baseline, as expected (untouched
code path).

## Roadmap status: COMPLETE

This closes the "AST-ify enterprise extractors" roadmap. All five
enterprise extractors now detect annotations via AST-derived
`SymbolRecord.annotations` rather than comment-unaware text regexes:

1. `dependency-injection.ts` (Phase 1)
2. `spring-mvc.ts` (Phase 2)
3. `transactions.ts` (Phase 3)
4. `jpa-entity.ts` (Phase 4a)
5. `spring-data.ts` (Phase 4b)
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-09-30-java-spring-data-ast-migration-summary.md
git commit -m "docs: summarize Java Spring Data @Query AST migration, roadmap complete"
```
