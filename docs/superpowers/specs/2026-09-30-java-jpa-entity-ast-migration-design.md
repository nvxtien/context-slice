# Java JPA Entity AST Migration — Design Spec (Phase 4a of the "AST-ify enterprise extractors" roadmap)

## Purpose

Phase 3 (merged 2026-09-30) migrated `transactions.ts`'s `@Transactional`
detection off regex onto AST symbols. This spec is Phase 4a: migrate
`src/languages/java/enterprise/jpa-entity.ts`'s field-level JPA
relationship-annotation detection (`@OneToOne`/`@OneToMany`/`@ManyToOne`/
`@ManyToMany`) the same way, using the field-level `SymbolRecord`s Phase 0
already established.

`jpa-entity.ts` is architecturally different from Phases 1-3's target
files: it uses `memberLevelBody()` (the DI extractor's original
comment-stripping technique, not `spring-mvc.ts`/`transactions.ts`'s
`header()`+`matchIsInsideLineComment()` pair) to scan a whole `@Entity`
class's body for relationship annotations, then hand-parses the FIELD
DECLARATION that follows each annotation match via a forward regex scan
past any stacked annotations. This file's own code contains an
explicit, already-diagnosed, real bug (see below) — unlike Phases 2-3,
this migration IS a bug fix, not purely architectural consistency.

**Class-level `@Entity` detection is ALREADY AST-based and needs no
migration**: `extractEntityRelations`'s existing filter
(`s.kind === "class" && s.annotations.includes("@Entity")`) already reads
`SymbolRecord.annotations` directly. This spec's scope is entirely the
FIELD-level relationship-annotation detection that currently follows.

## The real, pre-existing, already-diagnosed bug this migration fixes

`jpa-entity.ts`'s own code comment (lines 62-68, quoted verbatim):

> Stacked annotations (`@JoinColumn`, `@OrderBy`, ...) belong to the same
> field. ponytail: `[^)]*` isn't nested-paren-aware, so a stacked
> annotation with a nested-annotation argument (e.g.
> `@JoinColumn(foreignKey = @ForeignKey(name = "fk_x"))`) under-consumes
> at the inner `)`, leaving `decl` misaligned so the field-declaration
> regex below fails to match — this silently drops the WHOLE relation for
> that field (not just the JoinColumn evidence). Fix if it shows up on a
> real repo: a depth-counting scanner like `memberLevelBody`'s own brace
> walk, not a smarter regex.

Migrating field detection to Phase 0's field symbols fixes this
structurally, not by writing the depth-counting scanner the comment
suggests: each field is now its own `SymbolRecord` with its own
`.annotations` (already AST-parsed, immune to nested-paren argument
structure entirely) and its own `.source` (bounded to that one field,
never requiring a forward scan past sibling stacked annotations to find
"where the field declaration starts"). The bug's root cause — text-based
forward-scanning past an annotation whose own argument list isn't
correctly bounded — disappears because there is no forward-scanning left
to do.

## A second, real gap this migration fixes: multi-declarator relationship fields

`bare.match(/^([\w$.]+(?:\s*<.*>)?)\s+([\w$]+)$/s)` (the current
field-declaration-extraction regex) requires the text to end in exactly
ONE bare identifier. For `@OneToMany private List<Pet> pets, moreItems;`
(two fields sharing one relation annotation, both `pets` and `moreItems`
mapping to the same entity), the trailing text is `"pets, moreItems"` —
not a single identifier — so this regex fails to match at all, and the
CURRENT code drops BOTH fields' relations entirely (the same class of gap
Phase 1's own investigation found and fixed for `dependency-injection.ts`'s
multi-declarator fields). Since Phase 0's field symbols already emit one
correctly-named symbol per declarator, this migration fixes this gap as a
structural side effect — each declarator becomes its own `ENTITY_RELATION`.
Per Phase 0's own established, accepted divergence, only the
SINGLE-declarator case's `.source` includes the relation annotation's own
argument text (`mappedBy`/`fetch`/`cascade`); a multi-declarator field's
non-first declarators will correctly detect the relationship (via
`.annotations`) but lose those specific attribute values — same accepted
divergence pattern as Phase 1's `@Qualifier` case, not a new concern this
spec needs to re-litigate.

## Scope, confirmed with the user (2026-09-30 brainstorming)

Same detect-via-AST / extract-via-targeted-regex split as Phases 1-3:
- Whether a field carries a relationship annotation is now determined via
  `SymbolRecord.annotations` — never a text-matching regex, and never a
  forward-scan past stacked annotations.
- Whether that SAME field also carries `@JoinColumn` is now a SEPARATE,
  independent `.annotations` check — not a regex scan of "whatever
  annotation text happens to follow the relation annotation in the raw
  class body", which is exactly the mechanism the nested-paren bug lives
  in today.
- The relationship annotation's own attribute values (`mappedBy`, `fetch`,
  `cascade`) and `@JoinColumn`'s own argument text are not available from
  `.annotations` (bare names only) — extraction still needs a targeted
  regex against the field's own `.source`, run only after `.annotations`
  has confirmed each annotation is real. Both regexes get the same
  fully-qualified-name-tolerant prefix Phases 2-3 already established
  (`(?:[\w.]+\.)?`), applied proactively.
- The field's TARGET entity type (`targetLabel`) now comes from
  `field.metadata.declaredType` (Phase 0's convention) instead of
  hand-parsing the field declaration's type text out of raw source — the
  existing `COLLECTION_RE` unwrap logic (`List<X>`/`Set<X>`/`Collection<X>`
  → `X`) is reused unchanged, just applied to the AST-derived
  `declaredType` string instead of a regex-captured one.

## Non-goals (explicitly out of scope for Phase 4a)

- Any change to `resolveEntityRelations` (the project-wide bean-identity
  post-pass) — unchanged, operates on already-built relations.
- Any change to `spring-data.ts` — that is Phase 4b, a separate sub-project
  with its own brainstorm/spec/plan cycle (this file has meaningfully
  different internal logic — interface-generic-argument parsing and
  derived-query-method-name parsing — not the same
  detect-via-annotations-first pattern this spec addresses).
- Introducing a general depth-counting scanner for nested-paren-aware
  regex parsing anywhere else in the codebase — the code comment's own
  suggested fix ("a depth-counting scanner like `memberLevelBody`'s own
  brace walk") becomes unnecessary once field detection no longer needs
  ANY forward text-scanning at all; this spec does not build that scanner.
- Handling a field's OWN relationship annotation appearing with OTHER
  non-`@JoinColumn` stacked annotations (e.g. `@OrderBy`) — the existing
  code doesn't extract `@OrderBy`'s own value either (only mentions it in
  a comment as an example of "stacked annotations"), and this migration
  doesn't add that capability.

## Architecture

### What changes in `jpa-entity.ts`

**Deleted:** `memberLevelBody()` (confirmed to have zero other callers
before deletion — unlike `dependency-injection.ts`, which also had this
function, `jpa-entity.ts`'s own copy is independent and its deletion here
doesn't affect any other file).

**`RELATION_RE`, `JOIN_COLUMN_RE` replaced** by two per-annotation-name
regex-building functions (parallel to Phases 2-3's `mappingArgsRegex`/
`transactionalArgsRegex`), each with the qualified-name-tolerant prefix.

**`COLLECTION_RE`, `explicitAttributes()` stay unchanged** — same
disposition as prior phases' reused helpers — just now called with
`field.metadata.declaredType` / a per-field targeted-regex match's
argument text instead of raw-source-derived text.

**Changed: `extractEntityRelations`'s core loop.** Instead of iterating
`@Entity`-annotated classes and scanning their whole body text, it iterates
FIELD symbols belonging to those classes directly:

```
for (const entity of entities) {
  for (const field of allFieldsOf(entity)) {  // symbols with kind "field" and parentId === entity.id
    const relationName = field.annotations.map(bareName).find(name => RELATION_NAMES.has(name));
    if (!relationName) continue;
    // extract relation annotation's own args (mappedBy/fetch/cascade) via a targeted regex on field.source
    // extract @JoinColumn separately via field.annotations.some(bareName === "JoinColumn"), then a targeted regex
    // targetLabel from field.metadata.declaredType, unwrapped via the existing COLLECTION_RE
  }
}
```

## Testing

Existing test file `tests/java-enterprise-jpa-entity.test.ts` must continue
passing UNCHANGED — including the existing `"@Entity inside a comment
produces no relation"` test (this one exercises the ALREADY-AST-based
class-level `@Entity` filter, so it should already pass trivially both
before and after this migration — its continued passing is not new proof
of anything this migration changes, just a sanity check that nothing
regressed).

New tests to add:
- A field with a nested-paren `@JoinColumn` argument (e.g.
  `@JoinColumn(foreignKey = @ForeignKey(name = "fk_x"))`), asserting the
  relation is now correctly produced (pinning the bug fix — this is the
  SINGLE MOST IMPORTANT test in this plan, since it directly proves the
  diagnosed bug is fixed).
- A multi-declarator relationship field (`@OneToMany private List<Pet>
  pets, moreItems;`), asserting BOTH fields now produce their own
  `ENTITY_RELATION` (pinning the second fix).
- A fully-qualified relationship annotation name (e.g.
  `@javax.persistence.OneToMany`), asserting it's still detected and its
  target/attributes still extracted — mirroring Phases 2-3's own
  proactively-applied fix.

## Acceptance / Definition of Done for Phase 4a

1. All new and existing JPA entity tests pass.
2. The full existing test suite passes with no regressions (established
   worktree exclusion list for the four pre-existing hang-prone files).
3. `memberLevelBody`, `RELATION_RE`, `JOIN_COLUMN_RE` confirmed dead
   (grepped, zero remaining references) and deleted.
4. `npm run benchmark:v14-phase4` (confirmed via `package.json` to map to
   `tsx benchmarks/v1.4-phase4-jpa-spring-data.ts`, report file
   `benchmarks/results/v1.4-phase4-jpa-spring-data.{json,md}` — this
   single combined benchmark covers BOTH `jpa-entity.ts`'s
   `ENTITY_RELATION` facts and `spring-data.ts`'s `PERSISTS_ENTITY`/
   `REPOSITORY_QUERY` facts; Phase 4a only touches the former, so the
   report's `entity_relation`-scoped numbers are what this phase's
   acceptance bar applies to specifically — the `repository_linkage`
   numbers must simply stay unchanged, since Phase 4a makes no code
   change affecting `spring-data.ts` at all) is re-run and compared
   against currently-committed numbers: `entity_relation` recall/precision
   equal or better, never worse; `repository_linkage` numbers byte-
   identical (since nothing touching that code path changed). Given the
   diagnosed bug, genuine improvement in `entity_relation` recall is a
   real, plausible, welcome outcome this time (unlike Phases 2-3) — if
   the real-repo corpus happens to contain a nested-paren `@JoinColumn` or
   a multi-declarator relationship field, report the specific
   improvement explicitly.
5. A short follow-up note records Phase 4a complete and names Phase 4b
   (`spring-data.ts`) as the final remaining sub-project in the entire
   roadmap — after Phase 4b, all five enterprise extractors will have been
   migrated.
