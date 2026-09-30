# Java Spring Data `@Query` AST Migration — Design Spec (Phase 4b of the "AST-ify enterprise extractors" roadmap, FINAL phase)

## Purpose

Phase 4a (merged 2026-09-30) migrated `jpa-entity.ts`'s field-level
relationship-annotation detection off regex onto AST symbols. This spec is
Phase 4b, the last sub-project in the "AST-ify enterprise extractors"
roadmap: migrate `src/languages/java/enterprise/spring-data.ts`'s `@Query`
detection the same way.

`spring-data.ts` is architecturally different from every prior phase's
target file: it has THREE independent detection mechanisms, and only one of
them is annotation-based.

1. **`repositoryShape()`** (interface → base-repository detection, e.g.
   `extends JpaRepository<Owner, Long>`) — already parses the interface's
   own header text with a proper depth-counting `typeArguments()` function,
   not a fragile forward-scan past stacked annotations. It is a supertype
   check, not an annotation check, and `SymbolRecord.supertypes` cannot
   replace it: the parser's supertypes regex already stops at the first `<`
   and drops the generic type arguments entirely (documented in this file's
   own `ponytail:` comment on `resolveRepositoryQueryPropagation`), so the
   entity/id type arguments this function needs are only available via text
   parsing. **Out of scope** — no bug class from prior phases applies here.
2. **`derivedProperties()`** (method-name-pattern detection, e.g.
   `findByLastName`) — a naming-convention parser, not annotation
   detection at all. **Out of scope.**
3. **`queryText()`** (`@Query(...)` detection) — annotation-based, and
   carries the exact bug class every prior phase fixed. **In scope.**

## The real, confirmed bug this migration fixes

`queryText()` today:

```ts
function queryText(method: SymbolRecord): string | undefined {
  const at = method.source.search(/@Query\s*\(/);
  if (at === -1) return undefined;
  // ... depth-counting scan for the matching ")"
}
```

This searches the method's ENTIRE source — not just its header/annotation
block — with no comment-guard and no check against
`SymbolRecord.annotations` first. Reproduced directly against this
codebase's own parser:

```java
default void touch(int id) {
    // @Query("SELECT o FROM Owner o")
    System.out.println("noop");
}
```

produces a spurious `REPOSITORY_QUERY` relation with evidence
`"SELECT o FROM Owner o"`, even though `method.annotations` is correctly
empty (confirmed via a throwaway repro script against `parseJava` +
`extractEnterpriseRelations`, not just read from the code). This is the
same failure mode Phases 2-3 found and fixed for `spring-mvc.ts`'s mapping
annotations and `transactions.ts`'s `@Transactional`: a comment mentioning
the annotation's syntax produces a false positive because detection never
goes through AST-parsed `.annotations`.

## Scope, confirmed with the user (2026-09-30 brainstorming)

Same detect-via-AST / extract-via-targeted-regex split as Phases 1-4a,
applied to exactly one function:

- Whether a method carries `@Query` is now determined via
  `SymbolRecord.annotations` — never a text-search regex, and never run
  against a comment or string literal.
- The annotation's argument text (the JPQL/native query string) is not
  available from `.annotations` (bare names only) — extraction still needs
  the existing depth-counting, string-literal-aware scan against the
  method's own `.source`, run only after `.annotations` has confirmed the
  annotation is real.
- **Proactive fix, applied the same way Phases 2-4a each added it:** the
  extraction regex gains the qualified-name-tolerant prefix
  (`(?:[\w.]+\.)?`) so a fully-qualified
  `@org.springframework.data.jpa.repository.Query(...)` is still correctly
  extracted once `.annotations` has confirmed it (today's plain
  `/@Query\s*\(/` search would still work by accident on a qualified name
  since it doesn't anchor to `@` at position 0, but the new code replaces
  the whole detection mechanism, so this needs stating explicitly rather
  than relying on that accident).

## Non-goals (explicitly out of scope for Phase 4b)

- Any change to `repositoryShape()`, `typeArguments()`, `BASE_RE`, or
  `resolvePersistsEntity` — unrelated detection mechanism, no bug found.
- Any change to `derivedProperties()`, `DERIVED_RE`, or the derived-query
  evidence/targetLabel logic — unrelated detection mechanism, no bug found.
- Any change to `resolveRepositoryQueryPropagation` — it calls
  `derivedProperties()`/`queryText()` as-is; `queryText()`'s new signature
  stays identical (`(method: SymbolRecord) => string | undefined`), so the
  propagation resolver's two call sites need no change.
- Introducing a general comment-guard utility shared across files — each
  enterprise-extractor file keeps its own small `bareName()` helper, per
  the convention every prior phase already established (Phase
  1/2/3/4a each duplicated it locally rather than sharing one).
- Fixing the `repositoryShape()` header-comment theoretical edge case (a
  block comment between `interface X` and `{` containing fake `extends`
  text) — no real-repo occurrence found, not the annotation-detection bug
  class this roadmap targets, and `repositoryShape()` is explicitly out of
  scope per above.

## Architecture

### What changes in `spring-data.ts`

**Added:** `bareName(annotation)` helper (same one-line implementation as
every prior phase: `annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "")`).

**`queryText()` signature stays identical** — `(method: SymbolRecord) => string | undefined`.
Its body changes from a raw source search to:

```ts
function queryText(method: SymbolRecord): string | undefined {
  if (!method.annotations.some((a) => bareName(a) === "Query")) return undefined;
  const at = method.source.search(/@(?:[\w.]+\.)?Query\s*\(/);
  if (at === -1) return undefined;
  const open = method.source.indexOf("(", at);
  let depth = 0;
  let inString = false;
  for (let i = open; i < method.source.length; i++) {
    const ch = method.source[i];
    if (ch === '"' && method.source[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return method.source.slice(open + 1, i).trim();
  }
  return undefined;
}
```

The depth-counting/string-literal-aware paren-matching loop is unchanged
verbatim — it was already correct and is not part of the bug. Only the
entry guard and the search regex's prefix change.

**Everything else in the file — `BASE_RE`, `typeArguments()`,
`repositoryShape()`, `DERIVED_RE`, `derivedProperties()`,
`extractSpringData()`'s loop structure, `resolvePersistsEntity()`,
`resolveRepositoryQueryPropagation()` — stays unchanged.**

## Testing

Existing test file `tests/java-enterprise-spring-data.test.ts` must
continue passing UNCHANGED — all 12 existing tests, including
`"@Query captures the raw text verbatim"`.

New tests to add:

- A `@Query(...)` mentioned only inside a method body comment (the
  `touch()` repro above), asserting NO `REPOSITORY_QUERY` relation is
  produced — pinning the bug fix, mirroring Phases 2-3's own
  "annotation inside a comment produces no relation" test pattern.
- A fully-qualified `@org.springframework.data.jpa.repository.Query(...)`,
  asserting the query text is still correctly extracted — mirroring every
  prior phase's own proactively-applied fix test.

## Acceptance / Definition of Done for Phase 4b

1. All new and existing Spring Data tests pass.
2. The full existing test suite passes with no regressions (established
   worktree exclusion list for the four pre-existing hang-prone files).
3. `npm run benchmark:v14-phase4` (the same combined JPA/Spring Data
   benchmark Phase 4a used) is re-run and compared against currently-
   committed numbers: `repository_linkage` recall/precision equal or
   better, never worse; `entity_relation` numbers byte-identical (since
   nothing touching `jpa-entity.ts` changed). "Equal" is a fully
   acceptable outcome — the confirmed bug is a comment-only false
   positive, and real-repo corpora are not expected to contain
   commented-out `@Query` annotations, so an improvement is possible but
   not required for acceptance.
4. A short follow-up note records Phase 4b complete and closes out the
   "AST-ify enterprise extractors" roadmap: all five enterprise extractors
   (`dependency-injection.ts`, `spring-mvc.ts`, `transactions.ts`,
   `jpa-entity.ts`, `spring-data.ts`) now detect annotations via
   `SymbolRecord.annotations` rather than comment-unaware text regexes.
