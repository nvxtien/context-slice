# Java Dependency-Injection AST Migration — Design Spec (Phase 1 of the "AST-ify enterprise extractors" roadmap)

## Purpose

Phase 0 (merged 2026-09-28) made Java class/interface/enum/record fields
real `field`-kind `SymbolRecord`s, with `.annotations` populated directly
from the tree-sitter AST (the same mechanism already proven correct for
types, methods, and constructors). This spec is Phase 1: migrate
`src/languages/java/enterprise/dependency-injection.ts` to consume those
field symbols (and the existing method symbols' `.annotations`) instead of
its own hand-rolled regex-based detection machinery.

A direct real-repository investigation into `dependency-injection.ts` on
2026-09-28 (parsing all 578 Java files across spring-petclinic,
petclinic-rest, and keycloak, comparing raw annotation counts against
extracted relations) found **zero real extraction bugs** in the current
regex-based implementation — every apparent discrepancy traced to either a
javadoc comment being correctly ignored, or a non-project type being
correctly left unresolved. This phase is therefore not a bug fix. Per the
user's explicit decision (2026-09-28/29 brainstorming session), the goal is
architectural consistency with the rest of the codebase's AST-first
design, groundwork for future LSP-style tooling, and genuine accuracy
improvement is welcome (not required) — the acceptance bar is real-world
benchmark numbers equal or better than currently committed, never worse.

The user explicitly chose **full replacement, no regex fallback** for
field/method DI-annotation detection (2026-09-29 brainstorming answer):
`memberLevelBody()` and `INJECT_RE` are deleted entirely, not kept as a
backup path.

## Non-goals (explicitly out of scope for Phase 1)

- Any change to constructor injection detection — it already uses AST
  symbols (`SymbolRecord`s of `kind: "constructor"`) and is untouched.
- Any change to `resolveBeanType`/`resolveDependencyRelations` (the
  project-wide bean-identity post-pass) — Phase 1 only changes how
  per-file injection points are *extracted*, not how they're *resolved*.
- Introducing parameter-level `SymbolRecord`s. Constructor and setter
  *parameter* lists still have no structural symbol representation; Phase
  1 keeps parsing them via `firstParenGroup`/`splitTopLevel`/
  `parseDeclaration` against the callable symbol's own `.source` text —
  the same technique constructor injection already uses today, now also
  applied to setters. This is not "leftover regex the migration forgot,"
  it is a deliberate, load-bearing choice: no field-symbol-equivalent
  capability exists yet for individual parameters, and building one is a
  separate, much larger undertaking (its own future phase, if ever
  justified) that this spec does not attempt.
- Migrating any of the other four enterprise extractors (Spring MVC,
  `@Transactional`, JPA/Spring Data) — each gets its own future
  brainstorm→spec→plan cycle.
- Any change to `src/parser/java-parser.ts` or the field-symbol shape
  Phase 0 established.

## The one accepted, documented divergence

**Multi-declarator fields sharing a single `@Qualifier(...)` lose the
qualifier's VALUE, though the injection relation itself is still created.**

Phase 0's field-symbol design (by necessity, to preserve the
codebase-wide `source === slice(range)` invariant) only includes a field's
annotation TEXT in `.source` for the single-declarator case
(`@Autowired private Foo f;`). For a multi-declarator field
(`@Qualifier("x") private Foo a, b;`), each symbol's `.source` is just its
own bare declarator text (`"a"`, `"b"`) — the shared annotation text,
including any `@Qualifier`'s argument, is not present in either symbol's
`.source`. Since `.annotations` (a `string[]` of bare annotation names,
established by `modifiersNodeParts` since the original AST rewrite) never
carried argument values for ANY symbol kind, there is no field-symbol path
to recover a qualifier VALUE for this specific shape.

Concretely: the DI relation is still correctly created for both `a` and
`b` (their `.annotations` correctly include `@Qualifier` and
`@Autowired`/etc., so injection-point detection is unaffected) — only the
qualifier's string value (used purely as extra evidence text, never for
resolution — `resolveBeanType`'s own doc comment already states
"candidates all share the simple name, so it can't break a tie") is
absent from that relation's `evidence` array. This is accepted as
deliberate and documented, not fixed, because: (a) it is a vanishingly
rare real-world pattern (multiple DI-qualified fields declared on one
shared line), (b) the qualifier value is evidence-only, never
resolution-affecting, and (c) "fixing" it would require widening Phase
0's already-merged, already-reviewed field-symbol design specifically for
this one caller's benefit — scope creep this spec declines.

## Architecture

### What changes in `dependency-injection.ts`

**Deleted entirely:**
- `memberLevelBody(classSource: string): string` — the comment-stripping,
  depth-tracking state machine that isolated member-level text from a
  class's full source.
- `INJECT_RE` — the regex that scanned that isolated text for
  `@Autowired`/`@Inject`/`@Resource`.
- The "Field and explicit-setter injection, scanned at class-member depth
  only" loop that used both of the above (the loop iterating
  `own.filter(s => s.kind === "class")`, calling `memberLevelBody`, then
  `body.matchAll(INJECT_RE)`).

**Added: two new loops, replacing the deleted one.**

Field injection loop — iterates field symbols directly:

```
for (const field of own.filter(s => s.kind === "field")) {
  const annotation = field.annotations.find(a => INJECT_ANNOTATIONS.has(bareName(a)));
  if (!annotation) continue;
  const cls = own.find(s => s.id === field.parentId);
  if (!cls) continue;
  const qualifier = qualifierFrom(field); // see below
  relations.push(relation(cls, filePath,
    { type: field.metadata?.declaredType ?? "", name: field.name, qualifier },
    `${annotation} field ${field.metadata?.declaredType} ${field.name}`));
}
```

**Important — `relation()`'s first argument stays the ENCLOSING CLASS, not
the field itself**, even though the field is now a real symbol. This
preserves the existing, tested contract: `tests/java-enterprise-dependency-injection.test.ts`'s
`"field injection resolves via the enclosing class..."` test asserts
`rel.sourceSymbolId === checkoutClass.id` (the class's id), not a field
id — a real behavioral contract this migration must not silently change.
Attributing the relation to the field's own id instead would be a more
precise design in isolation, but it is a genuine semantic change to what
`sourceSymbolId` means for field-injection relations (every downstream
consumer that reads `sourceSymbolId` expecting "the class that injects
this dependency" would need auditing) — out of scope for a task whose
brief is "change detection mechanism," not "change relation attribution
semantics." `field.parentId` already gives the enclosing class's id
directly; looking it up via `own.find(s => s.id === field.parentId)`
costs nothing and keeps the existing contract intact.

Setter injection loop — iterates method symbols directly:

```
for (const method of own.filter(s => s.kind === "method")) {
  const annotation = method.annotations.find(a => INJECT_ANNOTATIONS.has(bareName(a)));
  if (!annotation) continue;
  const params = firstParenGroup(method.source);
  if (params === undefined) continue;
  const qualifier = qualifierFrom(method); // see below
  for (const param of splitTopLevel(params)) {
    const p = parseDeclaration(param);
    if (!p) continue;
    p.qualifier ??= qualifier;
    relations.push(relation(method, filePath, p, `${annotation} setter ${method.name}(${p.type})`));
  }
}
```

`INJECT_ANNOTATIONS` is a small constant set (`new Set(["Autowired",
"Inject", "Resource"])`), replacing the current `INJECT_RE`'s alternation
— `bareName(a)` strips the `@` prefix from an `.annotations` entry the
same way `STEREOTYPES`'s existing lookup already does
(`a.slice(a.lastIndexOf(".") + 1).replace("@", "")`, reused, not
reinvented, for fully-qualified annotation names like
`@org.springframework.beans.factory.annotation.Autowired`).

`qualifierFrom(symbol)` is a new small helper: `symbol.source.match(QUALIFIER_RE)?.[1]` —
`QUALIFIER_RE` itself is UNCHANGED, only its target changes (a single
already-AST-bounded symbol's `.source` instead of a whole class's
member-level text). For the accepted divergence case (multi-declarator
field), `qualifierFrom` naturally returns `undefined` since the
declarator-only `.source` never contains `@Qualifier(...)` text — no
special-casing needed, the existing regex simply finds nothing, which is
the correct, already-designed-for outcome.

### What stays unchanged

- `parseDeclaration`, `firstParenGroup`, `splitTopLevel` — reused exactly
  as today, only now also applied to setter methods (previously
  constructor-only in practice, though `parseDeclaration` was always
  general-purpose).
- `relation()`, `resolveBeanType()`, `resolveDependencyRelations()` — untouched.
- Constructor injection loop — untouched (already AST-based).
- `STEREOTYPES` — untouched.

## Testing

Existing test files (`tests/java-enterprise-dependency-injection.test.ts`,
`tests/java-enterprise-di-fixtures.test.ts`,
`tests/java-enterprise-dependency-composition.test.ts`) must continue
passing UNCHANGED (behavioral tests, not implementation-coupled) — any
test that "needs" a change is a signal to investigate, not an acceptable
adjustment, per this project's established discipline.

New tests to add, covering the two new loops directly:

- A field injected via `@Autowired`/`@Inject`/`@Resource`, each
  individually, resolves the same as before.
- A setter method injected via `@Autowired` with a parameter resolves
  correctly (this exercises the NEW setter-detection path, which
  previously relied on `INJECT_RE` finding the annotation followed by
  `(` in member-level text — now relies on `method.annotations` directly).
- A field with `@Qualifier("x")` (single-declarator) still recovers the
  qualifier value correctly, proving `qualifierFrom` works for the common
  case.
- The accepted divergence itself, as an explicit regression-prevention
  test: a multi-declarator field sharing `@Qualifier("x")` still produces
  a correct injection relation (type/name correct, annotation detected)
  but WITHOUT the qualifier value in its evidence — asserting the CURRENT
  (accepted) behavior, not silently leaving a gap.
- A multi-line `@Autowired(...)`-with-arguments field or setter (the
  class of pattern the original regex-based java-parser.ts bug affected
  at the type/method level) — proving field/method annotation detection
  inherits the same AST-native immunity Phase 0 already established,
  purely as a regression-prevention test (this was never actually broken
  in the OLD regex DI extractor either, per the 2026-09-28 investigation,
  but is worth pinning now that detection is AST-based).

## Acceptance / Definition of Done for Phase 1

1. All new and existing DI tests pass.
2. The full existing test suite passes with no regressions (using the
   established worktree exclusion list for the four pre-existing
   hang-prone files).
3. `memberLevelBody` and `INJECT_RE` are confirmed dead (grepped, zero
   remaining references) and deleted.
4. `npm run benchmark:v14-phase2` (Dependency Injection) is re-run and
   compared against the currently-committed numbers: equal or better,
   never worse. If ANY number regresses, stop and diagnose — do not
   proceed silently. Genuine improvement is welcome and expected to be
   at least possible (this migration removes the old regex's narrow
   comment/multi-line blind spots at the field/setter level, even though
   the 2026-09-28 investigation found no *currently manifesting* bug from
   them) but is not mandatory for Phase 1 to be considered complete —
   "equal" is an acceptable, valid outcome given the pre-migration
   investigation already found the old implementation correct on the
   measured real repositories.
5. A short follow-up note records Phase 1 complete and names Phase 2
   (whichever of Spring MVC / `@Transactional` / JPA-Spring-Data is
   chosen next) as the following sub-project, to be brainstormed
   separately.
