import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync as removeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseC } from "../src/languages/c/parse.js";
import { adapterFor } from "../src/languages/adapter.js";
import { ProjectIndex } from "../src/indexer/index.js";
import "../src/languages/c/index.js";

type Files = Record<string, string>;
const openIndexes = new Set<ProjectIndex>();

function rmSync(path: string, options: Parameters<typeof removeSync>[1]) {
  for (const index of openIndexes) {
    if (index.root === path) {
      index.close();
      openIndexes.delete(index);
    }
  }
  removeSync(path, options);
}

function indexedCProject(files: Files): { root: string; index: ProjectIndex } {
  const dir = mkdtempSync(join(tmpdir(), "cs-c-res-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const index = new ProjectIndex(dir);
  index.rebuild();
  openIndexes.add(index);
  return { root: dir, index };
}

test("adapterFor resolves .c to the C adapter, but leaves .h to the cpp adapter", () => {
  assert.equal(adapterFor("foo.c")?.id, "c");
  assert.equal(adapterFor("foo.h")?.id, "cpp");
});

test("typedef struct Tag { ... } Name; produces one 'class' symbol named for the typedef, not the tag", () => {
  const parsed = parseC(
    "point.c",
    `typedef struct Point {\n  int x;\n  int y;\n} Point;\n`,
  );
  const types = parsed.symbols.filter((s) => s.kind === "class");
  assert.equal(types.length, 1);
  assert.equal(types[0].name, "Point");
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(fields.map((f) => f.name).sort(), ["x", "y"]);
});

test("the common tagless typedef struct { ... } Name; form also produces a symbol named for the typedef", () => {
  const parsed = parseC(
    "shape.c",
    `typedef struct {\n  double area;\n} Shape;\n`,
  );
  const type = parsed.symbols.find((s) => s.kind === "class");
  assert.equal(type?.name, "Shape");
});

test("a plain (non-typedef'd) struct keeps its tag name", () => {
  const parsed = parseC("s.c", `struct Shape {\n  double area;\n};\n`);
  const type = parsed.symbols.find((s) => s.kind === "class");
  assert.equal(type?.name, "Shape");
});

test("struct S { ... } g; (type defined and a variable declared together) still produces the struct and its fields", () => {
  const parsed = parseC("s.c", `struct S {\n  int x;\n} g = { 0 };\n`);
  const type = parsed.symbols.find((s) => s.kind === "class");
  assert.equal(type?.name, "S");
  const field = parsed.symbols.find((s) => s.kind === "field");
  assert.equal(field?.name, "x");
  assert.equal(field?.parentId, type?.id);
});

test("a union is a 'class'-kind symbol tagged with the 'union' modifier", () => {
  const parsed = parseC("v.c", `union Value {\n  int i;\n  float f;\n};\n`);
  const type = parsed.symbols.find((s) => s.kind === "class");
  assert.ok(type?.modifiers.includes("union"));
});

test("an anonymous nested union's own members fold into the enclosing struct, not dropped", () => {
  const parsed = parseC(
    "o.c",
    `struct Outer {\n  union {\n    int i;\n    float f;\n  };\n  int tag;\n};\n`,
  );
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  const outer = parsed.symbols.find((s) => s.kind === "class");
  assert.deepEqual(fields.map((f) => f.name).sort(), ["f", "i", "tag"]);
  assert.ok(fields.every((f) => f.parentId === outer?.id));
});

test("an enum's members become 'field' symbols owned by it", () => {
  const parsed = parseC("c.c", `enum Color { RED, GREEN, BLUE };\n`);
  const enumSymbol = parsed.symbols.find((s) => s.kind === "enum");
  const members = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(
    members.map((m) => m.name),
    ["RED", "GREEN", "BLUE"],
  );
  assert.ok(members.every((m) => m.parentId === enumSymbol?.id));
});

test("a struct field declaration with multiple declarators emits one field per name", () => {
  const parsed = parseC("s.c", `struct S {\n  int a, b;\n};\n`);
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(fields.map((f) => f.name).sort(), ["a", "b"]);
});

test("every function is kind 'function' — C has no methods", () => {
  const parsed = parseC(
    "f.c",
    `static int helper(int x) {\n  return x;\n}\nint add(int a, int b) {\n  return helper(a) + b;\n}\n`,
  );
  const fns = parsed.symbols.filter((s) => s.kind === "function");
  assert.deepEqual(fns.map((f) => f.name).sort(), ["add", "helper"]);
  assert.ok(fns.find((f) => f.name === "helper")!.modifiers.includes("static"));
  assert.ok(fns.every((f) => f.parentId === undefined));
});

test('#include <x> and #include "x" both become namespace-wildcard imports', () => {
  const parsed = parseC("f.c", `#include <stdio.h>\n#include "util.h"\n`);
  assert.deepEqual(
    parsed.imports.map((i) => ({
      module: i.module,
      wildcard: i.wildcard ?? false,
    })),
    [
      { module: "stdio.h", wildcard: true },
      { module: "util.h", wildcard: true },
    ],
  );
});

test("a bare call records its argument count and no receiver; a->b() records a receiver", () => {
  const parsed = parseC(
    "f.c",
    `int run(struct S* s) {\n  helper(1, 2);\n  return s->method(3);\n}\n`,
  );
  const bare = parsed.calls.find((c) => c.calleeName === "helper")!;
  assert.equal(bare.receiverText, undefined);
  assert.equal(bare.argumentCount, 2);
  const viaPointer = parsed.calls.find((c) => c.calleeName === "method")!;
  assert.equal(viaPointer.receiverText, "s");
  assert.equal(viaPointer.argumentCount, 1);
});

test("a call to a function pointer field is captured but never resolved — it is runtime dispatch", () => {
  const { root, index } = indexedCProject({
    "f.c": `void dispatch(void (*cb)(int)) {\n  cb(1);\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "cb")!;
  assert.equal(call.resolvedTargetId, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("a call to a uniquely-named function resolves across files", () => {
  const { root, index } = indexedCProject({
    "util.c": `int helper(int x) {\n  return x;\n}\n`,
    "main.c": `int helper(int x);\nint run(void) {\n  return helper(1);\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "helper")!;
  const target = index.symbols.find((s) => s.id === call.resolvedTargetId);
  assert.equal(target?.name, "helper");
  assert.equal(call.resolutionKind, "same-file");
  rmSync(root, { recursive: true, force: true });
});
