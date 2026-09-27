# Java Parser: Real tree-sitter AST Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **A task's brief is its own section plus this header (everything above `### Task 1`).**

**Goal:** Replace `src/parser/java-parser.ts`'s regex-based type/method/constructor extraction with real tree-sitter-java AST traversal — the same architecture TypeScript, Python, and Rust adapters already use — producing **byte-identical `SymbolRecord`/`CallEdge` output** to the current implementation for every existing test and every measured real-repository benchmark. This eliminates, at the root and permanently, the entire CLASS of regex-boundary bugs the current implementation has (multi-line annotation arguments silently dropping a symbol's annotations; javadoc/comment text being mistaken for real declarations; and any other latent regex edge case not yet found) rather than patching them one at a time. Supersedes the smaller, already-drafted `docs/superpowers/plans/2026-09-28-v1.4-java-parser-fixes.md` (that plan's two targeted regex fixes become unnecessary — an AST never has either bug — see Task 4).

**Architecture:** `parseJava` keeps its exact existing signature (`(filePath: string, source: string) => { symbols, calls, parseError }`) and every `SymbolRecord`/`CallEdge` field it currently populates. Internally, the top-level `typeRe`/`methodRe`/`constructorRe` regex-matching loops are replaced by a single recursive AST walk over the tree tree-sitter-java already parses (`parser.parse(source)` — currently only used to set `parseError`; this rewrite makes that SAME parse tree the actual source of symbol boundaries, mirroring exactly how `src/languages/rust/parse.ts` and `src/languages/typescript/parse.ts` already walk their own languages' trees). The bottom-of-file call-extraction loop (regex over each callable symbol's `.body` text) is **deliberately left untouched** — it has no known bug, has its own well-established, separately-benchmarked behavior, and rewriting it is out of this plan's scope (see Global Constraints). `src/languages/java.ts`'s `resolveCalls` is also untouched — it operates on already-built `SymbolRecord`/`CallEdge` objects and the same `sourceOf()` text, so it is unaffected by how those objects were built, only by whether their SHAPE and CONTENT stay identical (which is this whole plan's acceptance bar).

**Tech Stack:** TypeScript (ESM `.js` imports), `npx tsx --test`, `tree-sitter` + `tree-sitter-java` (already a dependency, already imported in `java-parser.ts` — currently used only for its `hasError`-equivalent `parseError` check, this rewrite is the first time its actual parse TREE gets walked for symbol extraction).

**Spec:** No v1.4 spec section names this — this is an architecture-parity fix bringing Java in line with every other language adapter (TypeScript §5 "Tree-sitter first" mandate from the v1.1 spec, Python's and Rust's own "Tree-sitter first" mandates, all already satisfied by their own adapters). Java was the first language implemented (pre-v0.5, before the `LanguageAdapter`/tree-sitter architecture existed at all — confirmed via `git log`: `java-parser.ts` originates in `85e05a5 Harden symbol index`, which predates TypeScript's `e809616 Add language adapters and TypeScript/TSX support`, Python's `4e8da48`, and Rust's `c946894` by many commits) and was never migrated to the pattern later languages established.

## Real grounding (checked before writing this plan, not guessed)
Investigated tree-sitter-java's actual grammar output directly (a throwaway `npx tsx` script parsing representative real-shaped Java: annotated entity classes, multi-line `@Query`, nested interfaces, generics, records, enums, annotated constructor parameters) before writing this plan:
- `class_declaration`/`interface_declaration`/`enum_declaration`/`record_declaration` are real, distinct node types. `class_declaration` has `childForFieldName("name")`, `childForFieldName("superclass")` (text `"extends B"` — the `extends` keyword IS included, must be stripped), `childForFieldName("interfaces")` (text `"implements C, D"` — same), `childForFieldName("body")`. `interface_declaration`'s extends list is a differently-shaped `extends_interfaces` child (not reachable via `childForFieldName("interfaces")`, which returns `undefined` for interfaces — confirmed directly, this is a real, easy-to-get-wrong asymmetry between class and interface supertype access).
- `modifiers` is a distinct child node (on classes, methods, constructors, fields, and formal parameters alike) whose named children are `marker_annotation` (a bare `@Foo`, exposing `.childForFieldName("name")`) or `annotation` (a `@Foo(...)`, exposing both `.childForFieldName("name")` and `.childForFieldName("arguments")` — the WHOLE parenthesized argument list as its own subtree, so a multi-line `@Query(\n value = "...",\n countQuery = "...")` is just one `annotation` node whose `.text` naturally spans multiple lines — the exact case that breaks the current regex is structurally not a special case in the AST at all).
- `line_comment`/`block_comment` are separate SIBLING nodes in the tree, never nested inside or confused with a `class_declaration`/`interface_declaration`/etc. — the current regex bug (a javadoc sentence containing "interface can" producing a fake `interface:can` symbol) is categorically impossible with AST-based matching, since `matchAll` operates on raw text while `namedChildren` walking only ever visits real declaration nodes.
- `method_declaration` has `childForFieldName("type")` (return type), `childForFieldName("name")`, `childForFieldName("parameters")` (a `formal_parameters` node, itself containing `formal_parameter` nodes each with their own `type`/`name` fields and their own `modifiers` for parameter-level annotations like `@Qualifier("x")`), `childForFieldName("body")` (a `block` node, absent for an abstract/interface method — confirmed via a body-less interface method test in an earlier phase's own investigation). `constructor_declaration` is a DISTINCT node type from `method_declaration` — the current regex's "is the matched name equal to the enclosing class name" heuristic (which can misfire, e.g. a method literally named the same as its class, a rare but legal Java pattern) is replaced by a structurally-guaranteed distinction.
- Real Java 17-era syntax (generics with bounds, records, enums with constants, nested interfaces, annotated formal parameters) all parse with `hasError: false` — no early evidence tree-sitter-java can't handle patterns this codebase's real pinned repositories (spring-petclinic, petclinic-rest, keycloak) actually use; Task 3's own step against those real checkouts is the real confirmation, this is just a sanity check.
- `package_declaration`'s name is directly `childForFieldName("name")` (no regex needed, unlike the current `source.match(/\bpackage\s+.../)` scan).

## Global Constraints
- **Byte-identical output is the acceptance bar, not "close enough."** For every symbol the current parser correctly produces today (confirmed by the existing test suite and the existing real-repository benchmarks), the rewritten parser must produce a `SymbolRecord` with the SAME `id`, `canonicalIdentity`, `qualifiedName`, `signature`, `kind`, `range`, `bodyRange`, `parentId` (structurally equal, not necessarily byte-equal since ids are deterministic from the same inputs), `supertypes`, `annotations`, `modifiers`, `source`, `body`. Do not "improve" the id scheme, the signature format, or any other externally-visible field as part of this rewrite — that's explicitly out of scope (see below). A rewrite that happens to fix a symbol the OLD parser got wrong (per Task 3's real-repo re-measurement) is a welcome bonus, not a requirement — report it, don't chase it.
- **Call-extraction is OUT OF SCOPE.** The bottom-of-file regex loop building `CallEdge[]` from each callable symbol's `.body` text is untouched. It has no known bug, and this codebase's own README states 100% semantic call recall/precision for Java on its pinned benchmark — there is no evidence motivating a rewrite there, and doing one anyway would be scope creep this plan explicitly declines (YAGNI). The ONLY requirement on this loop: it must keep receiving the SAME `.body` text it always has, from symbols whose boundaries are now AST-derived instead of regex-derived — if `.body` content is byte-identical (Global Constraint above), this loop needs ZERO code changes.
- **`resolveCalls` (`src/languages/java.ts`) is OUT OF SCOPE.** Untouched. It consumes already-built symbols/calls and re-reads `sourceOf()` text; it has no dependency on HOW those were built.
- **Field-level symbol indexing is OUT OF SCOPE**, even though the AST makes it easy and even though it would let the v1.4 enterprise extractors (`dependency-injection.ts`'s field-injection scanning, `jpa-entity.ts`'s relationship-field scanning) stop needing their own separate regex-based field text-scanning — that is a genuine, valuable CAPABILITY change, not a parity fix, and bundling it into this rewrite would make "did I preserve existing behavior" and "did I add new behavior" impossible to verify independently. Note it as a real, concrete follow-up opportunity in Task 4's summary, do not build it now.
- **No change to any of the 5 v1.4 enterprise extractor files** (`spring-mvc.ts`, `dependency-injection.ts`, `transactions.ts`, `jpa-entity.ts`, `spring-data.ts`) or the registry/resolver infrastructure — they all consume `SymbolRecord`/`ProjectIndex` and independently regex their OWN `.source` slices; as long as `.source` content is unchanged, they need no changes and this plan must not touch them.
- **`INDEX_VERSION` bump required** (`src/storage/sqlite.ts`) — this changes Java parse output at the deepest level (even if the VALUES stay identical, this is worth treating with the same caution as every prior parse-output-affecting change in this repo's history). Confirm the current value yourself before bumping (`grep INDEX_VERSION src/storage/sqlite.ts`), don't assume.
- **The acceptance gate is the FULL existing test suite passing UNCHANGED**, not a new test suite written to match new behavior. If any existing test needs to be MODIFIED (not just re-run) to pass, that is a signal the rewrite introduced a real behavioral difference — STOP, investigate whether the old or the new behavior is correct, and treat it as a real finding to report explicitly (per the retention-rule discipline every v1.4 phase in this repo has followed), not something to silently paper over by editing the test's expectation.
- Commit messages: short, single-line, imperative, NO `Co-Authored-By`/author trailer (repo memory rule). Tests flat under `tests/`, run with `npx tsx --test`.
- Numbers in any re-generated benchmark report come from real runs; never hand-edited.

## Review Focus
1. **Constructor vs. same-named-method ambiguity**, a real edge case the OLD regex could get wrong (a method whose name coincidentally equals its enclosing class's name is legal Java and would be misidentified as a constructor by the old `parent?.name === name` heuristic) — the AST distinguishes `constructor_declaration` from `method_declaration` structurally; add a test proving the rewrite gets this RIGHT where the old regex-based logic (if tested against this exact case) would not.
2. **Interface vs. class supertype field-name asymmetry** (`interfaces` field works for classes, `undefined` for interfaces — the real extends list lives in a differently-named/shaped child for `interface_declaration`) — this is an easy, silent way to lose an interface's `supertypes` entirely if implemented carelessly; needs its own explicit test.
3. **An abstract/interface method with no body** (`childForFieldName("body")` is `undefined`) must still produce a correctly-bounded symbol (matching the old parser's `open >= 0 ? ... : start + match[0].length` fallback logic) — a body-less method is common in interfaces (exactly the shape v1.4 Phase 4's `PERSISTS_ENTITY` measurement depended on).
4. **A field-shaped generic collection type with nested angle brackets** (`List<Map<String, Pet>>`) inside a `formal_parameter` or method return type must not break traversal (AST handles this natively via `generic_type`/`type_arguments` nesting — no regex angle-bracket-depth tracking needed at all, but confirm the rewrite doesn't accidentally introduce its OWN text-based re-parsing of a type string anywhere it doesn't need to).
5. **Multiple top-level types in one file, and deeply nested types (interface inside class inside class)**, must still produce the correct `parentId` chain and `qualifiedName`/`canonicalIdentity` — the AST gives this for free via direct parent-child recursion (no more "find the smallest enclosing range" heuristic the old code used), but this is exactly the kind of thing worth a dedicated nested-type test since it's a structural rewrite of how parent-finding works, not just a mechanical translation.

---

### Task 1: AST-based type declaration extraction (class/interface/enum/record)

**Files:**
- Modify: `src/parser/java-parser.ts`
- Test: `tests/java-parser-ast-types.test.ts` (new — temporary, parallel test file for this task's own verification; Task 3 folds real parity-checking into the FULL existing suite, this file is this task's own scoped RED/GREEN evidence)

**Interfaces:**
- Consumes: nothing new — `parser.parse(source)` (tree-sitter-java) is already imported and called in `parseJava`; this task makes its RETURN VALUE (the actual `tree.rootNode`) used for real, instead of discarded after the `parseError` check.
- Produces: no new exported names. Internally, a recursive walk function (mirroring `src/languages/rust/parse.ts`'s `walk(node, parent, chain)` shape — read that file's walk loop first as the direct pattern to follow, adapting node-type names to Java's grammar) replaces the `for (const match of source.matchAll(typeRe))` loop, producing the exact same `SymbolRecord[]` shape (pushed into the same `symbols`/`types` arrays the rest of `parseJava` already uses) for `kind: "class" | "interface" | "enum" | "record"`.

- [ ] **Step 1: Write the failing tests first** (`tests/java-parser-ast-types.test.ts`), each asserting exact parity with documented current behavior:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";

test("a simple annotated class matches the old regex parser's id/source shape", () => {
  const source = "package com.example;\n\n@Entity\npublic class Owner {\n}\n";
  const { symbols } = parseJava("Owner.java", source);
  const owner = symbols.find((s) => s.kind === "class" && s.name === "Owner")!;
  assert.ok(owner);
  assert.equal(owner.packageName, "com.example");
  assert.equal(owner.qualifiedName, "com.example.Owner");
  assert.equal(owner.id, "Owner.java::com.example::Owner::class::Owner");
  assert.ok(owner.source.startsWith("@Entity"), "source must include the leading annotation");
  assert.deepEqual(owner.annotations, ["@Entity"]);
  assert.deepEqual(owner.modifiers, ["public"]);
});

test("class supertypes (extends + implements) are both captured", () => {
  const source = "class A extends B implements C, D {}";
  const { symbols } = parseJava("A.java", source);
  const a = symbols.find((s) => s.name === "A")!;
  assert.deepEqual(a.supertypes?.sort(), ["B", "C", "D"].sort());
});

test("interface extends (multiple) is captured despite the field-name asymmetry with classes", () => {
  const source = "interface I extends J, K {}";
  const { symbols } = parseJava("I.java", source);
  const i = symbols.find((s) => s.name === "I")!;
  assert.deepEqual(i.supertypes?.sort(), ["J", "K"].sort());
});

test("a multi-line @Query-shaped annotation on a top-level type is not lost (the bug this rewrite fixes)", () => {
  const source = [
    "@SuppressWarnings(",
    '    value = "unchecked"',
    ")",
    "class X {}",
  ].join("\n");
  const { symbols } = parseJava("X.java", source);
  const x = symbols.find((s) => s.name === "X")!;
  assert.ok(x.source.includes("@SuppressWarnings"));
  assert.deepEqual(x.annotations, ["@SuppressWarnings"]);
});

test("a javadoc sentence containing a type keyword does not produce a fake symbol (the other bug this rewrite fixes)", () => {
  const source = [
    "/**",
    " * this interface can easily be extended",
    " */",
    "public interface Real {",
    "}",
  ].join("\n");
  const { symbols } = parseJava("Real.java", source);
  const names = symbols.filter((s) => s.kind === "interface").map((s) => s.name);
  assert.deepEqual(names, ["Real"]);
});

test("nested types produce the correct parentId chain and qualifiedName", () => {
  const source = "class Outer {\n    interface Inner {\n    }\n}";
  const { symbols } = parseJava("Outer.java", source);
  const outer = symbols.find((s) => s.name === "Outer")!;
  const inner = symbols.find((s) => s.name === "Inner")!;
  assert.equal(inner.parentId, outer.id);
  assert.equal(inner.qualifiedName, "Outer.Inner");
});

test("enum and record kinds are both recognized", () => {
  const source = "enum Status { ACTIVE, INACTIVE }\nrecord Point(int x, int y) {}\n";
  const { symbols } = parseJava("Both.java", source);
  assert.ok(symbols.some((s) => s.kind === "enum" && s.name === "Status"));
  assert.ok(symbols.some((s) => s.kind === "record" && s.name === "Point"));
});
```

- [ ] **Step 2: Run to verify RED** on at least the two bug-fix tests (multi-line annotation, javadoc keyword) — the CURRENT regex-based parser should fail both; report the actual RED state for every test in the file honestly, some may already pass against the unmodified parser (e.g. simple parity tests might already hold).
- [ ] **Step 3: Implement the AST-based type walk.** Read `src/languages/rust/parse.ts`'s recursive `walk` function first (the direct pattern to mirror: `walk(node, parent, chain)`, using `node.namedChildren`, a `KIND_BY_NODE_TYPE`-style lookup, pushing to a shared `symbols` array, recursing into a body field for nested items). For Java: map `class_declaration → "class"`, `interface_declaration → "interface"`, `enum_declaration → "enum"`, `record_declaration → "record"` (matching the OLD parser's exact `kind` values — confirmed identical to the regex version's `match[3] as SymbolKind`, do not invent new kind strings). For each matched node: `name = node.childForFieldName("name")!.text`; `start = node.startIndex`, `end = node.endIndex` (tree-sitter gives these directly — no `closingBrace()` scan needed, this ENTIRELY replaces that helper for type declarations); `open`/`bodyRange` from `node.childForFieldName("body")` if present (class/enum/record always have one; a rare body-less case shouldn't occur for types, but don't assume — check the field exists before using it, matching the old code's `open >= 0 ? ... : ...` defensive shape); supertypes: for `class_declaration`, combine `childForFieldName("superclass")?.text.replace(/^extends\s+/, "")` and `childForFieldName("interfaces")?.text.replace(/^implements\s+/, "").split(/\s*,\s*/)`; for `interface_declaration`, find the DIRECT CHILD of type `"extends_interfaces"` (not via `childForFieldName`, confirmed this field name doesn't work for interfaces) and extract its `type_list`'s comma-separated identifiers (strip the leading `extends` keyword text the same way); annotations/modifiers: from the node's own `modifiers` child (if present) — for each of ITS named children, `marker_annotation` → `` `@${child.childForFieldName("name")!.text}` ``, `annotation` → same (the ANNOTATION NAME only, matching the old `annotationList()`'s bare-name behavior — do NOT include arguments in the `.annotations` array, that would change the external contract), and the non-annotation modifier keywords (`public`, `static`, etc. — these appear as PLAIN TOKEN children of the `modifiers` node, not as separate named node types with their own type name beyond the keyword text itself; inspect this directly rather than assuming, since it wasn't explicitly probed before writing this plan) collected into `.modifiers` in source order, matching the old parser's ordering. `.source`/`.body` = `source.slice(start, end)`/`source.slice(bodyNode.startIndex, bodyNode.endIndex)` — same slicing convention as before, just with AST-derived offsets instead of regex-derived ones. `packageName` = `tree.rootNode`'s `package_declaration` child's `name` field text directly (no regex needed — replaces the old `source.match(/\bpackage\s+.../)` scan). Parent-finding: walk recursively with an explicit `parent` parameter passed down through the AST's own nesting (a class's `class_body`'s named children ARE its direct nested types/methods/fields — no "find smallest enclosing range" heuristic needed, this is a real structural simplification the AST gives for free) — do not port the old range-containment heuristic at all, replace it with direct recursion.
- [ ] **Step 4: Run to verify GREEN.** `npx tsx --test tests/java-parser-ast-types.test.ts` → PASS (7/7).
- [ ] **Step 5: Run the full suite once, expect SOME failures at this point** (methods/constructors aren't converted yet, so any test depending on method/constructor symbols will still use the OLD regex loops running alongside the new type-only AST walk — confirm this hybrid state doesn't crash, just produces the expected subset of failures; do not try to make the whole suite pass yet, that's Task 2/3's job). Report the actual pass/fail counts honestly as a checkpoint, not a final claim.
- [ ] **Step 6: Commit.** `git add src/parser/java-parser.ts tests/java-parser-ast-types.test.ts && git commit -m "feat(java): AST-based type declaration extraction"`

---

### Task 2: AST-based method and constructor extraction

**Files:**
- Modify: `src/parser/java-parser.ts`
- Test: `tests/java-parser-ast-methods.test.ts` (new — same temporary/scoped-evidence role as Task 1's own test file)

**Interfaces:**
- Consumes: Task 1's AST type-walk (methods/constructors are found as named children of a type's `body` field during the SAME recursive walk Task 1 built — this task extends that walk's node-type handling, it does not add a second separate pass over the tree).
- Produces: no new exported names. `kind: "method" | "constructor"` symbols, matching the old parser's exact field shapes (`signature` format `` `${name}(${parameters}): ${type}` `` for methods, `` `${name}(${parameters}): ${name}` `` for constructors — keep these EXACT string formats, every downstream consumer/test depends on them).

- [ ] **Step 1: Write the failing tests first** (`tests/java-parser-ast-methods.test.ts`):

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";

test("a method's signature/annotations/modifiers match the old parser's exact shape", () => {
  const source = "class Owner {\n    @Transactional(readOnly = true)\n    public String getName() { return name; }\n}";
  const { symbols } = parseJava("Owner.java", source);
  const m = symbols.find((s) => s.kind === "method" && s.name === "getName")!;
  assert.equal(m.signature, "getName(): String");
  assert.deepEqual(m.annotations, ["@Transactional"]);
  assert.deepEqual(m.modifiers, ["public"]);
  assert.ok(m.source.includes("@Transactional(readOnly = true)"));
  assert.equal(m.body, "{ return name; }");
});

test("a constructor is never confused with a same-named method (the old parser's own heuristic could misfire here)", () => {
  const source = "class Repository {\n    Repository() {}\n    void Repository(int x) {}\n}"; // legal but unusual: a method literally named like the class
  const { symbols } = parseJava("Repository.java", source);
  const ctor = symbols.find((s) => s.kind === "constructor");
  const method = symbols.find((s) => s.kind === "method" && s.name === "Repository");
  assert.ok(ctor, "the real constructor must be found");
  assert.ok(method, "the same-named METHOD (with a return type, so not a constructor) must be found too, correctly typed as a method");
});

test("a body-less interface method (abstract, no {}) still produces a correctly-bounded symbol", () => {
  const source = "interface Repo {\n    Owner findById(Integer id);\n}";
  const { symbols } = parseJava("Repo.java", source);
  const m = symbols.find((s) => s.kind === "method" && s.name === "findById")!;
  assert.equal(m.body, undefined);
  assert.ok(m.source.includes("findById(Integer id)"));
});

test("a multi-line @Query annotation on a method is captured (the bug this rewrite fixes, at method level)", () => {
  const source = [
    "interface R {",
    "    @Query(",
    '        value = "SELECT o FROM Owner o",',
    '        countQuery = "SELECT COUNT(o) FROM Owner o")',
    "    Page<Owner> findAll(Pageable p);",
    "}",
  ].join("\n");
  const { symbols } = parseJava("R.java", source);
  const m = symbols.find((s) => s.kind === "method" && s.name === "findAll")!;
  assert.ok(m.source.includes("countQuery"), "the whole multi-line @Query argument must be in the method's own source");
  assert.deepEqual(m.annotations, ["@Query"]);
});

test("an annotated constructor parameter does not break constructor extraction", () => {
  const source = "class Checkout {\n    Checkout(@Qualifier(\"x\") Repo r) {}\n}";
  const { symbols } = parseJava("Checkout.java", source);
  const ctor = symbols.find((s) => s.kind === "constructor")!;
  assert.ok(ctor, "constructor with an annotated parameter must still be found");
});

test("parameterSignature stripping still matches the old convention exactly", () => {
  const source = "class X {\n    void m(final String a, @NotNull volatile int b) {}\n}"; // deliberately odd modifiers to exercise stripping
  const { symbols } = parseJava("X.java", source);
  const m = symbols.find((s) => s.kind === "method" && s.name === "m")!;
  assert.equal(m.signature, "m(String a, int b): void");
});
```

- [ ] **Step 2: Run to verify RED** against the current hybrid state (types via AST from Task 1, methods/constructors still via old regex) — report honestly which of these already pass by coincidence vs. genuinely fail.
- [ ] **Step 3: Implement.** Extend Task 1's walk: when recursing into a type's `body`, its named children of type `method_declaration`/`constructor_declaration` become `method`/`constructor` symbols directly (no name-equality heuristic needed for constructors — the AST node TYPE already disambiguates). For each method: `type = node.childForFieldName("type")!.text` (return type — note this can itself be a generic type like `Page<Owner>`, keep it as the RAW text, matching the old parser's behavior of not further parsing the return-type string); `name`, `parameters` from `childForFieldName("parameters")` (the raw formal-parameters text INCLUDING its own parens needs the SAME stripping `parameterSignature()` already does — reuse that EXISTING function unchanged, just feed it the AST-derived parameter text instead of a regex capture group; confirm the text shape matches what `parameterSignature` expects, e.g. whether it needs the surrounding parens stripped first — check the old code's `match[6]` capture group content precisely and match it). `body` from `childForFieldName("body")` (a `block` node — `undefined` for abstract/interface methods, exactly matching the old `open >= 0 ? ... : undefined` case, now driven by whether the field exists rather than an `indexOf` scan). Annotations/modifiers: same `modifiers` child-node walk as Task 1, reused (factor into a small shared helper if that's cleanly possible without over-engineering — a single extracted function used by both the type-walk and method-walk is reasonable DRY, not premature abstraction, since it's the exact same "read a `modifiers` node into annotations[]/modifiers[]" operation in both places). Constructors: same shape, but always attribute to the enclosing type by construction (the AST parent link, not a name-match heuristic) — `signature`/`canonicalId` use the constructor's OWN `kind: "constructor"` and the enclosing type's name for the `${name}(...): ${name}` format, matching the old convention exactly.
- [ ] **Step 4: Run to verify GREEN.** `npx tsx --test tests/java-parser-ast-methods.test.ts` → PASS (6/6).
- [ ] **Step 5: Remove the now-dead regex code.** `typeRe`, `methodRe`, `METHOD_EXTRA_PREFIX_ITEM`, `constructorRe`, `closingBrace()` (if type/method/constructor extraction no longer needs it — confirm nothing else in the file still calls it before removing), `point()`/`sourceRange()` (KEEP these — they're still needed to convert AST byte-offsets into line/column `SourceRange`s, just called with AST-derived offsets now instead of regex-match offsets) — remove dead code, do not leave the old regex constants sitting unused "just in case."
- [ ] **Step 6: Run the FULL suite.** `npm test` → this is the first point where the ENTIRE existing suite should pass again (both type and method/constructor extraction are now AST-based, call-extraction was never touched). Report the exact result. If anything fails, this is the task's own responsibility to fix (don't defer a known-broken state to Task 3) — Task 3 is real-world/benchmark verification, not "make the unit tests pass for the first time."
- [ ] **Step 7: Commit.** `git add src/parser/java-parser.ts tests/java-parser-ast-methods.test.ts && git commit -m "feat(java): AST-based method and constructor extraction"`

---

### Task 3: Full parity verification against real repositories

**Files:**
- Modify: `src/storage/sqlite.ts` (`INDEX_VERSION` bump, this commit)
- Modify (regenerated, only if numbers genuinely change — see Step 4): every `benchmarks/results/v1.4-phase*.{json,md}` and the base Java benchmark report the README cites
- No production `src/` changes beyond the version bump — this task is measurement and confirmation, not further implementation (matching every prior phase's own "Task N: real-repository measurement" discipline in this repo).

**Interfaces:** Consumes the completed AST rewrite from Tasks 1-2. Produces the real evidence this whole plan's "byte-identical output" claim rests on.

- [ ] **Step 1: Confirm the full suite is green** (`npm test`) — re-confirm Task 2's own Step 6 result at the start of this task, since time may have passed / other work may have landed on `main` in the meantime (check `git log` for anything new).
- [ ] **Step 2: Bump `INDEX_VERSION`.** Check the current value first (`grep INDEX_VERSION src/storage/sqlite.ts`), increment it, following this repo's own established convention (a simple minor-version bump, e.g. `"1.10.0"` → `"1.11.0"`, adjusted to whatever the real current value actually is).
- [ ] **Step 3: Re-run EVERY real-repository benchmark that touches Java**, comparing against the CURRENTLY COMMITTED numbers (never a re-derived "expected" number — the committed reports ARE the baseline): the original Java benchmark (`npm run benchmark:v03` or whatever the exact script is — confirm from `package.json`, this is the one the README cites as Java's 100%/100%/94.55% baseline), and all four v1.4 phase benchmarks (`npm run benchmark:v14-phase1` through `:v14-phase4` — routes, DI, transactions, JPA/Spring Data). For each: the recall/precision/reduction numbers must be EQUAL OR BETTER than currently committed, never worse. If ANY number regresses, STOP — do not proceed to Step 4, investigate the specific symbol/relation that changed, determine whether the OLD regex parser or the NEW AST parser is actually correct for that real case (per Review Focus items 1-2, the AST is structurally MORE correct for at least the constructor-ambiguity and interface-supertype cases — a "regression" that's actually a bug FIX in a benchmark's own ground truth would be a real, reportable finding, not a plan failure, but must be diagnosed and stated explicitly, never silently absorbed).
- [ ] **Step 4: If every number is unchanged or improved**, regenerate the affected committed report files via their real scripts (never hand-edit) ONLY if any number actually changed — leave reports whose numbers are byte-for-byte identical alone (a regenerated report with only a new `generatedAt` timestamp and identical numbers is noise, not signal; `git diff` it and revert the timestamp-only file if nothing else changed, matching how prior phases handled incidental regeneration noise).
- [ ] **Step 5: Spot-check the two originally-diagnosed real bugs directly** against their exact real-repository source: `SpringDataOwnerRepository.java`'s multi-line `@Query`-annotated `findAll(Pageable)`, and `OwnerRepository.java`/`VetRepository.java`'s javadoc-triggered fake `can` symbol. Confirm via a direct `parseJava` call against the real checked-out files (not just the unit-test fixtures from Tasks 1-2) that both are now correctly handled — write this confirmation into this task's own commit message or a short note, this is the plan's own "did we actually fix what we set out to fix" check, distinct from the broader regression-safety check in Step 3.
- [ ] **Step 6: Run the full suite one final time.** `npm test` → all green.
- [ ] **Step 7: Commit.** `git add src/storage/sqlite.ts benchmarks/results/*.json benchmarks/results/*.md && git commit -m "chore(java): bump index version for the AST parser rewrite"` (only include report files that genuinely changed, per Step 4).

---

### Task 4: Cleanup and follow-up notes

**Files:**
- Delete: `docs/superpowers/plans/2026-09-28-v1.4-java-parser-fixes.md` (superseded — its two targeted regex fixes are unnecessary now that the AST rewrite eliminates both bugs structurally; keep the file's git HISTORY as the record of the original diagnosis, just remove it from the working tree since it no longer describes planned, not-yet-done work)
- Create: `docs/superpowers/plans/2026-09-28-java-ast-rewrite-summary.md` (short)

- [ ] **Step 1: Confirm the small parser-fixes plan is genuinely superseded**, not just assumed — re-read its two bug descriptions against Task 3's Step 5 confirmation before deleting it. If, surprisingly, either bug is NOT actually fixed by the AST rewrite (would be a real finding contradicting this plan's own central premise), do NOT delete that plan — instead flag this loudly as the single most important finding of the whole plan and stop to report it rather than silently deleting evidence of a still-open problem.
- [ ] **Step 2: Write the short summary doc** — what changed (AST-based type/method/constructor extraction, call-extraction and `resolveCalls` untouched), the real bugs fixed (with the exact real-repository file/method names), the real-repository numbers before/after (from Task 3), and explicitly name the two things this plan deliberately declined (field-level symbol indexing as a natural, valuable follow-up; call-extraction rewrite as unmotivated scope creep) so a future reader doesn't have to re-derive why those weren't done here.
- [ ] **Step 3: Confirm the tree is clean and all tests pass.** `git status`, `npm test`.
- [ ] **Step 4: Commit.** `git add -A docs && git commit -m "docs: summarize the Java AST parser rewrite, retire the superseded regex-fix plan"`

## Self-review notes
- Spec coverage: no v1.4 spec section directly names this work; it is an architecture-parity fix already implied by every prior language adapter's own "Tree-sitter first" mandate, made explicit in this plan's own Spec line.
- Type consistency: `parseJava`'s external signature and every `SymbolRecord`/`CallEdge` field name/format is preserved byte-for-byte per the Global Constraints — this plan introduces NO new exported names, NO new `SymbolKind` values, NO new field. The only "produced interface" any task offers a later task is the shared internal AST-walk shape Task 2 extends from Task 1, both purely internal to `java-parser.ts`.
- Known, deliberately-declined scope, stated three times for the same reason every prior v1.4 phase's honesty discipline required: call-extraction rewrite (no evidence motivating it) and field-level symbol indexing (a real capability, not a parity fix) are both explicitly out of scope, named in the plan header, the Global Constraints, and Task 4's summary — not silently omitted.
- Real risk acknowledged directly: this is the single highest-blast-radius change to shared Java parsing code in this repository's history (bigger than Phase 1's `methodRe` fix, bigger than the small regex-patch plan this one supersedes) — Task 3's real-repository re-verification, not just the unit test suite, is the actual acceptance gate, and its Step 3 explicitly requires STOPPING on any regression rather than proceeding through it.
