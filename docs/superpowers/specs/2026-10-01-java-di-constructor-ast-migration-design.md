# Java DI Constructor-Injection AST Migration — Design Spec

## Purpose

The "AST-ify enterprise extractors" roadmap (Phases 1-4b, completed
2026-09-30) migrated the primary relationship-annotation detection in all
five Java enterprise extractors off text regexes onto AST-derived
`SymbolRecord.annotations`. Phase 4b's final whole-branch review flagged
one residual gap the roadmap's own scope never covered: in
`src/languages/java/enterprise/dependency-injection.ts`, the
constructor-injection path (`extractDependencyInjection`'s first loop,
predating the roadmap, from Phase 1) still gates on a raw text regex over
the constructor's own `.source` instead of `.annotations`. This spec
closes that gap.

Unlike the five phases that came before it, this is not new scope
discovery from scratch — it is finishing the one documented exception to
the roadmap's own "COMPLETE" claim.

## The real, confirmed bug this migration fixes

Today:

```ts
const annotated = new RegExp(`@(?:Autowired|Inject)\\b[\\s\\S]*?\\b${ctor.name}\\s*\\(`).test(ctor.source);
```

`ctor.source` is the constructor's FULL source including its body (per
`constructorSymbol()` in `src/parser/java-parser.ts`). The regex has no
comment-guard and never consults `SymbolRecord.annotations`, which is
already populated by the parser for constructors (confirmed directly:
`constructorSymbol()` calls `modifiersNodeParts(modifiersNode)` and
assigns the result to `annotations`, identically to how fields and
methods get theirs — the field/method injection loops already use this
correctly; only the constructor loop doesn't).

Reproduced directly against this codebase's own parser:

```java
class Foo {
    Foo(Bar b) {
        // note: @Autowired on Foo(Bar) in subclass requires this constructor to exist
        this.b = b;
    }
}
class Bar {}
```

produces a false `INJECTS_DEPENDENCY` relation (`Foo` -> `Bar`, confidence
`exact`) even though `ctor.annotations` is correctly empty — the regex's
lazy `[\s\S]*?` matches past the comment's own `@Autowired` text to the
literal substring `Foo(` that happens to also appear inside that same
comment. This is the same false-positive-from-comment failure mode every
phase of the roadmap fixed for its own target file, just never applied
here because this code predates the roadmap.

## Scope

- Whether a constructor carries `@Autowired` or `@Inject` is now
  determined via `SymbolRecord.annotations` — never a text-matching
  regex, and never scanned against the constructor's body text.
- No argument-value extraction is needed for this annotation (unlike
  `@Transactional`/`@Query`/JPA relation annotations in prior phases) —
  the existing code only ever needed a yes/no gate, not any attribute
  text. So this migration is strictly simpler than every prior phase:
  delete a regex, add a `.annotations` membership check, nothing to
  extract afterward.
- The replacement check only recognizes `{Autowired, Inject}` for the
  constructor gate — matching today's exact regex scope (`@(?:Autowired|Inject)`,
  not the field/method loops' broader `INJECT_ANNOTATIONS` set which also
  includes `Resource`). `@Resource` is not a legal annotation on a Java
  constructor in Spring, so this isn't a narrowing of real behavior — it's
  preserving the existing, correct distinction between the constructor
  gate and the field/method `INJECT_ANNOTATIONS` set.
- The `stereotyped` check (`cls?.annotations.some(...)`) is already
  AST-based and untouched.

## Non-goals

- Any change to `firstParenGroup()`, `splitTopLevel()`, `parseDeclaration()`,
  `relation()`, `QUALIFIER_RE`, `STEREOTYPES`, or `INJECT_ANNOTATIONS`.
- Any change to the field-injection or setter-injection loops in
  `extractDependencyInjection` — both already AST-based from Phase 0/1 and
  out of scope.
- Any change to `resolveBeanType()` or `resolveDependencyRelations()`.
- Any change to `spring-mvc.ts`, `transactions.ts`, `jpa-entity.ts`, or
  `spring-data.ts` — the roadmap's own five phases are complete and merged.
- Introducing a shared `bareName()`/comment-guard utility across files —
  `dependency-injection.ts` already has its own local `bareName()`
  (reused here, not duplicated again).

## Architecture

### What changes in `dependency-injection.ts`

One line, inside `extractDependencyInjection`'s constructor loop (replacing
the line quoted in "The real, confirmed bug" above):

```ts
const annotated = ctor.annotations.some((a) => bareName(a) === "Autowired" || bareName(a) === "Inject");
```

Everything else in the loop — the `seen` dedup, the `stereotyped` check,
`firstParenGroup`/`splitTopLevel`/`parseDeclaration` calls — stays
unchanged.

## Testing

Existing test file `tests/java-enterprise-dependency-injection.test.ts`
must continue passing UNCHANGED.

New tests to add:

- The exact comment-false-positive repro above (`@Autowired` mentioned in
  a constructor-body comment, constructor itself unannotated and the
  class has no stereotype), asserting NO `INJECTS_DEPENDENCY` relation is
  produced — pinning the bug fix.
- A genuinely `@Autowired`-annotated constructor on a plain (non-stereotyped)
  class still produces a relation — regression pin for the real positive
  case, proving the migration doesn't also break true detection.
- A fully-qualified `@org.springframework.beans.factory.annotation.Autowired`
  constructor still produces a relation — `bareName()` already strips
  qualification, but this wasn't exercised by any existing test for the
  constructor path specifically (the field/method loops already have
  qualified-name coverage from earlier work); add it here for parity.

## Acceptance / Definition of Done

1. All new and existing dependency-injection tests pass.
2. The full existing test suite passes with no regressions (worktree
   exclusion list for the four pre-existing hang-prone files).
3. `npm run benchmark:v14-phase2` (confirmed directly against
   `package.json`: maps to `tsx benchmarks/v1.4-phase2-dependency-injection.ts`
   — note the script-name/file-name numbering is NOT aligned with this
   roadmap's own phase numbers; verified rather than assumed, the same
   discipline every prior phase followed) is re-run and compared against
   currently-committed numbers: equal or better, never worse. "Equal" is a fully
   acceptable outcome — real-repo corpora are not expected to contain a
   constructor-body comment that happens to repeat the class name after
   mentioning `@Autowired`/`@Inject`.
4. A short follow-up note records this gap closed, finally making the
   "all five enterprise extractors detect their annotations via
   `SymbolRecord.annotations`" claim from the Phase 4b summary doc fully
   true without caveat.
