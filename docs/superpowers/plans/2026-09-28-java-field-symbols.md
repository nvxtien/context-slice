# Java Field-Level AST Symbols Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `parseJava` emit real `field`-kind `SymbolRecord`s for Java class/interface/enum/record fields, using the existing tree-sitter AST walk — the foundational, standalone Phase 0 of a larger "migrate the enterprise extractors off regex" roadmap (Phases 1-5, each a separate future sub-project).

**Architecture:** Extend `walkTypes`'s existing member loop (already branching on `method_declaration`/`constructor_declaration`) with one more branch that handles both `field_declaration` (class/enum/record) and `constant_declaration` (interface — a distinct node type with an otherwise-identical shape, confirmed by direct grammar probing). A new `fieldSymbols(...)` function returns one `SymbolRecord` per `variable_declarator` (a single node can declare multiple fields: `private int a, b;`). No enterprise extractor is touched — this phase is purely additive infrastructure.

**Tech Stack:** TypeScript (ESM `.js` imports), `npx tsx --test`, `tree-sitter` + `tree-sitter-java` (already in use throughout `java-parser.ts` since the 2026-09-28 AST rewrite).

**Spec:** `docs/superpowers/specs/2026-09-28-java-field-symbols-design.md`

## Global Constraints

- `SymbolRecord` has no top-level `type` property — a field's declared type goes in `metadata.declaredType`, the SAME convention TypeScript (`src/languages/typescript/parse.ts`) and Python (`src/languages/python/parse.ts`) already use for exactly this purpose, and the same field TypeScript's own call-resolution already reads (`src/languages/typescript/resolve.ts:409`).
- `range`/`source` must preserve the codebase-wide invariant `symbol.source === fullSource.slice(range.start, range.end)`. A single-declarator field spans the WHOLE `field_declaration`/`constant_declaration` node (annotations included, like a method). A multi-declarator field's individual symbols each span only their OWN `variable_declarator` node (no overlapping ranges).
- Interface constants are a DIFFERENT AST node type (`constant_declaration`), not `field_declaration` — both must be handled by the member loop, sharing the same `fieldSymbols` builder (their internal shape is identical).
- Record canonical components (`record R(int x) {}`'s `x`) are NOT field symbols — they live in `formal_parameters`, a structurally different location than `field_declaration`. Static/instance initializer blocks are not fields either. Neither is in scope.
- No enterprise extractor (`spring-mvc.ts`, `dependency-injection.ts`, `transactions.ts`, `jpa-entity.ts`, `spring-data.ts`) changes in this plan.
- No change to call-extraction, `resolveCalls`, or `CallEdge`/the call graph.
- No change to TypeScript/Python/Rust adapters — Java only, per explicit user decision.
- Commit messages: short, single-line, imperative, no Co-Authored-By trailer (repo convention — every commit on `main` follows this).
- `INDEX_VERSION` (`src/storage/sqlite.ts`) must be bumped — check the current value yourself (`grep INDEX_VERSION src/storage/sqlite.ts`) before incrementing; do not assume it is still `"1.11.0"`.
- Real-repository benchmark acceptance bar for this phase: equal or better, never worse — since no extractor consumes field symbols yet, no *improvement* is expected from this phase's own benchmark numbers (that starts in Phase 1). Any regression must be diagnosed, never silently absorbed.

## Review Focus

1. **The `field_declaration` vs. `constant_declaration` grammar asymmetry** — a member loop that checks only `field_declaration` would silently produce zero field symbols for every interface constant, a common real-world pattern. This must have its own explicit test (Task 1's interface test).
2. **Multi-declarator fields producing overlapping or malformed ranges** — `private int a, b = 2;` is one AST node with two declarators; a naive implementation might emit two symbols both spanning the whole node (violating the range==source invariant) or attribute `b`'s initializer text incorrectly. Needs an explicit test verifying both symbols' `range`/`source` are correct and non-overlapping.
3. **Record canonical components being mistaken for fields** — since records are a late addition to Java and their component list superficially resembles a field list, an implementation using the wrong AST location (`formal_parameters` instead of only genuine `field_declaration` nodes in the record's `class_body`) would over-count. Needs an explicit negative test.
4. **Local variables inside method bodies leaking into field extraction** — since `field_declaration` and `local_variable_declaration` are different node types but a careless implementation might walk into method bodies at all (rather than staying member-level via `memberNodesOf`), this needs an explicit negative test proving the walk never descends into method/constructor bodies for field purposes.
5. **`assignDedupIds` breaking for existing method/constructor dedup behavior** when fields are added to its ordering — since fields share the `canonicalId` machinery with every other kind, adding them to `assignDedupIds`'s `dedupOrder` construction must not change the existing suffix assignment for non-field symbols in any existing test. Task 1's own test run against the full existing Task 1/2 test files (not just the new field test file) covers this implicitly, but the implementer should watch for it explicitly since it's an easy thing to get subtly wrong (e.g., forgetting to sort fields by `byRange` before inserting them, which could perturb the array's iteration order if `dedupOrder` used a different collection strategy than a simple `[...a, ...b, ...c]` spread).

---

### Task 1: Field-symbol extraction (TDD)

**Files:**
- Modify: `src/parser/java-parser.ts`
- Test: `tests/java-parser-ast-fields.test.ts` (new)

**Interfaces:**
- Consumes: the existing `walkTypes`, `memberNodesOf`, `modifiersNodeParts`, `canonicalId`, `sourceRange`, `byRange`, `assignDedupIds` functions already in `java-parser.ts` (all unchanged in signature; `assignDedupIds` gets one new line of logic, not a signature change).
- Produces: `fieldSymbols(node: Node, parent: SymbolRecord, typeChain: string[], filePath: string, source: string, packageName: string): SymbolRecord[]` — a new function, following the exact parameter order and naming convention `methodSymbol`/`constructorSymbol` already establish (only the return type differs: plural, since one node can produce multiple symbols).

- [ ] **Step 1: Write the failing tests.** Create `tests/java-parser-ast-fields.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";

test("a single annotated field is extracted as a field symbol, source includes its annotation", () => {
  const source = "class Foo {\n    @Autowired\n    private UserRepository userRepository;\n}";
  const { symbols } = parseJava("Foo.java", source);
  const foo = symbols.find((s) => s.kind === "class" && s.name === "Foo")!;
  const field = symbols.find((s) => s.kind === "field")!;
  assert.equal(field.name, "userRepository");
  assert.equal(field.metadata?.declaredType, "UserRepository");
  assert.equal(field.signature, "userRepository: UserRepository");
  assert.deepEqual(field.annotations, ["@Autowired"]);
  assert.deepEqual(field.modifiers, ["private"]);
  assert.equal(field.parentId, foo.id);
  assert.equal(field.bodyRange, undefined);
  assert.equal(field.body, undefined);
  assert.ok(field.source.includes("@Autowired"), "single-declarator field source must include its own annotation");
  assert.ok(field.source.includes("userRepository"));
});

test("a field's source exactly matches its own range slice (the codebase-wide range==source invariant)", () => {
  const source = "class Foo {\n    @Autowired\n    private UserRepository userRepository;\n}";
  const { symbols } = parseJava("Foo.java", source);
  const field = symbols.find((s) => s.kind === "field")!;
  const lines = source.split("\n");
  const startOffset = lines.slice(0, field.range.startLine - 1).reduce((n, l) => n + l.length + 1, 0) + field.range.startColumn;
  const endOffset = lines.slice(0, field.range.endLine - 1).reduce((n, l) => n + l.length + 1, 0) + field.range.endColumn;
  assert.equal(field.source, source.slice(startOffset, endOffset));
});

test("multi-declarator fields produce two distinct, non-overlapping symbols sharing type and modifiers", () => {
  const source = "class Foo {\n    private int a, b = 2;\n}";
  const { symbols } = parseJava("Foo.java", source);
  const fields = symbols.filter((s) => s.kind === "field");
  assert.equal(fields.length, 2);
  const [a, b] = fields;
  assert.equal(a.name, "a");
  assert.equal(b.name, "b");
  assert.equal(a.metadata?.declaredType, "int");
  assert.equal(b.metadata?.declaredType, "int");
  assert.deepEqual(a.modifiers, ["private"]);
  assert.deepEqual(b.modifiers, ["private"]);
  assert.equal(a.source, "a");
  assert.equal(b.source, "b = 2");
  const aEndsBeforeBStarts =
    a.range.endLine < b.range.startLine ||
    (a.range.endLine === b.range.startLine && a.range.endColumn <= b.range.startColumn);
  assert.ok(aEndsBeforeBStarts, "the two declarators' ranges must not overlap");
});

test("a generic field type is kept whole in metadata.declaredType, not stripped", () => {
  const source = 'class Foo {\n    @Column(name = "x")\n    List<Pet> pets;\n}';
  const { symbols } = parseJava("Foo.java", source);
  const field = symbols.find((s) => s.kind === "field")!;
  assert.equal(field.metadata?.declaredType, "List<Pet>");
});

test("an interface constant is extracted as a field symbol despite using a different AST node type", () => {
  const source = "interface I {\n    int X = 1;\n}";
  const { symbols } = parseJava("I.java", source);
  const iface = symbols.find((s) => s.kind === "interface")!;
  const field = symbols.find((s) => s.kind === "field")!;
  assert.equal(field.name, "X");
  assert.equal(field.metadata?.declaredType, "int");
  assert.equal(field.parentId, iface.id);
});

test("an enum's own field (declared after its constants) is extracted", () => {
  const source = "enum Status {\n    ACTIVE, INACTIVE;\n    private final String label;\n}";
  const { symbols } = parseJava("Status.java", source);
  const en = symbols.find((s) => s.kind === "enum")!;
  const field = symbols.find((s) => s.kind === "field")!;
  assert.equal(field.name, "label");
  assert.equal(field.metadata?.declaredType, "String");
  assert.equal(field.parentId, en.id);
});

test("a record's real explicit field is extracted, but its canonical components are not", () => {
  const source = "record R(int x, String y) {\n    private static int counter;\n}";
  const { symbols } = parseJava("R.java", source);
  const fields = symbols.filter((s) => s.kind === "field");
  assert.equal(fields.length, 1, "only the real explicit field, never x/y from the record header");
  assert.equal(fields[0].name, "counter");
});

test("a local variable inside a method body is never extracted as a field", () => {
  const source = "class Foo {\n    void m() {\n        int local = 1;\n    }\n}";
  const { symbols } = parseJava("Foo.java", source);
  assert.equal(symbols.filter((s) => s.kind === "field").length, 0);
});

test("a multi-line annotation argument on a field is not lost (the same bug class the parent AST rewrite fixed for types/methods)", () => {
  const source = [
    "class Foo {",
    "    @SuppressWarnings(",
    '        value = "unchecked"',
    "    )",
    "    private Object raw;",
    "}",
  ].join("\n");
  const { symbols } = parseJava("Foo.java", source);
  const field = symbols.find((s) => s.kind === "field")!;
  assert.deepEqual(field.annotations, ["@SuppressWarnings"]);
  assert.ok(field.source.includes("value"), "the whole multi-line annotation argument must be in the field's own source");
});
```

- [ ] **Step 2: Run to verify RED.**

```
npx tsx --test tests/java-parser-ast-fields.test.ts
```

Expected: all 9 tests fail (no `field`-kind symbols exist yet, `symbols.find((s) => s.kind === "field")` returns `undefined`, causing a `TypeError` on the `!` non-null assertion or the subsequent property access). Report the actual failures honestly.

- [ ] **Step 3: Implement `fieldSymbols`.** Add this function to `src/parser/java-parser.ts`, placed after `constructorSymbol` and before `byRange` (matching the file's existing top-to-bottom ordering: type walk, then per-kind builders, then dedup):

```ts
/**
 * A field_declaration (class/enum/record) or constant_declaration (interface — a
 * different node type with an identical internal shape) can carry multiple
 * variable_declarator children (`private int a, b;`), so this returns one SymbolRecord
 * per declarator, all sharing the same declared type/annotations/modifiers. A field has
 * no top-level `type` property on SymbolRecord (only methods put a type-like thing in
 * `.signature`); the declared type goes in `metadata.declaredType`, the same convention
 * the TypeScript and Python adapters already use.
 */
function fieldSymbols(
  node: Node,
  parent: SymbolRecord,
  typeChain: string[],
  filePath: string,
  source: string,
  packageName: string,
): SymbolRecord[] {
  const declaredType = node.childForFieldName("type")!.text;
  const modifiersNode = node.namedChildren.find((c) => c.type === "modifiers");
  const { annotations, modifiers } = modifiersNodeParts(modifiersNode);
  const declarators = node.namedChildren.filter((c) => c.type === "variable_declarator");
  const single = declarators.length === 1;
  return declarators.map((declarator) => {
    const name = declarator.childForFieldName("name")!.text;
    const start = single ? node.startIndex : declarator.startIndex;
    const end = single ? node.endIndex : declarator.endIndex;
    const canonicalIdentity = canonicalId(filePath, packageName, typeChain, "field", name);
    return {
      id: canonicalIdentity,
      language: "java",
      kind: "field",
      name,
      packageName,
      qualifiedName: `${packageName ? `${packageName}.` : ""}${[...typeChain, name].join(".")}`,
      canonicalIdentity,
      signature: `${name}: ${declaredType}`,
      filePath,
      range: sourceRange(source, start, end),
      bodyRange: undefined,
      parentId: parent.id,
      annotations,
      modifiers,
      metadata: { declaredType },
      source: source.slice(start, end),
      body: undefined,
    };
  });
}
```

- [ ] **Step 4: Wire `fieldSymbols` into `walkTypes`'s member loop.** In `walkTypes`, find the existing block:

```ts
      for (const member of memberNodesOf(bodyNode)) {
        if (member.type === "method_declaration") {
          symbols.push(
            methodSymbol(member, symbol, typeChain, filePath, source, packageName),
          );
        } else if (member.type === "constructor_declaration") {
          symbols.push(
            constructorSymbol(member, symbol, typeChain, filePath, source, packageName),
          );
        }
      }
```

Add a third branch:

```ts
      for (const member of memberNodesOf(bodyNode)) {
        if (member.type === "method_declaration") {
          symbols.push(
            methodSymbol(member, symbol, typeChain, filePath, source, packageName),
          );
        } else if (member.type === "constructor_declaration") {
          symbols.push(
            constructorSymbol(member, symbol, typeChain, filePath, source, packageName),
          );
        } else if (member.type === "field_declaration" || member.type === "constant_declaration") {
          symbols.push(
            ...fieldSymbols(member, symbol, typeChain, filePath, source, packageName),
          );
        }
      }
```

- [ ] **Step 5: Update `assignDedupIds` to include fields.** Change:

```ts
function assignDedupIds(symbols: SymbolRecord[], types: SymbolRecord[]): void {
  const methods = symbols.filter((s) => s.kind === "method").sort(byRange);
  const constructors = symbols
    .filter((s) => s.kind === "constructor")
    .sort(byRange);
  const dedupOrder = [...types, ...methods, ...constructors];
```

to:

```ts
function assignDedupIds(symbols: SymbolRecord[], types: SymbolRecord[]): void {
  const fields = symbols.filter((s) => s.kind === "field").sort(byRange);
  const methods = symbols.filter((s) => s.kind === "method").sort(byRange);
  const constructors = symbols
    .filter((s) => s.kind === "constructor")
    .sort(byRange);
  const dedupOrder = [...types, ...fields, ...methods, ...constructors];
```

Also update the docstring comment directly above `assignDedupIds` (currently describing only "types, then methods, then constructors") to mention fields are included too, inserted after types and before methods — one sentence is enough, e.g. append: `" Fields (a new symbol kind with no old-parser precedent to match) are included in this same ordering, inserted after types and before methods — the exact position has no behavioral significance since there is no legacy ordering to preserve for fields, but must stay consistent."`

- [ ] **Step 6: Run to verify GREEN.**

```
npx tsx --test tests/java-parser-ast-fields.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 7: Run the broader scoped regression set** (the four hang-prone files documented in the prior AST-rewrite plan's SDD ledger — `mcp-stdio.test.ts`, `rust-product-surface.test.ts`, `typescript.test.ts`, `workflow-benchmark.test.ts` — must still be excluded; they hang for pre-existing, unrelated-to-Java worktree environment reasons):

```
npx tsx --test tests/java-parser-ast-fields.test.ts tests/java-parser-ast-types.test.ts tests/java-parser-ast-methods.test.ts tests/java-*.test.ts tests/parser.test.ts tests/index.test.ts tests/composition.test.ts tests/enterprise-relation.test.ts tests/enterprise-relations-indexer.test.ts
```

Expected: every test passes — this confirms adding a new symbol kind doesn't perturb the existing type/method/constructor dedup or extraction tests (Review Focus item 5).

- [ ] **Step 8: Commit.**

```bash
git add src/parser/java-parser.ts tests/java-parser-ast-fields.test.ts
git commit -m "feat(java): extract field-level AST symbols"
```

---

### Task 2: Real-repository regression verification

**Files:**
- Modify: `src/storage/sqlite.ts` (`INDEX_VERSION` bump, this commit)
- Modify (only if numbers genuinely change): `benchmarks/results/*.json`, `benchmarks/results/*.md`

**Interfaces:** Consumes Task 1's completed field-symbol extraction. Produces the evidence that adding field symbols to the index causes no regression in anything currently measured.

- [ ] **Step 1: Confirm the full suite is green**, using the corrected exclusion command (do NOT run plain `npm test` — it includes the four hang-prone files):

```
npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")
```

Report the exact pass/fail counts. Expect the same 6 pre-existing, unrelated failures (`tests/cli.test.ts` ×5, `tests/package-metadata.test.ts` ×1 — both fail fast with ENOENT against a broken worktree-relative `node_modules/.bin/tsx` path, a pre-existing environment limitation of running tests inside a git worktree, documented in the prior AST-rewrite plan's SDD ledger) and zero NEW failures.

- [ ] **Step 2: Bump `INDEX_VERSION`.** Check the current value first:

```
grep INDEX_VERSION src/storage/sqlite.ts
```

Increment it by a minor version bump (e.g. `"1.11.0"` → `"1.12.0"`, adjusted to whatever the actual current value is) in `src/storage/sqlite.ts`.

- [ ] **Step 3: Re-run every real-repository benchmark that touches Java**, comparing against the CURRENTLY COMMITTED numbers (never a re-derived "expected" number):

```
npm run benchmark:v03
npm run benchmark:v14-phase1
npm run benchmark:v14-phase2
npm run benchmark:v14-phase3
npm run benchmark:v14-phase4
```

(Confirm these are still the correct script names via `package.json` before running — do not assume.) For each: recall/precision/reduction numbers must be EQUAL OR BETTER than currently committed, never worse (no improvement is expected or required at this phase — only no regression, since no extractor consumes field symbols yet). If ANY number regresses, STOP — do not proceed to Step 4. Investigate: since this phase only ADDS new symbols to the index and touches no existing extraction logic for types/methods/constructors, a regression here would be a surprising, real finding (e.g., a benchmark's token-budget slicing logic picking up extra field symbols it wasn't expecting and crowding out something else) — diagnose and report it explicitly, never silently absorb it.

- [ ] **Step 4: If every number is unchanged or improved**, regenerate the affected committed report files via their real scripts ONLY if any number actually changed — leave reports whose numbers are byte-for-byte identical alone (`git diff` each regenerated file; revert any that changed only `generatedAt` with identical numbers).

- [ ] **Step 5: Run the full suite one final time** (same corrected exclusion command as Step 1) → all green (same 6 pre-existing failures, zero new ones).

- [ ] **Step 6: Commit.**

```bash
git add src/storage/sqlite.ts benchmarks/results/*.json benchmarks/results/*.md
git commit -m "chore(java): bump index version for field-symbol extraction"
```

(Only include report files that genuinely changed, per Step 4.)

---

### Task 3: Follow-up note

**Files:**
- Create: `docs/superpowers/plans/2026-09-28-java-field-symbols-summary.md`

- [ ] **Step 1: Write a short summary doc** covering: what changed (field-level `SymbolRecord`s now exist for Java, populated via the same AST walk as types/methods/constructors; `metadata.declaredType` convention used, matching TypeScript/Python), what was verified (Task 2's benchmark results — no regression), and explicitly name that this is Phase 0 of a larger roadmap: Phase 1 (migrating `dependency-injection.ts` to consume field symbols instead of its own regex-based `memberLevelBody`/`INJECT_RE` scan) is the next sub-project, to be brainstormed and specced separately, followed by Phases 2-5 (the remaining four enterprise extractors) in whatever order Phase 1's own findings suggest.
- [ ] **Step 2: Confirm the tree is clean and all tests pass** (same corrected full-suite command as Task 2 Step 1).
- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/plans/2026-09-28-java-field-symbols-summary.md
git commit -m "docs: summarize Java field-symbol extraction, Phase 0 complete"
```

## Self-review notes

- **Spec coverage:** every section of `2026-09-28-java-field-symbols-design.md` maps to a task step — Symbol shape and Multi-declarator handling to Task 1 Steps 3-4, Id-dedup ordering to Task 1 Step 5, Testing to Task 1 Steps 1-2/6-7, Acceptance/Definition of Done items 1-3 to Task 1 Step 7 and Task 2 Steps 1-2/5, item 4 to Task 2 Step 3, item 5 to Task 3.
- **Placeholder scan:** no TBD/TODO/"implement later" text anywhere in the plan; every test in Task 1 Step 1 is complete, runnable code with real assertions (an earlier draft of this plan briefly left a malformed placeholder assertion in the first test with a "fix it in a later step" note — caught during this self-review and corrected in place, since that pattern is exactly what the "No Placeholders" rule forbids).
- **Type consistency:** `fieldSymbols`'s parameter order/names (`node, parent, typeChain, filePath, source, packageName`) exactly match `methodSymbol`/`constructorSymbol`'s existing signatures; its call site in Task 1 Step 4 matches this exactly; `metadata.declaredType` matches the exact property path already used by `src/languages/typescript/parse.ts` and consumed by `src/languages/typescript/resolve.ts:409`, confirmed by direct inspection, not assumed.
- **Review Focus:** all five items (grammar asymmetry, multi-declarator ranges, record canonical components, local-variable leakage, dedup-ordering safety) each have a dedicated test in Task 1 Step 1, confirmed line-by-line against the test code above.
