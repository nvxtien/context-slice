# Java DI Constructor-Injection AST Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the one documented gap left by the "AST-ify enterprise extractors" roadmap: migrate `dependency-injection.ts`'s constructor-injection detection from a raw text regex to `SymbolRecord.annotations`, fixing a confirmed bug where `@Autowired`/`@Inject` mentioned in a constructor-body comment produces a false `INJECTS_DEPENDENCY` relation.

**Architecture:** One line changes inside `extractDependencyInjection`'s constructor loop: the `annotated` check moves from a regex scan of `ctor.source` to a `ctor.annotations` membership check (constructors already carry AST-parsed `.annotations`, populated identically to fields/methods — this migration only needed someone to use it). No extraction regex is needed afterward since this annotation never carried attribute values in this code path.

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test`), tree-sitter-java-backed `parseJava`.

**Spec:** `docs/superpowers/specs/2026-10-01-java-di-constructor-ast-migration-design.md`

## Global Constraints

- The constructor-gate check recognizes only `{Autowired, Inject}` — NOT the broader `INJECT_ANNOTATIONS` set (`Autowired, Inject, Resource`) used by the field/method loops. This matches today's exact regex scope (`@(?:Autowired|Inject)`); `@Resource` is not a legal constructor annotation in Spring, so this is preserving existing correct behavior, not narrowing it.
- Do not touch `firstParenGroup()`, `splitTopLevel()`, `parseDeclaration()`, `relation()`, `QUALIFIER_RE`, `STEREOTYPES`, `INJECT_ANNOTATIONS`, the field-injection loop, the setter-injection loop, `resolveBeanType()`, or `resolveDependencyRelations()`.
- Reuse the file's existing local `bareName()` helper (already defined at the top of `dependency-injection.ts`) — do not add a second copy or import one from elsewhere.
- The `stereotyped` check and the `seen`-based constructor dedup are unchanged — only the `annotated` line's right-hand side changes.
- Full test suite runs must exclude the four pre-existing hang-prone files: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`. In a git worktree, `tests/cli.test.ts` and `tests/package-metadata.test.ts` additionally fail fast with 6 known pre-existing failures (missing `node_modules` in the worktree) — always expected, never new.
- `sourceSymbolId: ctor.id` (via `relation(ctor, ...)`) must stay attributed to the constructor symbol, unchanged from current code.
- The benchmark script for this file is `npm run benchmark:v14-phase2` (maps to `tsx benchmarks/v1.4-phase2-dependency-injection.ts`, report `benchmarks/results/v1.4-phase2-dependency-injection.{json,md}`) — note the script-name number does NOT match this roadmap's own phase numbering; verified directly against `package.json`, not assumed.

## Review Focus

- A constructor with `@Autowired`/`@Inject` mentioned only in its body comment (not a real annotation) must produce NO relation — Task 1's new test pins this (the confirmed bug fix).
- A genuinely-annotated constructor on a plain (non-stereotyped) class must still produce a relation — Task 1's new test pins this (regression pin for the true-positive path, proving the fix doesn't also break real detection).
- A fully-qualified `@org.springframework.beans.factory.annotation.Autowired` constructor must still be detected — Task 1's new test pins this (parity with the field/method loops' existing qualified-name coverage).
- A stereotyped class's UNANNOTATED constructor must still produce a relation via the `stereotyped` path alone (this is existing, already-passing behavior via the untouched `stereotyped` check — verify the existing test(s) covering this still pass, no new test needed).
- Real-repo benchmark numbers must not regress — Task 2 pins this via `npm run benchmark:v14-phase2`.

---

### Task 1: Migrate the constructor-injection `annotated` check to `SymbolRecord.annotations`

**Files:**
- Modify: `src/languages/java/enterprise/dependency-injection.ts`
- Test: `tests/java-enterprise-dependency-injection.test.ts`

**Interfaces:**
- Consumes: `SymbolRecord.annotations` for `kind: "constructor"` symbols — already populated by `parseJava` (confirmed in `src/parser/java-parser.ts`'s `constructorSymbol()`, identical mechanism to fields/methods).
- Produces: no interface change — `extractDependencyInjection`'s signature and return shape are untouched.

- [ ] **Step 1: Write the failing test for the comment false-positive**

The file's actual helper (confirmed by reading `tests/java-enterprise-dependency-injection.test.ts:7-15`) is:

```ts
function relationsFor(source: string, filePath = "src/main/java/OrderService.java") {
  const { symbols } = parseJava(filePath, source);
  return { symbols, relations: resolved(symbols, filePath, source) };
}
```

i.e. single-source-string, not the multi-file-map shape some other test files in this codebase use. Use it exactly as the existing tests do (see e.g. the existing `"@Autowired inside a comment produces no relation"` test at line 154, which covers a FIELD-level comment, not a constructor-body one — this task's new test is a distinct case, not a duplicate).

Add this test (placement: alongside the file's other constructor-injection tests, e.g. near `"non-stereotyped class with an @Autowired constructor resolves, once"` around line 238):

```ts
test("@Autowired mentioned only in a constructor body comment produces no relation", () => {
  const source = `
class Bar {}
class Foo {
    Foo(Bar b) {
        // note: @Autowired on Foo(Bar) in subclass requires this constructor to exist
        this.b = b;
    }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Foo.java");
  const ctor = symbols.find((s) => s.kind === "constructor")!;
  assert.ok(!relations.some((r) => r.sourceSymbolId === ctor.id), "a comment mentioning @Autowired must not trigger constructor injection");
});
```

- [ ] **Step 2: Write the two regression-pin tests**

```ts
test("a genuinely @Autowired constructor on a plain class still produces a relation", () => {
  const source = `
class Bar {}
class Foo {
    @Autowired
    Foo(Bar b) { this.b = b; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Foo.java");
  const ctor = symbols.find((s) => s.kind === "constructor")!;
  const rel = relations.find((r) => r.sourceSymbolId === ctor.id)!;
  assert.ok(rel, "a real @Autowired constructor must still produce a relation");
  assert.equal(rel.targetLabel, "Bar");
});

test("a fully-qualified @Autowired constructor is still detected", () => {
  const source = `
class Bar {}
class Foo {
    @org.springframework.beans.factory.annotation.Autowired
    Foo(Bar b) { this.b = b; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Foo.java");
  const ctor = symbols.find((s) => s.kind === "constructor")!;
  const rel = relations.find((r) => r.sourceSymbolId === ctor.id)!;
  assert.ok(rel, "a fully-qualified @Autowired constructor must still produce a relation");
});
```

- [ ] **Step 3: Run the new tests to verify the first one fails against current code**

Run: `npx tsx --test tests/java-enterprise-dependency-injection.test.ts`

Expected: the comment-false-positive test FAILS (the bug reproduces — current code finds the `Foo(` text in the comment and produces a false relation). The two regression-pin tests are expected to already PASS against current code (the old regex happens to work for the true-positive and qualified-name cases too) — this is fine, they become permanent pins once Step 4 replaces the mechanism deliberately.

- [ ] **Step 4: Implement the fix**

In `src/languages/java/enterprise/dependency-injection.ts`, inside `extractDependencyInjection`'s constructor loop, replace:

```ts
const annotated = new RegExp(`@(?:Autowired|Inject)\\b[\\s\\S]*?\\b${ctor.name}\\s*\\(`).test(ctor.source);
```

with:

```ts
const annotated = ctor.annotations.some((a) => bareName(a) === "Autowired" || bareName(a) === "Inject");
```

No other lines in this file change.

- [ ] **Step 5: Run the full dependency-injection test file to verify everything passes**

Run: `npx tsx --test tests/java-enterprise-dependency-injection.test.ts`

Expected: all tests (existing + 3 new) PASS.

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`

Expected: PASS, with only the 6 known pre-existing worktree-environment failures (if running in a worktree) — no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/languages/java/enterprise/dependency-injection.ts tests/java-enterprise-dependency-injection.test.ts
git commit -m "feat(java): detect constructor @Autowired/@Inject via AST symbols"
```

---

### Task 2: Re-run the real-repo benchmark and record results

**Files:**
- Modify (regenerated, not hand-edited): `benchmarks/results/v1.4-phase2-dependency-injection.json`
- Modify (regenerated, not hand-edited, only if content actually changed — the benchmark script may only write the `.json`; confirm by checking the script's own `writeFileSync` calls before assuming the `.md` needs touching): `benchmarks/results/v1.4-phase2-dependency-injection.md`

**Interfaces:**
- Consumes: the Task 1 fix (already committed).
- Produces: updated benchmark report compared against the currently-committed baseline.

- [ ] **Step 1: Record current committed numbers for comparison**

Run: `git show HEAD:benchmarks/results/v1.4-phase2-dependency-injection.md | head -40` (or inspect the committed `.json` directly if the `.md` turns out to be a hand-maintained narrative log mixing stale historical numbers, as Phase 4b's Task 2 found for a different report file — check before trusting a `grep` over the `.md`).

- [ ] **Step 2: Run the benchmark**

Run: `npm run benchmark:v14-phase2`

- [ ] **Step 3: Compare against baseline**

The `INJECTS_DEPENDENCY`-relevant recall/precision numbers must be equal or better than baseline, never worse. "Equal" is a fully expected, acceptable outcome per the spec. If WORSE: STOP, do not commit, investigate — this fix's scope is narrow enough that a regression here almost certainly means a real implementation bug, not a stale benchmark oracle.

- [ ] **Step 4: Commit the regenerated report**

```bash
git add benchmarks/results/v1.4-phase2-dependency-injection.json
# add the .md too, only if Step 1 found the script actually (re)writes it and its content changed
git commit -m "test(java): regenerate Phase 2 dependency-injection benchmark report"
```

Commit even if numbers are byte-identical to baseline — the regenerated report is the evidence the acceptance criterion was checked.

---

### Task 3: Write the follow-up summary

**Files:**
- Create: `docs/superpowers/plans/2026-10-01-java-di-constructor-ast-migration-summary.md`

**Interfaces:**
- Consumes: Task 1's commit (test evidence), Task 2's benchmark comparison.
- Produces: a short follow-up note per the spec's Definition of Done item 4.

- [ ] **Step 1: Write the summary document**

Create `docs/superpowers/plans/2026-10-01-java-di-constructor-ast-migration-summary.md` with this structure (fill in the bracketed evidence from Tasks 1-2's actual results):

```markdown
# Java DI Constructor-Injection AST Migration Complete

**Spec:** `docs/superpowers/specs/2026-10-01-java-di-constructor-ast-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-10-01-java-di-constructor-ast-migration.md`

## What changed

`dependency-injection.ts`'s constructor-injection gate now checks
`SymbolRecord.annotations` for `Autowired`/`Inject` instead of running a
text regex over the constructor's own source (body included). No
extraction regex was needed — this annotation never carried attribute
values in this code path, so the fix is a straight membership check.

## Bug fixed

A `@Autowired`/`@Inject` mentioned inside a constructor body comment
previously produced a false `INJECTS_DEPENDENCY` relation on an
otherwise-plain (non-Spring-managed) class. RED test (Task 1, commit
`[hash]`) confirmed the bug reproduces via the existing code; GREEN after
the fix. [State whether the real-repo benchmark corpus happened to
contain this pattern — expected: no.]

## Real-repo benchmark result

[Task 2's before/after numbers for the relevant metric.]

## Roadmap status

This closes the one residual gap flagged by Phase 4b's final
whole-branch review. All five enterprise extractors' primary
relationship-annotation and dependency-injection detection paths —
including constructor injection, which predates the "AST-ify enterprise
extractors" roadmap itself — now use AST-derived `SymbolRecord.annotations`
rather than comment-unaware text regexes.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-01-java-di-constructor-ast-migration-summary.md
git commit -m "docs: summarize Java DI constructor-injection AST migration, gap closed"
```
