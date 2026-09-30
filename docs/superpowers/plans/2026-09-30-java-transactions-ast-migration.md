# Java @Transactional AST Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `transactions.ts`'s regex-based `@Transactional` DETECTION with direct use of `SymbolRecord.annotations` (AST-derived), deleting `matchIsInsideLineComment()` entirely (identical disposition to Phase 2's `spring-mvc.ts` deletion, for the identical reason). Attribute-value extraction (`readOnly`, `propagation`, etc.) keeps a narrower, safer regex — now only ever invoked after the AST has already confirmed `@Transactional` is real, with a proactive fix for fully-qualified annotation names (applying Phase 2's own self-caught lesson before, not after, implementation).

**Architecture:** `extractTransactionRelations`'s method-level check switches from `header(method).match(TRANSACTIONAL_RE)` (which did BOTH detection and extraction) to two separate steps: `method.annotations.some(a => bareName(a) === "Transactional")` for detection, then `header(method).match(transactionalArgsRegex())` (a new qualified-name-tolerant regex replacing `TRANSACTIONAL_RE`) for extraction only. `header()`, `splitTopLevel()`, `KEPT_ATTRS`, and everything from `const rawArgs = match[1];`'s downstream logic onward are reused unchanged.

**Tech Stack:** TypeScript (ESM `.js` imports), `npx tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-java-transactions-ast-migration-design.md`

## Global Constraints

- Detection of "does this method have `@Transactional`" must use `SymbolRecord.annotations` exclusively — never a text-matching regex.
- Attribute-value extraction (`rawArgs`) may still use regex, but ONLY targeting `@Transactional` specifically (this file has only one annotation to match, unlike Phase 2's six), and only ever after `.annotations` has confirmed it's present.
- `matchIsInsideLineComment` must be confirmed dead (grepped, zero remaining references) and deleted — this is the whole point of the migration.
- `TRANSACTIONAL_RE` is replaced by a new `transactionalArgsRegex(): RegExp` function that includes the qualified-name-tolerant `(?:[\w.]+\.)?` prefix (applying the exact lesson Phase 2's own self-review learned, proactively, not after an implementer rediscovers it) — do not keep both; `TRANSACTIONAL_RE`'s only caller is being replaced, so it becomes dead code too.
- No change to `header()`, `splitTopLevel()`, `KEPT_ATTRS`, or `extractTransactionRelations`'s confidence/targetLabel computation logic (everything from `const rawArgs = match[1];`'s existing early-exit checks (`if (rawArgs === undefined || rawArgs.trim() === "") continue;`) onward stays untouched — only how `rawArgs` itself is OBTAINED changes).
- No class-level `@Transactional` handling is added — out of scope, this extractor has never handled it and this migration does not add new scope.
- No change to any other enterprise extractor file, `src/parser/java-parser.ts`, or `src/languages/java.ts`.
- Existing test file `tests/java-enterprise-transactions.test.ts` must pass UNCHANGED — no existing test may be edited. In particular, the existing `"@Transactional inside a comment produces no relation"` test passing UNCHANGED is the actual proof that AST-based detection handles the comment case correctly without the deleted function.
- Commit messages: short, single-line, imperative, no Co-Authored-By trailer (repo convention — every commit on `main` follows this).
- Test commands must exclude the four hang-prone files documented in every prior plan's own SDD ledger on this codebase: `tests/mcp-stdio.test.ts`, `tests/rust-product-surface.test.ts`, `tests/typescript.test.ts`, `tests/workflow-benchmark.test.ts` — never run plain `npm test`.
- Real-repository benchmark acceptance bar: `benchmark:v14-phase3` (confirmed via `package.json` to map to `tsx benchmarks/v1.4-phase3-transactions.ts`, report file `benchmarks/results/v1.4-phase3-transactions.{json,md}` — verified directly, not assumed, avoiding Phase 2's own file-naming mistake) must be equal or better than currently committed, never worse. No bug was found in the pre-migration investigation of this file, so "equal" is a fully expected, acceptable outcome.

## Review Focus

1. **`transactionalArgsRegex()` accidentally matching a DIFFERENT method's or a stray annotation-shaped comment's text** — since this file has only ONE annotation name to match (unlike Phase 2's ambiguity risk across 6 names), the main residual risk is the SAME pre-existing, unchanged, out-of-scope issue Phase 2's own final review found and declined to fix (an annotation ARGUMENT string that itself contains annotation-shaped text) — not new to this migration, no new test needed for it, but worth naming here so nobody mistakes it for a regression if noticed later.
2. **`.annotations` containing a fully-qualified `@Transactional`** (e.g. `@org.springframework.transaction.annotation.Transactional`) that `bareName()` must correctly reduce to `"Transactional"` for the detection check to succeed, AND that `transactionalArgsRegex()` must correctly match for extraction — this is the one test explicitly expected to be genuinely new coverage (the old `TRANSACTIONAL_RE` could never detect this annotation shape at all).
3. **A bare `@Transactional` or empty-parens `@Transactional()`** — both existing behaviors (no relation produced) must not regress; `transactionalArgsRegex()`'s argument group is optional, so `match?.[1]` must correctly come back `undefined` for bare, and the empty-string check (`rawArgs.trim() === ""`) must correctly catch the empty-parens case exactly as it does today.
4. **A multi-line `@Transactional(...)` attribute list** — the existing `[^]*?` body pattern already tolerates embedded newlines (non-greedy, matches up to the first `)`); this should already work, but is worth an explicit pinning test now that detection has moved to AST.
5. **`TRANSACTIONAL_RE`/`matchIsInsideLineComment` deletion leaving orphaned dead code** — mechanical but easy to skip; verify via grep, not assumption. Also confirm `header()` and `splitTopLevel()` remain genuinely used (they should — `header()` for extraction, `splitTopLevel()` for attribute-list splitting, both unchanged).

---

### Task 1: Replace `@Transactional` detection with AST symbols (TDD)

**Files:**
- Modify: `src/languages/java/enterprise/transactions.ts`
- Test: `tests/java-enterprise-transactions.test.ts` (append new tests only — do not modify any existing test)

**Interfaces:**
- Consumes: `SymbolRecord.kind === "method"`, `.annotations: string[]` — already established since the original AST rewrite, no changes needed to `java-parser.ts`.
- Produces: `bareName(annotation: string): string` and `transactionalArgsRegex(): RegExp` — two new local functions in `transactions.ts`. No exported names change; `extractTransactionRelations`'s registered-extractor contract is unchanged in shape.

- [ ] **Step 1: Write the failing tests.** Append to the END of `tests/java-enterprise-transactions.test.ts` (do not touch any existing test in that file):

```ts
test("a fully-qualified @Transactional annotation still extracts its attributes", () => {
  const source = `
class PaymentService {
    @org.springframework.transaction.annotation.Transactional(readOnly = true)
    void charge() {}
}
`;
  const { symbols, relations } = relationsFor(source);
  const method = symbols.find((s) => s.name === "charge")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.equal(rel.targetLabel, "readOnly=true");
  assert.equal(rel.confidence, "exact");
});

test("a multi-line @Transactional argument list is not lost", () => {
  const source = `
class PaymentService {
    @Transactional(
        readOnly = true,
        timeout = 30
    )
    void charge() {}
}
`;
  const { symbols, relations } = relationsFor(source);
  const method = symbols.find((s) => s.name === "charge")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.equal(rel.targetLabel, "readOnly=true, timeout=30");
  assert.equal(rel.confidence, "exact");
});
```

- [ ] **Step 2: Run to verify RED.**

```
npx tsx --test tests/java-enterprise-transactions.test.ts
```

Do not assume which of the 2 new tests currently fail — report the ACTUAL state honestly:
- The fully-qualified-annotation test is the one expected to be GENUINELY red, since the current `TRANSACTIONAL_RE` (`/@Transactional(?:\(([^]*?)\))?/`) requires `@` immediately followed by the literal text `Transactional`, which never appears in `@org.springframework...Transactional` (the `@` is only before `org`).
- The multi-line test may ALREADY pass against the current regex (its `[^]*?` body already tolerates embedded newlines, matching Phase 1/2's own precedent for similarly-shaped patterns). That's fine to report as-is.

- [ ] **Step 3: Add `bareName` and `transactionalArgsRegex`, remove `TRANSACTIONAL_RE`.** In `src/languages/java/enterprise/transactions.ts`, change:

```ts
const TRANSACTIONAL_RE = /@Transactional(?:\(([^]*?)\))?/;
const KEPT_ATTRS = new Set(["readOnly", "propagation", "isolation", "rollbackFor", "noRollbackFor", "timeout"]);
```

to:

```ts
const KEPT_ATTRS = new Set(["readOnly", "propagation", "isolation", "rollbackFor", "noRollbackFor", "timeout"]);

/** Strips a leading "@" and any dotted package prefix, e.g. "@org.springframework...Transactional" -> "Transactional". */
function bareName(annotation: string): string {
  return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}

/**
 * Matches an already-AST-confirmed @Transactional annotation's own argument text. Detection
 * of whether the annotation is present happens via SymbolRecord.annotations, never via this
 * regex -- this only ever runs to extract an argument list once .annotations has confirmed
 * the annotation is real. The optional `(?:[\w.]+\.)?` prefix tolerates a fully-qualified
 * annotation name the same way bareName() already tolerates one for detection -- without it,
 * a qualified @Transactional would be correctly DETECTED but its attributes would never be
 * found, silently downgrading it to "no fact to record" (the same brief's Review Focus item 2).
 */
function transactionalArgsRegex(): RegExp {
  return /@(?:[\w.]+\.)?Transactional(?:\(([^]*?)\))?/;
}
```

- [ ] **Step 4: Delete `matchIsInsideLineComment` entirely.** Delete this whole function:

```ts
/**
 * Guards against a "@Transactional(...)"-shaped match that is itself commented out on its
 * own physical line (e.g. "// example: @Transactional(readOnly = true)"). Re-derived from
 * spring-mvc.ts's matchIsInsideLineComment: parseJava's leading-trivia scan strips a "//"
 * prefix out of symbol.source itself, so the header text alone can never see it — this maps
 * the match position back to the real file line and checks only that line for a preceding "//".
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

- [ ] **Step 5: Replace `extractTransactionRelations`'s detection logic.** Find:

```ts
  for (const method of symbols.filter((s) => s.kind === "method")) {
    const methodHeader = header(method);
    const match = methodHeader.match(TRANSACTIONAL_RE);
    if (!match) continue;
    if (matchIsInsideLineComment(method, methodHeader, match, source)) continue;

    const rawArgs = match[1];
    if (rawArgs === undefined || rawArgs.trim() === "") continue; // bare or empty-parens: no fact to record
```

Replace with:

```ts
  for (const method of symbols.filter((s) => s.kind === "method")) {
    const hasTransactional = method.annotations.some((a) => bareName(a) === "Transactional");
    if (!hasTransactional) continue;

    const match = header(method).match(transactionalArgsRegex());
    const rawArgs = match?.[1];
    if (rawArgs === undefined || rawArgs.trim() === "") continue; // bare or empty-parens: no fact to record
```

The rest of the function (everything from `const evidence: string[] = [];` through the closing `return relations;`) is UNCHANGED — do not modify it.

- [ ] **Step 6: Confirm no remaining references to the deleted symbols.**

```
grep -n "matchIsInsideLineComment\|TRANSACTIONAL_RE\b" src/languages/java/enterprise/transactions.ts
```

Expected: no output (both fully removed).

- [ ] **Step 7: Run to verify GREEN.**

```
npx tsx --test tests/java-enterprise-transactions.test.ts
```

Expected: every existing test in this file UNCHANGED, plus both new tests, all passing.

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
git add src/languages/java/enterprise/transactions.ts tests/java-enterprise-transactions.test.ts
git commit -m "feat(java): detect @Transactional annotations via AST symbols"
```

---

### Task 2: Real-repository regression verification

**Files:**
- Modify (only if numbers genuinely change): `benchmarks/results/v1.4-phase3-transactions.{json,md}`

**Interfaces:** Consumes Task 1's completed migration. Produces the evidence that the migration causes no regression against the real-repository `@Transactional` benchmark.

- [ ] **Step 1: Confirm the full suite is green**, using the corrected exclusion command:

```
npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")
```

Report the exact pass/fail counts. Expect the same pre-existing, unrelated failures documented in every prior plan's own SDD ledger (`tests/cli.test.ts`, `tests/package-metadata.test.ts`) and zero NEW failures.

- [ ] **Step 2: Confirm real-repository checkouts are available** (copy from the main repository into this worktree if not already present, to avoid a network fetch):

```
npx tsx benchmarks/fetch-checkouts.ts
```

If this reports missing repositories and appears to hang or need network access, stop and report BLOCKED rather than waiting indefinitely — the controller should copy `benchmarks/checkouts/` from the main repository into this worktree first.

- [ ] **Step 3: Re-run `benchmark:v14-phase3`**, comparing against the CURRENTLY COMMITTED numbers in `benchmarks/results/v1.4-phase3-transactions.json`:

```
npm run benchmark:v14-phase3
```

Recall/precision numbers must be EQUAL OR BETTER than currently committed, never worse. If ANY number regresses, STOP — investigate the specific relation that changed and report explicitly. No bug was found in the pre-migration investigation of this file, so "equal" is a fully expected, acceptable outcome — do not manufacture an "improvement" narrative if none is actually observed.

- [ ] **Step 4: If the numbers genuinely changed**, regenerate the committed report file via the real script — leave it alone (`git diff` it, revert if only `generatedAt` changed) if the numbers are byte-identical.

- [ ] **Step 5: Run the full suite one final time** (same command as Step 1) → all green.

- [ ] **Step 6: Commit** (only if Step 4 produced a real change):

```bash
git add benchmarks/results/v1.4-phase3-transactions.json benchmarks/results/v1.4-phase3-transactions.md
git commit -m "chore(java): confirm @Transactional benchmark parity after AST migration"
```

If Step 4 found no genuine change (numbers byte-identical), skip this commit entirely — there is nothing to commit for this task, matching Phases 1-2's own precedent; say so in your report rather than creating an empty or placeholder commit.

---

### Task 3: Follow-up note

**Files:**
- Create: `docs/superpowers/plans/2026-09-30-java-transactions-ast-migration-summary.md`

- [ ] **Step 1: Write a short summary doc** covering: what changed (`transactions.ts`'s `@Transactional` detection now uses `SymbolRecord.annotations` directly; `matchIsInsideLineComment`/`TRANSACTIONAL_RE` deleted, replaced by `bareName()`/`transactionalArgsRegex()`), that this phase found no bug in the pre-migration comment-handling itself (same disposition as Phase 2) but proactively applied Phase 2's own qualified-name-tolerance lesson before implementation rather than after, what was verified (Task 2's real benchmark numbers — cite them exactly, don't invent or round), and name Phase 4 (JPA/Spring Data — the only remaining enterprise extractor, so this is the final sub-project in the roadmap) as next.
- [ ] **Step 2: Confirm the tree is clean and all tests pass** (same corrected full-suite command as Task 2 Step 1).
- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/plans/2026-09-30-java-transactions-ast-migration-summary.md
git commit -m "docs: summarize Java @Transactional AST migration, Phase 3 complete"
```

## Self-review notes

- **Spec coverage:** the spec's Architecture section (detection-via-annotations, `transactionalArgsRegex`'s qualified-name-tolerant extraction, the reused `header`/`splitTopLevel`/`KEPT_ATTRS`) maps to Task 1 Steps 3-5; the "existing comment test must pass unchanged" requirement maps to Task 1's own Global Constraints and Step 7; the fully-qualified and multi-line tests map to Task 1 Step 1; Acceptance items 1-3 map to Task 1's steps, item 4 (benchmark) maps to Task 2, item 5 (follow-up note) maps to Task 3.
- **Placeholder scan:** no TBD/TODO; every test and code block in Task 1 is complete, runnable code.
- **Type consistency:** `bareName`/`transactionalArgsRegex`'s signatures match how they're called in Step 5's replacement code exactly; `match?.[1]` correctly handles `transactionalArgsRegex()`'s return being used with optional chaining since `header(method).match(...)` can return `null` — verified against the actual current file content before writing this plan, not assumed.
- **Review Focus:** all five items (stray-annotation-text risk noted as pre-existing/out-of-scope per Phase 2's own precedent, fully-qualified-name handling, bare/empty-parens preservation, multi-line pinning, dead-code cleanup) each map to a specific step or test in Task 1, confirmed line-by-line against the plan text above.
