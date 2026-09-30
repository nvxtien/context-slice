# Phase 4b Complete: Java Spring Data `@Query` AST Migration

**Spec:** `docs/superpowers/specs/2026-09-30-java-spring-data-ast-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-09-30-java-spring-data-ast-migration.md`

## What changed

`spring-data.ts`'s `queryText()` now detects `@Query` via
`SymbolRecord.annotations` before running its existing depth-counting
extraction regex, instead of searching the method's raw source text
unconditionally. `repositoryShape()` and `derivedProperties()` were
confirmed out of scope (not annotation-based detection) and left
unchanged.

## Bug fixed

A `@Query(...)` mentioned inside a method body comment previously produced
a false `REPOSITORY_QUERY` relation. RED test (Task 1, commit `c058268`)
confirmed the bug reproduces via the existing code; GREEN after the fix.
The real-repo benchmark corpus did not contain this pattern, matching the
spec's stated expectation that the actual codebase occurrence is rare.

## Real-repo benchmark result

`repository_linkage`: 100.0%/100.0% (26/26) baseline → 100.0%/100.0% (26/26) after (recall/precision).
`entity_relation`: byte-identical to baseline, as expected (untouched
code path).

## Roadmap status: COMPLETE

This closes the "AST-ify enterprise extractors" roadmap. All five
enterprise extractors now detect annotations via AST-derived
`SymbolRecord.annotations` rather than comment-unaware text regexes:

1. `dependency-injection.ts` (Phase 1)
2. `spring-mvc.ts` (Phase 2)
3. `transactions.ts` (Phase 3)
4. `jpa-entity.ts` (Phase 4a)
5. `spring-data.ts` (Phase 4b)
