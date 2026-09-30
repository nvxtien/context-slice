# Java Spring MVC AST Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `spring-mvc.ts`'s regex-based mapping-annotation DETECTION with direct use of `SymbolRecord.annotations` (AST-derived), deleting `matchIsInsideLineComment()` entirely since AST-based detection can never mistake a comment for a real annotation. Argument-value extraction (the mapping annotation's path text) keeps a narrower, safer regex — now only ever invoked after the AST has already confirmed the specific annotation is real.

**Architecture:** `extractSpringMvcRelations`'s method/class mapping checks switch from `header(x).match(MAPPING_RE)` (which did BOTH detection and extraction in one step) to two separate steps: `x.annotations.map(bareName).find(name => name in MAPPING_ANNOTATIONS)` for detection, then `header(x).match(mappingArgsRegex(confirmedName))` (a new per-annotation-name regex, replacing the old combined `MAPPING_RE`) for extraction only. `resolvePath()`, `joinPaths()`, `describeAnnotation()`, `header()`, `CONST_RE_TEMPLATE` are all reused unchanged.

**Tech Stack:** TypeScript (ESM `.js` imports), `npx tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-java-spring-mvc-ast-migration-design.md`

## Global Constraints

- Detection of "does this method/class have a mapping annotation" must use `SymbolRecord.annotations` exclusively — never a text-matching regex.
- Argument-value extraction (`resolvePath`'s `rawInside` input) may still use regex, but ONLY targeting the specific annotation name `.annotations` already confirmed is present — never a generic multi-name pattern that could match the wrong annotation.
- `matchIsInsideLineComment` must be confirmed dead (grepped, zero remaining references) and deleted — this is the whole point of the migration (AST detection makes it structurally unnecessary).
- `MAPPING_RE` (the old combined multi-name regex) is replaced by a new `mappingArgsRegex(name: string): RegExp` function that builds a single-name pattern — do not keep both; `MAPPING_RE`'s only remaining callers are being replaced, so it becomes dead code too and must be removed alongside `MAPPING_NAMES` (which existed only to build `MAPPING_RE`).
- No change to `resolvePath()`, `joinPaths()`, `describeAnnotation()`, `header()`, `CONST_RE_TEMPLATE`, `PathResolution`, or `MAPPING_ANNOTATIONS`'s own shape/values.
- No change to any other enterprise extractor file, `src/parser/java-parser.ts`, or `src/languages/java.ts`.
- Existing test file `tests/java-enterprise-spring-mvc.test.ts` (and any composition/fixture tests referencing Spring MVC) must pass UNCHANGED — no existing test may be edited. In particular, the two existing tests exercising the comment scenarios (`"a non-controller class with an annotation-shaped string in a comment produces no relation"` and `"a real handler preceded by an ordinary explanatory comment on a previous line is still extracted"`) passing UNCHANGED is the actual proof that AST-based detection handles both cases correctly without the deleted function.
- Commit messages: short, single-line, imperative, no Co-Authored-By trailer (repo convention — every commit on `main` follows this).
- Test commands must exclude the four hang-prone files documented in every prior plan's own SDD ledger on this codebase: `tests/mcp-stdio.test.ts`, `tests/rust-product-surface.test.ts`, `tests/typescript.test.ts`, `tests/workflow-benchmark.test.ts` — never run plain `npm test`.
- Real-repository benchmark acceptance bar: `benchmark:v14-phase1` must be equal or better than currently committed, never worse. No bug was found in the pre-migration investigation of this file, so "equal" is a fully expected, acceptable outcome (unlike Phase 1, which found and fixed real bugs).

## Review Focus

1. **`mappingArgsRegex(name)` accidentally matching a DIFFERENT annotation's text than the one `.annotations` confirmed** — if a method has multiple stacked annotations and the regex isn't properly anchored to the specific confirmed name, it could extract the wrong argument text. Since the regex is built per-name (`@${name}(?:\\(([^)]*)\\))?`), this should be structurally impossible if implemented correctly — but the task's own test suite should still include a case with a mapping annotation stacked alongside an unrelated annotation, to prove the extraction targets the right one.
2. **`.annotations` containing a fully-qualified mapping annotation name** (e.g. `@org.springframework.web.bind.annotation.GetMapping`) that `bareName()` must correctly reduce to `"GetMapping"` for the `in MAPPING_ANNOTATIONS` lookup to succeed — the same class of case Phase 1 already handled for DI annotations.
3. **The class-level check silently skipping evidence when `.annotations` says no class-level mapping exists but `header(parent)` would have matched something anyway** — must NOT fall back to the old regex-only behavior; a class with a mapping-annotation-SHAPED comment but no real class-level annotation must correctly produce zero class-level evidence, exercised by the existing (unchanged) `"a non-controller class with an annotation-shaped string in a comment produces no relation"` test.
4. **A bare mapping annotation with no parentheses at all** (`@GetMapping` with no arguments) — `mappingArgsRegex`'s argument group is optional, so `methodMatch?.[1]` must correctly come back `undefined` (not throw, not match wrong text), and `resolvePath(undefined, ...)` must correctly return `{ kind: "absent" }` exactly as it does today — an existing behavior that must not regress.
5. **`MAPPING_RE`/`MAPPING_NAMES` deletion leaving orphaned dead code or an unused import** — mechanical but easy to skip; verify via grep, not assumption.

---

### Task 1: Replace mapping-annotation detection with AST symbols (TDD)

**Files:**
- Modify: `src/languages/java/enterprise/spring-mvc.ts`
- Test: `tests/java-enterprise-spring-mvc.test.ts` (append new tests only — do not modify any existing test)

**Interfaces:**
- Consumes: `SymbolRecord.kind === "method"` / `"class"`, `.annotations: string[]` — already established since the original AST rewrite, no changes needed to `java-parser.ts`.
- Produces: `bareName(annotation: string): string` and `mappingArgsRegex(name: string): RegExp` — two new local functions in `spring-mvc.ts`. No exported names change; `extractSpringMvcRelations`'s registered-extractor contract is unchanged in shape.

- [ ] **Step 1: Write the failing tests.** Append to the END of `tests/java-enterprise-spring-mvc.test.ts` (do not touch any existing test in that file):

```ts
test("a multi-line mapping annotation argument is not lost", () => {
  const source = `
@RestController
class ReportController {
    @GetMapping(
        "/reports/summary"
    )
    String summary() { return "ok"; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/ReportController.java");
  const handler = symbols.find((s) => s.name === "summary")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET /reports/summary");
  assert.equal(route.confidence, "exact");
});

test("a mapping annotation stacked with an unrelated annotation still extracts the right argument", () => {
  const source = `
@RestController
class AuditedController {
    @Deprecated
    @GetMapping("/legacy/list")
    String legacyList() { return "[]"; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/AuditedController.java");
  const handler = symbols.find((s) => s.name === "legacyList")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET /legacy/list");
  assert.equal(route.confidence, "exact");
});

test("a fully-qualified mapping annotation name is still recognized", () => {
  const source = `
@RestController
class QualifiedController {
    @org.springframework.web.bind.annotation.GetMapping("/qualified")
    String q() { return "ok"; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/QualifiedController.java");
  const handler = symbols.find((s) => s.name === "q")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET /qualified");
  assert.equal(route.confidence, "exact");
});

test("a bare mapping annotation with no arguments produces a probable route with no path", () => {
  const source = `
@RestController
class BareController {
    @GetMapping
    String all() { return "[]"; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/BareController.java");
  const handler = symbols.find((s) => s.name === "all")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET");
  assert.equal(route.confidence, "probable");
});
```

- [ ] **Step 2: Run to verify RED.**

```
npx tsx --test tests/java-enterprise-spring-mvc.test.ts
```

Do not assume which of the 4 new tests currently fail — report the ACTUAL state honestly for each:
- The multi-line and stacked-annotation tests may ALREADY pass against the current `MAPPING_RE`-based code (its argument group already tolerates embedded newlines, matching Phase 1's own precedent for a similar regex; and `.match()` without a global flag finds the FIRST occurrence regardless of stacking order, which likely already works for the stacked case too). That's fine to report as-is — the test's value is pinning the behavior going forward under the new implementation.
- The fully-qualified-annotation-name test is the one most likely to be GENUINELY new coverage, since the current regex `@(${MAPPING_NAMES})` only matches the bare names literally — a fully-qualified `@org.springframework...GetMapping` would need the regex to match starting mid-string, which `.match()` without anchoring CAN do (regex isn't anchored to start), so this might also already pass. Report honestly either way.
- The bare-no-parens test is the most likely genuinely-informative one to trace through carefully, since it exercises the argument-group-optional path specifically.

- [ ] **Step 3: Add `bareName` and `mappingArgsRegex`, remove `MAPPING_RE`/`MAPPING_NAMES`.** In `src/languages/java/enterprise/spring-mvc.ts`, change:

```ts
const MAPPING_ANNOTATIONS: Record<string, string> = {
  RequestMapping: "REQUEST",
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};
const MAPPING_NAMES = Object.keys(MAPPING_ANNOTATIONS).join("|");
// Follows java-parser.ts's own annotationRe/typeRe/methodRe convention: raw regex over
// already-known symbol source slices, not a tokenizer.
const MAPPING_RE = new RegExp(`@(${MAPPING_NAMES})(?:\\(([^)]*)\\))?`);
const CONST_RE_TEMPLATE = (name: string) =>
  new RegExp(`(?:static\\s+final|final\\s+static)\\s+String\\s+${name}\\s*=\\s*"([^"]*)"`);
```

to:

```ts
const MAPPING_ANNOTATIONS: Record<string, string> = {
  RequestMapping: "REQUEST",
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};
const CONST_RE_TEMPLATE = (name: string) =>
  new RegExp(`(?:static\\s+final|final\\s+static)\\s+String\\s+${name}\\s*=\\s*"([^"]*)"`);

/** Strips a leading "@" and any dotted package prefix, e.g. "@org.springframework...GetMapping" -> "GetMapping". */
function bareName(annotation: string): string {
  return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}

/**
 * Matches ONE specific, already-AST-confirmed mapping annotation's own argument text.
 * Detection of WHICH annotation (if any) is present happens via SymbolRecord.annotations,
 * never via this regex — this only ever runs to extract an argument list for an annotation
 * name already known to be real, eliminating the false-positive risk a generic multi-name
 * scan over raw text would have (e.g. matching annotation-shaped text inside a comment).
 * The optional `(?:[\w.]+\.)?` prefix tolerates a fully-qualified annotation name (e.g.
 * "@org.springframework.web.bind.annotation.GetMapping(...)") the same way bareName()
 * already tolerates one for detection — without it, a qualified annotation would be
 * correctly DETECTED (via .annotations) but its argument text would never be found,
 * silently downgrading every qualified-annotation route to a path-less "probable" result
 * instead of the fully-resolved "exact" one it should get.
 */
function mappingArgsRegex(name: string): RegExp {
  return new RegExp(`@(?:[\\w.]+\\.)?${name}(?:\\(([^)]*)\\))?`);
}
```

- [ ] **Step 4: Delete `matchIsInsideLineComment` entirely.** Delete this whole function:

```ts
/**
 * Guards against a mapping-annotation-shaped match that is itself commented out on its own
 * physical line (e.g. "// example: @RequestMapping(...)") rather than a real annotation.
 *
 * parseJava's own leading-trivia scan absorbs starting from wherever an "@Word(...)"-shaped
 * token first appears, even inside a "//" comment — so a commented-out annotation's "//" prefix
 * is silently stripped OUT of symbol.source itself (confirmed by inspection: for
 * `// example: @RequestMapping("/fake")` the captured source begins at the "@", not the "//").
 * Checking the header text alone can therefore never see that stripped prefix. This instead maps
 * the match's position back to the REAL file (via symbol.range.startLine/startColumn plus the
 * newline count before the match within the header), and checks only THAT one physical source
 * line for a preceding "//" — not the symbol's leading trivia as a whole, since a real handler
 * can have an ordinary explanatory "//" comment on a PREVIOUS line (e.g. VisitController's
 * "// Spring MVC calls method ..." above a genuine @GetMapping) without the annotation itself
 * being "inside" a comment.
 */
function matchIsInsideLineComment(
  symbol: SymbolRecord,
  headerText: string,
  match: RegExpMatchArray,
  fullSource: string,
): boolean {
  const index = match.index ?? 0;
  const before = headerText.slice(0, index);
  const lastNewline = before.lastIndexOf("\n");
  const lineNumber = symbol.range.startLine + (before.match(/\n/g)?.length ?? 0);
  const column = lastNewline === -1 ? symbol.range.startColumn + index : index - lastNewline - 1;
  const fileLine = fullSource.split("\n")[lineNumber - 1] ?? "";
  return fileLine.slice(0, column).includes("//");
}
```

- [ ] **Step 5: Replace `extractSpringMvcRelations`'s detection logic.** Find:

```ts
  for (const method of symbols.filter((s) => s.kind === "method")) {
    const parent = classes.find((c) => c.id === method.parentId);
    const methodHeader = header(method);
    const methodMatch = methodHeader.match(MAPPING_RE);
    if (!methodMatch) continue; // not a handler: no annotation spam for non-mapped methods
    if (matchIsInsideLineComment(method, methodHeader, methodMatch, source)) continue; // commented-out annotation text, not real

    const httpMethod = MAPPING_ANNOTATIONS[methodMatch[1]];
    const classSourceForConstants = parent?.source ?? "";
    const methodResolution = resolvePath(methodMatch[2], classSourceForConstants);

    const evidence: string[] = [];
    let classMatch: RegExpMatchArray | null = null;
    if (parent) {
      const classHeader = header(parent);
      const candidate = classHeader.match(MAPPING_RE);
      if (candidate && !matchIsInsideLineComment(parent, classHeader, candidate, source)) {
        classMatch = candidate;
        evidence.push(describeAnnotation(classMatch[1], classMatch[2], "class", parent.name));
      }
    }
    evidence.push(describeAnnotation(methodMatch[1], methodMatch[2], "method", method.name));

    let confidence: EnterpriseRelationConfidence;
    let targetLabel: string | undefined;

    const classResolution: PathResolution = classMatch
      ? resolvePath(classMatch[2], classSourceForConstants)
      : { kind: "absent" };
```

Replace with:

```ts
  for (const method of symbols.filter((s) => s.kind === "method")) {
    const parent = classes.find((c) => c.id === method.parentId);
    const methodAnnotationName = method.annotations
      .map(bareName)
      .find((name) => name in MAPPING_ANNOTATIONS);
    if (!methodAnnotationName) continue; // not a handler: no annotation spam for non-mapped methods

    const httpMethod = MAPPING_ANNOTATIONS[methodAnnotationName];
    const methodMatch = header(method).match(mappingArgsRegex(methodAnnotationName));
    const classSourceForConstants = parent?.source ?? "";
    const methodResolution = resolvePath(methodMatch?.[1], classSourceForConstants);

    const evidence: string[] = [];
    let classAnnotationName: string | undefined;
    let classRawInside: string | undefined;
    if (parent) {
      classAnnotationName = parent.annotations.map(bareName).find((name) => name in MAPPING_ANNOTATIONS);
      if (classAnnotationName) {
        const classMatch = header(parent).match(mappingArgsRegex(classAnnotationName));
        classRawInside = classMatch?.[1];
        evidence.push(describeAnnotation(classAnnotationName, classRawInside, "class", parent.name));
      }
    }
    evidence.push(describeAnnotation(methodAnnotationName, methodMatch?.[1], "method", method.name));

    let confidence: EnterpriseRelationConfidence;
    let targetLabel: string | undefined;

    const classResolution: PathResolution = classAnnotationName
      ? resolvePath(classRawInside, classSourceForConstants)
      : { kind: "absent" };
```

The rest of the function (everything from `if (methodResolution.kind === "unresolved") {` through the closing `return relations;`) is UNCHANGED — do not modify it.

- [ ] **Step 6: Confirm no remaining references to the deleted symbols.**

```
grep -n "matchIsInsideLineComment\|MAPPING_RE\b\|MAPPING_NAMES" src/languages/java/enterprise/spring-mvc.ts
```

Expected: no output (all three fully removed).

- [ ] **Step 7: Run to verify GREEN.**

```
npx tsx --test tests/java-enterprise-spring-mvc.test.ts
```

Expected: every existing test in this file UNCHANGED, plus all 4 new tests, all passing.

- [ ] **Step 8: Run `tsc` to confirm no type errors.**

```
npx tsc --noEmit -p .
```

Expected: no errors.

- [ ] **Step 9: Run the broader scoped regression set:**

```
npx tsx --test tests/java-parser-ast-fields.test.ts tests/java-parser-ast-types.test.ts tests/java-parser-ast-methods.test.ts tests/java-*.test.ts tests/parser.test.ts tests/index.test.ts tests/composition.test.ts tests/enterprise-relation.test.ts tests/enterprise-relations-indexer.test.ts
```

Expected: every test passes.

- [ ] **Step 10: Commit.**

```bash
git add src/languages/java/enterprise/spring-mvc.ts tests/java-enterprise-spring-mvc.test.ts
git commit -m "feat(java): detect Spring MVC mapping annotations via AST symbols"
```

---

### Task 2: Real-repository regression verification

**Files:**
- Modify (only if numbers genuinely change): `benchmarks/results/v1.4-phase1-spring-mvc.{json,md}`

**Interfaces:** Consumes Task 1's completed migration. Produces the evidence that the migration causes no regression against the real-repository Spring MVC benchmark.

- [ ] **Step 1: Confirm the full suite is green**, using the corrected exclusion command:

```
npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")
```

Report the exact pass/fail counts. Expect the same pre-existing, unrelated failures documented in every prior plan's own SDD ledger (`tests/cli.test.ts`, `tests/package-metadata.test.ts` — both fail fast with ENOENT against a broken worktree-relative `node_modules/.bin/tsx` path) and zero NEW failures.

- [ ] **Step 2: Confirm real-repository checkouts are available** (copy from the main repository into this worktree if not already present, to avoid a network fetch — a lesson from every prior plan's own SDD ledger on this codebase):

```
npx tsx benchmarks/fetch-checkouts.ts
```

If this reports missing repositories and appears to hang or need network access, stop and report BLOCKED rather than waiting indefinitely — the controller should copy `benchmarks/checkouts/` from the main repository into this worktree first.

- [ ] **Step 3: Re-run `benchmark:v14-phase1`** (confirm the exact script name via `package.json` first — do not assume), comparing against the CURRENTLY COMMITTED numbers in `benchmarks/results/v1.4-phase1-spring-mvc.json`:

```
npm run benchmark:v14-phase1
```

Recall/precision numbers must be EQUAL OR BETTER than currently committed, never worse. If ANY number regresses, STOP — investigate the specific relation that changed and report explicitly. No bug was found in the pre-migration investigation of this file, so "equal" is a fully expected, acceptable outcome — do not manufacture an "improvement" narrative if none is actually observed.

- [ ] **Step 4: If the numbers genuinely changed**, regenerate the committed report file via the real script — leave it alone (`git diff` it, revert if only `generatedAt` changed) if the numbers are byte-identical.

- [ ] **Step 5: Run the full suite one final time** (same command as Step 1) → all green.

- [ ] **Step 6: Commit** (only if Step 4 produced a real change):

```bash
git add benchmarks/results/v1.4-phase1-spring-mvc.json benchmarks/results/v1.4-phase1-spring-mvc.md
git commit -m "chore(java): confirm Spring MVC benchmark parity after AST migration"
```

If Step 4 found no genuine change (numbers byte-identical), skip this commit entirely — there is nothing to commit for this task, and that is a valid, expected outcome (matching Phase 1's own Task 2 precedent); say so in your report rather than creating an empty or placeholder commit.

---

### Task 3: Follow-up note

**Files:**
- Create: `docs/superpowers/plans/2026-09-30-java-spring-mvc-ast-migration-summary.md`

- [ ] **Step 1: Write a short summary doc** covering: what changed (`spring-mvc.ts`'s mapping-annotation detection now uses `SymbolRecord.annotations` directly; `matchIsInsideLineComment`/`MAPPING_RE`/`MAPPING_NAMES` deleted, replaced by `bareName()`/`mappingArgsRegex()`), that this phase found no bug (unlike Phase 1) and was primarily a simplification/consistency migration, what was verified (Task 2's real benchmark numbers — cite them exactly, don't invent or round), and name Phase 3 (either `@Transactional` or JPA/Spring Data — this plan does not decide which) as the next sub-project, to be brainstormed and specced separately.
- [ ] **Step 2: Confirm the tree is clean and all tests pass** (same corrected full-suite command as Task 2 Step 1).
- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/plans/2026-09-30-java-spring-mvc-ast-migration-summary.md
git commit -m "docs: summarize Java Spring MVC AST migration, Phase 2 complete"
```

## Self-review notes

- **Spec coverage:** the spec's Architecture section (detection-via-annotations, `mappingArgsRegex`'s narrowed extraction role, the defensive-but-hard-to-test edge case, the `bareName` duplication decision) maps to Task 1 Steps 3-5; the "existing comment tests must pass unchanged" requirement maps to Task 1's own Global Constraints and Step 7; the multi-line test maps to Task 1 Step 1; Acceptance items 1-3 map to Task 1's steps, item 4 (benchmark) maps to Task 2, item 5 (follow-up note) maps to Task 3.
- **Placeholder scan:** no TBD/TODO; every test and code block in Task 1 is complete, runnable code.
- **Type consistency:** `bareName`/`mappingArgsRegex`'s signatures match how they're called in Step 5's replacement code exactly; `MAPPING_ANNOTATIONS`'s `Record<string, string>` shape is unchanged, so `name in MAPPING_ANNOTATIONS` (a plain-object `in` check, matching the file's existing `MAPPING_ANNOTATIONS[methodMatch[1]]`-style indexing convention) type-checks correctly against it — verified against the actual current file content before writing this plan, not assumed.
- **Review Focus:** all five items (wrong-annotation-match risk, fully-qualified-name stripping, class-level comment-false-positive proof via the unchanged existing test, bare-no-parens handling, dead-code cleanup) each map to a specific step or test in Task 1, confirmed line-by-line against the plan text above.
