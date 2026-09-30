# Java Spring MVC AST Migration: Phase 2 Summary

## Overview

Completed migration of `src/languages/java/enterprise/spring-mvc.ts` from regex-based annotation detection to AST-derived symbol detection, paralleling the Phase 1 DI migration completed in the previous sprint. Delivered zero regression and one genuine improvement: fully-qualified Spring MVC annotation names are now correctly detected.

## What Changed

### Detection Logic
- Replaced `MAPPING_RE` (generic multi-name regex) and `MAPPING_NAMES` with direct use of `SymbolRecord.annotations`, the AST-derived field that provides compiler-accurate annotation records.
- Deleted `matchIsInsideLineComment` entirely — no longer needed since AST annotation detection is immune to comment false-positives.

### New Helper Functions
- Added `bareName(annotation: string)` — strips leading `@` and any dotted package prefix (e.g., `@org.springframework.web.bind.annotation.GetMapping` → `GetMapping`).
- Added `mappingArgsRegex(name: string)` — builds a regex to extract a single, already-AST-confirmed annotation's argument text, tolerating fully-qualified name prefixes.

### Detection Flow
The core `extractSpringMvcRelations` function now:
1. Detects via `method.annotations.map(bareName).find(name => name in MAPPING_ANNOTATIONS)` (same for parent class).
2. Only after confirming a real annotation name, runs `mappingArgsRegex(name)` purely for argument extraction.

## Testing and Validation

### Regression Analysis
- **TDD outcome:** 1 of 4 new tests was genuinely RED against pre-migration code (fully-qualified annotation detection); the other 3 already passed, serving as pinning tests for regression prevention.
- **Unit test suite:** 14/14 pass (spring-mvc.ts tests); 152/152 pass across all Java parser and enterprise-relation suites.
- **No bugs in comment handling:** Unlike Phase 1's DI migration, pre-migration comment-handling logic required no fixes. Deletion of `matchIsInsideLineComment` was purely a simplification (AST symbols already bypass this risk).

### Real-Repository Benchmark (Task 2)
- **Metric:** `npm run benchmark:v14-phase1` (spring-petclinic, petclinic-rest).
- **Results:** 18/18 matched, 1.0 recall, 1.0 precision, byte-identical to committed baseline.
- **Commit status:** No commit needed — the benchmark rerun was byte-identical to the baseline (only the `generatedAt` timestamp differed, which was reverted per procedure).
- **Note:** The real-repository corpus contains no fully-qualified Spring MVC annotations, so the qualified-name fix does not manifest as a visible delta in these benchmarks. This is an honest "equal" — the corpus was already 100%/100%, leaving no room to improve numerically, but the code path now correctly handles a real-world edge case the old regex missed entirely.

## Key Improvement

**Fully-qualified annotation names are now correctly detected.** The old `MAPPING_RE` could only match bare annotation names (e.g., `@GetMapping`) in method headers. The new code strips package prefixes via `bareName()` and searches the AST, so annotations like `@org.springframework.web.bind.annotation.GetMapping` are now recognized. This is a genuine improvement for enterprise code that uses explicit FQDN imports.

## Deliverables Completed

| Item | Status | Evidence |
|------|--------|----------|
| Detection refactored to AST symbols | ✓ | `SymbolRecord.annotations` now used; `MAPPING_RE`/`MAPPING_NAMES` deleted |
| `bareName()` and `mappingArgsRegex()` added | ✓ | Functions added to `spring-mvc.ts`; all call sites working |
| Comment-handling risk eliminated | ✓ | `matchIsInsideLineComment` deleted; no bugs found in pre-migration logic |
| Unit tests green | ✓ | 14/14 spring-mvc tests, 152/152 broader suite |
| Real-repo benchmark verified | ✓ | 18/18, 1.0/1.0, byte-identical to baseline |
| Implementation matches brief exactly | ✓ | No scope creep; registered-extractor contract unchanged |

## Next Steps

**Phase 3:** Migrate `@Transactional` or JPA/Spring Data enterprise extractors to AST symbols. This plan does not prescribe which; both are candidates with similar regex→AST refactoring patterns. Brainstorm and spec separately before implementation.

---

*Migration completed 2026-09-30. No regression. One genuine improvement: fully-qualified annotation handling.*
