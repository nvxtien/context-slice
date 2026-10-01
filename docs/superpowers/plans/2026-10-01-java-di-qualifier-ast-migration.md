# Java DI `@Qualifier` Evidence AST-Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a confirmed bug in `dependency-injection.ts`'s setter-injection loop where a `@Qualifier("...")` mentioned only in a method body comment produces fabricated qualifier evidence on an otherwise-correctly-detected `INJECTS_DEPENDENCY` relation.

**Architecture:** Gate the setter loop's `QUALIFIER_RE` match against `method.source` behind a `method.annotations` check for a bare `"Qualifier"` name — if the method has no real `@Qualifier` annotation, the regex is never run against its (body-including) source, so no comment can fabricate a qualifier value. The field call site and the constructor-parameter call site are confirmed out of scope (field: empirically safe, no body/trailing-comment inclusion in `.source`; constructor parameter: no per-parameter `SymbolRecord` exists to gate against).

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test`), tree-sitter-java-backed `parseJava`.

**Spec:** `docs/superpowers/specs/2026-10-01-java-di-qualifier-ast-migration-design.md`

## Global Constraints

- Only the setter-injection loop's `qualifier` line changes. Do not touch the field loop's `decl.qualifier ??= field.source.match(QUALIFIER_RE)?.[1];` (line 125) or `parseDeclaration()`'s constructor-parameter `QUALIFIER_RE` match (line 57) — both are confirmed out of scope by the spec's own investigation (empirically safe / no AST alternative, respectively).
- `QUALIFIER_RE`'s own pattern is unchanged.
- Reuse the file's existing local `bareName()` helper — do not add a new one.
- Do not touch `STEREOTYPES`, `INJECT_ANNOTATIONS`, the constructor-injection `annotated` check, `firstParenGroup()`, `splitTopLevel()`, `relation()`, `resolveBeanType()`, or `resolveDependencyRelations()`.
- Full test suite runs must exclude the four pre-existing hang-prone files: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`. In a git worktree, `tests/cli.test.ts` and `tests/package-metadata.test.ts` additionally fail fast with 6 known pre-existing failures — always expected, never new.
- The benchmark script for this file is `npm run benchmark:v14-phase2` (maps to `tsx benchmarks/v1.4-phase2-dependency-injection.ts`, report `benchmarks/results/v1.4-phase2-dependency-injection.{json,md}`) — the script only writes the `.json` (single `writeFileSync` call, confirmed in the prior gap-closure branch's Task 2); do not assume the `.md` needs hand-editing.

## Review Focus

- A `@Qualifier(...)` mentioned only in a setter method body comment, with no real `@Qualifier` annotation on the method, must produce a relation WITHOUT a `@Qualifier(...)` evidence entry — Task 1's new test pins this (the confirmed bug fix). The relation itself must still exist (proving detection isn't also broken).
- A genuinely `@Qualifier("x")`-annotated setter must still have `"x"` correctly extracted — Task 1's new test pins this (regression pin for the true-positive path).
- The field and constructor-parameter `@Qualifier` paths must continue behaving exactly as before (untouched code, but existing tests covering them — if any — must still pass unchanged).
- Real-repo benchmark numbers must not regress — Task 2 pins this.

---

### Task 1: Gate setter-injection qualifier extraction behind `method.annotations`

**Files:**
- Modify: `src/languages/java/enterprise/dependency-injection.ts`
- Test: `tests/java-enterprise-dependency-injection.test.ts`

**Interfaces:**
- Consumes: `SymbolRecord.annotations` for `kind: "method"` symbols (already populated by `parseJava`).
- Produces: no interface change — `extractDependencyInjection`'s signature and return shape are untouched.

- [ ] **Step 1: Write the failing test for the comment false-evidence bug**

Read `tests/java-enterprise-dependency-injection.test.ts` first to confirm the exact `relationsFor(source, filePath)` helper signature and match existing conventions (as the prior DI-constructor task also had to do — do not assume a different shape).

Add this test, placed alongside the file's other setter-injection tests (near `"explicit setter injection attributes to the setter method symbol"`):

```ts
test("@Qualifier mentioned only in a setter body comment produces no qualifier evidence", () => {
  const source = `
class Bar {}
class Foo {
    @Autowired
    public void setBar(Bar bar) {
        // old wiring used @Qualifier("legacy") here, now removed
        this.bar = bar;
    }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Foo.java");
  const method = symbols.find((s) => s.kind === "method" && s.name === "setBar")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.ok(rel, "the real @Autowired setter must still produce a relation");
  assert.ok(!rel.evidence.some((e) => e.includes("@Qualifier")), "a comment-only @Qualifier must not appear in evidence");
});
```

- [ ] **Step 2: Write the regression-pin test**

```ts
test("a genuinely @Qualifier-annotated setter still has its value extracted", () => {
  const source = `
class Bar {}
class Foo {
    @Autowired
    @Qualifier("primary")
    public void setBar(Bar bar) {
        this.bar = bar;
    }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Foo.java");
  const method = symbols.find((s) => s.kind === "method" && s.name === "setBar")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.ok(rel.evidence.some((e) => e.includes('@Qualifier("primary")')), "a real @Qualifier must still be extracted");
});
```

- [ ] **Step 3: Run the new tests to verify the first one fails against current code**

Run: `npx tsx --test tests/java-enterprise-dependency-injection.test.ts`

Expected: the comment-false-evidence test FAILS (current code picks up the comment's `@Qualifier("legacy")` text as evidence). The regression-pin test is expected to already PASS against current code — fine, it becomes a permanent pin once Step 4 replaces the mechanism deliberately.

- [ ] **Step 4: Implement the fix**

In `src/languages/java/enterprise/dependency-injection.ts`, inside the setter-injection loop (`extractDependencyInjection`'s third loop over `own.filter((s) => s.kind === "method")`), replace:

```ts
const qualifier = method.source.match(QUALIFIER_RE)?.[1];
```

with:

```ts
const hasQualifier = method.annotations.some((a) => bareName(a) === "Qualifier");
const qualifier = hasQualifier ? method.source.match(QUALIFIER_RE)?.[1] : undefined;
```

No other lines in this file change.

- [ ] **Step 5: Run the full dependency-injection test file to verify everything passes**

Run: `npx tsx --test tests/java-enterprise-dependency-injection.test.ts`

Expected: all tests (existing + 2 new) PASS.

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`

Expected: PASS, with only the 6 known pre-existing worktree-environment failures (if running in a worktree) — no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/languages/java/enterprise/dependency-injection.ts tests/java-enterprise-dependency-injection.test.ts
git commit -m "fix(java): gate setter @Qualifier evidence extraction on AST annotations"
```

---

### Task 2: Re-run the real-repo benchmark and record results

**Files:**
- Modify (regenerated, not hand-edited): `benchmarks/results/v1.4-phase2-dependency-injection.json`

**Interfaces:**
- Consumes: the Task 1 fix (already committed).
- Produces: updated benchmark report compared against the currently-committed baseline.

- [ ] **Step 1: Record current committed numbers for comparison**

Run: `git show HEAD:benchmarks/results/v1.4-phase2-dependency-injection.json | head -40` (use the `.json` directly as the authoritative baseline — confirmed in the prior branch that the `.md` is not script-regenerated).

- [ ] **Step 2: Run the benchmark**

Run: `npm run benchmark:v14-phase2`

- [ ] **Step 3: Compare against baseline**

The relevant recall/precision numbers must be equal or better than baseline, never worse. "Equal" is a fully expected, acceptable outcome. If WORSE: STOP, do not commit, investigate — this fix's scope is narrow enough that a regression here almost certainly means a real implementation bug.

- [ ] **Step 4: Commit the regenerated report**

```bash
git add benchmarks/results/v1.4-phase2-dependency-injection.json
git commit -m "test(java): regenerate Phase 2 dependency-injection benchmark report"
```

Commit even if numbers are byte-identical to baseline.

---

### Task 3: Write the follow-up summary

**Files:**
- Create: `docs/superpowers/plans/2026-10-01-java-di-qualifier-ast-migration-summary.md`

**Interfaces:**
- Consumes: Task 1's commit (test evidence), Task 2's benchmark comparison.
- Produces: a short follow-up note per the spec's Definition of Done item 4.

- [ ] **Step 1: Write the summary document**

Create `docs/superpowers/plans/2026-10-01-java-di-qualifier-ast-migration-summary.md` with this structure (fill in the bracketed evidence from Tasks 1-2's actual results):

```markdown
# Java DI `@Qualifier` Evidence AST-Gating Complete

**Spec:** `docs/superpowers/specs/2026-10-01-java-di-qualifier-ast-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-10-01-java-di-qualifier-ast-migration.md`

## What changed

`dependency-injection.ts`'s setter-injection loop now gates its
`@Qualifier` evidence extraction on `method.annotations` before matching
`QUALIFIER_RE` against `method.source`. The field and constructor-parameter
`@Qualifier` call sites were investigated and confirmed out of scope: the
field path is empirically safe (`.source` excludes body/trailing
comments), and the constructor-parameter path has no per-parameter
`SymbolRecord` to gate against.

## Bug fixed

A `@Qualifier("...")` mentioned only in a setter method body comment
previously produced fabricated qualifier evidence on an otherwise-correct
`INJECTS_DEPENDENCY` relation (the relation itself was never false — only
its evidence was wrong). RED test (Task 1, commit `[hash]`) confirmed the
bug reproduces via the existing code; GREEN after the fix.

## Real-repo benchmark result

[Task 2's before/after numbers.]

## Status

This closes the last Minor item flagged by the DI constructor-injection
gap-closure branch's final review. `dependency-injection.ts` now has no
remaining text-based path that can fabricate relation evidence or produce
a false relation from comment text, except the two explicitly accepted
limitations: constructor-parameter `@Qualifier` extraction (no AST
alternative exists) and the Phase 1 multi-declarator-field divergence.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-01-java-di-qualifier-ast-migration-summary.md
git commit -m "docs: summarize Java DI @Qualifier evidence AST-gating fix"
```
