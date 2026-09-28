# Java Field-Level AST Symbols — Design Spec (Phase 0 of the "AST-ify enterprise extractors" roadmap)

## Purpose

The v1.4 Java enterprise extractors (Spring MVC routes, Dependency Injection,
`@Transactional`, JPA/Spring Data) each independently regex-scan a
`SymbolRecord`'s `.source`/`.body` text to find things the core parser
doesn't expose as symbols — most importantly, **class fields** (a field
annotated `@Autowired`, `@Column`, a JPA relationship annotation, etc.).
This works today (a real-repository investigation into
`dependency-injection.ts` on 2026-09-28 found zero real extraction bugs
across spring-petclinic, petclinic-rest, and keycloak), but it means five
separate files each carry their own hand-rolled comment-stripping,
depth-tracking, string-aware regex machinery to re-derive field boundaries
that the AST already knows precisely.

The user's stated goal for the broader roadmap this spec is Phase 0 of:
bring the enterprise extractors in line with the rest of the codebase's
"tree-sitter first" architecture (matching the Java parser's own recent
regex→AST rewrite, and TypeScript/Python/Rust's adapters), and lay
groundwork for future LSP-style tooling, which benefits from precise,
addressable symbol boundaries rather than text ranges rediscovered by regex
per-consumer. The user explicitly does not require behavior-parity with
today's regex extractors going forward (unlike the just-completed parser
rewrite) — genuine accuracy improvements, measured via the existing
real-repository benchmarks, are the expected and welcome outcome starting
in Phase 1 once an extractor actually consumes field symbols.

**This spec's own scope is Phase 0 only: making `parseJava` emit real
`field`-kind `SymbolRecord`s.** No enterprise extractor is modified in this
phase — that begins with Phase 1 (Dependency Injection), which gets its own
spec/plan once Phase 0 has landed. Phases 1-5 (migrating each of the five
extractors to consume field symbols and other AST data instead of
regex-scanning `.source`) are each independent sub-projects with their own
brainstorming→spec→plan cycle; only their shared prerequisite (this spec)
is being designed now.

## Non-goals (explicitly out of scope for Phase 0)

- Migrating any of the five enterprise extractors — they continue to
  regex-scan `.source` exactly as today; this phase changes nothing about
  their behavior or output.
- Record canonical components (`record R(int x) {}`'s `x`) as field
  symbols — these live in a different AST shape (`formal_parameters` in the
  record header, not `field_declaration`) and are deliberately deferred.
- Static/instance initializer blocks (`static { ... }`, bare `{ ... }` in a
  class body) — not fields, not handled.
- Local variables inside method/constructor bodies — never in scope; the
  AST walk only ever visits member-level nodes, exactly as it already does
  for methods/constructors.
- Any change to TypeScript, Python, or Rust adapters — this is Java-only,
  per explicit user decision (2026-09-28 brainstorming session), even
  though `SymbolKind` already declares `"field"` as a valid value no
  adapter currently populates.
- Any change to the call-extraction loop, `resolveCalls`, or the call graph
  (`CallEdge`) — fields are declarative data, not callable; they never
  produce or receive call edges.

## Architecture

### Where this fits

`src/parser/java-parser.ts`'s `walkTypes` function (introduced in the
2026-09-28 AST rewrite, Tasks 1-2) already recursively visits every type's
body, currently branching on `method_declaration` and
`constructor_declaration` node types to build `SymbolRecord`s, using
`memberNodesOf(bodyNode)` to correctly reach a type's members regardless of
body shape (a plain `namedChildren` list for class/interface/record bodies,
or the nested `enum_body_declarations` child for `enum_body`). Phase 0 adds
one more branch to that same loop: `field_declaration`.

No new files, no new exported functions from `java-parser.ts` beyond what
`walkTypes`'s existing per-kind builder functions (`methodSymbol`,
`constructorSymbol`) already establish as the pattern — a new
`fieldSymbols(node, parent, typeChain, filePath, source, packageName)`
function (plural: a `field_declaration` node can produce more than one
symbol) joins them.

### Symbol shape

A field symbol is a normal `SymbolRecord` with:

- `kind: "field"` (already a valid `SymbolKind`; this is the first Java
  code to populate it)
- `name`: from the `variable_declarator`'s `name` field
- `type`: raw text of the `field_declaration`'s `type` field, **not**
  generic-stripped (unlike `supertypes`, which strips generics to match the
  old parser's bare-identifier convention — there is no old-parser
  convention for fields to match, since fields were never extracted before,
  so the full, useful type text is kept: `List<Pet>` stays `List<Pet>`)
- `signature`: `` `${name}: ${type}` ``, mirroring the method convention of
  `` `${name}(${params}): ${type}` `` minus the parameter list
- `annotations`/`modifiers`: via the same `modifiersNodeParts` helper
  Task 1 introduced, reused unchanged — a field's `modifiers` node is
  structurally identical in shape to a class's or method's
- `parentId`: the enclosing type's id (class, interface, enum, or record —
  whichever body the `field_declaration` was found in)
- `range`: spans the individual `variable_declarator` this symbol
  represents (see Multi-declarator handling below) — **not** the whole
  `field_declaration` node when there are multiple declarators, so that two
  fields declared on one line (`private int a, b;`) get distinct,
  non-overlapping ranges
- `bodyRange`: never set (`undefined`) — a field has no body, matching how
  an abstract/interface method already leaves `bodyRange` unset
- `source`: the individual declarator's own slice, prefixed with the shared
  leading annotations/modifiers text (so a field's `.source` reads like
  real Java: `"@Autowired private UserRepository userRepository"`) —
  concretely: `` `${prefixText}${declaratorNode.text}` `` where
  `prefixText` is the `field_declaration`'s own text up to (not including)
  its first `variable_declarator`
- `qualifiedName`/`canonicalIdentity`: via the existing `canonicalId()`
  helper, called with `kind: "field"` and no `parameters` argument (fields
  have no parameter signature) — this already works generically since
  `canonicalId` takes `kind: SymbolKind` as a parameter, not a hardcoded
  method/constructor assumption

### Multi-declarator handling

`private int a, b = 2;` is one `field_declaration` AST node with two
`variable_declarator` children (`a`, `b = 2`). The Phase 0 walk emits **one
`SymbolRecord` per declarator**, all sharing the same `type`,
`annotations`, and `modifiers` (read once from the `field_declaration`
node), but each with its own `name` and `range` (from its own
`variable_declarator`). An initializer expression (`= 2`) is part of the
declarator's own text and is included in that field's `.source`, exactly
like a method's body is part of its `.source`.

**Correction after direct grammar verification (tree-sitter-java probed
2026-09-28):** interface constants do NOT use `field_declaration` — they
use a distinct node type, `constant_declaration`, inside `interface_body`.
Its internal shape is otherwise identical (a `modifiers` child,
`childForFieldName("type")`, one-or-more `variable_declarator` named
children — confirmed with both an implicit-modifier case and an explicit
`@Deprecated public static final int X = 1, Y = 2;` multi-declarator
case), so the same `fieldSymbols` builder function handles both node types
without any shape-specific branching inside it — but the member loop that
decides *which* nodes to hand to `fieldSymbols` must check for both
`field_declaration` and `constant_declaration`, not just the former. This
is a real, easy-to-miss grammar asymmetry (the same category of surprise
as `interface_declaration`'s `extends_interfaces` vs. `class_declaration`'s
`interfaces` field from the parent AST rewrite) and must not be assumed
away.

### Integration with existing member-loop infrastructure

`memberNodesOf(bodyNode)` (Task 1) already normalizes body-shape
differences (plain body vs. enum's `enum_body_declarations` indirection).
Phase 0's `field_declaration` branch sits in the same loop as the existing
`method_declaration`/`constructor_declaration` branches, so enum fields
(e.g., `enum Status { ACTIVE, INACTIVE; private final String label; }`)
are covered automatically via the same infrastructure that Task 4's
final-review fix already made enum-aware for methods/constructors — no
separate enum-specific field-handling code.

### Id-dedup ordering

`assignDedupIds` (introduced in Task 2's own fix round to preserve the old
parser's id-suffix ordering for methods/constructors) needs to also cover
fields for the rare case for two fields sharing a `canonicalIdentity`
within one file. Since fields are an entirely new symbol kind with no
"old parser" behavior to stay byte-identical to, the ordering convention is
ours to define freely: fields are added to `assignDedupIds`'s
`dedupOrder` construction, sorted by source position (the same `byRange`
comparator already used for methods/constructors), inserted in a
consistent, arbitrary-but-deterministic position in the combined order
(after types, before methods — the exact position has no behavioral
significance since there is no legacy ordering to match, but must be
picked once and documented so it stays consistent).

## Data Flow

No change to `parseJava`'s external signature or return shape
(`{ symbols, calls, parseError }`) — field symbols simply appear in the
existing `symbols` array, discoverable via `ProjectIndex.resolveSymbol()`,
direct array filtering (`symbols.filter(s => s.kind === "field")`), or any
other existing `SymbolRecord`-consuming code path. No enterprise extractor
reads them yet (that's Phase 1+), but nothing prevents other code from
querying them once they exist — this is a pure, additive capability.

## Testing

New test file `tests/java-parser-ast-fields.test.ts` (TDD, mirroring Task
1-2's own test-first discipline), covering at minimum:

- A single field with an annotation and modifiers (asserting `kind`,
  `name`, `type`, `signature`, `annotations`, `modifiers`, `parentId`)
- Multi-declarator: `private int a, b = 2;` produces two distinct field
  symbols with correct individual names/ranges, shared type/modifiers
- A field with a generic type (`List<Pet> pets`) — asserting the type text
  is kept whole, not stripped
- A field inside an `interface` body (a `constant_declaration` node, not
  `field_declaration` — see the grammar-asymmetry note in Architecture)
- A field inside an `enum` body (alongside the enum's existing
  method/constructor coverage)
- A field inside a `record` body (a real field, not the record's canonical
  components — e.g., a `record`'s own explicit non-canonical field, if the
  grammar allows one, or otherwise confirm canonical components correctly
  produce **no** field symbol, matching the Non-goals section)
- Negative case: a local variable declared inside a method body must NOT
  produce a field symbol (proving the walk stays member-level-only)
- Multi-line annotation arguments on a field (the same class of bug the
  parent AST rewrite fixed for types/methods) — confirms fields inherit
  that same structural immunity for free, as a regression-prevention test
  rather than a new capability

## Acceptance / Definition of Done for Phase 0

1. All new field-symbol tests pass.
2. The full existing test suite passes with no regressions (using this
   worktree environment's established exclusion list for the four
   pre-existing hang-prone files, documented in the AST-rewrite plan's own
   SDD ledger).
3. `INDEX_VERSION` is bumped in `src/storage/sqlite.ts`.
4. Every currently-committed real-repository benchmark
   (`benchmark:v03`, `benchmark:v14-phase1` through `:v14-phase4`) is
   re-run and shows **no regression** — recall/precision/reduction numbers
   equal or better than currently committed. Since no extractor consumes
   field symbols yet, no *improvement* is expected or required from this
   phase's benchmarks; the bar is "adding field symbols to the index
   doesn't break anything currently measured," not "field symbols make
   existing benchmarks better" (that arrives starting Phase 1).
5. A short follow-up note (matching the AST-rewrite plan's own Task 4
   pattern) records that Phase 0 is complete and Phase 1 (Dependency
   Injection AST migration) is the next sub-project, to be brainstormed
   and specced separately once Phase 0 is merged.

## Open Questions For The Implementation Plan (not this spec)

- Whether `fieldSymbols`' shared per-declaration annotation/modifier
  parsing should be factored to avoid re-parsing the `modifiers` node once
  per declarator (a minor efficiency question, not a correctness one) —
  left to the implementer's judgment during planning, consistent with this
  project's established "small pure helper functions" style.
