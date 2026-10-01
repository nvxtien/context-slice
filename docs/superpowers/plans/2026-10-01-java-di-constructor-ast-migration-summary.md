# Java DI Constructor-Injection AST Migration Complete

**Spec:** `docs/superpowers/specs/2026-10-01-java-di-constructor-ast-migration-design.md`
**Plan:** `docs/superpowers/plans/2026-10-01-java-di-constructor-ast-migration.md`

## What changed

`dependency-injection.ts`'s constructor-injection gate now checks
`SymbolRecord.annotations` for `Autowired`/`Inject` instead of running a
text regex over the constructor's own source (body included). No
extraction regex was needed — this annotation never carried attribute
values in this code path, so the fix is a straight membership check.

## Bugs fixed

Two bugs were fixed in Task 1 (commit d6ffec1), both confirmed via test
evidence:

1. **Comment false positive:** A `@Autowired`/`@Inject` mentioned inside a
   constructor body comment previously produced a false `INJECTS_DEPENDENCY`
   relation on an otherwise-plain (non-Spring-managed) class. Test 16 failed
   against old code (RED), passed after the fix (GREEN). The controller
   independently re-verified by reverting the fix and re-running, confirming
   test 16 failed pre-fix.

2. **Missed fully-qualified annotations:** The old regex pattern
   `@(?:Autowired|Inject)\b` required the bare annotation name immediately
   after `@`, so it never matched a fully-qualified
   `@org.springframework.beans.factory.annotation.Autowired` constructor
   annotation at all — such constructors were silently never detected as
   injection points. Test 18 failed against old code (RED), passed after the
   fix (GREEN).

All 25 dependency-injection tests pass (22 existing + 3 new). Full suite:
432/432 passing, with only the 6 known pre-existing worktree-environment
failures (unrelated, expected).

The real-repo benchmark corpus did not happen to contain either pattern
(expected).

## Real-repo benchmark result

Phase 2 dependency-injection benchmark (Task 2, commit fc79c8b):

- **Baseline:** recall 100% (35/35), precision 100% (0 false positives)
- **After fix:** recall 100% (35/35), precision 100% (0 false positives)
- Result: byte-identical except the generatedAt timestamp — no regression.

## Roadmap status

This closes the one residual gap flagged by Phase 4b's final
whole-branch review. All five enterprise extractors' primary
relationship-annotation and dependency-injection detection paths —
including constructor injection, which predates the "AST-ify enterprise
extractors" roadmap itself — now use AST-derived `SymbolRecord.annotations`
rather than comment-unaware text regexes.
