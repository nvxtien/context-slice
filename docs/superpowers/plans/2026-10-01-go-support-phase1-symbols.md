# Go Language Support — Phase 1 (Symbol Extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new, from-scratch Go language adapter (`src/languages/go/`) that extracts `SymbolRecord`s for Go's package-level declarations — functions, methods, structs, interfaces, type aliases, package-level const/var, and struct fields — and validate it against three real, pinned Go repositories via a new benchmark.

**Architecture:** `tree-sitter-go` (already added to `package.json` as a dependency, commit `0ad72b3`) parses each `.go` file into a tree whose top-level item types are direct children of `source_file`: `function_declaration`, `method_declaration`, `type_declaration` (which can wrap one or several `type_spec` children — Go's grouped `type (...)` form), `const_declaration`/`var_declaration` (same grouping behavior via `const_spec`/`var_spec`), and `import_declaration` (out of scope this phase). No deep recursive walk is needed the way Rust's adapter needs one for nested `impl`/`mod` blocks — Phase 1's constructs are all direct children of the file, with only one level of further nesting (struct fields inside `field_declaration_list`, interface methods inside `interface_type`, multiple specs inside a grouped `type_declaration`/`const_declaration`/`var_declaration`).

**Tech Stack:** TypeScript, `tree-sitter` + `tree-sitter-go`, Node's built-in test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-10-01-go-support-phase1-symbols-design.md`

## Global Constraints

- No new `SymbolKind` values. Mapping (verified against the live `SymbolKind` union in `src/types/model.ts` before writing this plan — do not add anything not already in that union):
  - `function_declaration` → `"function"`
  - `method_declaration` → `"method"`
  - `struct_type` (via its enclosing `type_spec`) → `"class"` (same precedent as Rust's `struct_item` → `"class"` mapping in `src/languages/rust/parse.ts`)
  - `interface_type` (via its enclosing `type_spec`) → `"interface"`
  - any other `type_spec` (type alias / defined type, e.g. `type UserID int`) → `"type"`
  - `const_spec` / `var_spec` → `"variable"`
  - `field_declaration` (struct field) → `"field"`
- `SymbolRecord.language` is `"go"` for every symbol.
- `annotations` is always `[]` (Go has no annotation syntax).
- Every grammar fact used below (node types, field names) was verified empirically against `tree-sitter-go@0.23.4` by parsing real sample source during this plan's own writing — not guessed. If an implementer finds a construct behaves differently, that is new information to report, not a sign the plan's claims are approximate.
- Receiver linkage: a method's `supertypes` array always holds exactly one entry — the receiver's base type name, with a leading `*` (pointer receiver) stripped. `parentId` is set to the matching struct/type symbol's `id` ONLY when that type is declared in the SAME file (same-file linkage is this phase's testable contract per the spec; cross-file linkage is deferred). When no same-file match exists, `parentId` is `undefined` and `supertypes` still carries the name — never drop the method or misattribute it to an unrelated symbol.
- `tree-sitter-go`'s binding, like every other adapter's tree-sitter binding in this project, rejects large single-chunk inputs — feed `parser.parse()` a chunked reader exactly like `src/languages/rust/parse.ts` and `src/languages/typescript/parse.ts` already do (`(index) => source.slice(index, index + 4_096)`), not `parser.parse(source)` directly.
- Full test suite runs: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")` (established exclusion list for this project's known hang-prone files in a worktree environment).

## Review Focus

- A grouped `type (...)` block with multiple `type_spec` children must produce one symbol PER spec, not one symbol for the whole block or only the first spec — Task 2's tests pin this (confirmed via direct grammar inspection: `type_declaration` can have 1-N `type_spec` named children).
- The same grouping behavior for `const (...)` / `var (...)` blocks — Task 2's tests pin this.
- An embedded struct field (`Base` with no explicit field name, just the type) must still produce a `"field"` symbol, using the type's own name as the field's name (confirmed via grammar inspection: `field_declaration`'s `name` field is absent for an embedded field; only `type` is present) — Task 2's tests pin this.
- A value receiver (`func (u User) Name()`, no `*`) must resolve the same as a pointer receiver (`func (u *User) Name()`) — Task 1's tests pin both forms.
- A generic function (`func Add[T any](a, b T) T`) must still produce a correctly kinded `"function"` symbol without the type-parameter list breaking name/signature extraction — Task 1's tests pin this.
- A syntactically broken `.go` file must produce `parseError: true` without throwing — Task 1's tests pin this (every other adapter in this project honors this contract; `go.test.ts` must too).

---

### Task 1: Adapter skeleton, package name, functions, and methods (with receiver linkage)

**Files:**
- Create: `src/languages/go/parse.ts`
- Create: `src/languages/go/index.ts`
- Create: `tests/go.test.ts`
- Modify: `src/indexer/index.ts` (register the adapter, mirroring the existing `import "../languages/rust/index.js";` line)
- Modify: `src/workflow/repository.ts` (register the adapter — note this file currently does NOT import rust's adapter, only java/typescript/python; follow the SAME pattern this file already uses, i.e. add `import "../languages/go/index.js";` alongside its existing java/typescript/javascript/python imports — do not add rust here, that is pre-existing and out of this plan's scope to fix)

**Interfaces:**
- Produces: `parseGo(filePath: string, source: string): ParsedFile` (same `ParsedFile` shape every other adapter's parse function returns — `symbols`, `calls: []`, `imports: []`, `exports: []`, `parseError`).
- Produces: `goAdapter: LanguageAdapter` (`id: "go"`, `label: "Go"`, `extensions: [".go"]`).
- Consumes: nothing from other tasks (this is the first task).

- [ ] **Step 1: Write the failing tests for Task 1's scope**

Create `tests/go.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseGo } from "../src/languages/go/parse.js";
import { adapterFor } from "../src/languages/adapter.js";
import "../src/languages/go/index.js";

test("a package-level function produces a 'function' symbol", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n`);
  const fn = parsed.symbols.find((s) => s.name === "Add");
  assert.ok(fn, "expected a symbol for Add");
  assert.equal(fn!.kind, "function");
  assert.equal(fn!.language, "go");
});

test("a pointer-receiver method resolves parentId to its same-file struct", () => {
  const source = `package main\n\ntype User struct {\n\tName string\n}\n\nfunc (u *User) Validate() error {\n\treturn nil\n}\n`;
  const parsed = parseGo("user.go", source);
  const struct = parsed.symbols.find((s) => s.name === "User");
  const method = parsed.symbols.find((s) => s.name === "Validate");
  assert.ok(struct, "expected a symbol for User");
  assert.ok(method, "expected a symbol for Validate");
  assert.equal(method!.kind, "method");
  assert.deepEqual(method!.supertypes, ["User"]);
  assert.equal(method!.parentId, struct!.id);
});

test("a value-receiver method (no pointer) resolves the same way", () => {
  const source = `package main\n\ntype User struct {\n\tName string\n}\n\nfunc (u User) String() string {\n\treturn u.Name\n}\n`;
  const parsed = parseGo("user.go", source);
  const struct = parsed.symbols.find((s) => s.name === "User");
  const method = parsed.symbols.find((s) => s.name === "String");
  assert.deepEqual(method!.supertypes, ["User"]);
  assert.equal(method!.parentId, struct!.id);
});

test("a method whose receiver struct is in another file keeps supertypes but has no parentId", () => {
  const source = `package main\n\nfunc (u *User) Validate() error {\n\treturn nil\n}\n`;
  const parsed = parseGo("user_methods.go", source);
  const method = parsed.symbols.find((s) => s.name === "Validate");
  assert.ok(method, "expected a symbol for Validate even without the struct in this file");
  assert.deepEqual(method!.supertypes, ["User"]);
  assert.equal(method!.parentId, undefined);
});

test("a generic function still produces a correctly kinded function symbol", () => {
  const parsed = parseGo("generic.go", `package main\n\nfunc Add[T any](a, b T) T {\n\treturn a\n}\n`);
  const fn = parsed.symbols.find((s) => s.name === "Add");
  assert.ok(fn, "expected a symbol for the generic function Add");
  assert.equal(fn!.kind, "function");
});

test("a syntactically broken .go file reports parseError without throwing", () => {
  const parsed = parseGo("broken.go", "func ( { : ;");
  assert.equal(parsed.parseError, true);
  assert.equal(Array.isArray(parsed.symbols), true);
});

test("the language registry routes .go files to the go adapter", () => {
  const adapter = adapterFor("main.go");
  assert.ok(adapter, "expected an adapter for main.go");
  assert.equal(adapter!.id, "go");
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts`

Expected: fails with a module-not-found error for `../src/languages/go/parse.js` (the files don't exist yet) — this is the correct RED, confirming the tests exercise real, not-yet-built code.

- [ ] **Step 3: Implement `src/languages/go/parse.ts`**

```ts
import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  SymbolKind,
  SymbolRecord,
} from "../../types/model.js";
import type { ParsedFile } from "../adapter.js";

type Node = Parser.SyntaxNode;

export const LANGUAGE_ID = "go";

let parser: Parser | undefined;
function goParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Go as any);
  }
  return parser;
}

const range = (node: Node) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});
const field = (node: Node, name: string) => node.childForFieldName(name);
const text = (node: Node | null | undefined) => node?.text ?? "";

/**
 * A method's receiver type as written, e.g. "*User" or "User" (verified: the
 * receiver's own parameter_declaration has a "type" field that is either a
 * pointer_type node (whose own namedChild(0) is the base type_identifier) or
 * a type_identifier node directly for a value receiver).
 */
function receiverBaseTypeName(methodNode: Node): string | undefined {
  const receiverList = field(methodNode, "receiver");
  const paramDecl = receiverList?.namedChildren.find(
    (c) => c.type === "parameter_declaration",
  );
  const typeNode = paramDecl ? field(paramDecl, "type") : undefined;
  if (!typeNode) return undefined;
  if (typeNode.type === "pointer_type") {
    const base = typeNode.namedChild(0);
    return base?.type === "type_identifier" ? base.text : undefined;
  }
  return typeNode.type === "type_identifier" ? typeNode.text : undefined;
}

function canonicalId(filePath: string, kind: SymbolKind, name: string, parameters?: string) {
  return [filePath, kind, name, parameters].filter(Boolean).join("::");
}

export function parseGo(filePath: string, source: string): ParsedFile {
  const symbols: SymbolRecord[] = [];
  const calls: CallEdge[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  let parseError = false;
  let tree: Parser.Tree;
  try {
    // tree-sitter's node binding rejects large single-string inputs; feed it in chunks,
    // matching every other adapter in this project (rust, typescript).
    tree = goParser().parse((index: number) => source.slice(index, index + 4_096));
  } catch {
    return { symbols, calls, imports, exports, parseError: true };
  }
  if (tree.rootNode.hasError) parseError = true;

  const seenIds = new Set<string>();
  const uniqueId = (id: string) => {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      return id;
    }
    let n = 2;
    while (seenIds.has(`${id}#${n}`)) n++;
    const deduped = `${id}#${n}`;
    seenIds.add(deduped);
    return deduped;
  };

  const structByName = new Map<string, SymbolRecord>();
  const pendingMethods: { node: Node; receiverName: string | undefined }[] = [];

  for (const child of tree.rootNode.namedChildren) {
    if (child.type === "function_declaration") {
      const name = text(field(child, "name"));
      if (!name) continue;
      const parameters = text(field(child, "parameters"));
      const id = uniqueId(canonicalId(filePath, "function", name, parameters));
      symbols.push({
        id,
        language: LANGUAGE_ID,
        kind: "function",
        name,
        qualifiedName: name,
        canonicalIdentity: id,
        signature: `func ${name}${parameters}`,
        filePath,
        range: range(child),
        bodyRange: field(child, "body") ? range(field(child, "body")!) : undefined,
        annotations: [],
        modifiers: [],
        source: child.text,
        body: field(child, "body")?.text,
      });
    } else if (child.type === "method_declaration") {
      // Deferred: struct symbols may appear later in this same file's top-level
      // children (Go has no forward-declaration ordering requirement), so method
      // linkage runs in a second pass below once every struct in this file is known.
      pendingMethods.push({ node: child, receiverName: receiverBaseTypeName(child) });
    } else if (child.type === "type_declaration") {
      // Task 1 scope: only build the "class" (struct) branch, needed for same-file
      // receiver linkage below. Task 2 REPLACES this whole branch with the fuller
      // version that also handles interface_type, plain type aliases, and struct
      // field extraction — see Task 2 Step 3 for the replacement.
      for (const spec of child.namedChildren.filter((c) => c.type === "type_spec")) {
        const name = text(field(spec, "name"));
        const typeNode = field(spec, "type");
        if (!name || typeNode?.type !== "struct_type") continue;
        const id = uniqueId(canonicalId(filePath, "class", name));
        const symbol: SymbolRecord = {
          id,
          language: LANGUAGE_ID,
          kind: "class",
          name,
          qualifiedName: name,
          canonicalIdentity: id,
          signature: `type ${name} struct`,
          filePath,
          range: range(spec),
          annotations: [],
          modifiers: [],
          source: spec.text,
        };
        symbols.push(symbol);
        structByName.set(name, symbol);
      }
    }
  }

  // Second pass: by now structByName holds every struct declared in THIS file (built
  // in the first pass above), so same-file receiver linkage is real here. A method
  // whose receiver type isn't in this file's own structByName correctly gets
  // parentId: undefined with supertypes still set — never dropped, never misattributed.
  for (const { node: methodNode, receiverName } of pendingMethods) {
    const name = text(field(methodNode, "name"));
    if (!name) continue;
    const parameters = text(field(methodNode, "parameters"));
    const id = uniqueId(canonicalId(filePath, "method", name, parameters));
    const receiverStruct = receiverName ? structByName.get(receiverName) : undefined;
    symbols.push({
      id,
      language: LANGUAGE_ID,
      kind: "method",
      name,
      qualifiedName: receiverName ? `${receiverName}.${name}` : name,
      canonicalIdentity: id,
      signature: `func (${receiverName ?? ""}) ${name}${parameters}`,
      filePath,
      range: range(methodNode),
      bodyRange: field(methodNode, "body") ? range(field(methodNode, "body")!) : undefined,
      parentId: receiverStruct?.id,
      supertypes: receiverName ? [receiverName] : undefined,
      annotations: [],
      modifiers: [],
      source: methodNode.text,
      body: field(methodNode, "body")?.text,
    });
  }

  return { symbols, calls, imports, exports, parseError };
}
```

- [ ] **Step 4: Implement `src/languages/go/index.ts`**

```ts
import { registerLanguage, type LanguageAdapter } from "../adapter.js";
import { LANGUAGE_ID, parseGo } from "./parse.js";

export const goAdapter: LanguageAdapter = {
  id: LANGUAGE_ID,
  label: "Go",
  extensions: [".go"],
  ignoredDirectories: ["vendor"],
  parse: parseGo,
  resolveCalls: () => {}, // Phase 3 concern; no calls are produced yet.
};

registerLanguage(goAdapter);

export { LANGUAGE_ID as GO_LANGUAGE_ID };
```

- [ ] **Step 5: Register the adapter in the two central import sites**

In `src/indexer/index.ts`, add `import "../languages/go/index.js";` alongside the existing language imports (after the `rust` import, matching that file's existing order: java, typescript, javascript, python, rust).

In `src/workflow/repository.ts`, add `import "../languages/go/index.js";` alongside its existing java/typescript/javascript/python imports (this file does not currently import rust — leave that as-is, out of this plan's scope).

- [ ] **Step 6: Run the tests to verify Task 1's scope passes**

Run: `npx tsx --test tests/go.test.ts`

Expected: all 7 tests PASS, including genuine same-file struct→method `parentId` linkage (Step 3's `parseGo` builds minimal struct symbols in its first pass specifically so this is real, not a vacuous empty-map pass).

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`

Expected: PASS, no new failures beyond the established pre-existing worktree-environment ones.

- [ ] **Step 8: Commit**

```bash
git add src/languages/go/ src/indexer/index.ts src/workflow/repository.ts tests/go.test.ts
git commit -m "feat(go): add Go adapter skeleton with function/method/struct symbol extraction"
```

---

### Task 2: Interfaces, type aliases, const/var, and struct fields

**Files:**
- Modify: `src/languages/go/parse.ts`
- Modify: `tests/go.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseGo`, `structByName`, the minimal struct-detection branch from Task 1 Step 3 (this task REPLACES that branch with the fuller version below — same branch location, same loop).
- Produces: no new exported interface; `parseGo`'s symbol output gains more kinds.

- [ ] **Step 1: Write the failing tests for Task 2's scope**

Add to `tests/go.test.ts`:

```ts
test("a struct's fields each produce their own 'field' symbol", () => {
  const source = `package main\n\ntype User struct {\n\tName string\n\tAge  int\n}\n`;
  const parsed = parseGo("user.go", source);
  const struct = parsed.symbols.find((s) => s.name === "User");
  const nameField = parsed.symbols.find((s) => s.kind === "field" && s.name === "Name");
  const ageField = parsed.symbols.find((s) => s.kind === "field" && s.name === "Age");
  assert.ok(nameField && ageField, "expected both fields as symbols");
  assert.equal(nameField!.parentId, struct!.id);
  assert.equal(ageField!.parentId, struct!.id);
});

test("an embedded field (no explicit name) uses its type name as the field name", () => {
  const source = `package main\n\ntype Base struct {\n\tID int\n}\n\ntype Derived struct {\n\tBase\n\tName string\n}\n`;
  const parsed = parseGo("derived.go", source);
  const derived = parsed.symbols.find((s) => s.name === "Derived");
  const embedded = parsed.symbols.find(
    (s) => s.kind === "field" && s.name === "Base" && s.parentId === derived!.id,
  );
  assert.ok(embedded, "expected an embedded 'Base' field on Derived");
});

test("an interface type produces an 'interface' symbol", () => {
  const parsed = parseGo("greeter.go", `package main\n\ntype Greeter interface {\n\tGreet() string\n}\n`);
  const iface = parsed.symbols.find((s) => s.name === "Greeter");
  assert.ok(iface, "expected a symbol for Greeter");
  assert.equal(iface!.kind, "interface");
});

test("a non-struct type alias produces a 'type' symbol", () => {
  const parsed = parseGo("id.go", `package main\n\ntype UserID int\n`);
  const alias = parsed.symbols.find((s) => s.name === "UserID");
  assert.ok(alias, "expected a symbol for UserID");
  assert.equal(alias!.kind, "type");
});

test("a grouped type block produces one symbol per spec", () => {
  const source = `package main\n\ntype (\n\tA int\n\tB string\n)\n`;
  const parsed = parseGo("grouped.go", source);
  const a = parsed.symbols.find((s) => s.name === "A");
  const b = parsed.symbols.find((s) => s.name === "B");
  assert.ok(a && b, "expected both A and B as separate symbols");
  assert.equal(a!.kind, "type");
  assert.equal(b!.kind, "type");
});

test("a package-level const produces a 'variable' symbol", () => {
  const parsed = parseGo("consts.go", `package main\n\nconst MaxUsers = 100\n`);
  const sym = parsed.symbols.find((s) => s.name === "MaxUsers");
  assert.ok(sym, "expected a symbol for MaxUsers");
  assert.equal(sym!.kind, "variable");
});

test("a grouped const block produces one symbol per spec", () => {
  const source = `package main\n\nconst (\n\tX = 1\n\tY = 2\n)\n`;
  const parsed = parseGo("grouped-const.go", source);
  const x = parsed.symbols.find((s) => s.name === "X");
  const y = parsed.symbols.find((s) => s.name === "Y");
  assert.ok(x && y, "expected both X and Y as separate symbols");
});

test("a package-level var produces a 'variable' symbol", () => {
  const parsed = parseGo("vars.go", `package main\n\nvar DefaultTimeout int\n`);
  const sym = parsed.symbols.find((s) => s.name === "DefaultTimeout");
  assert.ok(sym, "expected a symbol for DefaultTimeout");
  assert.equal(sym!.kind, "variable");
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx tsx --test tests/go.test.ts`

Expected: the new tests FAIL (interface/type-alias/const/var/field symbols don't exist yet — Task 1 only built structs and functions/methods); Task 1's 7 tests still PASS.

- [ ] **Step 3: Replace Task 1's minimal struct-detection branch with the full version**

In `src/languages/go/parse.ts`, replace the `else if (child.type === "type_declaration")` branch added in Task 1 Step 3 with:

```ts
    } else if (child.type === "type_declaration") {
      for (const spec of child.namedChildren.filter((c) => c.type === "type_spec")) {
        const name = text(field(spec, "name"));
        const typeNode = field(spec, "type");
        if (!name || !typeNode) continue;
        if (typeNode.type === "struct_type") {
          const id = uniqueId(canonicalId(filePath, "class", name));
          const symbol: SymbolRecord = {
            id,
            language: LANGUAGE_ID,
            kind: "class",
            name,
            qualifiedName: name,
            canonicalIdentity: id,
            signature: `type ${name} struct`,
            filePath,
            range: range(spec),
            annotations: [],
            modifiers: [],
            source: spec.text,
          };
          symbols.push(symbol);
          structByName.set(name, symbol);
          const fieldList = field(typeNode, "body"); // struct_type's body field is its field_declaration_list
          for (const fieldDecl of fieldList?.namedChildren.filter((c) => c.type === "field_declaration") ?? []) {
            // An embedded field (e.g. plain "Base") has no "name" field, only "type" —
            // verified empirically: field_declaration's name field is absent for embeds.
            const fieldName = text(field(fieldDecl, "name")) || text(field(fieldDecl, "type"));
            if (!fieldName) continue;
            const fieldId = uniqueId(canonicalId(filePath, "field", `${name}.${fieldName}`));
            symbols.push({
              id: fieldId,
              language: LANGUAGE_ID,
              kind: "field",
              name: fieldName,
              qualifiedName: `${name}.${fieldName}`,
              canonicalIdentity: fieldId,
              signature: fieldDecl.text,
              filePath,
              range: range(fieldDecl),
              parentId: id,
              annotations: [],
              modifiers: [],
              source: fieldDecl.text,
            });
          }
        } else if (typeNode.type === "interface_type") {
          const id = uniqueId(canonicalId(filePath, "interface", name));
          symbols.push({
            id,
            language: LANGUAGE_ID,
            kind: "interface",
            name,
            qualifiedName: name,
            canonicalIdentity: id,
            signature: `type ${name} interface`,
            filePath,
            range: range(spec),
            annotations: [],
            modifiers: [],
            source: spec.text,
          });
        } else {
          const id = uniqueId(canonicalId(filePath, "type", name));
          symbols.push({
            id,
            language: LANGUAGE_ID,
            kind: "type",
            name,
            qualifiedName: name,
            canonicalIdentity: id,
            signature: `type ${name} ${text(typeNode)}`,
            filePath,
            range: range(spec),
            annotations: [],
            modifiers: [],
            source: spec.text,
          });
        }
      }
    } else if (child.type === "const_declaration" || child.type === "var_declaration") {
      const kind = child.type === "const_declaration" ? "const" : "var";
      const specType = kind === "const" ? "const_spec" : "var_spec";
      for (const spec of child.namedChildren.filter((c) => c.type === specType)) {
        // const_spec/var_spec's "name" field only yields the FIRST identifier in a
        // multi-name spec (e.g. "var a, b int"); Phase 1 scope is single-name specs,
        // the common case — multi-name specs are a known, accepted gap, not a bug to
        // chase here (mirrors this project's established "accepted divergence" pattern
        // for narrow multi-declarator gaps elsewhere, e.g. Java field extraction).
        const name = text(field(spec, "name"));
        if (!name) continue;
        const id = uniqueId(canonicalId(filePath, "variable", name));
        symbols.push({
          id,
          language: LANGUAGE_ID,
          kind: "variable",
          name,
          qualifiedName: name,
          canonicalIdentity: id,
          signature: spec.text,
          filePath,
          range: range(spec),
          annotations: [],
          modifiers: [],
          source: spec.text,
        });
      }
    }
```

**Note on `struct_type`'s field name:** verify directly before trusting this snippet verbatim — the exploration during spec-writing found `struct_type`'s field-list child is reached via `field_declaration_list` as a NAMED CHILD of `struct_type`, not necessarily via a `childForFieldName("body")` call (this was not explicitly probed with `childForFieldName` during spec research, only observed via the named-children dump). If `field(typeNode, "body")` returns undefined, fall back to `typeNode.namedChildren.find((c) => c.type === "field_declaration_list")` instead — try the field-name accessor first since it matches this codebase's established style, but confirm it actually returns the node before relying on it, and use the fallback if not.

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npx tsx --test tests/go.test.ts`

Expected: all 15 tests (7 from Task 1 + 8 new) PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx tsx --test $(ls tests/*.test.ts | grep -v -E "mcp-stdio.test.ts|rust-product-surface.test.ts|typescript.test.ts|workflow-benchmark.test.ts")`

Expected: PASS, no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/languages/go/parse.ts tests/go.test.ts
git commit -m "feat(go): extract interface, type alias, const/var, and struct field symbols"
```

---

### Task 3: Real-repo benchmark

**Files:**
- Create: `benchmarks/go-repositories.json`
- Create: `benchmarks/v1.6-go-support.ts`
- Modify: `benchmarks/fetch-checkouts.ts` (add the new manifest to the `manifests` array)
- Modify: `package.json` (add `benchmark:v16` script)
- Create (generated by running the script, then committed): `benchmarks/results/v1.6-go-support.{json,md}`

**Interfaces:**
- Consumes: Task 1+2's completed `parseGo`.
- Produces: a committed benchmark report establishing Phase 1's real-repo baseline.

- [ ] **Step 1: Create the repository manifest**

Create `benchmarks/go-repositories.json`:

```json
[
  {
    "id": "pkg-errors",
    "scale": "small",
    "url": "https://github.com/pkg/errors.git",
    "commit": "87f8819acf6dc28bf5d3c14b334268236d686f48",
    "source": "benchmarks/checkouts/pkg-errors",
    "scope": "whole repository (single-purpose error-wrapping library)",
    "kind": "library"
  },
  {
    "id": "cobra",
    "scale": "medium",
    "url": "https://github.com/spf13/cobra.git",
    "commit": "adbc8813901bba65827259daa8e22ff94ec1f30e",
    "source": "benchmarks/checkouts/cobra",
    "scope": "whole repository (CLI framework)",
    "kind": "library"
  },
  {
    "id": "chi",
    "scale": "large",
    "url": "https://github.com/go-chi/chi.git",
    "commit": "167e1e3bd039d060696b99c8da4e876ae04f42c1",
    "source": "benchmarks/checkouts/chi",
    "scope": "whole repository (HTTP routing library)",
    "kind": "library"
  }
]
```

These three commits were verified reachable via `git ls-remote` during this plan's own spec-writing (not guessed) — if a checkout fails at this exact commit, treat that as a real problem to investigate (network/mirror issue), not a sign to silently pick a different commit.

- [ ] **Step 2: Register the manifest in `fetch-checkouts.ts`**

In `benchmarks/fetch-checkouts.ts`, add `"benchmarks/go-repositories.json"` to the `manifests` array (alongside the existing `repositories.json`, `typescript-repositories.json`, `python-repositories.json`, `rust-repositories.json` entries).

- [ ] **Step 3: Fetch the checkouts and inspect each repo's actual top-level declarations**

Run: `npx tsx benchmarks/fetch-checkouts.ts`

Then, for each of the three repos, pick 2-3 representative files and read them directly (e.g. `benchmarks/checkouts/pkg-errors/errors.go`) to hand-build the oracle in Step 4 — do not guess expected symbol names/counts, read the real source.

- [ ] **Step 4: Write the benchmark script**

Create `benchmarks/v1.6-go-support.ts`, modeled on `benchmarks/v1.3-python-support.ts`'s structure (repository list, hand-curated oracle, index each repo, compare). Keep this phase's oracle scoped to symbol-extraction recall/precision only (no call/import oracle yet — those are later phases' additions to this SAME file):

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

type Repository = {
  id: string;
  scale: string;
  url: string;
  commit: string;
  source: string;
  scope: string;
  kind: string;
};
type OracleSymbol = { name: string; kind: string };

const repositories: Repository[] = JSON.parse(
  readFileSync(resolve(process.cwd(), "benchmarks/go-repositories.json"), "utf8"),
);

// Hand-curated from reading each repo's actual source (Task 3 Step 3) — a representative
// sample per repo, not exhaustive. Each entry must be found among the indexed symbols for
// that repo (by name + kind); recall = found / total, precision is not separately tracked
// this phase (Phase 1 has no false-positive-prone construct the way annotation-detection
// phases did — a symbol either is or isn't a real Go declaration tree-sitter parsed).
// Every entry below was read directly from the real checked-out source during this
// plan's own writing (errors.go, stack.go, go113.go; cobra's command.go; chi's
// chain.go, mux.go, chi.go) — not guessed. Re-verify against the actual checkout
// in Step 3 before trusting this list if tree-sitter-go's version ever changes.
const oracles: Record<string, OracleSymbol[]> = {
  "pkg-errors": [
    { name: "New", kind: "function" },
    { name: "Errorf", kind: "function" },
    { name: "fundamental", kind: "class" },
    { name: "Error", kind: "method" },
    { name: "WithStack", kind: "function" },
    { name: "withStack", kind: "class" },
    { name: "Wrap", kind: "function" },
    { name: "Wrapf", kind: "function" },
    { name: "WithMessage", kind: "function" },
    { name: "withMessage", kind: "class" },
    { name: "Cause", kind: "function" },
    { name: "Frame", kind: "type" },
    { name: "StackTrace", kind: "type" },
    { name: "Is", kind: "function" },
    { name: "As", kind: "function" },
    { name: "Unwrap", kind: "function" },
  ],
  cobra: [
    { name: "Group", kind: "class" },
    { name: "Command", kind: "class" },
    { name: "Context", kind: "method" },
    { name: "SetArgs", kind: "method" },
    { name: "SetOut", kind: "method" },
    { name: "SetErr", kind: "method" },
    { name: "SetHelpFunc", kind: "method" },
    { name: "OutOrStdout", kind: "method" },
    { name: "UsageFunc", kind: "method" },
    { name: "FParseErrWhitelist", kind: "type" },
  ],
  chi: [
    { name: "Chain", kind: "function" },
    { name: "Handler", kind: "method" },
    { name: "ChainHandler", kind: "class" },
    { name: "ServeHTTP", kind: "method" },
    { name: "Mux", kind: "class" },
    { name: "NewMux", kind: "function" },
    { name: "Use", kind: "method" },
    { name: "Handle", kind: "method" },
    { name: "Get", kind: "method" },
    { name: "Post", kind: "method" },
    { name: "Router", kind: "interface" },
    { name: "Routes", kind: "interface" },
  ],
};

const results: Record<string, { total: number; found: number; missing: string[] }> = {};

for (const repo of repositories) {
  const root = resolve(process.cwd(), repo.source);
  const index = new ProjectIndex(root);
  index.rebuild();
  const oracle = oracles[repo.id] ?? [];
  const missing: string[] = [];
  let found = 0;
  for (const expected of oracle) {
    const match = index.symbols.some((s) => s.name === expected.name && s.kind === expected.kind);
    if (match) found++;
    else missing.push(`${expected.kind} ${expected.name}`);
  }
  results[repo.id] = { total: oracle.length, found, missing };
  console.log(`${repo.id}: ${found}/${oracle.length} symbols found`);
  if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
}

const outDir = resolve(process.cwd(), "benchmarks/results");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const report = { generatedAt: new Date().toISOString(), results };
writeFileSync(join(outDir, "v1.6-go-support.json"), JSON.stringify(report, null, 2) + "\n");
```

- [ ] **Step 5: Fill in the oracle with real, hand-verified expectations**

For each of the three repos, read 2-3 actual `.go` files from the checkout and add 8-15 entries per repo to the corresponding `oracles[repo.id]` array — real function/method/struct/interface/type/variable names that genuinely exist in that file, covering a mix of kinds (not all functions). Example shape: `{ name: "New", kind: "function" }`, `{ name: "Validate", kind: "method" }`, `{ name: "Command", kind: "class" }` (if `cobra.Command` is a struct — verify by reading the actual source first).

- [ ] **Step 6: Add the npm script**

In `package.json`, add (alongside the existing `benchmark:v11`/`v12`/`v13` entries):

```json
"benchmark:v16": "npm run benchmark:checkouts && tsx benchmarks/v1.6-go-support.ts",
```

- [ ] **Step 7: Run the benchmark and record the result**

Run: `npm run benchmark:v16`

Review the console output and the written `benchmarks/results/v1.6-go-support.json`. If any oracle entry is missing (the adapter failed to find a symbol that genuinely exists), investigate: either the oracle entry is wrong (fix the oracle to match reality) or the adapter has a real bug (fix the adapter, per Tasks 1-2's own global constraints — do not silently drop the oracle entry to make the number look better). This is a first-time benchmark with no prior baseline — the acceptance bar is 100% of the hand-curated oracle entries found, since every entry was verified to exist in the real source before being added.

- [ ] **Step 8: Write a short markdown report**

Create `benchmarks/results/v1.6-go-support.md` summarizing the run: which repos, what scale, the found/total per repo, and a one-paragraph note that this is Phase 1's symbol-extraction-only baseline (no call/import coverage yet — later phases extend this report).

- [ ] **Step 9: Commit**

```bash
git add benchmarks/go-repositories.json benchmarks/v1.6-go-support.ts benchmarks/fetch-checkouts.ts package.json benchmarks/results/v1.6-go-support.json benchmarks/results/v1.6-go-support.md
git commit -m "test(go): add Phase 1 real-repo symbol-extraction benchmark"
```

Do NOT commit `benchmarks/checkouts/pkg-errors`, `benchmarks/checkouts/cobra`, or `benchmarks/checkouts/chi` themselves — check `.gitignore` already excludes `benchmarks/checkouts/` (it does, matching every other language's checkouts); if it somehow doesn't, that is a pre-existing condition to flag, not something to fix silently in this task.

---

### Task 4: Follow-up summary

**Files:**
- Create: `docs/superpowers/plans/2026-10-01-go-support-phase1-symbols-summary.md`

**Interfaces:**
- Consumes: Tasks 1-3's commits and benchmark results.

- [ ] **Step 1: Write the summary document**

```markdown
# Go Language Support Phase 1 Complete: Symbol Extraction

**Spec:** `docs/superpowers/specs/2026-10-01-go-support-phase1-symbols-design.md`
**Plan:** `docs/superpowers/plans/2026-10-01-go-support-phase1-symbols.md`

## What was built

A new Go language adapter (`src/languages/go/`) extracting `SymbolRecord`s
for package-level functions, methods (with same-file receiver-type
linkage via `supertypes`/`parentId`), structs (as kind `"class"`,
including field extraction, with embedded-field name fallback),
interfaces, type aliases, and package-level const/var declarations.
No new `SymbolKind` values were added.

## Test evidence

[Task 1+2 commit hashes, final test count, full-suite pass/fail summary.]

## Real-repo benchmark

Ran against three pinned real Go repositories (`pkg/errors` small,
`spf13/cobra` medium, `go-chi/chi` large) — [oracle found/total per repo
from Task 3's report].

## Roadmap status

Phase 1 of 3-4 complete. Next: Phase 2 (imports and Go's
capitalization-based export visibility).
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-01-go-support-phase1-symbols-summary.md
git commit -m "docs: summarize Go support Phase 1 (symbol extraction)"
```
