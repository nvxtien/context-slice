# Java AST parser rewrite — summary

Replaced `src/parser/java-parser.ts`'s regex-based type, method, and constructor
extraction with real tree-sitter AST traversal (Tasks 1-2). Call extraction and
`resolveCalls` were left untouched — out of scope, no evidence motivating a rewrite
there.

## Bugs fixed (confirmed against real checked-out files, not fixtures)

1. **Multi-line `@Query`-annotated `findAll(Pageable)` silently dropped.**
   `SpringDataOwnerRepository.java` / `SpringDataPetRepository.java`
   (petclinic-rest). The old regex parser mis-split/missed the method when a
   multi-line `@Query(...)` annotation preceded it. Now extracted correctly as a
   single `findAll` method symbol.
2. **Javadoc text corrupting symbol extraction.** `OwnerRepository.java` /
   `VetRepository.java` (spring-petclinic): the sentence "...this interface can
   easily be extended for Spring Data..." caused the old regex parser to splice
   `for`/`can` into the canonical `qualifiedName` (e.g.
   `...vet.for.can.VetRepository.findAll`) and, in `PERSISTS_ENTITY` benchmark
   terms, produce spurious false-positive relations. Now zero false-positive
   symbols and correct qualified names.

## Real-repository numbers (Task 3)

- `benchmark:v03` (spring-petclinic, petclinic-rest, keycloak-services):
  medianTokenReduction 94.52% → 94.61% (improved), fact recall 100% → 100%,
  resolution harm 0 → 0.
- `benchmark:v14-phase4` (JPA / Spring Data): `repository_linkage`
  recall/precision 92.31%/92.31% (24/26) → 100%/100% (26/26); the two
  `REPOSITORY_QUERY_MISSING` misses removed were exactly the `findAll(Pageable)`
  case above. `PERSISTS_ENTITY` false positives 2 → 0, exactly the javadoc case
  above.
- `benchmark:v14-phase1/2/3` (routes, DI, transactions): unchanged, 100%/100%
  throughout — no regression.

All 5 real-repository Java benchmarks are equal or improved versus the
pre-rewrite baseline. Three per-task token-count deltas flagged during review
were investigated and confirmed to be genuine call-resolution correctness
improvements (previously-unresolved dependencies now correctly included), not
regressions — see Task 3's report for the full diagnosis.

## Declined scope

- **Field-level symbol indexing** — a real, valuable capability, but a new
  feature, not a parity fix for the two bugs this plan targeted. Left for a
  future plan.
- **Call-extraction / `resolveCalls` rewrite** — no evidence of a bug there;
  rewriting it here would have been unmotivated scope creep beyond what the two
  diagnosed bugs required.

## Superseded plan

`docs/superpowers/plans/2026-09-28-v1.4-java-parser-fixes.md` (a smaller,
earlier regex-patch plan targeting the same two bugs, committed on `main`
before this branch existed) is now redundant: this rewrite fixes both bugs as a
structural side effect. Removed from the working tree in this commit; its git
history remains as the record of the original diagnosis.
