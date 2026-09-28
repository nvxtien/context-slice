# Java Dependency-Injection AST Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `dependency-injection.ts`'s regex-based field/setter DI-annotation detection (`memberLevelBody` + `INJECT_RE`) with direct use of the `field`/`method` AST symbols Phase 0 already established, deleting the old detection machinery entirely (no fallback).

**Architecture:** Two new loops in `extractDependencyInjection` replace the single old "scan class-member text" loop: one iterating `field`-kind symbols directly (using `.annotations`/`metadata.declaredType`/`.name` — all AST-derived since Phase 0), one iterating `method`-kind symbols the same way for explicit setters. Parameter-list parsing (`firstParenGroup`/`splitTopLevel`/`parseDeclaration`) and qualifier-value extraction (`QUALIFIER_RE`) are reused unchanged, just retargeted from a whole-class text scan to a single, already-AST-bounded symbol's own `.source`. Constructor injection, `resolveBeanType`, and `resolveDependencyRelations` are untouched.

**Tech Stack:** TypeScript (ESM `.js` imports), `npx tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-29-java-di-ast-migration-design.md`

## Global Constraints

- **Relation attribution (`sourceSymbolId`) must not change.** Field-injection relations attribute to the ENCLOSING CLASS's id (via `field.parentId` → `own.find`), exactly as today — not the field's own id. This is a real, tested contract (`tests/java-enterprise-dependency-injection.test.ts`'s `"field injection resolves via the enclosing class..."` test asserts `rel.sourceSymbolId === checkoutClass.id`). Setter-injection relations continue attributing to the setter METHOD's own id, exactly as today (also tested).
- **The accepted divergence:** a multi-declarator field sharing one `@Qualifier(...)` (e.g. `@Qualifier("x") private Foo a, b;`) still produces a correct injection relation (type/name/annotation all correctly detected via the field's own `.annotations`/`metadata.declaredType`) but WITHOUT the qualifier's string value in its evidence, since Phase 0's field-symbol design only includes annotation text in `.source` for single-declarator fields. This must be pinned by an explicit test, not silently left uncovered.
- **No parameter-level symbols are introduced.** Constructor/setter parameter parsing keeps using `firstParenGroup`/`splitTopLevel`/`parseDeclaration` against the callable symbol's own `.source` — unchanged technique, now also applied to setters.
- **`memberLevelBody` and `INJECT_RE` must be confirmed dead (zero remaining references, grepped) before deletion**, not just replaced-in-place and left as unused dead code.
- No change to `resolveBeanType`, `resolveDependencyRelations`, `relation()`'s own signature, `STEREOTYPES`, or the constructor-injection loop.
- No change to any other enterprise extractor file, `src/parser/java-parser.ts`, or `src/languages/java.ts`.
- Existing DI test files (`tests/java-enterprise-dependency-injection.test.ts`, `tests/java-enterprise-di-fixtures.test.ts`, `tests/java-enterprise-dependency-composition.test.ts`) must pass UNCHANGED — no test file in this set may be edited by this plan. If one appears to need a change, that is a signal to investigate a real regression, not an acceptable adjustment.
- Commit messages: short, single-line, imperative, no Co-Authored-By trailer (repo convention — every commit on `main` follows this).
- Test commands must exclude the four hang-prone files documented in the prior AST-rewrite/field-symbols plans' own SDD ledgers: `tests/mcp-stdio.test.ts`, `tests/rust-product-surface.test.ts`, `tests/typescript.test.ts`, `tests/workflow-benchmark.test.ts` — never run plain `npm test`.
- Real-repository benchmark acceptance bar: `benchmark:v14-phase2` must be equal or better than currently committed, never worse. Improvement is welcome but not required (the 2026-09-28 investigation already found the pre-migration regex implementation correct on the measured real repositories, so "equal" is a fully acceptable, expected outcome).

## Review Focus

1. **`relation()`'s excess-property TypeScript pitfall** — `relation(source, filePath, decl: { type: string; qualifier?: string }, evidence: string)` only reads `decl.type`/`decl.qualifier`. Passing an inline object literal with an extra `name` property (as one might naturally write, mirroring the field/method's own shape) triggers a TypeScript excess-property-check compile error, since literal object arguments are checked strictly against the parameter type (unlike passing a pre-existing variable of a wider type, which the OLD code did via `parseDeclaration()`'s return value). The new field/setter loops must NOT include `name` in the object passed to `relation()`.
2. **Field-injection `sourceSymbolId` regressing to the field's own id instead of the enclosing class's** — the single easiest mistake given fields are now real symbols with their own `.id`; must not happen (see Global Constraints).
3. **The multi-declarator `@Qualifier` divergence silently regressing instead of being pinned** — a naive implementation might either crash (if `field.metadata` is assumed always present with a qualifier) or silently produce a WRONG qualifier value (e.g., accidentally reading a NEIGHBORING declarator's irrelevant text) rather than correctly producing `undefined`. Needs an explicit test.
4. **Setter detection missing methods whose annotation is qualified with a full package path** (e.g. `@org.springframework.beans.factory.annotation.Autowired`) — `bareName()` must strip both the `@` and any dotted package prefix, matching the existing `STEREOTYPES` lookup's own established pattern exactly, not a new, subtly different implementation.
5. **`memberLevelBody`/`INJECT_RE` deletion leaving orphaned dead code or an unused import** — a mechanical but easy-to-skip cleanup step; must be verified via grep, not assumed.

---

### Task 1: Replace field/setter DI detection with AST symbols (TDD)

**Files:**
- Modify: `src/languages/java/enterprise/dependency-injection.ts`
- Test: `tests/java-enterprise-dependency-injection.test.ts` (append new tests only — do not modify any existing test)

**Interfaces:**
- Consumes: `SymbolRecord.kind === "field"` / `"method"`, `.annotations: string[]`, `.metadata?.declaredType: string`, `.name`, `.parentId`, `.source` — all already established by Phase 0 and the original AST rewrite, no changes needed to `java-parser.ts`.
- Produces: no new exported names. `extractDependencyInjection`'s external behavior (its registered-extractor contract via `registerEnterpriseExtractor`) is unchanged in shape, only its internal detection mechanism changes.

- [ ] **Step 1: Write the failing tests.** Append to the END of `tests/java-enterprise-dependency-injection.test.ts` (do not touch any existing test in that file):

```ts
test("a field injected via @Inject resolves the same as @Autowired", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Inject
    private PaymentGateway gateway;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id)!;
  assert.ok(rel, "expected an @Inject field-injection relation");
  assert.equal(rel.targetLabel, "PaymentGateway");
  assert.match(rel.evidence.join(" "), /@Inject field/);
});

test("a field injected via @Resource resolves the same as @Autowired", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Resource
    private PaymentGateway gateway;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id)!;
  assert.ok(rel, "expected an @Resource field-injection relation");
  assert.equal(rel.targetLabel, "PaymentGateway");
  assert.match(rel.evidence.join(" "), /@Resource field/);
});

test("a multi-declarator field sharing an @Qualifier still detects the injection but loses the qualifier value (accepted divergence)", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Autowired @Qualifier("strict")
    private PaymentGateway a, b;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const diRelations = relations.filter((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id);
  assert.equal(diRelations.length, 2, "both declarators must still be detected as injection points");
  for (const rel of diRelations) {
    assert.equal(rel.targetLabel, "PaymentGateway");
    assert.doesNotMatch(rel.evidence.join(" "), /@Qualifier/, "multi-declarator fields cannot recover the shared qualifier's value (accepted divergence, see spec)");
  }
});

test("a multi-line @Autowired-with-arguments field is not lost (AST-native immunity inherited from Phase 0)", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Autowired(
        required = false
    )
    private PaymentGateway gateway;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id)!;
  assert.ok(rel, "a multi-line annotation argument must not hide the field injection");
  assert.equal(rel.targetLabel, "PaymentGateway");
});

test("a multi-line @Autowired-with-arguments setter is not lost", () => {
  const source = `
class Notifier {}
class Alerts {
    private Notifier notifier;
    @Autowired(
        required = false
    )
    void setNotifier(Notifier notifier) { this.notifier = notifier; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Alerts.java");
  const setter = symbols.find((s) => s.kind === "method" && s.name === "setNotifier")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === setter.id)!;
  assert.ok(rel, "a multi-line annotation argument must not hide the setter injection");
  assert.equal(rel.targetLabel, "Notifier");
});
```

- [ ] **Step 2: Run to verify RED.**

```
npx tsx --test tests/java-enterprise-dependency-injection.test.ts
```

Do not assume which of the 5 new tests currently fail — report the ACTUAL RED/GREEN state honestly for each:
- The `@Inject`/`@Resource` tests may already PASS against the current code (its `INJECT_RE` alternation already includes both names), since this task changes the DETECTION MECHANISM, not the set of recognized annotations. That is fine to report as-is — the test's value is pinning the behavior going forward under the new implementation, not proving a bug existed.
- The two multi-line-annotation tests may ALSO already pass — the current `INJECT_RE`'s `(?:\s*\([^)]*\))?` group already tolerates newlines inside annotation arguments (`[^)]*` excludes only `)`, not `\n`), so this was never actually broken in the regex implementation either. Same reasoning: still worth pinning going forward.
- The multi-declarator-qualifier test is the one most likely to be GENUINELY red for a reason beyond "just the qualifier is missing": trace through the CURRENT `parseDeclaration`'s regex (`^((?:[\w$]+\.)*([\w$]+))\s*(?:<.*>)?\s*(?:\[\s*\])*\s+([\w$]+)$`) against input text ending in `"...PaymentGateway a, b"` — the trailing `$` anchor requires the text to end in exactly one bare identifier, which `"a, b"` is not, so `parseDeclaration` likely returns `undefined` for the WHOLE multi-declarator case today, meaning the CURRENT implementation may produce ZERO relations for both `a` and `b`, not just a missing qualifier. If so, this test is doubly informative: it both pins the new (better) behavior AND reveals that the migration is a genuine improvement here (two real injection points recovered, not just parity) — report this finding explicitly if you confirm it, don't just note the test passed.

- [ ] **Step 3: Add `bareName` and `INJECT_ANNOTATIONS`, replacing `INJECT_RE`.** In `src/languages/java/enterprise/dependency-injection.ts`, change:

```ts
const INJECT_RE = /@(Autowired|Inject|Resource)\b(?:\s*\([^)]*\))?/g;
const QUALIFIER_RE = /@Qualifier\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/;
const STEREOTYPES = new Set(["Component", "Service", "Repository", "Controller", "RestController", "Configuration"]);
```

to:

```ts
const QUALIFIER_RE = /@Qualifier\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/;
const STEREOTYPES = new Set(["Component", "Service", "Repository", "Controller", "RestController", "Configuration"]);
const INJECT_ANNOTATIONS = new Set(["Autowired", "Inject", "Resource"]);

/** Strips a leading "@" and any dotted package prefix, e.g. "@org.springframework...Autowired" -> "Autowired". */
function bareName(annotation: string): string {
  return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}
```

- [ ] **Step 4: Reuse `bareName` for the existing `STEREOTYPES` check.** Find:

```ts
    const stereotyped = cls?.annotations.some((a) => STEREOTYPES.has(a.slice(a.lastIndexOf(".") + 1).replace("@", "")));
```

Replace with:

```ts
    const stereotyped = cls?.annotations.some((a) => STEREOTYPES.has(bareName(a)));
```

- [ ] **Step 5: Delete `memberLevelBody` and the old field/setter loop.** Delete the entire `memberLevelBody` function:

```ts
/**
 * The class body at member depth only: nested bodies (methods, initializers, inner classes),
 * and comments are blanked to spaces, so positions still line up with the
 * class source while annotations on locals or inside comments can never match.
 */
function memberLevelBody(classSource: string): string {
  const out = classSource.split("");
  let depth = 0;
  let inString = false;
  for (let i = 0; i < out.length; i++) {
    const ch = classSource[i];
    if (!inString && ch === "/" && classSource[i + 1] === "/") {
      while (i < out.length && classSource[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (!inString && ch === "/" && classSource[i + 1] === "*") {
      const end = classSource.indexOf("*/", i + 2);
      const stop = end === -1 ? out.length : end + 2;
      for (; i < stop; i++) if (out[i] !== "\n") out[i] = " ";
      i--;
      continue;
    }
    if (ch === '"' && classSource[i - 1] !== "\\") inString = !inString;
    const keep = depth === 1; // member-level string literals kept: @Qualifier values live there
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (!keep && out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}
```

And delete the old field/setter loop:

```ts
  // Field and explicit-setter injection, scanned at class-member depth only.
  for (const cls of own.filter((s) => s.kind === "class")) {
    const body = memberLevelBody(cls.source);
    for (const match of body.matchAll(INJECT_RE)) {
      const annotation = match[1];
      const rest = body.slice((match.index ?? 0) + match[0].length);
      // Other annotations stacked after this one (e.g. @Qualifier) belong to the same member.
      const lead = rest.match(/^(?:\s*@[\w.]+(?:\s*\([^)]*\))?\s*)*/)![0];
      const leadQualifier = lead.match(QUALIFIER_RE)?.[1];
      const decl = rest.slice(lead.length);
      const end = decl.search(/[;(=]/);
      if (end === -1) continue;
      if (decl[end] === "(") {
        const methodName = decl.slice(0, end).match(/([\w$]+)\s*$/)?.[1];
        const setter = own.find((s) => s.kind === "method" && s.parentId === cls.id && s.name === methodName);
        const params = firstParenGroup(decl.slice(end));
        if (!setter || params === undefined) continue; // e.g. an annotated constructor, handled above
        for (const param of splitTopLevel(params)) {
          const p = parseDeclaration(param);
          if (!p) continue;
          p.qualifier ??= leadQualifier;
          relations.push(relation(setter, filePath, p, `@${annotation} setter ${setter.name}(${p.type})`));
        }
      } else {
        const field = parseDeclaration(lead + decl.slice(0, end));
        if (field) relations.push(relation(cls, filePath, field, `@${annotation} field ${field.type} ${field.name}`));
      }
    }
  }
```

- [ ] **Step 6: Add the two new loops in its place.** In the same spot the deleted loop occupied (after the constructor-injection loop, before the function's closing `return relations;`), add:

```ts
  // Field injection, using field symbols directly (Phase 0 AST rewrite) instead of a
  // regex scan over class-member text.
  for (const field of own.filter((s) => s.kind === "field")) {
    const annotation = field.annotations.find((a) => INJECT_ANNOTATIONS.has(bareName(a)));
    if (!annotation) continue;
    const cls = own.find((s) => s.id === field.parentId);
    if (!cls) continue;
    const qualifier = field.source.match(QUALIFIER_RE)?.[1];
    relations.push(
      relation(
        cls,
        filePath,
        { type: field.metadata?.declaredType ?? "", qualifier },
        `${annotation} field ${field.metadata?.declaredType ?? ""} ${field.name}`,
      ),
    );
  }

  // Explicit setter injection, using method symbols directly.
  for (const method of own.filter((s) => s.kind === "method")) {
    const annotation = method.annotations.find((a) => INJECT_ANNOTATIONS.has(bareName(a)));
    if (!annotation) continue;
    const params = firstParenGroup(method.source);
    if (params === undefined) continue;
    const qualifier = method.source.match(QUALIFIER_RE)?.[1];
    for (const param of splitTopLevel(params)) {
      const p = parseDeclaration(param);
      if (!p) continue;
      p.qualifier ??= qualifier;
      relations.push(relation(method, filePath, p, `${annotation} setter ${method.name}(${p.type})`));
    }
  }
```

- [ ] **Step 7: Confirm no remaining references to the deleted symbols.**

```
grep -n "memberLevelBody\|INJECT_RE" src/languages/java/enterprise/dependency-injection.ts
```

Expected: no output (both fully removed).

- [ ] **Step 8: Run to verify GREEN.**

```
npx tsx --test tests/java-enterprise-dependency-injection.test.ts tests/java-enterprise-di-fixtures.test.ts tests/java-enterprise-dependency-composition.test.ts
```

Expected: every test passes, including every pre-existing test in these three files UNCHANGED (no test file other than the new appended tests was edited) and all 5 new tests from Step 1.

- [ ] **Step 9: Run `tsc` to confirm no type errors** (specifically checking for the excess-property pitfall named in Review Focus item 1):

```
npx tsc --noEmit -p .
```

Expected: no errors.

- [ ] **Step 10: Run the broader scoped regression set:**

```
npx tsx --test tests/java-parser-ast-fields.test.ts tests/java-parser-ast-types.test.ts tests/java-parser-ast-methods.test.ts tests/java-*.test.ts tests/parser.test.ts tests/index.test.ts tests/composition.test.ts tests/enterprise-relation.test.ts tests/enterprise-relations-indexer.test.ts
```

Expected: every test passes.

- [ ] **Step 11: Commit.**

```bash
git add src/languages/java/enterprise/dependency-injection.ts tests/java-enterprise-dependency-injection.test.ts
git commit -m "feat(java): detect DI field/setter injection via AST symbols"
```

---

### Task 2: Real-repository regression verification

**Files:**
- Modify (only if numbers genuinely change): `benchmarks/results/v1.4-phase2-dependency-injection.{json,md}`

**Interfaces:** Consumes Task 1's completed migration. Produces the evidence that the migration causes no regression (and reports any genuine improvement honestly) against real-repository benchmarks.

- [ ] **Step 1: Confirm the full suite is green**, using the corrected exclusion command:

```
npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")
```

Report the exact pass/fail counts. Expect the same pre-existing, unrelated failures documented in the prior plans' SDD ledgers (`tests/cli.test.ts`, `tests/package-metadata.test.ts` — both fail fast with ENOENT against a broken worktree-relative `node_modules/.bin/tsx` path) and zero NEW failures.

- [ ] **Step 2: Confirm real-repository checkouts are available** (copy from the main repository into this worktree if not already present, to avoid a network fetch — a lesson from both prior plans' SDD ledgers):

```
npx tsx benchmarks/fetch-checkouts.ts
```

If this reports missing repositories and appears to hang or need network access, stop and report BLOCKED rather than waiting indefinitely — the controller should copy `benchmarks/checkouts/` from the main repository into this worktree first.

- [ ] **Step 3: Re-run `benchmark:v14-phase2`** (confirm the exact script name via `package.json` first — do not assume), comparing against the CURRENTLY COMMITTED numbers in `benchmarks/results/v1.4-phase2-dependency-injection.json`:

```
npm run benchmark:v14-phase2
```

Recall/precision numbers must be EQUAL OR BETTER than currently committed, never worse. If ANY number regresses, STOP — investigate the specific relation that changed, determine whether it's a real regression or a genuine, expected consequence of the accepted multi-declarator-qualifier divergence (unlikely to appear in real code, but check), and report explicitly. Genuine improvement is a welcome, plausible outcome (this migration removes the old regex's narrow blind spots) but not required — "equal" is a fully acceptable result.

- [ ] **Step 4: If the numbers genuinely changed**, regenerate the committed report file via the real script — leave it alone (`git diff` it, revert if unchanged) if only `generatedAt` changed.

- [ ] **Step 5: Run the full suite one final time** (same command as Step 1) → all green.

- [ ] **Step 6: Commit** (only if Step 4 produced a real change):

```bash
git add benchmarks/results/v1.4-phase2-dependency-injection.json benchmarks/results/v1.4-phase2-dependency-injection.md
git commit -m "chore(java): confirm DI benchmark parity after AST migration"
```

If Step 4 found no genuine change (numbers byte-identical), skip this commit entirely — there is nothing to commit for this task, and that is a valid, expected outcome; say so in your report rather than creating an empty or placeholder commit.

---

### Task 3: Follow-up note

**Files:**
- Create: `docs/superpowers/plans/2026-09-29-java-di-ast-migration-summary.md`

- [ ] **Step 1: Write a short summary doc** covering: what changed (`dependency-injection.ts`'s field/setter detection now uses AST symbols directly, `memberLevelBody`/`INJECT_RE` deleted), the accepted divergence (multi-declarator `@Qualifier` value loss, with the real-world rarity rationale), what was verified (Task 2's real benchmark numbers — cite them exactly, don't invent or round), and name Phase 2 (the next enterprise extractor to migrate — Spring MVC routes, `@Transactional`, or JPA/Spring Data, in whatever order makes sense; this plan does not decide which) as the next sub-project, to be brainstormed and specced separately.
- [ ] **Step 2: Confirm the tree is clean and all tests pass** (same corrected full-suite command as Task 2 Step 1).
- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/plans/2026-09-29-java-di-ast-migration-summary.md
git commit -m "docs: summarize Java DI AST migration, Phase 1 complete"
```

## Self-review notes

- **Spec coverage:** the spec's Architecture section (deleted code, new loops, `qualifierFrom`/`bareName` helpers, the `sourceSymbolId` attribution fix) maps to Task 1 Steps 3-6; the accepted divergence maps to Task 1 Step 1's dedicated test and this plan's Global Constraints; Testing section maps to Task 1 Steps 1-2/8-10; Acceptance items 1-3 map to Task 1's steps, item 4 (benchmark) maps to Task 2, item 5 (follow-up note) maps to Task 3.
- **Placeholder scan:** no TBD/TODO; every test and code block in Task 1 is complete, runnable code, not a description of what to write.
- **Type consistency:** the new loops' call to `relation(cls | method, filePath, { type, qualifier }, evidence)` matches `relation()`'s actual existing signature exactly (verified against the current file content before writing this plan) — deliberately OMITTING a `name` property from the object literal to avoid the TypeScript excess-property-check error named in Review Focus item 1 (the old code's equivalent call passed a variable, not a literal, so this pitfall didn't previously exist and is a genuine, easy-to-miss risk specific to this rewrite's more direct style).
- **Review Focus:** all five items (excess-property pitfall, sourceSymbolId attribution, multi-declarator divergence pinning, qualified-annotation-name stripping, dead-code cleanup) each map to a specific step or test in Task 1, confirmed line-by-line against the plan text above.
