# Go Language Support — Phase 3b: Call Resolution — Design Spec

## Purpose

Phase 3a (merged) extracts every call syntactically, always `confidence:
"unresolved"`. This spec is Phase 3b: give `resolveCalls` a real body
(currently a no-op), resolving as many of those edges as can be done
soundly without over-claiming. This is the most complex remaining piece
of the Go roadmap — Rust's equivalent (`calls-resolve.ts`) is 1280 lines
— so this phase is deliberately scoped to three sound resolution
strategies, each modeled directly on an existing adapter's own
precedent, with receiver-type-based method resolution kept intentionally
simple (regex-based binding inference, mirroring Python's own
`bindingClass`) rather than attempting real type inference.

## Scope

### 1. Same-package direct-call resolution

Go's package membership is PER-DIRECTORY (every `.go` file in one
directory belongs to the same package and can call each other's
functions with no import, regardless of the files'
`package`-clause name matching — two different directories with the
SAME declared package name are still two different packages). `Symbol
Record.packageName` is never set by this adapter (confirmed: Phase
1-3a never write it) — directory grouping via `dirname(filePath)` is
the correct, simpler mechanism, needing no retrofit to Phases 1-3a.

For a direct call (`receiverText` undefined), resolve against every
FUNCTION symbol (never a method — Go methods always require an
explicit receiver expression, so a bare call can never reach one)
sharing the caller's own directory:

- Exactly one same-directory function match by name → `confidence:
  "exact"`, `resolutionKind: "same-file"` (reusing the existing
  `ResolutionKind` value — "same-file" already means "same compilation
  unit" in this project's model; a Go package spanning multiple files
  is the closest existing fit, not worth adding a new `ResolutionKind`
  for). A same-named method in the same directory is not a competing
  candidate and does not create ambiguity, since it can never be the
  real target of a receiver-less call.
- Multiple same-directory function matches (shouldn't happen for
  exported Go names within one package — Go forbids duplicate
  top-level names in a package — but an adapter dedup/edge case, e.g.
  test-file build tags this project doesn't model, could theoretically
  produce one) → `confidence: "unresolved"`, never guessed.
- Zero same-directory matches → left `"unresolved"` (falls through to
  strategy 3, or truly unresolved — e.g. a stdlib builtin like
  `len`/`make`/`append`, or a function genuinely outside the indexed
  project).

### 2. Import-based package-qualified resolution

A selector call whose `receiverText` matches an import's `localName`
(the alias, or — for a plain import — the import path's own last
segment, Phase 2's documented heuristic) is a package-qualified call
(`fmt.Println()`, `mypkg.Helper()`). Resolving WHERE that import points
requires mapping the import's `module` string to an actual indexed
directory:

- If this repository has a `go.mod` at its root, its `module` directive
  gives this project's own module path (e.g. `github.com/me/project`).
  An import whose path starts with that prefix is an INTERNAL import;
  strip the prefix to get the project-relative directory
  (`github.com/me/project/internal/util` → `internal/util`).
- An import's path that does NOT start with the project's own module
  prefix (or when no `go.mod` is found at all) is EXTERNAL — set
  `externalPackage` on the call edge (the existing `CallEdge` field
  already means exactly this) and leave `confidence: "unresolved"`,
  same precedent as every other adapter's handling of a call into code
  outside the indexed repository.
- For an internal import, look up EXPORTED (per Phase 2's `"exported"`
  modifier) FUNCTION symbols only (never a method — a package-qualified
  call like `pkg.Save()` has no receiver and so, like the direct-call
  case above, can never reach a method) in that resolved directory,
  matching the selector's `field` name:
  - Exactly one match → `confidence: "exact"`, `resolutionKind:
    "imported"` (existing value, already means "resolved via an
    import").
  - Zero or multiple → `"unresolved"`.
- An UNEXPORTED name can never be the target of a package-qualified call
  from outside that package (Go's own visibility rule) — if the
  selector's field name is lowercase, this is not a valid
  package-qualified call at all in real Go; skip strategy 2 for it
  entirely (falls through unresolved, since it's almost certainly
  actually a method call via strategy 3, not a package call).

### 3. Basic receiver-type-based method resolution

For a selector call whose `receiverText` did NOT resolve via strategy 2
(not a known import alias), treat it as a potential method call on a
local variable. Infer the receiver variable's type with a narrow,
regex-based syntactic search over the CALLER's own `body` text (mirrors
`src/languages/python/resolve.ts`'s `bindingClass` function exactly —
same technique, same acknowledged limitation: single, unambiguous
assignment only, reassignment or multiple bindings drop the evidence
rather than guessing):

- `receiver := &TypeName{...}` or `receiver := TypeName{...}` (composite
  literal, pointer or value) → type is `TypeName`.
- `var receiver TypeName` / `var receiver *TypeName` (explicit var
  declaration) → type is `TypeName`.
- `receiver := NewTypeName(...)` (Go's own idiomatic constructor-function
  naming convention, `New` + the type name) → type is `TypeName` — a
  heuristic, not a real return-type check (this project's Go adapter
  doesn't track function return types at all; accepted, documented
  limitation, same "detect the common idiom, don't build full type
  inference" discipline every prior phase has used).
- A method or receiver declaration's own receiver variable (`u` inside
  `func (u *User) Validate()`) → type is the enclosing method's own
  `supertypes[0]` (already computed by Phase 1) — this is the single
  most common real-world case (`u.other()` inside a method on `*User`
  calling another method on the same `u`) and needs no regex at all,
  just reading data Phase 1 already built.
- Once a type name is found, resolve it the same way strategy 1 resolves
  a same-package name (same-directory lookup first, since the type is
  usually declared alongside its methods; cross-package not attempted
  this phase — a receiver typed from an IMPORTED package's type is
  deferred, since it compounds two already-complex lookups).
- Then find a METHOD symbol (kind `"method"`) with matching `name` whose
  `supertypes` includes that type name, in the resolved type's own
  directory → `confidence: "exact"`, `resolutionKind: "same-type"`
  (existing value).
- Any ambiguity at any step → `"unresolved"`, never guessed.

## Non-goals (explicitly out of scope for Phase 3b)

- Interface satisfaction (Go's structural typing — does type T implement
  interface I) and struct embedding resolution — explicitly the
  optional Phase 4, not attempted even partially here.
- Cross-package receiver types (a local variable typed from an imported
  package's struct) — strategy 3 only resolves same-directory types.
- Generics-aware resolution — a method call on a generic receiver
  resolves by base type name only (matching Phase 1's own
  `receiverBaseTypeName`, which already strips type parameters);
  resolving to a specific instantiation is out of scope (Go's own
  method set doesn't vary by instantiation anyway, so this is actually
  fully correct, not a gap).
- Vendored dependencies, build-tag-gated files, or multi-module
  workspaces (`go.work`) — `go.mod` lookup is for the single
  module-root case only, the common case this project's other
  adapters' own module-resolution logic (Python's `moduleIndex`, Rust's
  `modulePathFor`) already assumes for their own ecosystems.
- Any change to Phase 1-3a's extraction logic — this phase only adds
  `resolveCalls`'s real body and whatever small `ResolveContext`-facing
  helper functions it needs; `parseGo` itself is untouched.

## Architecture

### New file: `src/languages/go/resolve.ts`

Exports `resolveGoCalls(context: ResolveContext): void`, wired into
`src/languages/go/index.ts`'s `resolveCalls` field (replacing today's
no-op).

Core helpers (names illustrative, the implementation task's own job to
finalize exact signatures):

- `directoryOf(filePath): string` — `posix.dirname`, Go's package
  boundary.
- `goModulePath(context): string | undefined` — `ResolveContext` already
  exposes `root` (the repository's absolute root path, confirmed in
  `src/languages/adapter.ts`'s `ResolveContext` interface — no
  extension needed). Read `join(context.root, "go.mod")` directly via
  Node's `fs` (a plain file read, same as any other adapter reading a
  config file outside the indexed-source-file set) and parse its first
  `module <path>` line. A missing `go.mod` means no project-relative
  resolution is possible — every import is treated as external, which
  is the correct, safe fallback, not a special case to code around.
- `symbolsInDirectory(context, dir): SymbolRecord[]`.
- `resolveDirectCall`, `resolveQualifiedCall`, `resolveMethodCall` — the
  three strategies above, each returning an upgrade (or `undefined` to
  leave the edge alone) applied back onto the matching `CallEdge` in
  `context.calls`.

## Testing

New tests in `tests/go.test.ts` use `ProjectIndex` against small
multi-file fixture sets (mirroring how `tests/typescript.test.ts`/
Rust's own tests build multi-file scenarios), not just single-file
`parseGo` calls, since resolution is inherently cross-file:

- A direct call to a function in ANOTHER file in the same directory
  resolves exact.
- A direct call to a function in a DIFFERENT directory does not resolve
  (even same package name, different directory).
- A package-qualified call to an internal project import (with a
  `go.mod` fixture) resolves exact to the right exported symbol.
- A package-qualified call to an external (non-project) import stays
  unresolved with `externalPackage` set.
- A package-qualified call targeting an UNEXPORTED name in the imported
  package does not resolve via the import strategy.
- A method call via a `:=` composite-literal-typed local variable
  resolves exact.
- A method call via a `var`-declared local variable resolves exact.
- A method call via a `New*`-constructor-typed local variable resolves
  exact.
- A method call where the receiver is the enclosing method's own
  receiver variable (`u.other()` inside `func (u *User) ...`) resolves
  exact using Phase 1's existing `supertypes` data, no regex needed.
- An ambiguous/reassigned local variable's method call stays
  unresolved, never guessed.

## Acceptance / Definition of Done for Phase 3b

1. All new and existing Go tests pass.
2. The full existing test suite passes with no regressions.
3. `npm run benchmark:v16` is extended with a resolution oracle (real
   call sites from the three pinned repos whose resolved target is
   known by reading the real source) and run — the existing
   symbol/import/call-extraction oracle entries must stay at 100%
   (resolution never changes `calleeName`/`receiverText`, only adds
   `resolvedTargetId`/upgrades `confidence`), and resolution accuracy is
   reported explicitly (recall/precision against the hand-verified
   oracle) as this phase's own real-world evidence.
4. A short follow-up note records Phase 3b complete, closes the core
   call-graph portion of the Go roadmap, and names the optional Phase 4
   (interface satisfaction, struct embedding) as the only remaining,
   explicitly optional, not-yet-committed-to work.
