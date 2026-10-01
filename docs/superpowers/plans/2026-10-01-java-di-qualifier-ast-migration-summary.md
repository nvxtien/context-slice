# Java DI `@Qualifier` Evidence AST-Gating Complete

**Spec:** `docs/superpowers/specs/2026-10-01-java-di-qualifier-ast-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-10-01-java-di-qualifier-ast-migration.md`

## What changed

`dependency-injection.ts`'s setter-injection loop now gates its
`@Qualifier` evidence extraction on `method.annotations` before matching
`QUALIFIER_RE` against `method.source`. The field and constructor-parameter
`@Qualifier` call sites were investigated and confirmed out of scope: the
field path is empirically safe (`.source` excludes body/trailing
comments), and the constructor-parameter path has no per-parameter
`SymbolRecord` to gate against.

## Bug fixed

A `@Qualifier("...")` mentioned only in a setter method body comment
previously produced fabricated qualifier evidence on an otherwise-correct
`INJECTS_DEPENDENCY` relation (the relation itself was never false — only
its evidence was wrong). RED test (Task 1, commit `b0a8b71`) confirmed the
bug reproduces via the existing code; GREEN after the fix.

## Real-repo benchmark result

Task 2 (commit `eebddbb`) showed no regression: recall 100% (35/35) baseline → 100% (35/35) after; precision 100% (0 false positives) baseline → 100% (0 false positives) after. Byte-identical except timestamp.

## Status

This closes the last Minor item flagged by the DI constructor-injection
gap-closure branch's final review. `dependency-injection.ts` now has no
remaining text-based path that can fabricate relation evidence or produce
a false relation from comment text, except the two explicitly accepted
limitations: constructor-parameter `@Qualifier` extraction (no AST
alternative exists) and the Phase 1 multi-declarator-field divergence.
