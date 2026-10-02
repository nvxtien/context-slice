# Go Language Support — Phase 4 (Optional): Struct Embedding and Interface Satisfaction — Design Spec

## Purpose

Phases 1-3b (merged) cover symbol extraction, imports/exports, and call
extraction/resolution for direct calls, import-qualified calls, and
receiver-typed method calls. This spec is the explicitly OPTIONAL Phase
4, closing two structural gaps Go's own type system creates that no
prior phase modeled: struct embedding (a struct "inherits" an embedded
type's methods/fields without declaring them itself) and interface
satisfaction (Go's structural typing — a type implements an interface
by having its methods, with no `implements` keyword).

## Scope

### Part A: Mark embedded fields explicitly (small `parse.ts` addition)

Phase 1's field extraction already handles an embedded field's NAME
correctly (falls back to the type name when no explicit field name
exists), but does not record that a field IS embedded anywhere
queryable — a field symbol named `Base` of type `Base` is
indistinguishable from a coincidentally-named explicit field `Base
Base` without re-deriving it. Add `metadata.embedded: true` to a field
symbol when `field(fieldDecl, "name")` is absent (the exact condition
Phase 1 already detects, just not persisted) — the smallest change that
makes Part B possible, following the established pattern of per-field
metadata flags already in `SymbolMetadata` (`classMethod`,
`staticMethod`, `implSelfType`, etc.).

This is the one change to `src/languages/go/parse.ts` this phase makes;
every other phase's "don't touch parse.ts" discipline was scoped to
THEIR OWN unrelated work, not a permanent freeze — this is a small,
directly-justified addition for Phase 4's own correctness requirement.

### Part B: Struct embedding — method promotion in call resolution

Extend `resolveMethodCall` (Phase 3b, `src/languages/go/resolve.ts`):
when a receiver's resolved type `T` has NO direct method matching the
call (today's existing `resolveMethodCall` already finds this — it's
the "no match" case that currently just leaves the call unresolved),
look at `T`'s own embedded fields (`kind: "field"`, `parentId: T.id`,
`metadata.embedded: true`) for a type that DOES have the method:

- Exactly one embedded field's type has a matching method (checked
  recursively — if THAT type also lacks it directly, check ITS embedded
  fields, and so on) → resolve to that method, `confidence: "exact"`,
  `resolutionKind: "same-type"` (same existing value Phase 3b already
  uses for receiver-type method resolution — struct embedding is a
  variant of the same underlying mechanism, not a new kind of fact).
- Multiple embedded fields at the SAME promotion depth both have a
  matching method → Go itself would reject this as an ambiguous
  selector at compile time; this adapter mirrors that by staying
  `"unresolved"`, never guessing which one.
- A match found at a SHALLOWER depth takes precedence over one at a
  deeper depth (Go's own shadowing rule) — stop searching deeper once
  any depth level produces a match (ambiguous or not).
- Same-directory-only lookup for the embedded type itself, matching
  every other Phase 3b strategy's existing same-package scope — a
  struct embedding a type from an IMPORTED package is out of scope
  (Non-goals).

### Part C: Interface satisfaction — structural `supertypes` linkage

For every `interface` symbol and every `class` (struct) symbol in the
SAME directory (same package — cross-package deferred, same
established boundary as every other Phase 3b strategy), determine
whether the struct's own method set — ITS DIRECT methods, PLUS every
method reachable via Part B's embedding-promotion logic — includes
every method NAME the interface declares (method-NAME matching only,
not parameter/return-type signature matching — this project's own
established precision level throughout; Java's own `implements`
modeling and this project's general philosophy never type-checks
signatures, only detects structural presence). If every interface
method name is present, append the interface's name to the struct
symbol's `supertypes` array (structs currently never populate
`supertypes` — this is the first time a struct symbol gets one, a
natural, additive use of an existing field, not a new one).

This computation runs as a POST-PASS over all directories' symbols
(not as part of the call-resolution loop), since it is not about a
specific call edge — it is a standing fact about the symbol itself,
like Phase 1's own `supertypes` population for methods already is.

## Non-goals (explicitly out of scope for Phase 4)

- Cross-package struct embedding or interface satisfaction — both
  stay same-directory-only, matching Phase 3b's own established
  boundary.
- Embedded INTERFACES (an interface embedding another interface, or a
  struct embedding an interface) — Part B only handles struct-embeds-struct;
  Go's other embedding forms are a real but separate extension, deferred.
- Signature-level interface satisfaction (parameter/return types) —
  method-name-set matching only, an accepted, documented precision
  limit consistent with this project's approach everywhere else.
- Any change to `canonicalId`, the existing three Phase 3b resolution
  strategies' own logic, or Phase 1/2's non-field symbol extraction.
- Ambiguous-promotion tie-breaking beyond "same depth, multiple matches
  → unresolved" — no attempt to apply Go's full disambiguation rules
  beyond the shallowest-wins-or-ambiguous rule already stated.

## Architecture

### `src/languages/go/parse.ts` (Part A)

One-line addition in the field-building branch: when the embedded-field
fallback path is taken (no explicit `name` field), set
`metadata: { embedded: true }` on that field's `SymbolRecord` (merge
with any other metadata already being set there, which today is none
for fields — the field branch currently passes no `metadata` key at
all, so this is a new key, not a conflicting overwrite).

### `src/types/model.ts`

Add `embedded?: boolean` to `SymbolMetadata` (one line, matching the
existing style of every other per-construct boolean flag already
there) — the project's own stated rule ("adding a language must not
require core changes") is about LANGUAGE IDs and `SymbolKind`, not
`SymbolMetadata`, which every language already extends with its own
flags (Python's `classMethod`, Rust's `implSelfType`) — this is the
established mechanism for exactly this kind of addition, not an
exception to the rule.

### `src/languages/go/resolve.ts` (Parts B and C)

- A `methodSetOf(struct, byDirectory, visited)` helper: returns the set
  of method names reachable from a struct, direct methods first, then
  BFS over embedded-field types one promotion-depth level at a time,
  stopping at the first depth with any match (per struct embedding's
  own shadowing rule) — used by BOTH Part B (resolving one specific
  call) and Part C (computing `supertypes` for every struct once).
- Part B extends `resolveMethodCall`'s existing "no direct method
  found" branch to call this helper instead of giving up immediately.
- Part C runs once per `resolveGoCalls` invocation (not per call edge):
  for every interface in a directory, for every struct in the same
  directory, check interface-method-names ⊆ struct's `methodSetOf`
  result; on a match, push the interface's name onto the struct's
  `supertypes` (mutating the `SymbolRecord` in `context.symbols`
  directly, the same in-place-mutation style `settle()` already uses
  for `CallEdge`s).

## Testing

New tests in `tests/go.test.ts`:

- An embedded field is marked `metadata.embedded === true`; a
  coincidentally same-named EXPLICIT field (`Base Base`) is NOT marked.
- A method call on an embedding struct's value resolves to the EMBEDDED
  type's method when the outer struct has no method of its own with
  that name.
- A method defined on BOTH the outer struct and an embedded type
  resolves to the OUTER struct's own method (direct beats promoted).
- Two embedded fields at the same depth both having the same method
  name leaves the call unresolved (ambiguous), never guessed.
- A multi-level embedding chain (A embeds B embeds C, only C has the
  method) resolves correctly through two promotion levels.
- A struct whose method set (including promoted methods) covers an
  interface's full method set gets that interface's name in its
  `supertypes`.
- A struct missing even one of an interface's methods does NOT get it
  in `supertypes`.

## Acceptance / Definition of Done for Phase 4

1. All new and existing Go tests pass.
2. The full existing test suite passes with no regressions.
3. `npm run benchmark:v16` is extended with embedding/interface-satisfaction
   oracle entries read from the three pinned real repos (if any exist —
   report honestly if the sampled files don't happen to contain struct
   embedding or a satisfied interface, same discipline as prior phases'
   "a correct negative/absence is valid evidence too"), and existing
   oracle entries stay unchanged.
4. A short follow-up note records Phase 4 complete and states that this
   closes the ENTIRE "add Go language support" roadmap, with no further
   committed or optional phases remaining.
