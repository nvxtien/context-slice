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

Task 1 commit d2471bd: 36 tests total in tests/go.test.ts, full suite 483/484 passing (1 pre-existing unrelated skip), tsc clean.

## Real-repo benchmark

Task 2 commits ca9bdc3 (initial benchmark extension) and 2f61742 (fix round adding direct-call oracle entries):

| Metric | Found | Total | Coverage |
|--------|-------|-------|----------|
| Symbols | 46 | 46 | 100% |
| Imports | 8 | 8 | 100% |
| Calls | 14 | 14 | 100% |

Breakdown by repository:
- **pkg-errors:** symbols 21/21, imports 2/2, calls 5/5
- **cobra:** symbols 12/12, imports 3/3, calls 4/4
- **chi:** symbols 13/13, imports 3/3, calls 5/5

The Task 2 fix round demonstrates the benchmark review process is catching real gaps: the initial extension missed direct calls within sampled files, and the review identified the all-selector-calls gap, which the fix round resolved by adding oracle entries for actual direct-call examples already present in the data.

## Roadmap status

Phase 3a of 3-4 complete. Next: Phase 3b (call resolution — same-file
exact matches, package-qualified resolution via Phase 2's
`ImportRecord`s, and basic receiver-type tracking for method calls),
the most complex remaining phase in this roadmap.
