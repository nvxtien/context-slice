# Java @Transactional AST Migration: Phase 3 Summary

## Overview

Completed migration of `src/languages/java/enterprise/transactions.ts` from regex-based annotation detection to AST-derived symbol detection, paralleling the Phase 1 DI and Phase 2 Spring MVC migrations. Delivered zero regression and proactive application of the fully-qualified-name fix learned in Phase 2, applied here before implementation rather than after.

## What Changed

### Detection Logic
- Replaced `TRANSACTIONAL_RE` (generic regex) with direct use of `SymbolRecord.annotations`, the AST-derived field that provides compiler-accurate annotation records.
- Deleted `matchIsInsideLineComment` entirely — no longer needed since AST annotation detection is immune to comment false-positives.

### New Helper Functions
- Added `bareName(annotation: string)` — strips leading `@` and any dotted package prefix (e.g., `@org.springframework.transaction.annotation.Transactional` → `Transactional`).
- Added `transactionalArgsRegex()` — returns a regex to extract argument text from an already-AST-confirmed `@Transactional` annotation, tolerating fully-qualified name prefixes.

### Detection Flow
The core `extractTransactionRelations` function now:
1. Detects via `method.annotations.some((a) => bareName(a) === "Transactional")` on each method symbol.
2. Only after confirming a real annotation via AST, runs `header(method).match(transactionalArgsRegex())` purely for argument extraction.

## Testing and Validation

### Regression Analysis
- **TDD outcome:** 1 of 2 new tests was genuinely RED against pre-migration code (fully-qualified annotation detection); the other was already passing, serving as a pinning test for multi-line argument handling.
- **Unit test suite:** 9/9 pass (transactions.ts tests); 154/154 pass across all Java parser and enterprise-relation suites.
- **No bugs in comment handling:** Like Phase 2's DI/Spring MVC outcome, pre-migration comment-handling logic required no fixes. Deletion of `matchIsInsideLineComment` was purely a simplification (AST symbols already bypass this risk).

### Real-Repository Benchmark (Task 2)
- **Metric:** `npm run benchmark:v14-phase3` (spring-petclinic, petclinic-rest).
- **Results:** 21/21 matched, 100% recall, 100% precision, byte-identical to committed baseline.
- **Commit status:** No commit needed — the benchmark rerun was byte-identical to the baseline (only the `generatedAt` timestamp differed, which was reverted per procedure).
- **Note:** The real-repository corpus contains no fully-qualified `@Transactional` annotations, so the qualified-name fix does not manifest as a visible delta in these benchmarks. This is an honest "equal" — the corpus was already 100%/100%, leaving no room to improve numerically, but the code path now correctly handles a real-world edge case the old regex missed entirely.

## Proactive Improvement

**Fully-qualified annotation names are now correctly detected, learned and applied proactively from Phase 2.** The old `TRANSACTIONAL_RE` could only match bare annotation names (e.g., `@Transactional`) in method headers. The new code strips package prefixes via `bareName()` and searches the AST, so annotations like `@org.springframework.transaction.annotation.Transactional` are now recognized. This fix was applied at implementation time (Task 1) rather than discovered mid-project and patched afterward, shortening the overall roadmap.

## Deliverables Completed

| Item | Status | Evidence |
|------|--------|----------|
| Detection refactored to AST symbols | ✓ | `SymbolRecord.annotations` now used; `TRANSACTIONAL_RE` deleted |
| `bareName()` and `transactionalArgsRegex()` added | ✓ | Functions added to `transactions.ts`; all call sites working |
| Comment-handling risk eliminated | ✓ | `matchIsInsideLineComment` deleted; no bugs found in pre-migration logic |
| Unit tests green | ✓ | 9/9 transactions.ts tests, 154/154 broader suite |
| Real-repo benchmark verified | ✓ | 21/21, 100%/100%, byte-identical to baseline |
| Implementation matches brief exactly | ✓ | No scope creep; registered-extractor contract unchanged |

## Next Steps

**Phase 4 (FINAL):** Migrate `JPA` and `Spring Data` enterprise extractors to AST symbols. After Phase 4, all five enterprise extractors will have been migrated off regex onto AST-derived symbols. This represents the final sub-project in the entire roadmap.

---

*Migration completed 2026-09-30. Zero regression (21/21 @ 100%/100%). Fully-qualified annotation handling applied proactively. Phase 4 is the final remaining phase of this roadmap.*
