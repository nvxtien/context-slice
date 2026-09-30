# Java JPA Entity AST Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `jpa-entity.ts`'s regex-based, forward-text-scanning field-relationship DETECTION with direct use of Phase 0's field-level `SymbolRecord`s, fixing two real, pre-existing bugs as a structural side effect: a documented nested-paren `@JoinColumn` argument bug, and an undocumented multi-declarator relationship-field bug.

**Architecture:** `extractEntityRelations`'s core loop switches from "scan an `@Entity` class's whole body text for relation-annotation-shaped matches, then forward-scan past stacked annotations to find the field declaration" to "iterate the class's field symbols directly, check each one's `.annotations` for a relationship annotation." `memberLevelBody()` is deleted entirely (no forward-scanning is left to protect). Attribute-value extraction (`mappedBy`/`fetch`/`cascade`, `@JoinColumn`'s own args) keeps targeted, per-annotation-name regexes against each field's own `.source`, run only after `.annotations` has confirmed the relevant annotation is real — both with the fully-qualified-name-tolerant prefix Phases 2-3 already established, applied proactively.

**Tech Stack:** TypeScript (ESM `.js` imports), `npx tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-java-jpa-entity-ast-migration-design.md`

## Global Constraints

- Class-level `@Entity` detection (`entities = symbols.filter(s => s.kind === "class" && s.annotations.includes("@Entity"))`) is ALREADY AST-based and stays completely unchanged — this plan's scope is entirely the field-level relationship-annotation loop that follows it.
- Detection of "does this field have a relationship annotation" (`@OneToOne`/`@OneToMany`/`@ManyToOne`/`@ManyToMany`) and "does this field also have `@JoinColumn`" must both use `SymbolRecord.annotations` exclusively — never a text-matching regex, and never a forward-scan past stacked annotation text.
- Attribute-value extraction (relation annotation's own `mappedBy`/`fetch`/`cascade`, and `@JoinColumn`'s own argument text) may still use regex, but ONLY targeting the specific, already-AST-confirmed annotation name, against that ONE field's own `.source` — never a whole-class-body scan.
- Both new targeted regexes must tolerate a fully-qualified/dotted annotation name via the `(?:[\w.]+\.)?` prefix Phases 2-3 already established — applied proactively here, not discovered later.
- **`joinColumnArgsRegex()`'s own argument-VALUE capture is NOT nested-paren-aware** (it keeps the old `JOIN_COLUMN_RE`'s `[^)]*` body unchanged, only adding the qualified-name prefix) — per the spec's Non-goals, this plan does not build a depth-counting scanner for that. The bug this plan fixes is that the RELATION was being dropped entirely; `@JoinColumn`'s own evidence text can still be imprecise for a nested-annotation argument like `@JoinColumn(foreignKey = @ForeignKey(...))`. This is a known, accepted, documented limitation — not a gap for a reviewer to flag as unaddressed.
- `memberLevelBody`, `RELATION_RE`, `JOIN_COLUMN_RE` must be confirmed dead (grepped, zero remaining references) and deleted.
- `COLLECTION_RE` and `explicitAttributes()` stay unchanged — reused exactly as today, just fed AST-derived input (`field.metadata.declaredType`, a targeted-regex match's argument group) instead of raw-source-derived input.
- `resolveEntityRelations` (the project-wide bean-identity post-pass) stays completely unchanged.
- Relation attribution (`sourceSymbolId`) must not change: `ENTITY_RELATION` relations attribute to the ENCLOSING ENTITY CLASS's id (`entity.id`), exactly as today — not the field's own id. This is the exact same attribution-preservation lesson Phase 1's own plan self-review caught for `dependency-injection.ts` — verify it explicitly, don't assume it by default.
- No change to any other enterprise extractor file (`spring-mvc.ts`, `transactions.ts`, `dependency-injection.ts`, `spring-data.ts` — the last is Phase 4b, a separate future plan), `src/parser/java-parser.ts`, or `src/languages/java.ts`.
- Existing test file `tests/java-enterprise-jpa-entity.test.ts` must pass UNCHANGED — no existing test may be edited. In particular, `"@Entity inside a comment produces no relation"` passing unchanged is a sanity check (that test exercises the ALREADY-AST-based class-level filter, unaffected by this plan), not new proof of anything this plan changes.
- Commit messages: short, single-line, imperative, no Co-Authored-By trailer (repo convention — every commit on `main` follows this).
- Test commands must exclude the four hang-prone files documented in every prior plan's own SDD ledger on this codebase: `tests/mcp-stdio.test.ts`, `tests/rust-product-surface.test.ts`, `tests/typescript.test.ts`, `tests/workflow-benchmark.test.ts` — never run plain `npm test`.
- Real-repository benchmark acceptance bar: `npm run benchmark:v14-phase4` (confirmed via `package.json` to map to `tsx benchmarks/v1.4-phase4-jpa-spring-data.ts`, report `benchmarks/results/v1.4-phase4-jpa-spring-data.{json,md}` — this ONE combined report covers BOTH `jpa-entity.ts`'s `entity_relation` facts and `spring-data.ts`'s `repository_linkage` facts). This plan's acceptance bar: `entity_relation` recall/precision equal or better than currently committed (genuine improvement is plausible and welcome here, given the diagnosed bugs); `repository_linkage` numbers must stay BYTE-IDENTICAL, since this plan makes no change to any code `spring-data.ts` depends on.

## Review Focus

1. **The nested-paren `@JoinColumn` bug actually being fixed, not just "probably fixed by construction"** — the plan's own Task 1 must include a direct regression test with `@JoinColumn(foreignKey = @ForeignKey(name = "..."))`, since this is THE bug this whole plan exists to fix; a plan that migrates the architecture without proving this specific case now works would miss its own stated purpose.
2. **`sourceSymbolId` attribution regressing to the field's own id instead of the enclosing entity class's** — the single easiest mistake given fields are now real symbols with their own `.id` (identical risk class to Phase 1's own self-caught DI bug); must not happen.
3. **The multi-declarator relationship-field bug** — a naive re-implementation might still only process the FIRST field symbol matching a relation annotation per class (e.g. if the implementer iterates class body children instead of field symbols directly, or de-dupes by annotation occurrence instead of by field), silently preserving the old bug instead of fixing it. Needs an explicit test asserting BOTH declarators get their own relation.
4. **A field with a relationship annotation but NO `@JoinColumn` at all** (the common case) — `hasJoinColumn` must correctly come back `false`, and the evidence array must NOT include a `@JoinColumn(...)` entry at all (not `@JoinColumn(undefined)` or similar) — this is already covered by the existing, unchanged `"no explicit fetch/cascade/mappedBy means none appear in evidence"` test, but the implementer should be aware this exact test is the regression guard for this specific case.
5. **`memberLevelBody`/`RELATION_RE`/`JOIN_COLUMN_RE` deletion leaving orphaned dead code** — mechanical but easy to skip; verify via grep, not assumption. Also confirm `COLLECTION_RE` and `explicitAttributes()` remain genuinely used (they should — just fed different input).

---

### Task 1: Replace field-relationship detection with AST symbols (TDD)

**Files:**
- Modify: `src/languages/java/enterprise/jpa-entity.ts`
- Test: `tests/java-enterprise-jpa-entity.test.ts` (append new tests only — do not modify any existing test)

**Interfaces:**
- Consumes: `SymbolRecord.kind === "field"`, `.annotations: string[]`, `.metadata?.declaredType: string`, `.parentId`, `.source` — all already established since Phase 0. No changes needed to `java-parser.ts`.
- Produces: `bareName(annotation: string): string`, `relationArgsRegex(name: string): RegExp`, `joinColumnArgsRegex(): RegExp` — three new local functions in `jpa-entity.ts`. No exported names change; `extractEntityRelations`'s registered-extractor contract is unchanged in shape.

- [ ] **Step 1: Write the failing tests.** Append to the END of `tests/java-enterprise-jpa-entity.test.ts` (do not touch any existing test in that file):

**Important nuance for this first test, read before writing it:** the fix
this test proves is that the RELATION ITSELF is no longer dropped —
`targetLabel`/`targetSymbolId` now come from `field.metadata.declaredType`,
which is entirely independent of whether `@JoinColumn`'s own argument text
parses correctly. `joinColumnArgsRegex()` still uses the same non-nested-
-paren-aware `[^)]*` body the old `JOIN_COLUMN_RE` had (only adding the
qualified-name prefix) — per the spec's own Non-goals, this plan does NOT
build a depth-counting scanner for `@JoinColumn`'s own argument text, so
that specific extraction can still produce a truncated/imprecise value for
a nested-annotation argument. Do NOT assert anything about the exact
`@JoinColumn(...)` evidence STRING content in this test — only assert the
relation exists with the correct target, which is the actual bug this
plan fixes.

```ts
test("a field's @JoinColumn with a nested-annotation argument no longer drops the whole relation", () => {
  const visit = `
@Entity
class Visit {
    @ManyToOne
    @JoinColumn(foreignKey = @ForeignKey(name = "fk_pet"))
    private Pet pet;
}
`;
  const pet = `@Entity\nclass Pet {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/Visit.java": visit, "src/main/java/Pet.java": pet });
  const visitClass = symbols.find((s) => s.name === "Visit")!;
  const petClass = symbols.find((s) => s.name === "Pet")!;
  const rel = relations.find((r) => r.kind === "ENTITY_RELATION" && r.sourceSymbolId === visitClass.id)!;
  assert.ok(rel, "expected an ENTITY_RELATION despite the nested-paren @JoinColumn argument");
  assert.equal(rel.targetSymbolId, petClass.id);
  assert.equal(rel.targetLabel, "Pet");
});

test("a multi-declarator relationship field produces a relation for each declarator", () => {
  const owner = `
@Entity
class Owner {
    @OneToMany
    private java.util.List<Pet> pets, favorites;
}
`;
  const pet = `@Entity\nclass Pet {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/Owner.java": owner, "src/main/java/Pet.java": pet });
  const ownerClass = symbols.find((s) => s.name === "Owner")!;
  const entityRelations = relations.filter((r) => r.kind === "ENTITY_RELATION" && r.sourceSymbolId === ownerClass.id);
  assert.equal(entityRelations.length, 2, "both pets and favorites must produce their own relation");
  for (const rel of entityRelations) {
    assert.equal(rel.targetLabel, "Pet");
  }
});

test("a fully-qualified relationship annotation name is still recognized", () => {
  const order = `
@Entity
class Order {
    @javax.persistence.ManyToOne
    private Customer customer;
}
`;
  const customer = `@Entity\nclass Customer {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/Order.java": order, "src/main/java/Customer.java": customer });
  const orderClass = symbols.find((s) => s.name === "Order")!;
  const customerClass = symbols.find((s) => s.name === "Customer")!;
  const rel = relations.find((r) => r.kind === "ENTITY_RELATION" && r.sourceSymbolId === orderClass.id)!;
  assert.ok(rel, "expected a relation for a fully-qualified @ManyToOne");
  assert.equal(rel.targetSymbolId, customerClass.id);
});
```

- [ ] **Step 2: Run to verify RED.**

```
npx tsx --test tests/java-enterprise-jpa-entity.test.ts
```

Do not assume which of the 3 new tests currently fail — report the ACTUAL state honestly for each:
- The nested-paren `@JoinColumn` test and the multi-declarator test are both EXPECTED to be genuinely RED — these are the two real, diagnosed bugs this plan exists to fix (trace the current code by hand if you want to confirm why before running: the nested-paren case makes the field-declaration regex fail to match, dropping the whole relation; the multi-declarator case makes the SAME regex fail for a different reason — `"pets, favorites"` isn't a single trailing identifier).
- The fully-qualified-annotation-name test is ALSO expected to be genuinely RED, since the current `RELATION_RE` only matches bare names (`/@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b.../`, no qualified-prefix tolerance).
- If any test unexpectedly passes against the current code, report that honestly too rather than assuming your trace was right.

- [ ] **Step 3: Add `bareName`, `RELATION_ANNOTATIONS`, `relationArgsRegex`, `joinColumnArgsRegex`; remove `RELATION_RE`/`JOIN_COLUMN_RE`.** In `src/languages/java/enterprise/jpa-entity.ts`, change:

```ts
const RELATION_RE = /@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b(?:\s*\(([^)]*)\))?/g;
const JOIN_COLUMN_RE = /@JoinColumn\s*\(([^)]*)\)/;
const COLLECTION_RE = /\b(?:List|Set|Collection)<\s*([\w.]+)\s*>/;
```

to:

```ts
const RELATION_ANNOTATIONS = new Set(["OneToOne", "OneToMany", "ManyToOne", "ManyToMany"]);
const COLLECTION_RE = /\b(?:List|Set|Collection)<\s*([\w.]+)\s*>/;

/** Strips a leading "@" and any dotted package prefix, e.g. "@javax.persistence.ManyToOne" -> "ManyToOne". */
function bareName(annotation: string): string {
  return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}

/**
 * Matches ONE specific, already-AST-confirmed relationship annotation's own argument text
 * (mappedBy/fetch/cascade). Detection of WHICH relationship annotation (if any) is present
 * happens via SymbolRecord.annotations, never via this regex -- this only ever runs to
 * extract an argument list for a name already known to be real. The optional
 * `(?:[\w.]+\.)?` prefix tolerates a fully-qualified annotation name the same way
 * bareName() already tolerates one for detection.
 */
function relationArgsRegex(name: string): RegExp {
  return new RegExp(`@(?:[\\w.]+\\.)?${name}\\b(?:\\s*\\(([^)]*)\\))?`);
}

/** Same qualified-name-tolerant pattern as relationArgsRegex, for the fixed @JoinColumn name. */
function joinColumnArgsRegex(): RegExp {
  return /@(?:[\w.]+\.)?JoinColumn\s*\(([^)]*)\)/;
}
```

- [ ] **Step 4: Delete `memberLevelBody` entirely.** Delete this whole function:

```ts
/** Class body at member depth only; comments and nested bodies blanked (same as DI's). */
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
    const keep = depth === 1;
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (!keep && out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}
```

- [ ] **Step 5: Replace `extractEntityRelations`'s core loop.** Find:

```ts
function extractEntityRelations(symbols: SymbolRecord[], filePath: string, _source: string): EnterpriseRelation[] {
  const relations: EnterpriseRelation[] = [];
  const entities = symbols.filter((s) => s.filePath === filePath && s.kind === "class" && s.annotations.includes("@Entity"));
  for (const entity of entities) {
    const body = memberLevelBody(entity.source);
    for (const match of body.matchAll(RELATION_RE)) {
      const rest = body.slice((match.index ?? 0) + match[0].length);
      // Stacked annotations (@JoinColumn, @OrderBy, ...) belong to the same field.
      // ponytail: `[^)]*` isn't nested-paren-aware, so a stacked annotation with a
      // nested-annotation argument (e.g. `@JoinColumn(foreignKey = @ForeignKey(name = "fk_x"))`)
      // under-consumes at the inner `)`, leaving `decl` misaligned so the field-declaration
      // regex below fails to match — this silently drops the WHOLE relation for that field
      // (not just the JoinColumn evidence). Fix if it shows up on a real repo: a depth-counting
      // scanner like `memberLevelBody`'s own brace walk, not a smarter regex.
      const lead = rest.match(/^(?:\s*@[\w.]+(?:\s*\([^)]*\))?)*/)![0];
      const decl = rest.slice(lead.length);
      const end = decl.search(/[;=(]/);
      if (end === -1 || decl[end] === "(") continue; // annotated getter/method: not handled
      const bare = decl
        .slice(0, end)
        .replace(/\b(?:final|private|protected|public|static|transient|volatile)\b/g, " ")
        .trim();
      const field = bare.match(/^([\w$.]+(?:\s*<.*>)?)\s+([\w$]+)$/s);
      if (!field) continue;
      const [, typeText, name] = field;
      const rawTarget = typeText.match(COLLECTION_RE)?.[1] ?? typeText.replace(/<.*>/s, "").trim();
      const joinColumn = lead.match(JOIN_COLUMN_RE)?.[1];
      relations.push({
        kind: "ENTITY_RELATION",
        family: "spring-data-jpa",
        sourceSymbolId: entity.id,
        targetLabel: rawTarget.slice(rawTarget.lastIndexOf(".") + 1),
        confidence: "unresolved", // provisional until resolveEntityRelations runs
        evidence: [
          `@${match[1]} on field ${name}`,
          ...explicitAttributes(match[2] ?? ""),
          ...(joinColumn !== undefined ? [`@JoinColumn(${joinColumn.trim()})`] : []),
        ],
        range: entity.range,
        filePath,
      });
    }
  }
  return relations;
}
```

Replace with:

```ts
function extractEntityRelations(symbols: SymbolRecord[], filePath: string, _source: string): EnterpriseRelation[] {
  const relations: EnterpriseRelation[] = [];
  const entities = symbols.filter((s) => s.filePath === filePath && s.kind === "class" && s.annotations.includes("@Entity"));
  for (const entity of entities) {
    const fields = symbols.filter((s) => s.kind === "field" && s.parentId === entity.id);
    for (const field of fields) {
      const relationName = field.annotations.map(bareName).find((name) => RELATION_ANNOTATIONS.has(name));
      if (!relationName) continue;

      const relationMatch = field.source.match(relationArgsRegex(relationName));
      const typeText = field.metadata?.declaredType ?? "";
      const rawTarget = typeText.match(COLLECTION_RE)?.[1] ?? typeText.replace(/<.*>/s, "").trim();

      const hasJoinColumn = field.annotations.some((a) => bareName(a) === "JoinColumn");
      const joinColumn = hasJoinColumn ? field.source.match(joinColumnArgsRegex())?.[1] : undefined;

      relations.push({
        kind: "ENTITY_RELATION",
        family: "spring-data-jpa",
        sourceSymbolId: entity.id,
        targetLabel: rawTarget.slice(rawTarget.lastIndexOf(".") + 1),
        confidence: "unresolved", // provisional until resolveEntityRelations runs
        evidence: [
          `@${relationName} on field ${field.name}`,
          ...explicitAttributes(relationMatch?.[1] ?? ""),
          ...(joinColumn !== undefined ? [`@JoinColumn(${joinColumn.trim()})`] : []),
        ],
        range: entity.range,
        filePath,
      });
    }
  }
  return relations;
}
```

- [ ] **Step 6: Confirm no remaining references to the deleted symbols.**

```
grep -n "memberLevelBody\|RELATION_RE\b\|JOIN_COLUMN_RE\b" src/languages/java/enterprise/jpa-entity.ts
```

Expected: no output (all three fully removed).

- [ ] **Step 7: Run to verify GREEN.**

```
npx tsx --test tests/java-enterprise-jpa-entity.test.ts
```

Expected: every existing test in this file UNCHANGED, plus all 3 new tests, all passing.

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
git add src/languages/java/enterprise/jpa-entity.ts tests/java-enterprise-jpa-entity.test.ts
git commit -m "feat(java): detect JPA entity relationships via AST field symbols"
```

---

### Task 2: Real-repository regression verification

**Files:**
- Modify (only if numbers genuinely change): `benchmarks/results/v1.4-phase4-jpa-spring-data.{json,md}`

**Interfaces:** Consumes Task 1's completed migration. Produces the evidence that the migration causes no regression (and reports any genuine improvement honestly, given the two diagnosed bugs it fixes) against the real-repository `entity_relation` benchmark, while confirming `repository_linkage` (an unrelated, untouched code path) stays byte-identical.

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

- [ ] **Step 3: Re-run `benchmark:v14-phase4`**, comparing against the CURRENTLY COMMITTED numbers in `benchmarks/results/v1.4-phase4-jpa-spring-data.json`:

```
npm run benchmark:v14-phase4
```

This report has TWO scoped metric groups — `entity_relation` (this plan's own scope) and `repository_linkage` (Phase 4b's future scope, `spring-data.ts`, untouched by this plan). For `entity_relation`: recall/precision must be EQUAL OR BETTER than currently committed, never worse — given this plan fixes two real, diagnosed bugs (nested-paren `@JoinColumn`, multi-declarator relationship fields), genuine improvement here is a real, plausible, welcome outcome (unlike Phases 2-3's own experience) — if you see improved numbers, identify and report the SPECIFIC relation(s) now correctly detected, don't just note "better." For `repository_linkage`: the numbers must be BYTE-IDENTICAL to currently committed — this plan makes no change to any code that path depends on, so any difference here would be a genuine, unexpected, concerning finding requiring investigation, not something to wave through.

If ANY `entity_relation` number regresses, STOP — investigate and report explicitly.

- [ ] **Step 4: If the numbers genuinely changed** (in `entity_relation` — `repository_linkage` should never change), regenerate the committed report file via the real script — leave it alone (`git diff` it, revert if only `generatedAt` changed) if the numbers are byte-identical.

- [ ] **Step 5: Run the full suite one final time** (same command as Step 1) → all green.

- [ ] **Step 6: Commit** (only if Step 4 produced a real change):

```bash
git add benchmarks/results/v1.4-phase4-jpa-spring-data.json benchmarks/results/v1.4-phase4-jpa-spring-data.md
git commit -m "chore(java): confirm JPA entity benchmark parity after AST migration"
```

If Step 4 found no genuine change (numbers byte-identical), skip this commit entirely — say so in your report rather than creating an empty or placeholder commit. Given the two diagnosed bugs this plan fixes, "no genuine change" would itself be a notable (if disappointing) finding worth reporting honestly — it would mean the real-repo corpus doesn't happen to contain either buggy pattern, mirroring Phases 2-3's own repeated experience with real-repo blind spots for synthetic-only-verified fixes.

---

### Task 3: Follow-up note

**Files:**
- Create: `docs/superpowers/plans/2026-09-30-java-jpa-entity-ast-migration-summary.md`

- [ ] **Step 1: Write a short summary doc** covering: what changed (field-level relationship-annotation detection now uses `SymbolRecord.annotations` directly; `memberLevelBody`/`RELATION_RE`/`JOIN_COLUMN_RE` deleted, replaced by `bareName()`/`relationArgsRegex()`/`joinColumnArgsRegex()`), the two real bugs this phase fixes (nested-paren `@JoinColumn`, multi-declarator relationship fields — cite Task 1's actual RED/GREEN evidence for both), what was verified (Task 2's real benchmark numbers for BOTH `entity_relation` and `repository_linkage` — cite them exactly, don't invent or round), and name Phase 4b (`spring-data.ts`) as the FINAL remaining sub-project in the entire roadmap — after Phase 4b, all five enterprise extractors will have been migrated off regex onto AST-derived symbols.
- [ ] **Step 2: Confirm the tree is clean and all tests pass** (same corrected full-suite command as Task 2 Step 1).
- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/plans/2026-09-30-java-jpa-entity-ast-migration-summary.md
git commit -m "docs: summarize Java JPA entity AST migration, Phase 4a complete"
```

## Self-review notes

- **Spec coverage:** the spec's Architecture section (field-symbol iteration, `relationArgsRegex`/`joinColumnArgsRegex`, `COLLECTION_RE`/`explicitAttributes()` reuse, the two diagnosed-bug fixes, the `sourceSymbolId` attribution preservation) maps to Task 1 Steps 3-5; the two bug-fix tests and the qualified-name test map to Task 1 Step 1; Acceptance items 1-3 map to Task 1's steps, item 4 (benchmark, with its two-scoped-metric-group nuance) maps to Task 2, item 5 (follow-up note) maps to Task 3.
- **Placeholder scan:** no TBD/TODO; every test and code block in Task 1 is complete, runnable code, hand-traced against the actual pre-migration file content read before writing this plan.
- **Type consistency:** `bareName`/`relationArgsRegex`/`joinColumnArgsRegex`'s signatures match how they're called in Step 5's replacement code exactly; `field.metadata?.declaredType` and `field.source` usage matches Phase 0's established `SymbolRecord` shape (`metadata` is optional, hence the `?.`); `sourceSymbolId: entity.id` (not `field.id`) is preserved exactly matching the original code's own attribution, verified against the actual current file content, not assumed.
- **Review Focus:** all five items (nested-paren fix proof, sourceSymbolId attribution, multi-declarator fix proof, no-JoinColumn evidence-array correctness via the existing unchanged test, dead-code cleanup) each map to a specific step or test in Task 1, confirmed line-by-line against the plan text above.
