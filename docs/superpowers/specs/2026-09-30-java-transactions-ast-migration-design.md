# Java @Transactional AST Migration — Design Spec (Phase 3 of the "AST-ify enterprise extractors" roadmap)

## Purpose

Phase 2 (merged 2026-09-30) migrated `spring-mvc.ts`'s mapping-annotation
detection off regex onto AST symbols. This spec is Phase 3: migrate
`src/languages/java/enterprise/transactions.ts`'s `@Transactional`
detection the same way.

`transactions.ts` is structurally almost a direct copy of `spring-mvc.ts`'s
pre-Phase-2 shape — its own `matchIsInsideLineComment()` doc comment
literally says "Re-derived from spring-mvc.ts's matchIsInsideLineComment"
(confirmed; Phase 2's own final review independently found and flagged
this exact duplication, including that spring-mvc.ts's own comment now
references a deleted function). No bug was found in reading this file
(same disposition as Phase 2): the comment-guard logic is correct, and
this migration is primarily architectural consistency plus one
anticipated small fix (see below), not a bug fix.

## Scope, confirmed with the user (2026-09-30 brainstorming)

Same split as Phases 1-2: **detection moves fully to AST; attribute-value
extraction keeps a narrower, safer regex.**
- Whether a method carries `@Transactional` is now determined via
  `SymbolRecord.annotations` — never a text-matching regex. (Unlike
  Phase 2, there is no class-level check here — `@Transactional` is only
  ever meaningful at the method level in this extractor's existing scope,
  matching its current, unchanged behavior.)
- The annotation's ATTRIBUTE values (`readOnly = true`,
  `propagation = Propagation.REQUIRES_NEW`, etc.) are not available from
  `.annotations` (bare names only) — extraction still needs a targeted
  regex against the method's own `.source`, run only after `.annotations`
  has already confirmed the annotation is real.
- **Anticipated fix, applied proactively (not discovered via a bug, but
  via the established pattern from Phase 2's own self-caught bug):** the
  attribute-extraction regex must tolerate a fully-qualified annotation
  name (e.g. `@org.springframework.transaction.annotation.Transactional`),
  the same `(?:[\w.]+\.)?`-prefix fix Phase 2 needed for
  `mappingArgsRegex`. Without it, a qualified `@Transactional` would be
  correctly DETECTED (via `.annotations`) but its attributes would never
  be found — silently downgrading it to "no fact to record" (the same
  outcome as a bare `@Transactional`, per this file's own existing
  `if (rawArgs === undefined || rawArgs.trim() === "") continue;` early
  exit), rather than the fully-resolved relation it should produce.

## Non-goals (explicitly out of scope for Phase 3)

- Resolving `@Transactional` applied at the CLASS level (Spring allows a
  class-level `@Transactional` that applies to all its methods) —
  `transactions.ts` does not handle this today (only iterates
  `symbols.filter(s => s.kind === "method")`), and this migration does
  not add it; that would be new scope, not a parity/consistency fix.
- Any change to `KEPT_ATTRS`, `splitTopLevel()`, or the
  confidence/targetLabel computation logic (`extractTransactionRelations`'s
  body from `const rawArgs = match[1];` onward stays untouched).
- Any change to `dependency-injection.ts`, `spring-mvc.ts`, `jpa-entity.ts`,
  or `spring-data.ts`.
- Any change to `src/parser/java-parser.ts`.
- Fixing `spring-mvc.ts`'s own stale comment reference (the one Phase 2's
  final review flagged) is IN scope for this phase, since Phase 3 is
  exactly the phase that makes it true again by deleting this file's own
  `matchIsInsideLineComment` — see Implementation Note below.

## Architecture

### What changes in `transactions.ts`

**Deleted entirely:** `matchIsInsideLineComment()` — identical
disposition to Phase 2's `spring-mvc.ts` deletion, for the identical
reason (AST-based detection can never mistake a comment for a real
annotation).

**`TRANSACTIONAL_RE` replaced** by a new `transactionalArgsRegex(): RegExp`
function (parallel to Phase 2's `mappingArgsRegex(name)`, except this file
only ever has ONE annotation name to match, so the function takes no
parameter — `/@(?:[\w.]+\.)?Transactional(?:\(([^]*?)\))?/`, preserving
the original's non-greedy `[^]*?` body (which already tolerates embedded
newlines and parens inside string-literal attribute values, e.g. a
`rollbackFor = {SomeException.class}` array) and adding only the
qualified-name-tolerant prefix.

**`header()`, `splitTopLevel()`, `KEPT_ATTRS`, the confidence/targetLabel
computation all stay unchanged** — same disposition as Phase 2's
`resolvePath()`/`joinPaths()`/etc.

**Changed: the method-level detection call site.** Today:

```ts
const methodHeader = header(method);
const match = methodHeader.match(TRANSACTIONAL_RE);
if (!match) continue;
if (matchIsInsideLineComment(method, methodHeader, match, source)) continue;

const rawArgs = match[1];
```

Becomes: first check `method.annotations` for a bare name equal to
`"Transactional"` (reusing a locally-duplicated `bareName()` helper —
same convention Phases 1-2 both established: each enterprise-extractor
file keeps its own small copy rather than sharing a cross-file utility
module). Only once confirmed does the code call
`header(method).match(transactionalArgsRegex())` to extract `rawArgs` —
now purely for the attribute text, never for detection.

### Implementation Note: the `spring-mvc.ts` stale comment

Phase 2's final review found that `spring-mvc.ts`'s own (now-deleted)
`matchIsInsideLineComment` doc comment used to say "Re-derived from
spring-mvc.ts's matchIsInsideLineComment" is backwards — it's
`transactions.ts`'s comment that references spring-mvc.ts, and since
Phase 2 already deleted spring-mvc.ts's version, `transactions.ts`'s
comment now points at a function that no longer exists anywhere. Since
Phase 3 deletes `transactions.ts`'s own copy of that function entirely,
this stale reference disappears as a natural side effect of the deletion
— no separate fix step is needed; noting it here only so the plan doesn't
need to invent a reason to delete a comment that's being deleted anyway.

## Testing

Existing test file `tests/java-enterprise-transactions.test.ts` must
continue passing UNCHANGED — including, notably, the existing
`"@Transactional inside a comment produces no relation"` test, whose
continuing to pass unchanged IS the regression proof that AST-based
detection correctly replaces the deleted comment-guard, exactly matching
Phase 2's own established testing pattern (no new test needed for that
specific behavior — it's already pinned).

New tests to add:
- A fully-qualified `@Transactional` (e.g.
  `@org.springframework.transaction.annotation.Transactional(readOnly = true)`),
  asserting the attribute is still correctly extracted — this is expected
  to be the one GENUINELY new-coverage test (mirroring Phase 2's own
  finding that this was the only scenario the old regex couldn't handle
  at all).
- A multi-line `@Transactional(...)` argument list, pinning that behavior
  explicitly now that detection has moved to AST (the underlying
  `[^]*?` pattern already tolerates this, matching Phase 1/2's own
  precedent of "likely already correct, still worth pinning").

## Acceptance / Definition of Done for Phase 3

1. All new and existing `@Transactional` tests pass.
2. The full existing test suite passes with no regressions (established
   worktree exclusion list for the four pre-existing hang-prone files).
3. `matchIsInsideLineComment` and `TRANSACTIONAL_RE` confirmed dead
   (grepped, zero remaining references) and deleted.
4. `npm run benchmark:v14-phase3` (confirmed via `package.json` directly
   before writing this spec — maps to
   `tsx benchmarks/v1.4-phase3-transactions.ts`, report file
   `benchmarks/results/v1.4-phase3-transactions.{json,md}`, verified to
   exist rather than assumed — Phase 2's own Task 2 found the plan's
   guessed file name was slightly wrong, a mistake this spec avoids by
   checking directly) is re-run and compared against currently-committed
   numbers: equal or better, never worse. No bug was found in the
   pre-migration investigation of this file, so "equal" is a fully
   expected, acceptable outcome.
5. A short follow-up note records Phase 3 complete and names Phase 4
   (JPA/Spring Data — the only remaining enterprise extractor after this
   phase) as the final sub-project in this roadmap.
