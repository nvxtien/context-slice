# Go Language Support Phase 1 Complete: Symbol Extraction

**Spec:** `docs/superpowers/specs/2026-10-01-go-support-phase1-symbols-design.md`
**Plan:** `docs/superpowers/plans/2026-10-01-go-support-phase1-symbols.md`

## What was built

A new Go language adapter (`src/languages/go/`) extracting `SymbolRecord`s
for package-level functions, methods (with same-file receiver-type
linkage via `supertypes`/`parentId`), structs (as kind `"class"`,
including field extraction, with embedded-field name fallback),
interfaces, type aliases, and package-level const/var declarations.
No new `SymbolKind` values were added.

## Test evidence

Commits 4b18295 (feat: add Go adapter skeleton with function/method/struct symbol extraction)
and 0b1a175 (feat: extract interface, type alias, const/var, and struct field symbols)
delivered comprehensive test coverage: 15/15 tests passing in `tests/go.test.ts`.
Full test suite: 462+/463 passing (1 pre-existing unrelated skip), `tsc --noEmit` clean.

## Real-repo benchmark

Ran against three pinned real Go repositories:

- **pkg/errors** (small): 20/20 symbols found
- **spf13/cobra** (medium): 11/11 symbols found
- **go-chi/chi** (large): 12/12 symbols found

**Total: 43/43 (100%)** across all three pinned repositories, covering functions, methods, structs, interfaces, type aliases, and both regular and embedded struct fields.

The benchmark's fix round (Task 3, finding a real field-coverage gap in embedded-field oracle logic, fixing it, confirming no adapter defect) is itself evidence the benchmark is a genuine regression gate, not a rubber stamp.

## Roadmap status

Phase 1 of 3-4 complete. Next: Phase 2 (imports and Go's
capitalization-based export visibility).
