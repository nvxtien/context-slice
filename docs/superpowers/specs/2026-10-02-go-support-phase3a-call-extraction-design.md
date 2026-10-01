# Go Language Support — Phase 3a: Call Extraction — Design Spec

## Purpose

Phases 1-2 (merged) built symbol extraction and import/export-visibility
marking for the Go adapter. This spec is Phase 3a: extract `CallEdge`s
from function/method bodies — purely syntactic, every edge emitted with
`confidence: "unresolved"`. Cross-file and receiver-type-based
RESOLUTION (distinguishing a package-qualified call like `fmt.Println`
from a receiver method call like `u.Save()`, matching calls to their
real target symbol) is explicitly Phase 3b's concern, kept separate
because it is the most complex remaining piece of this roadmap — Rust's
own equivalent resolver (`src/languages/rust/calls-resolve.ts`) is 1280
lines, and attempting extraction and resolution together risks an
unreviewable single phase.

## Scope, confirmed with the user (2026-10-02 brainstorming)

Grammar facts (verified empirically against the installed
`tree-sitter-go@0.23.4` during this spec's own writing):

- `call_expression` has a `function` field (an `identifier` for a direct
  call like `helper()`, or a `selector_expression` for `u.Save()` /
  `fmt.Println()` — both shapes are IDENTICAL at the syntax level; only
  resolution, not extraction, can tell a method call from a
  package-qualified call) and an `arguments` field (an `argument_list`).
- `selector_expression` has an `operand` field (the receiver/package
  expression, e.g. `u` or `fmt` — an `identifier` in the common case)
  and a `field` field (a `field_identifier`, e.g. `Save`/`Println`).
- `go_statement` and `defer_statement` each wrap a `call_expression`
  directly as a named child — a goroutine launch or deferred call is
  structurally just a `call_expression` one level down; Phase 3a treats
  it the same as any other call, with evidence noting the wrapping
  statement kind.

### What gets extracted

For every top-level `function_declaration` and `method_declaration`
(Phase 1's existing symbols — no new symbol kinds), walk its `body`
block and collect every `call_expression` found, including inside
nested blocks (`if`/`for`/`switch` bodies) and inside anonymous function
literals (`func(){...}()`) — a closure's calls attribute to the
INNERMOST enclosing NAMED function/method (Go closures aren't named
top-level symbols in this project's model, matching how Rust's resolver
already treats "closures/async blocks belong to [the enclosing fn]").

Each call becomes a `CallEdge`:

- Direct call (`function` field is `identifier`): `calleeName` = the
  identifier's text, `receiverText` undefined.
- Selector call (`function` field is `selector_expression`):
  `calleeName` = the `field` child's text, `receiverText` = the
  `operand` child's text WHEN the operand is itself a plain
  `identifier` (the common case: `u.Save()`, `fmt.Println()`); when the
  operand is anything more complex (a chained selector like
  `a.b.Save()`, a call result `f().Save()`, an index expression, etc.),
  `receiverText` is left undefined rather than guessing — same
  "detect what's syntactically simple, don't guess the rest" discipline
  this project applies elsewhere (e.g. TypeScript's `addCall` leaves
  `receiverText` undefined for non-identifier/non-`this` objects).
- `argumentCount`: the `arguments` field's `argument_list` node's
  `namedChildCount`.
- `confidence: "unresolved"`, `resolutionKind: "unresolved"` for every
  edge — Phase 3a never attempts resolution, matching exactly how every
  other adapter's own raw extraction layer emits edges before its
  separate `resolveCalls` pass runs (confirmed by reading
  `src/languages/typescript/parse.ts`'s `addCall`, which does the
  identical thing: emit `"unresolved"`/`"unresolved"` always, let
  `resolve.ts` upgrade it later).
- `evidence`: `["syntactic call"]` for a plain call; `["syntactic call",
  "goroutine launch"]` when wrapped in a `go_statement`; `["syntactic
  call", "deferred call"]` when wrapped in a `defer_statement`.
- `callerId`: the enclosing named function/method's own symbol id (from
  Phase 1's already-built symbols).

### What is explicitly NOT extracted this phase

- Any call whose caller is NOT inside a named function/method body (a
  package-level `var x = compute()` initializer, or a call inside
  another top-level declaration) — rare in idiomatic Go, and this
  project's Go model has no package-level "module" owner symbol the way
  TypeScript's adapter synthesizes one; left unattributed/skipped rather
  than inventing a synthetic owner this phase doesn't need.
- `new`-equivalent constructor calls — Go has no `new Type(...)` call
  syntax (`User{...}` composite literals and `new(User)`/`make(...)`
  built-ins are NOT `call_expression` wrapping a type the way Java/TS
  `new X()` is); `new(User)` and `make([]int, 0)` DO parse as ordinary
  `call_expression`s with `function` = `identifier` ("new"/"make") and
  so are captured by the plain direct-call path above with no special
  handling needed or added.

## Non-goals (explicitly out of scope for Phase 3a)

- Any resolution: no `resolvedTargetId`, no upgrading `confidence`
  beyond `"unresolved"`, no distinguishing method calls from
  package-qualified calls, no cross-file work of any kind. All of this
  is Phase 3b.
- `receiverType` (the syntactically-declared type of the receiver
  variable, which TypeScript's adapter populates via scope tracking) —
  Phase 1 never built the local-variable-type-tracking infrastructure
  this would need (Go's `:=` short declarations, `var` statements with
  inferred vs. explicit types); deferred to Phase 3b, which needs
  exactly this infrastructure anyway to do receiver-based resolution.
- Any change to `src/languages/go/index.ts`'s `resolveCalls: () => {}`
  no-op — it stays a no-op this phase; Phase 3b is what gives it a real
  body.
- Any change to Phase 1/2's symbol or import extraction logic.

## Architecture

### What changes in `src/languages/go/parse.ts`

A new call-collection pass, run after the existing two-pass
symbol-building logic (so every function/method symbol — including
methods receiver-linked in the second pass — already exists and can be
used as `callerId`):

```ts
const collectCalls = (node: Node, owner: SymbolRecord | undefined, wrapKind?: "go" | "defer") => {
  for (const child of node.namedChildren) {
    if (child.type === "call_expression" && owner) {
      calls.push(buildCallEdge(child, filePath, owner.id, wrapKind));
    }
    const nextWrap =
      child.type === "go_statement" ? "go" : child.type === "defer_statement" ? "defer" : undefined;
    collectCalls(child, owner, nextWrap ?? (child.type === "call_expression" ? undefined : wrapKind));
  }
};
```

(Illustrative shape, not final code — the exact recursion/wrap-tracking
logic is the implementation task's job to get right and test, including
correctly resetting `wrapKind` after descending past the `go`/`defer`
statement's own immediate call so a NESTED call inside that call's own
arguments isn't wrongly tagged as also being a goroutine launch.)

Every top-level `function_declaration` and `method_declaration` symbol
already built by the existing loops gets `collectCalls(bodyNode, thatSymbol)`
called on its body — both functions and methods already have their
`SymbolRecord` available at the point their body would need walking (the
existing code already computes `field(child, "body")` for both, so the
body node is already in hand).

## Testing

New tests in `tests/go.test.ts` (existing Phase 1/2 tests must continue
passing unchanged):

- A direct call (`helper()`) inside a function body produces a
  `CallEdge` with `calleeName: "helper"`, `confidence: "unresolved"`.
- A selector call with a simple identifier operand (`u.Save()`) produces
  `calleeName: "Save"`, `receiverText: "u"`.
- A selector call with a non-identifier operand (e.g. `a.b.Save()`,
  chained) produces `calleeName: "Save"`, `receiverText: undefined`.
- A call inside a `go` statement has `"goroutine launch"` in its
  evidence.
- A call inside a `defer` statement has `"deferred call"` in its
  evidence.
- A call inside a nested `if`/`for` block still attributes to the
  enclosing function (proves the walk descends into nested blocks, not
  just the body's immediate children).
- A call inside an anonymous function literal (closure) still
  attributes to the enclosing NAMED function (proves closures don't
  need their own symbol for their calls to be captured).
- A call on a method's receiver works the same way as a function's
  (pins that `callerId` correctly uses the method symbol, not some
  other id, when the call is inside a method body).
- `argumentCount` is correctly computed for a multi-argument call.

## Acceptance / Definition of Done for Phase 3a

1. All new and existing Go tests pass.
2. The full existing test suite passes with no regressions.
3. `npm run benchmark:v16` is extended with a call-extraction oracle
   (real call sites read directly from the three pinned checkouts,
   asserting a `CallEdge` with the right `calleeName`/`receiverText`
   exists) and run against the same three real repos — the existing
   symbol/import oracle entries must stay at 100% (byte-identical
   behavior, since Phase 3a adds call extraction without touching
   symbol/import logic), and the new call-extraction entries should be
   found; any genuinely missing one is investigated as a real bug
   before being treated as an acceptable gap.
4. A short follow-up note records Phase 3a complete and names Phase 3b
   (call resolution: same-file, import-based package-qualified
   resolution, and basic receiver-type tracking for method calls) as
   the next phase.
