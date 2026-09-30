# Java Spring MVC AST Migration — Design Spec (Phase 2 of the "AST-ify enterprise extractors" roadmap)

## Purpose

Phase 1 (merged 2026-09-29) migrated `dependency-injection.ts`'s field/setter
detection off regex onto AST field/method symbols, finding and fixing two
real bugs along the way. This spec is Phase 2: migrate
`src/languages/java/enterprise/spring-mvc.ts`'s Spring MVC route-mapping
detection (`@RequestMapping`/`@GetMapping`/`@PostMapping`/`@PutMapping`/
`@DeleteMapping`/`@PatchMapping`) the same way.

Unlike Phase 1, reading `spring-mvc.ts` in full before writing this spec
found **no evidence of a real bug** in the current implementation — its
`matchIsInsideLineComment()` helper (a careful, position-mapped check for a
commented-out mapping annotation) is already correct, per its own detailed
doc comment and two existing passing tests that exercise exactly this
scenario. This phase is therefore, like the user's original stated goal for
the whole roadmap, primarily about architectural consistency and
simplification (deleting now-unnecessary regex machinery), not a bug fix —
though the user's standing acceptance bar (real-repository benchmark equal
or better, improvement welcome but not required) still applies.

## Scope, confirmed with the user (2026-09-30 brainstorming)

**Detection moves fully to AST; argument-value extraction keeps a
narrower, safer regex.** Concretely:
- Whether a method/class carries a mapping annotation is now determined via
  `SymbolRecord.annotations` (already AST-derived, already proven immune to
  comment/multi-line false-positives across the whole codebase since the
  original AST rewrite) — never via a text-matching regex.
- The mapping annotation's ARGUMENT text (e.g. `@GetMapping("/foo")`'s
  `"/foo"`, or `value = "/foo"`, or `{"/a", "/b"}`) is NOT available from
  `.annotations` (which only stores bare annotation names, no arguments —
  the same limitation Phase 1 already established and worked around for
  `@Qualifier`'s value). Extracting it still requires a targeted regex
  against the symbol's own `.source` text — but now that regex only ever
  runs AFTER the AST has already confirmed the annotation genuinely exists,
  eliminating the entire class of "is this really an annotation or just
  annotation-shaped text" false-positive risk the current
  `matchIsInsideLineComment()` exists to guard against.
- Extracting the AST's own structured `annotation_argument_list` into real
  data (eliminating the LAST regex here too) is explicitly out of scope —
  a separate, larger capability not part of this roadmap's current phase.

## Non-goals (explicitly out of scope for Phase 2)

- Parsing a bare `@RequestMapping`'s `method = RequestMethod.X` attribute
  into a real HTTP verb — a pre-existing, documented limitation
  (`spring-mvc.ts`'s own top-of-file comment), unrelated to this migration,
  unchanged.
- Resolving Spring's meta-annotation composition (a custom annotation that
  itself carries `@GetMapping`) — neither the old nor the new
  implementation attempts this; `.annotations` only ever reflects
  annotations written directly on the symbol, matching the old regex's
  same direct-annotation-only behavior.
- Any change to `dependency-injection.ts`, `transactions.ts`,
  `jpa-entity.ts`, or `spring-data.ts`.
- Any change to `src/parser/java-parser.ts` or the field-symbol shape.
- Building a structured `annotation_argument_list` AST representation (see
  Scope above).

## Architecture

### What changes in `spring-mvc.ts`

**Deleted entirely:** `matchIsInsideLineComment()` — once detection no
longer relies on a raw text match that could theoretically land inside a
comment, there is nothing left for this function to guard against. Grep
confirms it is called in exactly two places (the method-level and
class-level checks), both being replaced.

**`MAPPING_RE`, `header()`, `CONST_RE_TEMPLATE`, `resolvePath()`,
`joinPaths()`, `describeAnnotation()` all stay, unchanged in their own
logic** — they still do real, necessary work (argument-value extraction,
constant-hop resolution, path joining, evidence text), just invoked from a
different call site with a different precondition (an AST-confirmed real
annotation, not a raw text scan).

**Changed: the method/class mapping-detection call sites.** Today:

```ts
const methodHeader = header(method);
const methodMatch = methodHeader.match(MAPPING_RE);
if (!methodMatch) continue;
if (matchIsInsideLineComment(method, methodHeader, methodMatch, source)) continue;
const httpMethod = MAPPING_ANNOTATIONS[methodMatch[1]];
```

Becomes: first check `method.annotations` for a bare name present in
`MAPPING_ANNOTATIONS`'s keys (reusing the `bareName()`-style helper
already established in `dependency-injection.ts` — see Implementation
Note below on whether to share it or duplicate the few lines, a plan-level
decision, not a spec-level one). Only once a real annotation name is
confirmed this way does the code call `header(method)` +
`MAPPING_RE`-equivalent to extract the argument text — the match is now
ONLY for the value, never for detection. Symmetric treatment for the
class-level check (`parent.annotations` instead of `header(parent)` +
`matchIsInsideLineComment(parent, ...)`).

**Defensive edge case (not independently, naturally testable — a design
note, not a required test):** it is difficult to construct a real Java
snippet where `.annotations` confirms a mapping annotation's presence but
the subsequent `header()`+regex extraction genuinely fails to find any
match at all, since `.annotations`' own bare-name extraction is itself
derived from the same real source text `header()` would scan, and
`MAPPING_RE`'s argument group is already optional (`(?:\(([^)]*)\))?`) —
a bare `@GetMapping` with no parens still matches, with the argument group
simply absent. The implementation must not crash or silently skip the
relation if this ever happens anyway (belt-and-braces): treat a failed
argument-text extraction as `rawInside: undefined` (the same "absent"
path `resolvePath()` already handles for a bare annotation), not as
"annotation doesn't exist after all."

### Implementation Note (for the plan, not decided here)

Phase 1 introduced a `bareName(annotation: string): string` helper in
`dependency-injection.ts` (strips `@` and any dotted package prefix). This
phase needs the identical operation. The plan should decide: duplicate the
same 3-line function locally in `spring-mvc.ts` (consistent with this
codebase's existing convention — Phase 1 itself duplicated similar-shaped
helpers per-file rather than introducing a shared cross-extractor utility
module), or extract a shared helper. Given every enterprise extractor file
is currently self-contained with its own small helpers (no shared
`enterprise/util.ts` exists today), this spec recommends duplicating the
few lines rather than introducing a new shared module for one function —
consistent with the codebase's established pattern, and YAGNI until a
third file needs the same helper.

## Testing

Existing test files (`tests/java-enterprise-spring-mvc.test.ts` and any
composition/fixture tests referencing it) must continue passing UNCHANGED
— including, notably, the two existing tests that already exercise the
comment-related scenarios `matchIsInsideLineComment()` used to guard
(`"a non-controller class with an annotation-shaped string in a comment
produces no relation"` and `"a real handler preceded by an ordinary
explanatory comment on a previous line is still extracted"`) — these
continuing to pass IS the regression proof that AST-based detection
handles both cases correctly without the deleted function, no new test
needed for that specific behavior.

New test to add:
- A multi-line mapping annotation argument (e.g.
  `@GetMapping(\n "/foo"\n)`), pinning that AST-based detection plus the
  narrowed-scope argument-extraction regex still correctly resolves the
  path — likely already correct today too (per Phase 1's own precedent
  that `[^)]*`-style argument groups already tolerate embedded newlines),
  but worth pinning explicitly now that detection has moved to AST.

## Acceptance / Definition of Done for Phase 2

1. All new and existing Spring MVC tests pass.
2. The full existing test suite passes with no regressions (established
   worktree exclusion list for the four pre-existing hang-prone files).
3. `matchIsInsideLineComment` confirmed dead (grepped, zero remaining
   references) and deleted.
4. `npm run benchmark:v14-phase1` (Spring MVC routes) is re-run and
   compared against currently-committed numbers: equal or better, never
   worse. Given no bug was found in the pre-migration investigation,
   "equal" is a fully expected, acceptable outcome — same disposition as
   Phase 1's own acceptance bar.
5. A short follow-up note records Phase 2 complete and names Phase 3 (one
   of `@Transactional` or JPA/Spring Data — the plan does not decide
   which) as the next sub-project.
