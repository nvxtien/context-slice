# Go Language Support — Phase 4 (Optional): Struct Embedding and Interface Satisfaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark embedded struct fields and interface method names at parse time (two small, justified `parse.ts` additions), then use that data to (1) promote method calls through struct embedding in `resolveGoCalls`, and (2) compute interface satisfaction as `supertypes` on struct symbols — closing the entire "add Go language support" roadmap.

**Architecture:** Part A extends `parse.ts`'s field-building and interface-building branches with two metadata flags. Parts B and C extend `resolve.ts`'s existing `resolveMethodCall` (embedding promotion, per-call) and add a new post-pass (interface satisfaction, once per `resolveGoCalls` run) — both built on a shared `embeddedTypesOf` BFS helper.

**Tech Stack:** TypeScript, `tree-sitter-go` (one new grammar fact: `method_elem` vs `type_elem` inside `interface_type`, verified empirically), Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-02-go-support-phase4-embedding-interfaces-design.md`

## Global Constraints

- No new `SymbolKind` values. `SymbolMetadata` gains two new optional fields: `embedded?: boolean` (on field symbols) and `interfaceMethods?: string[]` (on interface symbols) — both in `src/types/model.ts`, following the exact style of existing per-construct flags (`classMethod`, `implSelfType`).
- Struct embedding and interface satisfaction are both SAME-DIRECTORY-ONLY — matching every Phase 3b strategy's own established package boundary. Do not attempt cross-package resolution.
- Embedding promotion follows Go's own shadowing rule: a match at a SHALLOWER depth wins; multiple matches at the SAME depth are ambiguous and must stay unresolved, never guessed.
- Interface satisfaction is METHOD-NAME-SET matching only — no parameter/return-type checking (this project's established precision level throughout).
- `method_elem`'s own name is its `namedChild(0)` (a `field_identifier`) — confirmed empirically against `tree-sitter-go@0.23.4` during planning; a `type_elem` (embedded interface inside another interface, e.g. `io.Reader`) is a DIFFERENT node type and must NOT be mistaken for a `method_elem` — only `method_elem` children contribute to `interfaceMethods`.
- Full test suite runs: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`.

## Review Focus

- A coincidentally same-named explicit field (`Base Base`) must NOT be marked `metadata.embedded` — only a true embedded field (no explicit name node) gets the flag — Task 1's tests pin this.
- An interface embedding ANOTHER interface (`type X interface { io.Reader; Foo() }`) must only record `Foo` in `interfaceMethods`, never pick up `io.Reader` as a method name — Task 1's tests pin this (the `method_elem`-vs-`type_elem` distinction).
- A method defined directly on the outer struct AND on an embedded type must resolve to the OUTER struct's own method (direct beats promoted) — Task 2's tests pin this.
- Two embedded fields at the SAME depth both having a matching method name must leave the call unresolved — Task 2's tests pin this.
- A multi-level embedding chain (A embeds B embeds C, only C has the method) must resolve through two promotion levels — Task 2's tests pin this.
- A struct missing even one interface method (direct or promoted) must NOT get that interface in `supertypes` — Task 3's tests pin this as the negative case.

---

### Task 1: Mark embedded fields and interface method names in `parse.ts`

**Files:**
- Modify: `src/types/model.ts`
- Modify: `src/languages/go/parse.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Produces: field symbols gain `metadata.embedded`; interface symbols gain `metadata.interfaceMethods`.
- Consumes: nothing from other tasks (first task in this plan).

- [ ] **Step 1: Write the failing tests for Task 1's scope**

Add to `tests/go.test.ts` (read the file first for exact style/helper usage):

```ts
test("an embedded field is marked metadata.embedded; a coincidentally same-named explicit field is not", () => {
  const parsed = parseGo("a.go", `package main\n\ntype Base struct{}\ntype Derived struct {\n\tBase\n}\ntype Other struct {\n\tBase Base\n}\n`);
  const embedded = parsed.symbols.find((s) => s.kind === "field" && s.name === "Base" && s.parentId === parsed.symbols.find((p) => p.name === "Derived")!.id)!;
  const explicit = parsed.symbols.find((s) => s.kind === "field" && s.name === "Base" && s.parentId === parsed.symbols.find((p) => p.name === "Other")!.id)!;
  assert.equal(embedded.metadata?.embedded, true);
  assert.equal(explicit.metadata?.embedded, undefined);
});

test("interface method names are recorded, excluding an embedded interface", () => {
  const parsed = parseGo("a.go", `package main\n\nimport "io"\n\ntype Greeter interface {\n\tGreet() string\n\tio.Reader\n}\n`);
  const iface = parsed.symbols.find((s) => s.kind === "interface" && s.name === "Greeter")!;
  assert.deepEqual(iface.metadata?.interfaceMethods, ["Greet"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts` — expected: both new tests FAIL (`metadata` isn't set at all yet for these cases).

- [ ] **Step 3: Add `embedded`/`interfaceMethods` to `SymbolMetadata`**

In `src/types/model.ts`, inside the `SymbolMetadata` interface, add (near the other per-language optional flags):

```ts
  /** Go: this field has no explicit name — it IS the embedded type, not a coincidentally same-named one. */
  embedded?: boolean;
  /** Go: an interface's own declared method names (excludes embedded interfaces' names). */
  interfaceMethods?: string[];
```

- [ ] **Step 4: Mark embedded fields in `parse.ts`**

In the struct field-building loop (around the existing `fieldName` computation), change:

```ts
            const fieldName = text(field(fieldDecl, "name")) || text(field(fieldDecl, "type"));
            if (!fieldName) continue;
```

to also capture whether this is a true embed:

```ts
            const explicitName = text(field(fieldDecl, "name"));
            const fieldName = explicitName || text(field(fieldDecl, "type"));
            if (!fieldName) continue;
```

and add `metadata: explicitName ? undefined : { embedded: true },` to the field's `symbols.push({...})` object literal (it currently has no `metadata` key at all — this adds the first one).

- [ ] **Step 5: Record interface method names in `parse.ts`**

In the `interface_type` branch, add before `symbols.push({...})`:

```ts
          const interfaceMethods = typeNode.namedChildren
            .filter((c) => c.type === "method_elem")
            .map((m) => text(m.namedChild(0)))
            .filter(Boolean);
```

and add `metadata: { interfaceMethods },` to that symbol's object literal (it currently has no `metadata` key either).

- [ ] **Step 6: Run the tests to verify all pass**

Run: `npx tsx --test tests/go.test.ts` — expected: all PASS.

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")` — expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types/model.ts src/languages/go/parse.ts tests/go.test.ts
git commit -m "feat(go): mark embedded fields and record interface method names"
```

---

### Task 2: Struct embedding — method promotion in call resolution

**Files:**
- Modify: `src/languages/go/resolve.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Consumes: Task 1's `metadata.embedded` flag.

- [ ] **Step 1: Write the failing tests for Task 2's scope**

```ts
test("a method call resolves to an embedded type's method when the outer struct has none of its own", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype Base struct{}\nfunc (b *Base) Greet() {}\n\ntype Derived struct {\n\tBase\n}\n\nfunc main() {\n\td := &Derived{}\n\td.Greet()\n}\n`,
  });
  const greet = index.symbols.find((s) => s.kind === "method" && s.name === "Greet")!;
  const call = index.calls.find((c) => c.calleeName === "Greet")!;
  assert.equal(call.resolvedTargetId, greet.id);
  rmSync(root, { recursive: true, force: true });
});

test("a method defined on both the outer struct and an embedded type resolves to the outer struct's own method", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype Base struct{}\nfunc (b *Base) Greet() {}\n\ntype Derived struct {\n\tBase\n}\nfunc (d *Derived) Greet() {}\n\nfunc main() {\n\td := &Derived{}\n\td.Greet()\n}\n`,
  });
  const derivedGreet = index.symbols.find((s) => s.kind === "method" && s.name === "Greet" && s.supertypes?.includes("Derived"))!;
  const call = index.calls.find((c) => c.calleeName === "Greet")!;
  assert.equal(call.resolvedTargetId, derivedGreet.id);
  rmSync(root, { recursive: true, force: true });
});

test("two embedded fields at the same depth with the same method name leave the call unresolved", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype A struct{}\nfunc (a *A) Greet() {}\ntype B struct{}\nfunc (b *B) Greet() {}\n\ntype Derived struct {\n\tA\n\tB\n}\n\nfunc main() {\n\td := &Derived{}\n\td.Greet()\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Greet")!;
  assert.equal(call.confidence, "unresolved");
  rmSync(root, { recursive: true, force: true });
});

test("a multi-level embedding chain resolves through two promotion levels", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype C struct{}\nfunc (c *C) Deep() {}\ntype B struct {\n\tC\n}\ntype A struct {\n\tB\n}\n\nfunc main() {\n\ta := &A{}\n\ta.Deep()\n}\n`,
  });
  const deep = index.symbols.find((s) => s.kind === "method" && s.name === "Deep")!;
  const call = index.calls.find((c) => c.calleeName === "Deep")!;
  assert.equal(call.resolvedTargetId, deep.id);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts` — expected: the 4 new tests FAIL, all else PASS.

- [ ] **Step 3: Add `embeddedTypesOf` and `findPromotedMethod`, extend `resolveMethodCall`**

In `src/languages/go/resolve.ts`, add (after `bindingTypeInBody`):

```ts
/** A struct's own embedded field TYPES (not all fields) — same-directory lookup only, cycle-safe. */
function embeddedTypesOf(
  struct: SymbolRecord,
  byDirectory: Map<string, SymbolRecord[]>,
  visited: Set<string>,
): SymbolRecord[] {
  const dir = directoryOf(struct.filePath);
  const siblings = byDirectory.get(dir) ?? [];
  const types: SymbolRecord[] = [];
  for (const f of siblings) {
    if (f.kind !== "field" || f.parentId !== struct.id || !f.metadata?.embedded) continue;
    const embeddedType = siblings.find((s) => s.kind === "class" && s.name === f.name);
    if (embeddedType && !visited.has(embeddedType.id)) {
      visited.add(embeddedType.id);
      types.push(embeddedType);
    }
  }
  return types;
}

/** BFS one promotion-depth level at a time; a match at a shallower depth shadows deeper ones;
 * multiple matches at the SAME depth are ambiguous (Go itself rejects this at compile time). */
function findPromotedMethod(
  struct: SymbolRecord,
  methodName: string,
  byDirectory: Map<string, SymbolRecord[]>,
): SymbolRecord | "ambiguous" | undefined {
  const visited = new Set([struct.id]);
  let frontier = embeddedTypesOf(struct, byDirectory, visited);
  while (frontier.length) {
    const matches = frontier
      .map((t) => (byDirectory.get(directoryOf(t.filePath)) ?? []).find(
        (s) => s.kind === "method" && s.name === methodName && s.supertypes?.includes(t.name),
      ))
      .filter((m): m is SymbolRecord => Boolean(m));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return "ambiguous";
    const next: SymbolRecord[] = [];
    for (const t of frontier) next.push(...embeddedTypesOf(t, byDirectory, visited));
    frontier = next;
  }
  return undefined;
}
```

Replace `resolveMethodCall`'s body (the existing direct-lookup-only version) with:

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
    const dir = directoryOf(caller.filePath);
    const directMethod = (byDirectory.get(dir) ?? []).find(
      (s) => s.kind === "method" && s.name === call.calleeName && s.supertypes?.includes(typeName!),
    );
    if (directMethod) {
      settle(call, directMethod, "same-type", "receiver-type method call");
      return;
    }
    const struct = (byDirectory.get(dir) ?? []).find((s) => s.kind === "class" && s.name === typeName);
    if (!struct) return;
    const promoted = findPromotedMethod(struct, call.calleeName, byDirectory);
    if (promoted && promoted !== "ambiguous") {
      settle(call, promoted, "same-type", "struct embedding method promotion");
    }
  };
```

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npx tsx --test tests/go.test.ts` — expected: all PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/languages/go/resolve.ts tests/go.test.ts
git commit -m "feat(go): resolve method calls promoted through struct embedding"
```

---

### Task 3: Interface satisfaction

**Files:**
- Modify: `src/languages/go/resolve.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Consumes: Task 1's `metadata.interfaceMethods`, Task 2's `embeddedTypesOf`.

- [ ] **Step 1: Write the failing tests for Task 3's scope**

```ts
test("a struct whose method set (including promoted methods) satisfies an interface gets it in supertypes", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype Base struct{}\nfunc (b *Base) Greet() string { return "" }\n\ntype Greeter interface {\n\tGreet() string\n}\n\ntype Derived struct {\n\tBase\n}\n`,
  });
  const derived = index.symbols.find((s) => s.kind === "class" && s.name === "Derived")!;
  assert.ok(derived.supertypes?.includes("Greeter"));
  rmSync(root, { recursive: true, force: true });
});

test("a struct missing one of an interface's methods does NOT get it in supertypes", () => {
  const { root, index } = indexedGoProject({
    "a.go": `package main\n\ntype Greeter interface {\n\tGreet() string\n\tFarewell() string\n}\n\ntype Partial struct{}\nfunc (p *Partial) Greet() string { return "" }\n`,
  });
  const partial = index.symbols.find((s) => s.kind === "class" && s.name === "Partial")!;
  assert.equal(partial.supertypes?.includes("Greeter") ?? false, false);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts` — expected: the first new test FAILS, the second already passes trivially (absence is the default) but is still a real regression pin going forward.

- [ ] **Step 3: Add the interface-satisfaction post-pass**

In `src/languages/go/resolve.ts`, add (after `findPromotedMethod`, before `settle`):

```ts
/** All method names reachable from a struct: its own direct methods, plus every method
 * reachable via embedding at any depth (ambiguity doesn't matter here — for satisfaction we
 * only need "is this name reachable at all", unlike call resolution's shallowest-wins rule). */
function methodSetOf(struct: SymbolRecord, byDirectory: Map<string, SymbolRecord[]>): Set<string> {
  const names = new Set<string>();
  const collectDirect = (type: SymbolRecord) => {
    for (const s of byDirectory.get(directoryOf(type.filePath)) ?? [])
      if (s.kind === "method" && s.supertypes?.includes(type.name)) names.add(s.name);
  };
  collectDirect(struct);
  const visited = new Set([struct.id]);
  let frontier = embeddedTypesOf(struct, byDirectory, visited);
  while (frontier.length) {
    const next: SymbolRecord[] = [];
    for (const t of frontier) {
      collectDirect(t);
      next.push(...embeddedTypesOf(t, byDirectory, visited));
    }
    frontier = next;
  }
  return names;
}

function resolveInterfaceSatisfaction(symbols: SymbolRecord[], byDirectory: Map<string, SymbolRecord[]>) {
  for (const [, siblings] of byDirectory) {
    const interfaces = siblings.filter((s) => s.kind === "interface" && s.metadata?.interfaceMethods);
    const structs = siblings.filter((s) => s.kind === "class");
    for (const struct of structs) {
      const methods = methodSetOf(struct, byDirectory);
      for (const iface of interfaces) {
        const required = iface.metadata!.interfaceMethods!;
        if (required.length > 0 && required.every((name) => methods.has(name))) {
          struct.supertypes = [...(struct.supertypes ?? []), iface.name];
        }
      }
    }
  }
}
```

Call it once near the end of `resolveGoCalls`, after the main `for (const call of context.calls)` loop:

```ts
  resolveInterfaceSatisfaction(context.symbols, byDirectory);
```

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npx tsx --test tests/go.test.ts` — expected: all PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/languages/go/resolve.ts tests/go.test.ts
git commit -m "feat(go): compute interface satisfaction as struct supertypes"
```

---

### Task 4: Extend the real-repo benchmark

**Files:**
- Modify: `benchmarks/v1.6-go-support.ts`
- Modify (regenerated): `benchmarks/results/v1.6-go-support.{json,md}`

- [ ] **Step 1: Look for real embedding/interface-satisfaction examples in the checkouts**

Re-fetch checkouts if needed (`npx tsx benchmarks/fetch-checkouts.ts`). Search the three repos for real struct embedding (`grep -rn` for a bare type name on its own line inside a `struct {` block) and real interface satisfaction (an interface whose methods a concrete struct implements, directly or via embedding). Report honestly what you find — these patterns may or may not be common in all three repos; a correct "none found in the sampled files" is valid evidence too, same discipline as every prior phase.

- [ ] **Step 2: Extend the oracle and comparison loop**

Add embedding-resolution and/or interface-satisfaction oracle entries (whatever real examples Step 1 found) to `benchmarks/v1.6-go-support.ts`, extending the existing scoring pattern.

- [ ] **Step 3: Run the benchmark and record results**

Run: `npm run benchmark:v16`. Existing oracle entries must stay unchanged. Update `benchmarks/results/v1.6-go-support.md`.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/v1.6-go-support.ts benchmarks/results/v1.6-go-support.json benchmarks/results/v1.6-go-support.md
git commit -m "test(go): extend Phase 4 benchmark with embedding/interface coverage"
```

---

### Task 5: Follow-up summary

**Files:**
- Create: `docs/superpowers/plans/2026-10-02-go-support-phase4-embedding-interfaces-summary.md`

- [ ] **Step 1: Write the summary document**

```markdown
# Go Language Support Phase 4 Complete: Struct Embedding and Interface Satisfaction

**Spec:** `docs/superpowers/specs/2026-10-02-go-support-phase4-embedding-interfaces-design.md`
**Plan:** `docs/superpowers/plans/2026-10-02-go-support-phase4-embedding-interfaces.md`

## What was built

Embedded-field marking and interface-method-name extraction (Task 1),
method-call resolution promoted through struct embedding with correct
depth-based shadowing and ambiguity handling (Task 2), and interface
satisfaction computed as `supertypes` on struct symbols, including
methods reached via embedding (Task 3).

## Test evidence

[Task 1-3 commit hashes, final test count, full-suite pass/fail
summary.]

## Real-repo benchmark

[Task 4's findings and numbers.]

## Roadmap status: COMPLETE

This closes the ENTIRE "add Go language support" roadmap. No further
committed or optional phases remain: Phase 1 (symbols), Phase 2
(imports/exports), Phase 3a (call extraction), Phase 3b (call
resolution), Phase 4 (embedding/interfaces) are all merged.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-02-go-support-phase4-embedding-interfaces-summary.md
git commit -m "docs: summarize Go support Phase 4, roadmap complete"
```
