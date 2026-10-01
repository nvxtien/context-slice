# Go Language Support — Phase 3b (Call Resolution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Go adapter's `resolveCalls` (currently a no-op) a real body: same-package direct-call resolution, import-based package-qualified resolution, and basic receiver-type-based method resolution — then validate against the same three real, pinned Go repositories via an extended benchmark.

**Architecture:** A new `src/languages/go/resolve.ts` exports `resolveGoCalls(context: ResolveContext)`, wired into `src/languages/go/index.ts`'s `resolveCalls` field. `ResolveContext` (confirmed in `src/indexer/index.ts`) already hands each adapter only ITS OWN language's `symbols`/`calls`/`imports`/`exports`, pre-filtered to not-yet-resolved calls, plus `root` (the repo's absolute path) — no `ResolveContext` changes needed. Resolution mutates each matching `CallEdge` object in place (`resolvedTargetId`, `resolutionKind`, `confidence`, `evidence`), mirroring `src/languages/typescript/resolve.ts`'s own `settle()` helper pattern exactly.

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test`), `node:fs`/`node:path` for `go.mod` reading and directory grouping — no tree-sitter grammar work this phase (Phase 3b operates entirely on Phase 1-3a's already-extracted `SymbolRecord`/`ImportRecord`/`CallEdge` data).

**Spec:** `docs/superpowers/specs/2026-10-02-go-support-phase3b-call-resolution-design.md`

## Global Constraints

- No new `ResolutionKind`/`CallConfidence` values — reuse existing ones: `"same-file"` for same-directory direct calls, `"imported"` for import-resolved package-qualified calls, `"same-type"` for receiver-type method calls (all three already exist in `src/types/model.ts`, confirmed before writing this plan).
- Every resolution strategy must leave an edge `"unresolved"` on ANY ambiguity (multiple candidates) rather than guessing — this is the binding discipline every prior phase's resolver in this project follows (Rust, Python, TypeScript all do this).
- `resolveGoCalls` must NOT touch `calleeName`/`receiverText`/`argumentCount`/`evidence`'s first entry (Phase 3a's own extraction evidence) — only APPEND to `evidence`, never replace the array wholesale (mirrors the spec's `settle()` helper, which should push/append, not overwrite Phase 3a's `"syntactic call"` entry — this is a plan-level refinement beyond the spec's own illustrative `call.evidence = [evidence]`; the plan's own code below appends correctly: `call.evidence = [...call.evidence, evidence]`).
- Go's package membership is per-DIRECTORY (`dirname(filePath)`), never by matching `package`-clause name strings across directories — two different directories can legally declare the same package name and are still different packages.
- Do not touch `src/languages/go/parse.ts` — this phase is resolve-only.
- Full test suite runs: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`.

## Review Focus

- A direct call resolving to a function in a DIFFERENT directory (even same package-clause name) must NOT resolve — Task 1's tests pin this.
- A package-qualified call to an UNEXPORTED name in the target package must NOT resolve via the import strategy (Go's own visibility rule forbids it) — Task 2's tests pin this.
- A package-qualified call whose import is EXTERNAL (not under this project's own `go.mod` module path) must set `externalPackage` and stay unresolved, never guessed — Task 2's tests pin this.
- A method call via a REASSIGNED or AMBIGUOUS local variable binding must stay unresolved — Task 3's tests pin this (mirrors Python's `bindingClass` same discipline).
- A method call via the enclosing method's OWN receiver variable (`u.other()` inside `func (u *User) X()`) must resolve using Phase 1's existing `supertypes` data with no body-regex needed — Task 3's tests pin this as the cheapest, most reliable case.

---

### Task 1: `go.mod` parsing, directory grouping, and same-package direct-call resolution

**Files:**
- Create: `src/languages/go/resolve.ts`
- Modify: `src/languages/go/index.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Produces: `resolveGoCalls(context: ResolveContext): void`, wired as the adapter's `resolveCalls`.
- Consumes: Phase 1-3a's `parseGo` output as already indexed (no changes needed there).

- [ ] **Step 1: Write the failing tests for Task 1's scope**

These tests need multi-file resolution, so they use `ProjectIndex` against real files on disk, mirroring the pattern `tests/typescript.test.ts` already establishes (read that file's `fixture()`/`indexed()` helpers first and reuse the same style — a temp directory with real `.go` files, not a fixtures/ directory, to keep this self-contained in the test file itself):

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

function indexedGoProject(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "context-slice-go-resolve-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    require("node:fs").mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const index = new ProjectIndex(root);
  index.rebuild();
  return { root, index };
}

test("a direct call resolves to a function in another file in the SAME directory", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\nfunc main() {\n\thelper()\n}\n`,
    "b.go": `package main\n\nfunc helper() {}\n`,
  });
  const helper = index.symbols.find((s) => s.name === "helper")!;
  const call = index.calls.find((c) => c.calleeName === "helper")!;
  assert.equal(call.resolvedTargetId, helper.id);
  assert.equal(call.confidence, "exact");
  assert.equal(call.resolutionKind, "same-file");
  rmSync(root, { recursive: true, force: true });
});

test("a direct call does NOT resolve to a function in a DIFFERENT directory, even same package name", () => {
  const { root, index } = indexedGoProject({
    "a/a.go": `package main\n\nfunc main() {\n\thelper()\n}\n`,
    "b/b.go": `package main\n\nfunc helper() {}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "helper")!;
  assert.equal(call.resolvedTargetId, undefined);
  assert.equal(call.confidence, "unresolved");
  rmSync(root, { recursive: true, force: true });
});

test("an unresolvable direct call (e.g. a stdlib builtin) stays unresolved", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\nfunc main() {\n\tlen(\"x\")\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "len")!;
  assert.equal(call.confidence, "unresolved");
  rmSync(root, { recursive: true, force: true });
});
```

(Illustrative directory-creation helper above — use whatever this project's existing multi-file test fixture convention actually is after reading `tests/typescript.test.ts`'s real helpers; do not hand-roll a worse version if a reusable one already exists in a shared test-utils module — check for one first.)

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts`

Expected: new tests FAIL (no `resolve.ts` exists yet, `resolveCalls` is still a no-op) — this should be a clear "module not found" or "still unresolved" failure, not a crash from a typo.

- [ ] **Step 3: Implement `src/languages/go/resolve.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallEdge, ImportRecord, SymbolRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";

const CALLABLE_KINDS = new Set(["function", "method"]);

/** Go's package boundary is per-directory, never by matching package-clause name strings. */
function directoryOf(filePath: string): string {
  const dir = dirname(filePath);
  return dir === "." ? "" : dir;
}

/** This project's own go.mod module path, or undefined if none/unreadable — a missing go.mod
 * means every import is treated as external, the correct safe fallback, not a special case. */
function goModulePath(root: string): string | undefined {
  try {
    const text = readFileSync(join(root, "go.mod"), "utf8");
    return text.match(/^module\s+(\S+)/m)?.[1];
  } catch {
    return undefined;
  }
}

function settle(
  call: CallEdge,
  target: SymbolRecord,
  kind: CallEdge["resolutionKind"],
  evidence: string,
) {
  call.resolvedTargetId = target.id;
  call.resolutionKind = kind;
  call.confidence = "exact";
  call.evidence = [...call.evidence, evidence];
}

export function resolveGoCalls(context: ResolveContext): void {
  const symbolsById = new Map(context.symbols.map((s) => [s.id, s]));
  const byDirectory = new Map<string, SymbolRecord[]>();
  for (const symbol of context.symbols) {
    const dir = directoryOf(symbol.filePath);
    const list = byDirectory.get(dir) ?? [];
    list.push(symbol);
    byDirectory.set(dir, list);
  }
  const modulePath = goModulePath(context.root);

  const importsByFile = new Map<string, ImportRecord[]>();
  for (const record of context.imports) {
    const list = importsByFile.get(record.filePath) ?? [];
    list.push(record);
    importsByFile.set(record.filePath, list);
  }

  const resolveDirectCall = (call: CallEdge, caller: SymbolRecord) => {
    const candidates = (byDirectory.get(directoryOf(caller.filePath)) ?? []).filter(
      (s) => CALLABLE_KINDS.has(s.kind) && s.name === call.calleeName,
    );
    if (candidates.length === 1) settle(call, candidates[0], "same-file", "same-package direct call");
  };

  for (const call of context.calls) {
    const caller = symbolsById.get(call.callerId);
    if (!caller) continue;
    if (!call.receiverText) {
      resolveDirectCall(call, caller);
    }
    // Strategies 2 (import-qualified) and 3 (receiver-type method) are added in Tasks 2-3.
  }
}
```

- [ ] **Step 4: Wire `resolveGoCalls` into the adapter**

In `src/languages/go/index.ts`, replace `resolveCalls: () => {},` with:

```ts
  resolveCalls: (context) => {
    resolveGoCalls(context);
  },
```

and import `resolveGoCalls` from `./resolve.js` at the top of the file.

- [ ] **Step 5: Run the tests to verify Task 1's scope passes**

Run: `npx tsx --test tests/go.test.ts`

Expected: all tests PASS (37 from Phase 3a's final state + 3 new).

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`

Expected: PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/languages/go/resolve.ts src/languages/go/index.ts tests/go.test.ts
git commit -m "feat(go): resolve same-package direct calls"
```

---

### Task 2: Import-based package-qualified resolution

**Files:**
- Modify: `src/languages/go/resolve.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Consumes: Task 1's `resolveGoCalls`, `goModulePath`, `byDirectory`, `importsByFile` — extends the same function, does not restructure it.

- [ ] **Step 1: Write the failing tests for Task 2's scope**

```ts
test("a package-qualified call to an internal project import resolves exact", () => {
  const { root, index } = indexedGoProject({
    "go.mod": `module example.com/proj\n\ngo 1.21\n`,
    "main.go": `package main\n\nimport "example.com/proj/util"\n\nfunc main() {\n\tutil.Helper()\n}\n`,
    "util/util.go": `package util\n\nfunc Helper() {}\n`,
  });
  const helper = index.symbols.find((s) => s.name === "Helper")!;
  const call = index.calls.find((c) => c.calleeName === "Helper")!;
  assert.equal(call.resolvedTargetId, helper.id);
  assert.equal(call.resolutionKind, "imported");
  rmSync(root, { recursive: true, force: true });
});

test("a package-qualified call to an external (non-project) import stays unresolved with externalPackage set", () => {
  const { root, index } = indexedGoProject({
    "go.mod": `module example.com/proj\n\ngo 1.21\n`,
    "main.go": `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("x")\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Println")!;
  assert.equal(call.confidence, "unresolved");
  assert.equal(call.externalPackage, "fmt");
  rmSync(root, { recursive: true, force: true });
});

test("a package-qualified call to an UNEXPORTED name in the imported package does not resolve", () => {
  const { root, index } = indexedGoProject({
    "go.mod": `module example.com/proj\n\ngo 1.21\n`,
    "main.go": `package main\n\nimport "example.com/proj/util"\n\nfunc main() {\n\tutil.helper()\n}\n`,
    "util/util.go": `package util\n\nfunc helper() {}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "helper")!;
  assert.equal(call.confidence, "unresolved");
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts` — expected: the 3 new tests FAIL, all else PASS.

- [ ] **Step 3: Add `resolveQualifiedCall` and wire it in**

In `src/languages/go/resolve.ts`, add (after `resolveDirectCall`):

```ts
  const importLocalName = (record: ImportRecord): string | undefined =>
    record.localName ?? record.module.split("/").pop();

  const resolveQualifiedCall = (call: CallEdge, caller: SymbolRecord): boolean => {
    if (!call.receiverText || !/^[A-Z]/.test(call.calleeName)) return false; // unexported: never a package-qualified target
    const record = (importsByFile.get(caller.filePath) ?? []).find(
      (r) => importLocalName(r) === call.receiverText,
    );
    if (!record) return false;
    if (!modulePath || !record.module.startsWith(modulePath)) {
      call.externalPackage = record.module;
      return false;
    }
    const relative = record.module.slice(modulePath.length).replace(/^\//, "");
    const candidates = (byDirectory.get(relative) ?? []).filter(
      (s) => CALLABLE_KINDS.has(s.kind) && s.name === call.calleeName && s.modifiers.includes("exported"),
    );
    if (candidates.length === 1) {
      settle(call, candidates[0], "imported", "package-qualified import call");
      return true;
    }
    return false;
  };
```

Update the main loop's body:

```ts
    if (!call.receiverText) {
      resolveDirectCall(call, caller);
      continue;
    }
    resolveQualifiedCall(call, caller);
    // Strategy 3 (receiver-type method) is added in Task 3.
```

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npx tsx --test tests/go.test.ts` — expected: all PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/languages/go/resolve.ts tests/go.test.ts
git commit -m "feat(go): resolve package-qualified calls via imports"
```

---

### Task 3: Receiver-type-based method resolution

**Files:**
- Modify: `src/languages/go/resolve.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Consumes: Task 1-2's `resolveGoCalls` — extends the same function, does not restructure it.

- [ ] **Step 1: Write the failing tests for Task 3's scope**

```ts
test("a method call via a := composite-literal-typed local variable resolves exact", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype User struct{}\nfunc (u *User) Save() {}\n\nfunc main() {\n\tu := &User{}\n\tu.Save()\n}\n`,
  });
  const save = index.symbols.find((s) => s.kind === "method" && s.name === "Save")!;
  const call = index.calls.find((c) => c.calleeName === "Save")!;
  assert.equal(call.resolvedTargetId, save.id);
  assert.equal(call.resolutionKind, "same-type");
  rmSync(root, { recursive: true, force: true });
});

test("a method call via a var-declared local variable resolves exact", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype User struct{}\nfunc (u *User) Save() {}\n\nfunc main() {\n\tvar u *User\n\tu.Save()\n}\n`,
  });
  const save = index.symbols.find((s) => s.kind === "method" && s.name === "Save")!;
  const call = index.calls.find((c) => c.calleeName === "Save")!;
  assert.equal(call.resolvedTargetId, save.id);
  rmSync(root, { recursive: true, force: true });
});

test("a method call via a New*-constructor-typed local variable resolves exact", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype User struct{}\nfunc NewUser() *User { return &User{} }\nfunc (u *User) Save() {}\n\nfunc main() {\n\tu := NewUser()\n\tu.Save()\n}\n`,
  });
  const save = index.symbols.find((s) => s.kind === "method" && s.name === "Save")!;
  const call = index.calls.find((c) => c.calleeName === "Save")!;
  assert.equal(call.resolvedTargetId, save.id);
  rmSync(root, { recursive: true, force: true });
});

test("a method call using the enclosing method's own receiver variable resolves exact with no body regex needed", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype User struct{}\nfunc (u *User) Validate() {\n\tu.other()\n}\nfunc (u *User) other() {}\n`,
  });
  const other = index.symbols.find((s) => s.kind === "method" && s.name === "other")!;
  const call = index.calls.find((c) => c.calleeName === "other")!;
  assert.equal(call.resolvedTargetId, other.id);
  rmSync(root, { recursive: true, force: true });
});

test("a method call via a reassigned/ambiguous local variable stays unresolved", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype User struct{}\nfunc (u *User) Save() {}\ntype Other struct{}\n\nfunc main() {\n\tu := &User{}\n\tu = nil\n\tu.Save()\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Save")!;
  assert.equal(call.confidence, "unresolved");
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts` — expected: the 5 new tests FAIL, all else PASS. (The last test, the ambiguous-reassignment one, should already PASS even before Task 3's code exists, since an unimplemented strategy 3 leaves everything unresolved by default — note this in your run and don't be alarmed; it becomes a real pin once Task 3's code could otherwise have resolved it incorrectly.)

- [ ] **Step 3: Add `bindingTypeInBody`, `receiverVarNameOf`, and `resolveMethodCall`**

In `src/languages/go/resolve.ts`, add:

```ts
/** A method's own receiver variable name, e.g. "u" in "func (u *User) Name(...)" — read directly
 * off the symbol's own .source text rather than re-deriving it from parse.ts, since Phase 1
 * already formats every method's signature/source starting with its receiver clause. */
function receiverVarNameOf(method: SymbolRecord): string | undefined {
  return method.source.match(/^func\s*\(\s*(\w+)\s+/)?.[1];
}

/** Narrow, regex-based binding-type inference over a function body — mirrors
 * src/languages/python/resolve.ts's bindingClass exactly: single unambiguous assignment only,
 * any reassignment or multiple bindings drop the evidence rather than guessing. */
function bindingTypeInBody(body: string, receiver: string): string | undefined {
  const literalOrVar = new RegExp(
    `(?<![\\w.])${receiver}\\s*:?=\\s*(?:&)?([A-Za-z_]\\w*)\\s*\\{|var\\s+${receiver}\\s+\\*?([A-Za-z_]\\w*)\\b`,
    "g",
  );
  const matches = [...body.matchAll(literalOrVar)];
  const reassignments = [...body.matchAll(new RegExp(`(?<![\\w.:])${receiver}\\s*=[^=]`, "g"))].length;
  if (matches.length === 1 && reassignments === 0) {
    const [, literalType, varType] = matches[0];
    if (literalType) return literalType;
    if (varType) return varType;
  }
  if (matches.length === 0 && reassignments === 0) {
    const ctor = body.match(new RegExp(`(?<![\\w.])${receiver}\\s*:=\\s*New([A-Za-z_]\\w*)\\s*\\(`));
    if (ctor) return ctor[1];
  }
  return undefined;
}
```

Add `resolveMethodCall` (after `resolveQualifiedCall`):

```ts
  const resolveMethodCall = (call: CallEdge, caller: SymbolRecord) => {
    if (!call.receiverText) return;
    let typeName: string | undefined;
    if (caller.kind === "method" && caller.supertypes?.[0] && receiverVarNameOf(caller) === call.receiverText) {
      typeName = caller.supertypes[0];
    } else {
      typeName = bindingTypeInBody(caller.body ?? caller.source, call.receiverText);
    }
    if (!typeName) return;
    const method = (byDirectory.get(directoryOf(caller.filePath)) ?? []).find(
      (s) => s.kind === "method" && s.name === call.calleeName && s.supertypes?.includes(typeName!),
    );
    if (method) settle(call, method, "same-type", "receiver-type method call");
  };
```

Update the main loop's body — replace the `resolveQualifiedCall(call, caller);` line with:

```ts
    if (resolveQualifiedCall(call, caller)) continue;
    resolveMethodCall(call, caller);
```

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npx tsx --test tests/go.test.ts` — expected: all PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/languages/go/resolve.ts tests/go.test.ts
git commit -m "feat(go): resolve receiver-typed method calls"
```

---

### Task 4: Extend the real-repo benchmark

**Files:**
- Modify: `benchmarks/v1.6-go-support.ts`
- Modify (regenerated): `benchmarks/results/v1.6-go-support.{json,md}`

**Interfaces:**
- Consumes: Tasks 1-3's completed `resolveGoCalls`.
- Produces: a resolution-accuracy oracle, still 100% on the existing symbol/import/call-extraction entries.

- [ ] **Step 1: Read real call sites AND their real resolution targets from the checkouts**

For each of the three repos, pick 2-3 of the EXISTING call oracle entries (or add 2-3 new ones) and determine, by reading the real source, what each call's target SHOULD resolve to: a same-package direct call (find the target function in the same directory), a package-qualified call to an internal vs. external import, or a receiver-typed method call. Note: most of these repos' own call sites will resolve to EXTERNAL stdlib packages (no `go.mod`-internal target) — that's fine and expected; pick at least one same-package or same-type example per repo if one exists in the sampled files, and note explicitly in the oracle when an entry's correct expected outcome is "stays unresolved, externalPackage set" (a correct negative is as valid an oracle entry as a correct positive).

- [ ] **Step 2: Extend the oracle and comparison loop**

In `benchmarks/v1.6-go-support.ts`, extend the `calls` oracle entries (or add a parallel `resolution` oracle) with an expected `resolutionKind`/`confidence`/`externalPackage` per entry, and extend the scoring loop to check actual vs. expected. Report resolution recall/precision per repo the same way symbols/imports/calls already are.

- [ ] **Step 3: Run the benchmark and record results**

Run: `npm run benchmark:v16`

Existing symbol/import/call-extraction entries must stay at 100% (resolution never changes `calleeName`/`receiverText`). New resolution entries should match their expected outcome; investigate any genuine mismatch as a possible real bug in Tasks 1-3's logic before accepting it as a gap. Update `benchmarks/results/v1.6-go-support.md`.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/v1.6-go-support.ts benchmarks/results/v1.6-go-support.json benchmarks/results/v1.6-go-support.md
git commit -m "test(go): extend Phase 3b benchmark with call-resolution accuracy"
```

---

### Task 5: Follow-up summary

**Files:**
- Create: `docs/superpowers/plans/2026-10-02-go-support-phase3b-call-resolution-summary.md`

- [ ] **Step 1: Write the summary document**

```markdown
# Go Language Support Phase 3b Complete: Call Resolution

**Spec:** `docs/superpowers/specs/2026-10-02-go-support-phase3b-call-resolution-design.md`
**Plan:** `docs/superpowers/plans/2026-10-02-go-support-phase3b-call-resolution.md`

## What was built

`resolveGoCalls` now resolves three sound strategies: same-package
direct calls (directory-grouped, never cross-directory), import-based
package-qualified calls (via `go.mod` module-path matching, exported
names only, external imports correctly left unresolved with
`externalPackage` set), and basic receiver-type-based method calls
(composite-literal/var/constructor-convention binding inference for
local variables, plus a zero-regex fast path for a method calling
another method on its own receiver). Any ambiguity at any step leaves
the edge unresolved — never guessed.

## Test evidence

[Task 1-3 commit hashes, final test count, full-suite pass/fail
summary.]

## Real-repo benchmark

[Task 4's resolution-accuracy numbers, alongside the unchanged
symbol/import/call-extraction 100% baseline.]

## Roadmap status

This closes the core call-graph portion of the "add Go language
support" roadmap: symbol extraction (Phase 1), imports and export
visibility (Phase 2), call extraction (Phase 3a), and call resolution
(Phase 3b) are all complete. Only the explicitly OPTIONAL Phase 4
(interface satisfaction, struct embedding) remains, not yet committed
to.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-02-go-support-phase3b-call-resolution-summary.md
git commit -m "docs: summarize Go support Phase 3b (call resolution)"
```
