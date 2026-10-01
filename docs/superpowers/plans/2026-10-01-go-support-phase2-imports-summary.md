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

Commit 4538665: 26 tests total (18 pre-existing + 8 new), full suite passing 473/474 (1 pre-existing unrelated skip).

## Real-repo benchmark

Pre-existing symbol oracle: 46/46 (100%) across pkg-errors 21/21, cobra 12/12, chi 13/13. New import/exported-visibility oracle: 8/8 (100%) across pkg-errors 2/2, cobra 3/3, chi 3/3. No regression on Phase 1's original 43 symbol entries.

## Roadmap status

Phase 2 of 3-4 complete. Next: Phase 3 (call-edge extraction and
resolution, including the cross-file import resolution Phase 2
deliberately deferred — resolving an import's `module` to an actual
project file, and a plain import's real local binding name via the
imported package's own declared `package` clause).
