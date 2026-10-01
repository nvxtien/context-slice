# Go Language Support — Phase 3a (Call Extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Go adapter (`src/languages/go/parse.ts`) to extract `CallEdge`s from every function/method body — purely syntactic, every edge `confidence: "unresolved"` — then validate against the same three real, pinned Go repositories via an extended benchmark.

**Architecture:** A new recursive walk collects every `call_expression` inside each top-level function/method's body, attributing it to that enclosing named symbol regardless of nesting depth (blocks, closures). Whether a call is the direct target of a `go`/`defer` statement is determined by checking the PARENT node's type during the walk — verified empirically to require no explicit wrap-state threading through the recursion, simpler than originally sketched in the spec.

**Tech Stack:** TypeScript, `tree-sitter` + `tree-sitter-go`, Node's built-in test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-10-02-go-support-phase3a-call-extraction-design.md`

## Global Constraints

- Every `CallEdge` this phase emits has `confidence: "unresolved"` and `resolutionKind: "unresolved"` — no exceptions, no attempted resolution of any kind.
- `receiverText` is set ONLY when a selector call's `operand` is a plain `identifier` node; any other operand shape (chained selector, call result, index expression) leaves `receiverText` undefined.
- `go_statement`/`defer_statement` tagging applies ONLY to the call that is their own direct child — verified via a throwaway script during planning: checking whether the call_expression's immediate PARENT node is a `go_statement`/`defer_statement` during the recursive walk correctly tags only the direct target, never a nested call inside that call's own arguments.
- Do not touch `canonicalId`, `receiverBaseTypeName`, `modifiersFor`, the symbol-building loops, or the import-extraction loop — only add the call-collection pass and wire it to the already-built function/method symbols.
- Full test suite runs: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`.

## Review Focus

- A call inside a nested `if`/`for` block must still attribute to the enclosing function — Task 1's tests pin this (proves the walk descends past the body's immediate children).
- A call inside an anonymous function literal (closure) must still attribute to the enclosing NAMED function, with no attempt to give the closure its own owner — Task 1's tests pin this.
- A call nested inside a `go`/`defer` statement's own call's ARGUMENTS (e.g. `go outer(inner())`) must NOT itself be tagged as a goroutine/deferred call — only `outer` gets the tag, not `inner` — Task 1's tests pin this (verified against real grammar during planning).
- A selector call with a non-identifier operand must leave `receiverText` undefined, never a guessed/truncated value — Task 1's tests pin this.

---

### Task 1: Call extraction

**Files:**
- Modify: `src/languages/go/parse.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Produces: `parseGo`'s `calls` array is now populated (previously always `[]`).
- Consumes: Phase 1/2's `parseGo` as it currently exists on disk — read the file first; the function-symbol-building branch, the method second pass, and the import loop are all unchanged by this task, only consumed for their already-built `SymbolRecord`s and `body` nodes.

- [ ] **Step 1: Write the failing tests for Task 1's scope**

Add to `tests/go.test.ts` (read the file first to match its exact style):

```ts
test("a direct call inside a function body produces an unresolved CallEdge", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc helper() {}\n\nfunc main() {\n\thelper()\n}\n`);
  const main = parsed.symbols.find((s) => s.name === "main" && s.kind === "function")!;
  const call = parsed.calls.find((c) => c.calleeName === "helper");
  assert.ok(call, "expected a call edge for helper");
  assert.equal(call!.callerId, main.id);
  assert.equal(call!.confidence, "unresolved");
  assert.equal(call!.resolutionKind, "unresolved");
});

test("a selector call with a plain identifier operand carries receiverText", () => {
  const source = `package main\n\ntype User struct{}\nfunc (u *User) Save() {}\n\nfunc main() {\n\tu := &User{}\n\tu.Save()\n}\n`;
  const parsed = parseGo("main.go", source);
  const call = parsed.calls.find((c) => c.calleeName === "Save");
  assert.ok(call, "expected a call edge for Save");
  assert.equal(call!.receiverText, "u");
});

test("a selector call with a chained (non-identifier) operand leaves receiverText undefined", () => {
  const source = `package main\n\nfunc main() {\n\ta.b.Save()\n}\n`;
  const parsed = parseGo("main.go", source);
  const call = parsed.calls.find((c) => c.calleeName === "Save");
  assert.ok(call, "expected a call edge for Save even with a chained operand");
  assert.equal(call!.receiverText, undefined);
});

test("a call wrapped in a go statement is tagged as a goroutine launch", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc helper() {}\n\nfunc main() {\n\tgo helper()\n}\n`);
  const call = parsed.calls.find((c) => c.calleeName === "helper");
  assert.ok(call!.evidence.includes("goroutine launch"));
});

test("a call wrapped in a defer statement is tagged as deferred", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc cleanup() {}\n\nfunc main() {\n\tdefer cleanup()\n}\n`);
  const call = parsed.calls.find((c) => c.calleeName === "cleanup");
  assert.ok(call!.evidence.includes("deferred call"));
});

test("a call nested inside a go statement's own call arguments is NOT itself tagged", () => {
  const source = `package main\n\nfunc inner() int { return 1 }\nfunc outer(n int) {}\n\nfunc main() {\n\tgo outer(inner())\n}\n`;
  const parsed = parseGo("main.go", source);
  const outerCall = parsed.calls.find((c) => c.calleeName === "outer");
  const innerCall = parsed.calls.find((c) => c.calleeName === "inner");
  assert.ok(outerCall!.evidence.includes("goroutine launch"));
  assert.ok(!innerCall!.evidence.includes("goroutine launch"), "the nested call must not inherit the goroutine tag");
});

test("a call inside a nested if block still attributes to the enclosing function", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc helper() {}\n\nfunc main() {\n\tif true {\n\t\thelper()\n\t}\n}\n`);
  const main = parsed.symbols.find((s) => s.name === "main" && s.kind === "function")!;
  const call = parsed.calls.find((c) => c.calleeName === "helper");
  assert.equal(call!.callerId, main.id);
});

test("a call inside a closure still attributes to the enclosing named function", () => {
  const source = `package main\n\nfunc closureCall() {}\n\nfunc main() {\n\tfn := func() {\n\t\tclosureCall()\n\t}\n\tfn()\n}\n`;
  const parsed = parseGo("main.go", source);
  const main = parsed.symbols.find((s) => s.name === "main" && s.kind === "function")!;
  const call = parsed.calls.find((c) => c.calleeName === "closureCall");
  assert.equal(call!.callerId, main.id);
});

test("a call inside a method body attributes to the method symbol", () => {
  const source = `package main\n\nfunc helper() {}\n\ntype User struct{}\nfunc (u *User) Save() {\n\thelper()\n}\n`;
  const parsed = parseGo("main.go", source);
  const method = parsed.symbols.find((s) => s.kind === "method" && s.name === "Save")!;
  const call = parsed.calls.find((c) => c.calleeName === "helper");
  assert.equal(call!.callerId, method.id);
});

test("argumentCount is correctly computed for a multi-argument call", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc add(a, b, c int) int { return a + b + c }\n\nfunc main() {\n\tadd(1, 2, 3)\n}\n`);
  const call = parsed.calls.find((c) => c.calleeName === "add");
  assert.equal(call!.argumentCount, 3);
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts`

Expected: all new tests FAIL (`parsed.calls` is always `[]` currently); all pre-existing tests still PASS.

- [ ] **Step 3: Implement the call-collection pass**

In `src/languages/go/parse.ts`, add a new function near the other small helpers (after `modifiersFor`):

```ts
/**
 * A call_expression's callee name and (when the operand is a plain identifier) its
 * receiver text. selector_expression's "operand"/"field" fields and call_expression's
 * "function"/"arguments" fields verified empirically against tree-sitter-go@0.23.4.
 */
function buildCallEdge(
  callNode: Node,
  filePath: string,
  callerId: string,
  wrapKind: "go" | "defer" | undefined,
): CallEdge {
  const fnNode = field(callNode, "function");
  const argsNode = field(callNode, "arguments");
  const argumentCount = argsNode?.namedChildCount ?? 0;
  const evidence = ["syntactic call"];
  if (wrapKind === "go") evidence.push("goroutine launch");
  else if (wrapKind === "defer") evidence.push("deferred call");

  let calleeName = "";
  let receiverText: string | undefined;
  if (fnNode?.type === "identifier") {
    calleeName = fnNode.text;
  } else if (fnNode?.type === "selector_expression") {
    calleeName = text(field(fnNode, "field"));
    const operand = field(fnNode, "operand");
    if (operand?.type === "identifier") receiverText = operand.text;
  }

  return {
    callerId,
    calleeName,
    receiverText,
    argumentCount,
    filePath,
    language: LANGUAGE_ID,
    range: range(callNode),
    confidence: "unresolved",
    resolutionKind: "unresolved",
    evidence,
  };
}

/**
 * Walks every descendant of `node` for call_expressions, attributing each to `ownerId`
 * regardless of nesting depth (blocks, closures — Go closures have no symbol of their
 * own in this adapter's model, so their calls attribute to the innermost enclosing
 * NAMED function/method). Whether a call is the direct target of a go/defer statement
 * is read off the immediate parent's type during the walk — verified empirically that
 * this correctly tags only the direct target, never a call nested inside its arguments.
 */
function collectCalls(node: Node, ownerId: string, filePath: string, calls: CallEdge[]) {
  for (const child of node.namedChildren) {
    if (child.type === "call_expression") {
      const wrapKind = node.type === "go_statement" ? "go" : node.type === "defer_statement" ? "defer" : undefined;
      calls.push(buildCallEdge(child, filePath, ownerId, wrapKind));
    }
    collectCalls(child, ownerId, filePath, calls);
  }
}
```

- [ ] **Step 4: Wire `collectCalls` to every function and method symbol**

Track callable symbols as they're built. In `parseGo`, add a new array near `structByName`/`pendingMethods`:

```ts
  const callables: { symbol: SymbolRecord; body: Node | null | undefined }[] = [];
```

In the `function_declaration` branch, after `symbols.push({...})` for the function symbol, add:

```ts
      callables.push({ symbol, body: field(child, "body") });
```

(this requires naming that symbol object — change `symbols.push({ ... })` to `const symbol: SymbolRecord = { ... }; symbols.push(symbol);` first, matching the pattern the struct branch already uses for the same reason).

In the method second-pass loop (near the bottom, after `symbols.push({...})` for the method symbol), apply the identical change: name the object `symbol`, push it, then also `callables.push({ symbol, body: field(methodNode, "body") })`.

Finally, right before the `return { symbols, calls, imports, exports, parseError };` statement, add:

```ts
  for (const { symbol, body } of callables) {
    if (body) collectCalls(body, symbol.id, filePath, calls);
  }
```

- [ ] **Step 5: Run the tests to verify all pass**

Run: `npx tsx --test tests/go.test.ts`

Expected: all tests (34 from Phase 1-2's final state + 10 new) PASS.

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`

Expected: PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/languages/go/parse.ts tests/go.test.ts
git commit -m "feat(go): extract call edges from function and method bodies"
```

---

### Task 2: Extend the real-repo benchmark

**Files:**
- Modify: `benchmarks/v1.6-go-support.ts`
- Modify (regenerated): `benchmarks/results/v1.6-go-support.{json,md}`

**Interfaces:**
- Consumes: Task 1's completed `parseGo`.
- Produces: an extended oracle covering real call sites, still 100% on the existing symbol/import entries.

- [ ] **Step 1: Read real call sites from the checkouts**

Checkouts should already exist from Phase 1/2 work in this worktree, or re-fetch with `npx tsx benchmarks/fetch-checkouts.ts`. Read 1-2 files per repo and note 3-5 real call sites per repo — a mix of direct calls and selector calls (e.g. a method call on a receiver, a package-qualified stdlib call) — covering different `calleeName`s than what the symbol/import oracle already names, to genuinely exercise the new extraction logic rather than re-testing the same lines.

- [ ] **Step 2: Extend the oracle and comparison loop**

In `benchmarks/v1.6-go-support.ts`, add a `calls: Record<string, { calleeName: string; receiverText?: string }[]>` oracle map alongside the existing `oracles`/`imports` maps, with 3-5 real entries per repo. Extend the scoring loop to check each against `index.calls` (match by `calleeName`, and `receiverText` when the oracle entry specifies one), reporting found/total the same way symbols and imports already are.

- [ ] **Step 3: Run the benchmark and record results**

Run: `npm run benchmark:v16`

All existing symbol/import oracle entries must stay at 100% (no regression). New call entries should be found; investigate any genuine miss as a possible real bug in Task 1's extraction logic before accepting it as a gap. Update `benchmarks/results/v1.6-go-support.md` to describe the new call-extraction coverage.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/v1.6-go-support.ts benchmarks/results/v1.6-go-support.json benchmarks/results/v1.6-go-support.md
git commit -m "test(go): extend Phase 3a benchmark with call-extraction coverage"
```

---

### Task 3: Follow-up summary

**Files:**
- Create: `docs/superpowers/plans/2026-10-02-go-support-phase3a-call-extraction-summary.md`

**Interfaces:**
- Consumes: Tasks 1-2's commits and benchmark results.

- [ ] **Step 1: Write the summary document**

```markdown
# Go Language Support Phase 3a Complete: Call Extraction

**Spec:** `docs/superpowers/specs/2026-10-02-go-support-phase3a-call-extraction-design.md`
**Plan:** `docs/superpowers/plans/2026-10-02-go-support-phase3a-call-extraction.md`

## What was built

Syntactic call-edge extraction for every function/method body —
direct calls, selector calls (with receiverText when the operand is a
plain identifier), goroutine (`go`) and deferred (`defer`) call
tagging, and correct attribution through nested blocks and closures
to the innermost enclosing NAMED function/method. Every edge is
emitted `confidence: "unresolved"` — no resolution attempted this
phase.

## Test evidence

[Task 1 commit hash, final test count, full-suite pass/fail summary.]

## Real-repo benchmark

[Task 2's found/total for symbols, imports (must stay 100%, unchanged
from Phase 2), and the new call-extraction entries.]

## Roadmap status

Phase 3a of 3-4 complete. Next: Phase 3b (call resolution — same-file
exact matches, package-qualified resolution via Phase 2's
`ImportRecord`s, and basic receiver-type tracking for method calls),
the most complex remaining phase in this roadmap.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-02-go-support-phase3a-call-extraction-summary.md
git commit -m "docs: summarize Go support Phase 3a (call extraction)"
```
