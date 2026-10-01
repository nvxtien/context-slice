# Go Language Support — Phase 2: Imports and Export Visibility — Design Spec

## Purpose

Phase 1 (merged 2026-10-01) built symbol extraction for Go's package-level
declarations. This spec is Phase 2 of the "add Go language support"
roadmap: extract `import` declarations into `ImportRecord`s, and mark
exported (capitalization-visible) symbols. Phase 3 (call-edge extraction
and resolution) and the optional Phase 4 (interface satisfaction, struct
embedding) remain separate, later work.

## Scope, confirmed with the user (2026-10-01 brainstorming)

### Imports

Every Go `import` declaration — single (`import "os"`) or grouped
(`import (...)`) — produces one `ImportRecord` per `import_spec`.
Grammar facts (verified empirically against the installed
`tree-sitter-go@0.23.4` during this spec's own writing, parsing all five
real import forms in one sample file):

- `import_spec`'s `path` field is always an `interpreted_string_literal`
  whose own `interpreted_string_literal_content` child holds the
  unquoted import path text (e.g. `net/http/pprof`).
- `import_spec`'s `name` field is absent for a plain import
  (`import "fmt"`), a `package_identifier` for an aliased import
  (`import f "fmt"` or a real third-party import path like
  `import myalias "github.com/foo/bar/baz"`), a `blank_identifier`
  (literal text `_`) for a blank import (`import _ "net/http/pprof"`),
  or a `dot` node (literal text `.`) for a dot import (`import . "math"`).

Mapping onto `ImportRecord` (`src/types/model.ts`):

- `module`: the import path text verbatim (e.g. `"net/http"`,
  `"github.com/foo/bar/baz"`) — Go's own string, no transformation.
- A plain or aliased import (`name` field absent or a
  `package_identifier`) → `kind: "namespace"`. Go has no "named" imports
  in the TS/JS sense — a Go import always binds ONE local name to the
  WHOLE imported package (every one of that package's exported
  identifiers is then reached as `name.Identifier`), which is
  structurally closest to TypeScript's `import * as foo` namespace form,
  not a named/default import. `localName` is the alias text for an
  aliased import, or (plain import) the import path's own last segment
  as a heuristic local name — Go's real local binding is the imported
  package's OWN declared `package` name, which is conventionally but not
  guaranteedly the path's last segment (e.g. `gopkg.in/yaml.v3` declares
  package `yaml`, not `yaml.v3`); Phase 2 accepts this heuristic as a
  known, documented limitation (same "detect what's syntactically
  available, don't over-model what needs cross-package context" discipline
  this project already applies elsewhere — resolving the REAL declared
  package name requires parsing the imported package's own files, which
  is cross-file work; left as a known gap, not attempted this phase).
- A blank import (`name` field is `blank_identifier`) → `kind:
  "side-effect"` (this `ImportKind` variant already exists and already
  means exactly "imported for its side effects, no binding used").
- A dot import (`name` field is `dot`) → `kind: "namespace"` with
  `wildcard: true` and no `localName` — every exported identifier from
  the imported package becomes usable unqualified in this file, the same
  shape Rust's `use foo::*` already uses `wildcard: true` for.
- `typeOnly`: always `false` — Go has no type-only import concept.

### Export visibility

Go has no `export` keyword or statement. A top-level identifier (any
Phase-1-extracted symbol kind: function, method, class/struct, interface,
type, variable, field) is visible outside its package if and only if its
name's first character is uppercase — a purely syntactic, per-symbol
fact requiring no cross-file resolution.

**No `ExportRecord`s are emitted this phase.** Investigated directly:
`src/languages/rust/parse.ts`/`resolve.ts` (the closest existing analog —
Rust also has no `export` keyword, using `pub` instead) only emits
`ExportRecord`s for `pub use` RE-EXPORT chains; a plain `pub fn foo()`
never gets its own `ExportRecord` — `resolve.ts`'s `lookup()` falls back
to a direct `${file}#${name}` symbol-table match for ordinary
declarations, with `ExportRecord`s consulted only when following a
re-export forward to its real source. Go has no re-export mechanism at
all (no `pub use`/`export { x } from "./m"` equivalent — an imported
package's identifiers are only ever reached via `pkg.Name`, never
re-exported under a local file's own name), so there is nothing for an
`ExportRecord` to model in Go. Emitting one per capitalized symbol would
be pure volume with no consumer.

Instead, exported-ness is recorded the same way Rust records `pub`:
appended to the symbol's own `modifiers` array. A symbol whose name
starts with an uppercase letter gets `"exported"` added to `modifiers`
(mirroring `src/languages/rust/parse.ts`'s `const modifiers = isPub(child)
? ["pub"] : [];` pattern exactly — same mechanism, same field, new value).

## Non-goals (explicitly out of scope for Phase 2)

- Resolving a plain import's real local binding name via the imported
  package's own declared `package` clause (see the heuristic note above)
  — deferred indefinitely, not just to a later phase, since it requires
  reading another package's files during THIS file's own parse, which
  `ParsedFile`'s per-file signature doesn't support (every other
  adapter's imports are similarly per-file-only).
- Any cross-file import resolution (matching an `ImportRecord`'s `module`
  to actual files, populating `resolvedFile`/`externalPackage`) — that is
  Phase 3's concern, alongside call-edge resolution, since both need the
  same cross-file infrastructure.
- `ExportRecord`s of any kind (see above — not applicable to Go's model).
- Any change to Phase 1's symbol-extraction logic beyond adding the
  `"exported"` modifier — `canonicalId`, `supertypes`/`parentId` receiver
  linkage, struct/interface/type/const/var extraction all stay as Phase 1
  built them.

## Architecture

### What changes in `src/languages/go/parse.ts`

- A new top-level loop (alongside the existing function/method/type/const/var
  loop) over `child.type === "import_declaration"` children of
  `source_file`, handling both the single-spec and `import_spec_list`
  (grouped) shapes, producing one `ImportRecord` per `import_spec` per
  the mapping above.
- Every symbol-building branch (function, method, struct, interface,
  type, variable, field) gains one additional line: if the symbol's
  `name` starts with an uppercase letter (`/^[A-Z]/.test(name)`), push
  `"exported"` into its `modifiers` array (currently always `[]` in every
  branch — this becomes the first real value that array can hold).

## Testing

New tests in `tests/go.test.ts` (existing Phase 1 tests must continue
passing unchanged):

- A plain import (`import "fmt"`) produces an `ImportRecord` with
  `module: "fmt"`, `kind: "namespace"`.
- An aliased import (`import f "fmt"`) produces `localName: "f"`.
- A blank import (`import _ "net/http/pprof"`) produces `kind:
  "side-effect"`.
- A dot import (`import . "math"`) produces `wildcard: true`.
- A grouped `import (...)` block with multiple specs produces one
  `ImportRecord` per spec (pinning the same "don't collapse a grouped
  block into one record" discipline Phase 1 already pinned for
  `type`/`const`/`var` grouped blocks).
- An exported function (`func Add(...)`) has `"exported"` in its
  `modifiers`; an unexported function (`func add(...)`) does not.
- An exported struct, an exported field, and an exported method
  each correctly get `"exported"` in `modifiers` too (one test covering
  a struct with a mix of exported/unexported fields is sufficient to pin
  the field case without one test per kind).

## Acceptance / Definition of Done for Phase 2

1. All new and existing Go tests pass.
2. The full existing test suite passes with no regressions.
3. `npm run benchmark:v16` is re-run against the same three pinned real
   Go repositories (`pkg/errors`, `spf13/cobra`, `go-chi/chi`) — the
   existing symbol-extraction oracle must stay at 100% (byte-identical
   behavior for symbol kinds/names/linkage, since Phase 2 only adds
   imports + a modifier, never changes Phase 1's symbol output shape
   otherwise), and new oracle entries are added covering real import
   statements and at least one real exported/unexported pair read
   directly from the checked-out source (not guessed).
4. A short follow-up note records Phase 2 complete and names Phase 3
   (call-edge extraction and resolution, which will also need the
   cross-file import-resolution infrastructure Phase 2 deliberately
   deferred) as the next phase.
