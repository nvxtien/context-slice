# Java DI `@Qualifier` Evidence AST-Gating Complete

**Spec:** `docs/superpowers/specs/2026-10-01-java-di-qualifier-ast-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-10-01-java-di-qualifier-ast-migration.md`

## What changed

`dependency-injection.ts`'s setter-injection loop now gates its
`@Qualifier` evidence extraction on `method.annotations` before matching
`QUALIFIER_RE` against `method.source`. The field-injection loop had the
same bug class: a comment placed between the `@Autowired` annotation and
the field declaration is still inside `field.source`'s range, so it could
fabricate qualifier evidence too. That loop now gates on
`field.annotations` the same way. The constructor-parameter `@Qualifier`
call site remains out of scope: it has no per-parameter `SymbolRecord` to
gate against.

## Bugs fixed

A `@Qualifier("...")` mentioned only in a setter method body comment
previously produced fabricated qualifier evidence on an otherwise-correct
`INJECTS_DEPENDENCY` relation (the relation itself was never false — only
its evidence was wrong). RED test (Task 1, commit `b0a8b71`) confirmed the
bug reproduces via the existing code; GREEN after the fix.

The same bug class existed in the field loop: a `@Qualifier("...")` left
in a comment between `@Autowired` and the field declaration was still
inside `field.source` and produced the same kind of fabricated evidence.
Fixed by gating on `field.annotations`, mirroring the setter fix.

## Real-repo benchmark result

Task 2 (commit `eebddbb`) showed no regression: recall 100% (35/35) baseline → 100% (35/35) after; precision 100% (0 false positives) baseline → 100% (0 false positives) after. Byte-identical except timestamp.

## Status

This closes the last Minor item flagged by the DI constructor-injection
gap-closure branch's final review, plus a same-bug-class finding raised
against the field loop during final whole-branch review.
`dependency-injection.ts` now has no remaining text-based path that can
fabricate relation evidence or produce a false relation from comment
text, except the two explicitly accepted limitations:
constructor-parameter `@Qualifier` extraction (no AST alternative exists)
and the Phase 1 multi-declarator-field divergence.
