# Go Language Support — Phase 1: Symbol Extraction — Design Spec

## Purpose

context-slice currently supports Java, Python, Rust, TypeScript, and
(as of 2026-10-01) plain JavaScript. This spec is Phase 1 of a new,
from-scratch Go adapter — the first of a 3-4 phase roadmap (symbol
extraction → import/export → call-edge extraction/resolution →
optional deeper resolution refinements such as interface satisfaction
and struct embedding). Unlike the JavaScript addition, there is no
existing parser to reuse: Go has its own tree-sitter grammar
(`tree-sitter-go`, confirmed available on npm, 0.25.0) and its own
syntax (packages instead of ES modules, capitalization-based
visibility instead of `export`, structs/interfaces instead of
classes, methods declared via a receiver parameter rather than inside
a class body).

Phase 1's scope is narrow and foundational: produce correct
`SymbolRecord`s for Go's package-level declarations, with no call-edge
or import/export extraction yet (those are later phases). Every phase
in this roadmap, including this one, is benchmarked against real,
pinned Go repositories — not unit tests alone.

## Scope, confirmed with the user (2026-10-01 brainstorming)

- New adapter at `src/languages/go/` (`index.ts`, `parse.ts`;
  `resolve.ts` is a Phase 3 concern — Phase 1 registers a no-op
  `resolveCalls` since the adapter interface requires one, matching
  how a brand-new adapter without call support yet would look).
- `SymbolRecord`s for: package-level `func` declarations (kind
  `"function"`), methods — a `func` with a receiver parameter (kind
  `"method"`, `parentId` pointing at the receiver type's own symbol),
  `struct` type declarations (kind `"class"` — Go has no `class`
  keyword, but a struct is the closest match to "a named product type
  with methods attached", consistent with how this project already
  treats Rust `struct`s elsewhere), `interface` type declarations
  (kind `"interface"`), non-struct/non-interface `type` aliases and
  defined types (kind `"type"`), package-level `const`/`var`
  declarations (kind `"variable"`), and struct fields (kind
  `"field"`, `parentId` pointing at the struct's symbol).
- No new `SymbolKind` values — every Go construct in this phase's
  scope maps onto an existing kind, preserving the project's own
  "adding a language must not require core changes" rule (see
  `src/types/model.ts`'s header comment).
- `SymbolRecord.language` is `"go"`.
- `packageName` is the Go package's declared name (from the file's
  `package` clause) — Go's package name is per-directory, not a
  dotted namespace path like Java, so this is simpler than the Java
  adapter's `packageName` derivation.
- `modifiers` captures Go-specific facts that don't fit elsewhere in
  the existing shape: this phase adds no new ones unless a concrete
  construct needs one (e.g. nothing here needs `"exported"` as a
  modifier — see the Non-goals note on capitalization-based
  visibility below).
- `annotations` stays an empty array for all Go symbols in this
  phase — Go has no annotation syntax; the field exists on
  `SymbolRecord` for other languages and is simply unused here, same
  as how Rust's adapter leaves it empty.
- Receiver-type linkage for methods: a method's `parentId` must point
  at the struct (or other named type) its receiver names, with the
  receiver's pointer-ness (`*T` vs `T`) stripped to find the base type
  name — mirroring how the existing Rust adapter already strips `&`,
  `&mut`, `dyn`, and path prefixes to find `implSelfType` (see
  `SymbolMetadata.implSelfType` in `src/types/model.ts`). A method
  whose receiver type isn't found among this file's own symbols
  (e.g. the struct is defined in another file in the same package —
  very common in Go, where a type and its methods are routinely split
  across files) is NOT silently dropped or misattributed: Phase 1
  attributes it to a synthetic per-package-per-type placeholder ID
  scheme that a later cross-file pass can reconcile, OR (simpler,
  preferred — see Architecture) Phase 1 defers full cross-file
  linkage to the indexer's existing symbol-table pass, the same way
  TypeScript/Rust symbols reference each other by name and get
  reconciled once the whole project is indexed, not per-file.

## Non-goals (explicitly out of scope for Phase 1)

- Call edges of any kind (direct calls, method calls, `go` statement
  goroutine launches) — Phase 3.
- Import statements, and Go's capitalization-based export visibility
  — Phase 2. Phase 1 does not add an `exported` flag to
  `SymbolMetadata`; that's Phase 2's concern once imports/exports are
  modeled together (a name's exported-ness only matters once
  something can reference it from another package).
- Interface satisfaction (Go's structural "does this type implement
  this interface" relationship, no `implements` keyword) and struct
  embedding resolution — explicitly deferred to the optional Phase 4,
  not attempted here even partially.
- Generics (Go 1.18+ type parameters on functions/types) — Phase 1
  parses a generic declaration's NAME and still produces a correctly
  kinded symbol (a generic function is still kind `"function""`), but
  does not attempt to model type parameters themselves in
  `SymbolMetadata`; this is the same "detect the construct, don't
  over-model its generic argument list" discipline the DI/JPA work
  applied to Java generics.
- Any change to `src/types/model.ts`, `src/languages/adapter.ts`, or
  any other existing language adapter.

## Architecture

### New files

- `src/languages/go/index.ts` — adapter registration (`id: "go"`,
  `label: "Go"`, `extensions: [".go"]`), mirroring
  `src/languages/rust/index.ts`'s shape. `ignoredDirectories`
  includes `"vendor"` (Go's vendored-dependency directory, the
  closest Go analog to `node_modules`) alongside the project's
  existing defaults.
- `src/languages/go/parse.ts` — the `parseGo(filePath, source):
  ParsedFile` function. Returns `calls: []`, `imports: []`,
  `exports: []` unconditionally this phase (both because those are
  later phases' concern, and because `ParsedFile`'s shape requires
  all four arrays regardless of what a given phase populates).
- Phase 1 registers `resolveCalls: () => {}` (a no-op) in the
  adapter, since the interface requires one and there are no calls to
  resolve yet.

### Cross-file receiver linkage

Go routinely splits a type's declaration and its methods across
multiple files in the same package (e.g. `user.go` declares `type
User struct {...}`, `user_methods.go` declares `func (u *User)
Validate() error {...}`). Within a SINGLE file's `parseGo` call,
a method's receiver type may not be visible. Phase 1 handles this by
recording `supertypes: [receiverTypeName]` (reusing the existing
`SymbolRecord.supertypes` field, the same mechanism Rust's adapter
uses for impl-block Self-type linkage, per the file's own documented
convention) rather than attempting to resolve `parentId` to a
same-file symbol that may not exist. `supertypes` here holds exactly
one entry (the receiver's base type name, pointer-stripped). A later
phase's resolution pass — or, if needed even in Phase 1's own
testing, a simple post-pass within the SAME file when the receiver
type IS present — fills in `parentId` once cross-file context is
available, mirroring how `spring-data.ts`'s
`resolveRepositoryQueryPropagation` already does cross-file linkage
via `supertypes` for an unrelated language. Phase 1's own acceptance
criteria (below) requires same-file receiver linkage (`parentId` set
correctly when the struct IS in the same file) and requires
`supertypes` to carry the receiver name whether or not the struct is
found, so this is testable without waiting for a later phase's
resolver.

### Benchmark

- `benchmarks/go-repositories.json` — three pinned, real repositories
  (manifest shape matches the existing
  `rust-repositories.json`/`typescript-repositories.json` precedent:
  `id`, `scale`, `url`, `commit`, `source`, `scope`, `kind`):
  - **small** — `pkg/errors` (github.com/pkg/errors), commit
    `87f8819acf6dc28bf5d3c14b334268236d686f48`, 10 `.go` files, a
    small single-purpose error-wrapping library.
  - **medium** — `spf13/cobra` (github.com/spf13/cobra), commit
    `adbc8813901bba65827259daa8e22ff94ec1f30e`, 36 `.go` files, a CLI
    framework (structs, interfaces, methods, a realistic application
    shape).
  - **large** — `go-chi/chi` (github.com/go-chi/chi), commit
    `167e1e3bd039d060696b99c8da4e876ae04f42c1`, 84 `.go` files, an
    HTTP routing library with a larger, more varied surface.
  - All three pinned commits were verified reachable via `git
    ls-remote` and checked out directly during this spec's own
    writing (not guessed) — file counts above are measured, not
    estimated.
- `benchmarks/v1.6-go-support.ts` — new benchmark script (next free
  `v1.X` slot per `package.json`; `v1.5` is already used by Rust).
  Phase 1's run: index each of the three repos, compare the extracted
  symbol set against a hand-written oracle (a small, explicit list of
  "this file must produce a symbol named X of kind Y" expectations
  per repo — the same oracle-by-hand-curated-ground-truth approach
  `v1.3-python-support.ts`/`v1.1-typescript-support.ts` already use),
  and report symbol-extraction recall/precision. Later phases
  (imports/exports, calls) EXTEND this same file with additional
  oracle sections and metrics rather than creating parallel benchmark
  files, keeping one benchmark surface per language the way the Java
  enterprise work consolidated JPA+Spring Data into one shared
  report.
- `npm run benchmark:v16` script added to `package.json`, mirroring
  the existing `benchmark:v11`/`v12`/`v13` naming (no `-phaseN`
  suffix needed yet since Phase 1 is this language's first benchmark
  entry; later phases may extend the same script rather than add
  new ones, to be decided when Phase 3 is spec'd).

## Testing

New test file `tests/go.test.ts`, following this project's established
direct-unit-call pattern (`parseGo(filePath, source)` called directly,
no fixture/ProjectIndex ceremony needed for most cases — mirroring
`tests/javascript.test.ts`'s style from the same day's JS work).

Required coverage:
- A package-level `func` produces a `"function"` symbol with the
  correct name and signature text.
- A method (`func (r *Receiver) Name(...)`) produces a `"method"`
  symbol, `supertypes: ["Receiver"]` (pointer-receiver form), and —
  when the receiver struct IS declared in the same file — `parentId`
  correctly resolved to that struct's own symbol id.
- A value-receiver method (`func (r Receiver) Name(...)`, no `*`)
  resolves the same way — pointer-stripping must not require the
  pointer to be present.
- A `struct` type produces a `"class"` symbol; each of its fields
  produces its own `"field"` symbol with `parentId` pointing at the
  struct.
- An `interface` type produces an `"interface"` symbol.
- A non-struct `type` alias/defined type (e.g. `type UserID int`)
  produces a `"type"` symbol.
- A package-level `const` and a package-level `var` each produce a
  `"variable"` symbol.
- A generic function (`func Map[T, U any](...)`) still produces a
  correctly kinded `"function"` symbol (pinning the Non-goals
  decision that generics are detected, not deeply modeled).
- `SymbolRecord.language` is `"go"` for every symbol produced.
- A syntactically broken `.go` file produces `parseError: true`
  without throwing (same contract every other adapter's parse
  function honors).
- The adapter registry test: `adapterFor("main.go")` returns the Go
  adapter (`id: "go"`).

## Acceptance / Definition of Done for Phase 1

1. All new Go unit tests pass.
2. The full existing test suite passes with no regressions.
3. `npm run benchmark:v16` is run against the three real, pinned Go
   repositories above (not skipped, not approximated with synthetic
   fixtures) and its symbol-extraction recall/precision is recorded
   in a committed report (`benchmarks/results/v1.6-go-support.{json,md}`,
   matching every other language-support benchmark's report
   convention). A first-time benchmark has no prior baseline to beat;
   the acceptance bar is that the oracle's hand-curated expectations
   are met, not a regression comparison.
4. `tree-sitter-go` is added to `package.json` dependencies (version
   confirmed available at `0.25.0` on npm as of this spec).
5. A short follow-up note records Phase 1 complete and names Phase 2
   (imports/exports) as the next phase in this roadmap.
