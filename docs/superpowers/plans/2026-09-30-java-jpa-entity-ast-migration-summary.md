# Java JPA Entity AST Migration: Phase 4a Summary

## Overview

Phase 4a of the AST migration for enterprise extractors completed the migration of `jpa-entity.ts` from regex-based field-relationship detection to direct iteration over Phase 0's established AST field symbols. This migration fixed two real, diagnosed bugs confirmed in the pinned real-repository benchmark and, unusually, also required and received an authorized fix to the benchmark's own oracle generator because it independently contained the identical bug class.

## What Changed

**Field-level relationship-annotation detection** now iterates directly over `SymbolRecord` field annotations using their existing `annotations` property, eliminating the need for text-scanning synthesis.

**Deleted code:**
- `memberLevelBody()` — the entire comment-stripping, depth-tracking text scan over the class body
- `RELATION_RE` and `JOIN_COLUMN_RE` — regex patterns for matching stacked relationship annotations and join-column evidence

**New helpers:**
- `bareName(name)` — strips `@` and any dotted package prefix to normalize annotation names
- `relationArgsRegex(name)` — per-annotation argument regex tolerant of fully-qualified annotation names
- `joinColumnArgsRegex()` — fixed regex for `@JoinColumn` arguments, same tolerance

**Core loop replacement:** `extractEntityRelations` now filters AST symbols directly (`symbols.filter(s => s.kind === "field" && s.parentId === entity.id)`), checks `field.annotations.map(bareName)` against a new `RELATION_ANNOTATIONS` set, and pulls declared type from `field.metadata?.declaredType` — no intermediate string synthesis, no regex on member-level body.

## Real Bugs Fixed

### 1. Nested-paren `@JoinColumn` arguments silently dropped the whole relation

**Evidence (Task 1):**
- RED test: `"a field's @JoinColumn with a nested-annotation argument no longer drops the whole relation"` → FAILED (`expected an ENTITY_RELATION despite the nested-paren @JoinColumn argument`)
- GREEN result: After migration, test passes. Relation exists with correct target `Pet` even with nested `@JoinColumn(foreignKey = @ForeignKey(name = "fk_pet"))`.

**Why it happened:** The pre-migration regex `[^)]*` body for matching stacked annotations couldn't distinguish a closing `)` from the inner annotation's argument list from the outer annotation's closing paren. When consuming `@JoinTable(... @JoinColumn(...) ...)`, the regex consumed only up to the first `)` (the inner one), leaving a misaligned fragment that failed the subsequent field-declaration match, so the entire relation was silently dropped.

### 2. Multi-declarator relationship fields silently dropped all but the first

**Evidence (Task 1):**
- RED test: `"a multi-declarator relationship field produces a relation for each declarator"` → FAILED (`0 !== 2`)
- GREEN result: After migration, test passes. Field `private java.util.List<Pet> pets, favorites;` now correctly produces 2 relations, both targeting `Pet`.

**Why it happened:** The pre-migration approach synthesized a "member-level body" string, then regex-matched it for relationship annotations. The string included the first declarator with its annotations, but the subsequent declarators on the same type declaration appeared as bare identifiers without annotation context, so they were never matched as relationship fields.

## Benchmark Verification: The Unusual Oracle Fix

**Discovered during Task 2 verification:** After Task 1's fix was deployed, the real-repository benchmark surfaced an **independent copy of the identical nested-paren bug** in `benchmarks/java-enterprise-jpa-oracle.ts` — the benchmark's own ground-truth generator. The oracle had never recorded `Vet.specialties` (a real `@ManyToMany` relation in both `spring-petclinic` and `petclinic-rest`) because its own regex-based annotation-consuming step used the same `[^)]*` body and under-consumed at the first `)`, leaving the oracle's oracleTotal at 10 instead of the honest 12.

**Coordinator ruling:** Fix the oracle's own copy of the bug (narrowly, oracle file only).

**Oracle fixes applied:**
1. Replaced the regex-based lead computation with a hand-written `consumeLeadingAnnotations(text)` that walks character-by-character and depth-counts nested parens, mirroring the existing `memberLevelMask`'s brace-depth counting.
2. Fixed a second-order bug discovered during oracle validation: after (1), the oracle re-scanned the now-complete lead text with `JOIN_COLUMN_RE` to find `@JoinColumn` evidence. But the new lead correctly includes all of `@JoinTable(...)`'s content, including its nested `@JoinColumn(name = "vet_id")`. That nested annotation is NOT a top-level field annotation — it's an argument value *inside* `@JoinTable`. Fixed by using the structured annotation list from (1) to find only genuine top-level `@JoinColumn` stacked annotations.

**Result:** `entity_relation` benchmark numbers moved from an undersized (and incorrect) 10/10 to the honest and now-correct **12/12 (100%/100%)**, with both newly-recognized relations (`Vet.specialties` in both repositories) now correctly detected and counted as ground truth.

## Verification Results

**Full suite (corrected exclusion command):**
```
npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")
```
Result: 434 tests, 428 pass, 6 fail — identical 6 pre-existing failures in `tests/cli.test.ts`, zero new failures.

**Benchmark metrics (Task 2, post-oracle-fix, final):**
- `entity_relation`: oracle=12, matched=12, falsePositives=0 → recall 100%, precision 100%
- `repository_linkage`: oracle=26, matched=26, falsePositives=0 → recall 100%, precision 100% (byte-identical to committed, confirming zero unintended effect on the untouched `spring-data.ts` code path)

## Final Roadmap Status

**Phase 4a complete.** Phase 4b (`spring-data.ts`) is the **ABSOLUTE FINAL remaining sub-project** in the entire AST-migration roadmap. After Phase 4b, all five enterprise extractors will have been migrated off regex onto AST-derived symbols, completing the whole "AST-ify enterprise extractors" initiative that began 2026-09-28.

## Commits

- `c9e1e22` — feat(java): detect JPA entity relationships via AST field symbols
- `0a7aa4e` — fix(benchmark): correct oracle's nested-paren @JoinColumn/JoinTable bug
- `eb3d387` — docs: update benchmark narrative for the oracle fix

## Files Modified

- `src/languages/java/enterprise/jpa-entity.ts` — field-symbol iteration, deleted regex and text-scanning
- `tests/java-enterprise-jpa-entity.test.ts` — 3 new tests for the two bugs and qualified-name tolerance
- `benchmarks/java-enterprise-jpa-oracle.ts` — paren-depth-aware annotation consumption, structured annotation extraction
- `benchmarks/results/v1.4-phase4-jpa-spring-data.json` — regenerated with honest 12-relation oracle
- `benchmarks/results/v1.4-phase4-jpa-spring-data.md` — updated numeric tables and caveat description
