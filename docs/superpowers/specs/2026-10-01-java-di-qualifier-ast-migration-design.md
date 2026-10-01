# Java DI `@Qualifier` Evidence AST-Gating — Design Spec

## Purpose

The "AST-ify enterprise extractors" roadmap and its follow-up gap-closure
(constructor-injection migration, merged 2026-10-01) removed every
comment-unaware text regex that could produce a false `INJECTS_DEPENDENCY`
relation in `dependency-injection.ts`. The final whole-branch review of
that gap-closure branch flagged one more residual item (Minor, not
blocking): `QUALIFIER_RE` is still matched directly against raw source
text at three call sites, with no gate on `SymbolRecord.annotations`
first. This spec investigates and fixes the one call site where that
produces a real, confirmed bug.

Unlike every detection-path bug this roadmap has fixed so far, this one
does not produce a FALSE relation — the relation itself is always
correctly gated elsewhere (by `INJECT_ANNOTATIONS` membership on
`.annotations`). What can go wrong here is narrower: a correctly-detected
real injection point gets the WRONG `@Qualifier` evidence text attached
to it.

## Investigation: which of the three `QUALIFIER_RE` call sites are real bugs

`QUALIFIER_RE = /@Qualifier\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/`

1. **`parseDeclaration()` (line 57), matched against a single constructor
   parameter's text** (one entry from `splitTopLevel(firstParenGroup(ctor.source))`).
   Parameters are not their own `SymbolRecord`s — the parser has no
   `.annotations` array for an individual constructor parameter — so
   there is no AST-based gate available here at all. A Java parameter
   list essentially never contains a comment in practice (confirmed: no
   realistic Java style puts `//` or `/* */` between parameters). **Out
   of scope** — no AST alternative exists, and the risk is theoretical,
   not demonstrated.

2. **Field loop (line 125), matched against `field.source`.** Verified
   directly: `field.source` for a field declaration does NOT include a
   trailing same-line comment or any body (fields have no body). Repro
   attempted:
   ```java
   @Autowired
   private Bar bar; // was @Qualifier("legacy") before refactor
   ```
   confirmed via `parseJava` that `field.source` is exactly
   `"@Autowired\n    private Bar bar;"` — the trailing comment is not
   included, so `QUALIFIER_RE` cannot match it. **Out of scope** — no bug
   found, confirmed empirically, not assumed.

3. **Method loop (line 141), matched against `method.source`.** Methods'
   `.source` includes the full body (same fact that caused the bug Phase
   4b fixed in `spring-data.ts`'s `queryText()`). Reproduced directly:
   ```java
   @Autowired
   public void setBar(Bar bar) {
       // old wiring used @Qualifier("legacy") here, now removed
       this.bar = bar;
   }
   ```
   produces a relation with evidence `["@Autowired setter setBar(Bar)", "@Qualifier(\"legacy\")"]`
   — the relation itself is correct (a real `@Autowired` setter), but the
   qualifier evidence is fabricated from a body comment. **In scope — this
   is the one real, confirmed bug this spec fixes.**

## Scope

- The method loop's qualifier extraction gains an AST gate: only attempt
  `QUALIFIER_RE` against `method.source` if `method.annotations` actually
  contains a bare `"Qualifier"` name. If the method has no real
  `@Qualifier` annotation, no regex match is attempted at all, so no body
  comment can produce a false qualifier value.
- Once gated, the existing `QUALIFIER_RE` and its match logic are
  unchanged — a genuinely-annotated method's qualifier value extraction
  doesn't need to change (the annotation always precedes the body in
  source order, so an unconditional regex match already finds the real
  annotation's value correctly when one exists; the bug is only that it
  ALSO matches when none exists).
- `bareName()` (already defined in this file) is reused for the
  `"Qualifier"` check — no new helper needed.

## Non-goals

- The constructor-parameter call site (line 57) — no `SymbolRecord` exists
  per-parameter to gate against; risk is theoretical, not demonstrated.
- The field call site (line 125) — confirmed safe by direct repro; no bug
  to fix.
- Any change to `QUALIFIER_RE`'s own pattern, `STEREOTYPES`,
  `INJECT_ANNOTATIONS`, the constructor-injection `annotated` check (fixed
  in the prior gap-closure branch), `firstParenGroup()`, `splitTopLevel()`,
  `relation()`, `resolveBeanType()`, or `resolveDependencyRelations()`.
- Any change to `spring-mvc.ts`, `transactions.ts`, `jpa-entity.ts`, or
  `spring-data.ts`.

## Architecture

### What changes in `dependency-injection.ts`

Inside the setter-injection loop (`extractDependencyInjection`'s third
loop), the line:

```ts
const qualifier = method.source.match(QUALIFIER_RE)?.[1];
```

becomes:

```ts
const hasQualifier = method.annotations.some((a) => bareName(a) === "Qualifier");
const qualifier = hasQualifier ? method.source.match(QUALIFIER_RE)?.[1] : undefined;
```

Everything else in the loop — how `qualifier` is subsequently used
(`p.qualifier ??= qualifier;`) — stays unchanged.

## Testing

Existing test file `tests/java-enterprise-dependency-injection.test.ts`
must continue passing UNCHANGED.

New tests to add:

- The exact repro above (`@Qualifier("legacy")` mentioned only in a setter
  method body comment, no real `@Qualifier` annotation on the method),
  asserting the relation's evidence does NOT contain a `@Qualifier(...)`
  entry — pinning the bug fix. The relation itself must still exist
  (proving the fix doesn't also suppress real detection).
- A genuinely `@Qualifier("x")`-annotated setter still has `"x"` correctly
  extracted into its evidence — regression pin for the true-positive path.

## Acceptance / Definition of Done

1. All new and existing dependency-injection tests pass.
2. The full existing test suite passes with no regressions (worktree
   exclusion list for the four pre-existing hang-prone files).
3. `npm run benchmark:v14-phase2` is re-run and compared against
   currently-committed numbers: equal or better, never worse. "Equal" is a
   fully acceptable outcome — real-repo corpora are unlikely to contain a
   setter-body comment that happens to mention `@Qualifier("...")`.
4. A short follow-up note records this fixed; no further caveats remain
   about text-based detection or evidence-extraction paths in
   `dependency-injection.ts` except the two explicitly accepted ones
   above (constructor-parameter qualifiers, with no AST alternative; and
   the already-accepted multi-declarator-field divergence from Phase 1).
