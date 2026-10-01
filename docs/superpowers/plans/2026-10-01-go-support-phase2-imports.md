# Go Language Support — Phase 2 (Imports and Export Visibility) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Go adapter (`src/languages/go/parse.ts`) to extract `ImportRecord`s from `import` declarations, and mark every exported (capitalized) symbol with `"exported"` in its `modifiers` array — then validate against the same three real, pinned Go repositories via an extended benchmark.

**Architecture:** One new top-level loop over `import_declaration` children (handling both single-spec and grouped `import_spec_list` shapes) produces `ImportRecord`s. Every existing symbol-building branch gains one line computing `modifiers` from the symbol's own name instead of hardcoding `[]`. No `ExportRecord`s are emitted — Go has no re-export mechanism, so (per the spec's own investigation of `src/languages/rust/parse.ts`'s precedent) there is nothing for `ExportRecord` to model.

**Tech Stack:** TypeScript, `tree-sitter` + `tree-sitter-go`, Node's built-in test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-10-01-go-support-phase2-imports-design.md`

## Global Constraints

- No `ExportRecord`s emitted this phase — confirmed in the spec, not a gap to "complete."
- `modifiers` gains its first-ever real value (`"exported"`) — every symbol-building branch currently hardcodes `modifiers: []`; this task replaces each with a computed value, never leaves any branch still hardcoded.
- Import mapping (verified against live `tree-sitter-go@0.23.4` grammar during spec-writing):
  - `name` field absent or `package_identifier` → `kind: "namespace"`.
  - `name` field is `blank_identifier` → `kind: "side-effect"`.
  - `name` field is `dot` → `kind: "namespace"`, `wildcard: true`, no `localName`.
  - `path` field is always `interpreted_string_literal`; its text with surrounding quotes stripped (or read its `interpreted_string_literal_content` child directly) is the import path.
- Do not touch `canonicalId`, `receiverBaseTypeName`, the struct/interface/type/const/var extraction logic, or the two-pass method-linkage structure — only add the import loop and the `modifiers` computation.
- Full test suite runs: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`.

## Review Focus

- A grouped `import (...)` block with multiple specs must produce one `ImportRecord` PER spec — Task 1's tests pin this (same discipline Phase 1 already pinned for grouped `type`/`const`/`var`).
- A dot import's `wildcard: true` must be set WITHOUT a `localName` (not an empty string, `undefined`) — Task 1's tests pin this.
- An unexported symbol (lowercase first letter) must NOT have `"exported"` in `modifiers` — Task 1's tests pin this as a negative case, not just the positive case.
- A struct with a mix of exported and unexported fields must correctly mark only the exported ones — Task 1's tests pin this (proves the modifier logic is per-symbol, not file-wide).

---

### Task 1: Import extraction and export-visibility modifiers

**Files:**
- Modify: `src/languages/go/parse.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Produces: `parseGo`'s `imports` array is now populated (previously always `[]`); every symbol's `modifiers` may now contain `"exported"`.
- Consumes: Phase 1's `parseGo` structure as it currently exists (read the file first — it has evolved since Phase 1's own plan via a final-review fix wave; the current file's `modifiers: []` occurrences are at these locations: the function branch, the struct branch, the field branch, the interface branch, the type-alias branch, the const/var branch, and the method branch — seven total, confirm this count by grepping `modifiers: \[\]` in the file before starting, don't assume seven is still exactly right if something changed).

- [ ] **Step 1: Write the failing tests for Task 1's scope**

Add to `tests/go.test.ts` (read the file first to match its exact style and the `parseGo`/`adapterFor` import pattern already established):

```ts
test("a plain import produces a namespace ImportRecord", () => {
  const parsed = parseGo("main.go", `package main\n\nimport "fmt"\n\nfunc main() {}\n`);
  const imp = parsed.imports.find((i) => i.module === "fmt");
  assert.ok(imp, "expected an import record for fmt");
  assert.equal(imp!.kind, "namespace");
});

test("an aliased import carries its alias as localName", () => {
  const parsed = parseGo("main.go", `package main\n\nimport f "fmt"\n\nfunc main() {}\n`);
  const imp = parsed.imports.find((i) => i.module === "fmt");
  assert.equal(imp!.localName, "f");
});

test("a blank import is a side-effect import", () => {
  const parsed = parseGo("main.go", `package main\n\nimport _ "net/http/pprof"\n\nfunc main() {}\n`);
  const imp = parsed.imports.find((i) => i.module === "net/http/pprof");
  assert.ok(imp, "expected an import record");
  assert.equal(imp!.kind, "side-effect");
});

test("a dot import is a wildcard namespace import with no localName", () => {
  const parsed = parseGo("main.go", `package main\n\nimport . "math"\n\nfunc main() {}\n`);
  const imp = parsed.imports.find((i) => i.module === "math");
  assert.ok(imp, "expected an import record");
  assert.equal(imp!.wildcard, true);
  assert.equal(imp!.localName, undefined);
});

test("a grouped import block produces one record per spec", () => {
  const source = `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {}\n`;
  const parsed = parseGo("main.go", source);
  const fmtImp = parsed.imports.find((i) => i.module === "fmt");
  const osImp = parsed.imports.find((i) => i.module === "os");
  assert.ok(fmtImp && osImp, "expected both fmt and os as separate import records");
});

test("an exported function has 'exported' in its modifiers", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n`);
  const fn = parsed.symbols.find((s) => s.name === "Add");
  assert.ok(fn!.modifiers.includes("exported"));
});

test("an unexported function does not have 'exported' in its modifiers", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n`);
  const fn = parsed.symbols.find((s) => s.name === "add");
  assert.equal(fn!.modifiers.includes("exported"), false);
});

test("a struct's exported and unexported fields are marked independently", () => {
  const source = `package main\n\ntype User struct {\n\tName string\n\tsecret string\n}\n`;
  const parsed = parseGo("user.go", source);
  const nameField = parsed.symbols.find((s) => s.kind === "field" && s.name === "Name");
  const secretField = parsed.symbols.find((s) => s.kind === "field" && s.name === "secret");
  assert.ok(nameField!.modifiers.includes("exported"));
  assert.equal(secretField!.modifiers.includes("exported"), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts`

Expected: the new import tests FAIL (`parsed.imports` is always `[]` currently) and the new modifiers tests FAIL (`modifiers` is always `[]` currently); all pre-existing tests still PASS.

- [ ] **Step 3: Add the `modifiersFor` helper and apply it to every symbol branch**

In `src/languages/go/parse.ts`, add near the other small helpers (after `canonicalId`):

```ts
function modifiersFor(name: string): string[] {
  return /^[A-Z]/.test(name) ? ["exported"] : [];
}
```

Then replace EVERY occurrence of `modifiers: [],` in the file with the computed version, using whichever name variable is in scope at that point:

- Function branch: `modifiers: modifiersFor(name),`
- Struct (`class`) branch: `modifiers: modifiersFor(name),`
- Field branch (inside the struct branch): `modifiers: modifiersFor(fieldName),`
- Interface branch: `modifiers: modifiersFor(name),`
- Type-alias/defined-type (`else`) branch: `modifiers: modifiersFor(name),`
- Const/var branch: `modifiers: modifiersFor(name),`
- Method branch (second pass, at the bottom): `modifiers: modifiersFor(name),` (use the method's own `name`, not `qualifiedName` — a method named `validate` on an exported struct `User` is itself still unexported; Go's visibility is per-identifier, not inherited from the receiver type).

Grep `modifiers: \[\]` in the file after this step — it must return ZERO matches; every branch must now compute its own value.

- [ ] **Step 4: Add the import-extraction loop**

In `src/languages/go/parse.ts`, inside `parseGo`'s main `for (const child of tree.rootNode.namedChildren)` loop, add a new branch (order relative to the others doesn't matter — Go has no ordering dependency between imports and declarations):

```ts
    } else if (child.type === "import_declaration") {
      const specs = child.namedChildren.flatMap((c) =>
        c.type === "import_spec_list"
          ? c.namedChildren.filter((s) => s.type === "import_spec")
          : c.type === "import_spec"
            ? [c]
            : [],
      );
      for (const spec of specs) {
        const pathNode = field(spec, "path");
        const module = text(pathNode?.namedChild(0) ?? pathNode).replace(/^["']|["']$/g, "");
        if (!module) continue;
        const nameNode = field(spec, "name");
        if (nameNode?.type === "blank_identifier") {
          imports.push({
            filePath,
            language: LANGUAGE_ID,
            module,
            kind: "side-effect",
            typeOnly: false,
            range: range(spec),
          });
        } else if (nameNode?.type === "dot") {
          imports.push({
            filePath,
            language: LANGUAGE_ID,
            module,
            kind: "namespace",
            typeOnly: false,
            wildcard: true,
            range: range(spec),
          });
        } else {
          imports.push({
            filePath,
            language: LANGUAGE_ID,
            module,
            kind: "namespace",
            typeOnly: false,
            localName: nameNode?.type === "package_identifier" ? nameNode.text : undefined,
            range: range(spec),
          });
        }
      }
    }
```

Note: `text(pathNode?.namedChild(0) ?? pathNode)` reaches `interpreted_string_literal_content`'s already-unquoted text when present, falling back to the full literal with manual quote-stripping only if the content child is somehow absent (defensive, matches this codebase's general style of not assuming a single grammar path without a fallback — verify directly whether `pathNode.namedChild(0)` reliably returns the content node by running the Step 1 tests; if the primary path already works cleanly, the fallback is dead code you may simplify away, but verify before deleting it).

- [ ] **Step 5: Run the tests to verify all pass**

Run: `npx tsx --test tests/go.test.ts`

Expected: all tests (18 from Phase 1's final state + 8 new) PASS.

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`

Expected: PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/languages/go/parse.ts tests/go.test.ts
git commit -m "feat(go): extract imports and mark exported symbols"
```

---

### Task 2: Extend the real-repo benchmark

**Files:**
- Modify: `benchmarks/v1.6-go-support.ts`
- Modify (regenerated): `benchmarks/results/v1.6-go-support.{json,md}`

**Interfaces:**
- Consumes: Task 1's completed `parseGo`.
- Produces: an extended oracle covering imports and exported/unexported symbols, still 100% on the existing symbol-kind entries (no regression).

- [ ] **Step 1: Read real import statements and exported/unexported pairs from the checkouts**

The three repos are already fetched at `benchmarks/checkouts/pkg-errors`, `benchmarks/checkouts/cobra`, `benchmarks/checkouts/chi` (re-run `npx tsx benchmarks/fetch-checkouts.ts` if they're missing in this worktree). Read 1-2 files per repo and note: a real import path actually used (e.g. `pkg-errors/errors.go` imports `"fmt"` and `"io"`), and confirm the existing oracle's exported/unexported symbol names are already correct per Go's capitalization rule (they should be, since every existing oracle entry was hand-picked from real exported identifiers — but verify at least one genuinely unexported identifier exists in these files for a negative-case oracle entry, e.g. a lowercase helper function).

- [ ] **Step 2: Extend the `OracleSymbol` type and oracle entries**

In `benchmarks/v1.6-go-support.ts`, broaden the type and comparison logic to optionally check imports and modifiers:

```ts
type OracleSymbol = { name: string; kind: string; exported?: boolean };
type OracleImport = { module: string; kind: string };
```

Add an `imports: Record<string, OracleImport[]>` map alongside the existing `oracles` map, with 2-3 real, hand-verified import entries per repo (e.g. `{ module: "fmt", kind: "namespace" }` for `pkg-errors`, which does `import "fmt"` in `errors.go` — verify this import actually exists in the real file before adding it).

For existing `oracles[repo.id]` entries, add `exported: true` to each (every existing entry is a capitalized, genuinely-exported identifier — this is a cheap, free addition since the oracle already only contains exported names). Add at least one NEW entry per repo with `exported: false` for a genuinely unexported identifier you found in Step 1.

- [ ] **Step 3: Extend the comparison loop**

Update the scoring loop to also check `kind: "field"` entries' `exported` flag against the symbol's `modifiers.includes("exported")`, and to check each `OracleImport` entry is found among `index.imports` (module + kind match). Report found/total for symbols and imports separately in the console output and the written JSON (e.g. `results[repo.id] = { symbolsTotal, symbolsFound, importsTotal, importsFound, missing: [...] }`).

- [ ] **Step 4: Run the benchmark and record results**

Run: `npm run benchmark:v16`

All existing symbol-kind oracle entries must still be found (100%, no regression from Task 1's changes). New import and exported/unexported entries must also be found — if any is missing, investigate whether it's a real adapter bug (fix it, per Task 1's constraints) or a bad oracle entry (fix the oracle) before committing; do not silently drop an entry to inflate the number.

Update `benchmarks/results/v1.6-go-support.md` to reflect the new import/exported-visibility coverage.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/v1.6-go-support.ts benchmarks/results/v1.6-go-support.json benchmarks/results/v1.6-go-support.md
git commit -m "test(go): extend Phase 2 benchmark with imports and export visibility"
```

---

### Task 3: Follow-up summary

**Files:**
- Create: `docs/superpowers/plans/2026-10-01-go-support-phase2-imports-summary.md`

**Interfaces:**
- Consumes: Tasks 1-2's commits and benchmark results.

- [ ] **Step 1: Write the summary document**

```markdown
# Go Language Support Phase 2 Complete: Imports and Export Visibility

**Spec:** `docs/superpowers/specs/2026-10-01-go-support-phase2-imports-design.md`
**Plan:** `docs/superpowers/plans/2026-10-01-go-support-phase2-imports.md`

## What was built

`import` declaration extraction (plain, aliased, blank, dot, and grouped
forms) into `ImportRecord`s, and export-visibility marking (`"exported"`
in `modifiers`) for every Go symbol kind based on Go's capitalization
convention. No `ExportRecord`s are emitted — Go has no re-export
mechanism for them to model (confirmed by investigating the Rust
adapter's own precedent before writing the spec).

## Test evidence

[Task 1 commit hash, final test count, full-suite pass/fail summary.]

## Real-repo benchmark

[Task 2's found/total for both the pre-existing symbol oracle (must stay
100%) and the new import/exported-visibility oracle entries.]

## Roadmap status

Phase 2 of 3-4 complete. Next: Phase 3 (call-edge extraction and
resolution, including the cross-file import resolution Phase 2
deliberately deferred — resolving an import's `module` to an actual
project file, and a plain import's real local binding name via the
imported package's own declared `package` clause).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-01-go-support-phase2-imports-summary.md
git commit -m "docs: summarize Go support Phase 2 (imports and export visibility)"
```
