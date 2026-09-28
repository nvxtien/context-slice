# Java field-symbol extraction — Phase 0 complete

## What changed

Java class/interface/enum/record fields are now extracted as field-level `SymbolRecord`s alongside existing types, methods, and constructors. All fields use the `metadata.declaredType` convention (matching TypeScript and Python's existing approach), populated via the same AST walk as other language constructs.

**Implementation:** `src/parser/java-parser.ts` — a new `fieldSymbols` function walks the AST and emits field-kind records. Index version bumped 1.11.0 → 1.12.0.

## What was verified (Task 2 benchmarks)

All 5 real-repository benchmarks show zero regression:

- **v0.3**: 100.00% required-fact recall, 94.61% median token reduction, 0.00% resolution harm rate, 0.00% resolution fact-loss rate — headline metrics byte-for-byte identical to baseline.
- **v1.4-phase1** (Spring MVC routes): 100.0% route_linkage_recall and precision.
- **v1.4-phase2** (Dependency injection): 100.0% dependency_linkage_recall and precision.
- **v1.4-phase3** (Transactions): 100.0% transaction_boundary_recall and precision, 100.0% readOnly subset recall.
- **v1.4-phase4** (JPA/Spring Data): 100.0% entity_relation_recall/precision, 100.0% repository_linkage_recall/precision.

Genuine diagnostic changes: v0.3's indexed symbol count rose (240 → 318), and keycloak's call-resolution improved slightly (17350 → 17352 total calls, unresolved −2, resolved +3) — a positive-direction side effect from field-typed receiver availability, outside gated metrics. No regression in any benchmark.

## Phase 0 → Phase 1

This extraction is **Phase 0** of a five-phase roadmap:

- **Phase 1** (next): Migrate `src/languages/java/dependency-injection.ts` to consume field symbols instead of its own regex-based `memberLevelBody` / `INJECT_RE` scan. To be brainstormed and specced separately; findings will suggest priority for Phases 2–5.
- **Phases 2–5**: Migrating the remaining four enterprise extractors (Spring MVC routes, transactions, JPA/Spring Data, and one more) to consume extracted symbols instead of regex scanning.

The pattern: once extractors stop scanning and start consuming symbols, the AST becomes the single source of truth for all language semantics, unifying extraction across codebases and enabling future optimization and language evolution without re-speccing every extractor.
