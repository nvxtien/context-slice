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

Commits c106cc6 ("feat(go): resolve same-package direct calls"), 63c9299 ("feat(go): resolve package-qualified calls via imports"), and 848a5f8 ("feat(go): resolve receiver-typed method calls") landed the three core resolution strategies. Final test result: 50/50 in `tests/go.test.ts`, full suite 523/523 passing, tsc clean.

## Real-repo benchmark

Commits 298f957 (benchmark extension, found a real bug) and 994558e (dedicated fix for that bug) completed the implementation. Final resolution accuracy: symbols 46/46 (100%), imports 8/8 (100%), calls 14/14 (100%), resolutions 16/16 (100%) — across pkg-errors, cobra, chi. This baseline is unchanged for symbol/import/call-extraction accuracy (all 100%).

## Two bugs found and fixed

During review and benchmarking, two real correctness issues were discovered and independently verified:

1. **Module-prefix boundary bug (Task 3 review):** Sibling modules sharing a string prefix (e.g. `example.com/proj` vs `example.com/projfoo`) were being wrongly conflated during module resolution. Fixed during Task 3's review cycle.

2. **Versioned-import-path bug (Task 4 benchmark):** Go's standard `/vN` major-version-suffix module convention broke the unaliased-import local-name heuristic (e.g. `github.com/go-chi/chi/v5`). The fix strips the trailing `/vN` before taking the last path segment. Direct source verification by independent reviewers confirmed both issues in real code.

These findings demonstrate that the review and benchmark process substantively catches real correctness issues, not just rubber-stamping implementer claims.

## Roadmap status

This phase closes the core call-graph portion of the "add Go language support" roadmap: symbol extraction (Phase 1), imports and export visibility (Phase 2), call extraction (Phase 3a), and call resolution (Phase 3b) are all complete. Only the explicitly OPTIONAL Phase 4 (interface satisfaction, struct embedding) remains, not yet committed to.
