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
import { parseCpp } from "../src/languages/cpp/parse.js";
import { adapterFor } from "../src/languages/adapter.js";
import { ProjectIndex } from "../src/indexer/index.js";
import "../src/languages/cpp/index.js";

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

function indexedCppProject(files: Files): {
  root: string;
  index: ProjectIndex;
} {
  const dir = mkdtempSync(join(tmpdir(), "cs-cpp-res-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const index = new ProjectIndex(dir);
  index.rebuild();
  openIndexes.add(index);
  return { root: dir, index };
}

test("adapterFor resolves .cpp, .h, and .hpp to the C++ adapter", () => {
  assert.equal(adapterFor("foo.cpp")?.id, "cpp");
  assert.equal(adapterFor("foo.h")?.id, "cpp");
  assert.equal(adapterFor("foo.hpp")?.id, "cpp");
});

test("a class's base_class_clause with multiple bases is recorded as supertypes", () => {
  const parsed = parseCpp(
    "d.h",
    `class Base {};\nclass Mid {};\nclass Derived : public Base, public Mid {};\n`,
  );
  const derived = parsed.symbols.find((s) => s.name === "Derived");
  assert.deepEqual(derived?.supertypes, ["Base", "Mid"]);
});

test("struct S { ... } g; (type defined and a variable declared together) still produces the struct and its fields", () => {
  const parsed = parseCpp("s.h", `struct S {\n  int x;\n} g;\n`);
  const type = parsed.symbols.find((s) => s.kind === "class");
  assert.equal(type?.name, "S");
  const field = parsed.symbols.find((s) => s.kind === "field");
  assert.equal(field?.name, "x");
  assert.equal(field?.parentId, type?.id);
});

test("the same struct+variable pattern inside a namespace still gets the namespace as packageName", () => {
  const parsed = parseCpp(
    "s.h",
    `namespace N {\n  struct S {\n    int x;\n  } g;\n}\n`,
  );
  const type = parsed.symbols.find((s) => s.kind === "class");
  assert.equal(type?.packageName, "N");
});

test("a class defaults members to private visibility; a struct defaults to public", () => {
  const parsed = parseCpp("s.h", `class C { int a; };\nstruct S { int b; };\n`);
  const a = parsed.symbols.find((s) => s.name === "a");
  const b = parsed.symbols.find((s) => s.name === "b");
  assert.ok(a?.modifiers.includes("private"));
  assert.ok(b?.modifiers.includes("public"));
});

test("a union is a 'class'-kind symbol tagged with the 'union' modifier, members default to public", () => {
  const parsed = parseCpp("v.h", `union Value {\n  int i;\n  float f;\n};\n`);
  const type = parsed.symbols.find((s) => s.kind === "class");
  assert.ok(type?.modifiers.includes("union"));
  const i = parsed.symbols.find((s) => s.name === "i");
  assert.ok(i?.modifiers.includes("public"));
});

test("an anonymous nested union's own members fold into the enclosing class, not dropped", () => {
  const parsed = parseCpp(
    "o.h",
    `class Outer {\n public:\n  union {\n    int i;\n    float f;\n  };\n private:\n  int tag;\n};\n`,
  );
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  const outer = parsed.symbols.find((s) => s.kind === "class");
  assert.deepEqual(fields.map((f) => f.name).sort(), ["f", "i", "tag"]);
  assert.ok(fields.every((f) => f.parentId === outer?.id));
  assert.ok(fields.find((f) => f.name === "i")!.modifiers.includes("public"));
  assert.ok(
    fields.find((f) => f.name === "tag")!.modifiers.includes("private"),
  );
});

test("an access_specifier switches visibility for every member after it, not just the next one", () => {
  const parsed = parseCpp(
    "c.h",
    `class C {\n public:\n  int a;\n  int b;\n private:\n  int c;\n};\n`,
  );
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(
    fields.map((f) => [
      f.name,
      f.modifiers.includes("public") ? "public" : "private",
    ]),
    [
      ["a", "public"],
      ["b", "public"],
      ["c", "private"],
    ],
  );
});

test("a field_declaration with multiple declarators emits one field per name", () => {
  const parsed = parseCpp("c.h", `class C { int a, b; };\n`);
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(fields.map((f) => f.name).sort(), ["a", "b"]);
});

test("a pointer-returning method prototype is still recognized as a method, not a field", () => {
  const parsed = parseCpp("c.h", `class C { public: int* Foo(); };\n`);
  const method = parsed.symbols.find((s) => s.name === "Foo");
  assert.equal(method?.kind, "method");
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  assert.equal(fields.length, 0);
});

test("a destructor is a 'constructor'-kind symbol tagged with the 'destructor' modifier", () => {
  const parsed = parseCpp("c.h", `class C { public: ~C(); };\n`);
  const dtor = parsed.symbols.find((s) => s.kind === "constructor");
  assert.equal(dtor?.name, "C");
  assert.ok(dtor?.modifiers.includes("destructor"));
});

test("template type parameters are dropped; the templated class/method still produce symbols", () => {
  const parsed = parseCpp(
    "box.h",
    `template<typename T>\nclass Box {\n public:\n  Box(T v) : value_(v) {}\n  T Get() const { return value_; }\n private:\n  T value_;\n};\n`,
  );
  assert.equal(parsed.symbols.find((s) => s.kind === "class")?.name, "Box");
  assert.equal(parsed.symbols.find((s) => s.name === "Get")?.kind, "method");
  assert.equal(parsed.symbols.find((s) => s.name === "value_")?.kind, "field");
});

test("an enum's members become 'field' symbols owned by it", () => {
  const parsed = parseCpp(
    "color.h",
    `enum class Color { Red, Green, Blue };\n`,
  );
  const enumSymbol = parsed.symbols.find((s) => s.kind === "enum");
  const members = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(
    members.map((m) => m.name),
    ["Red", "Green", "Blue"],
  );
  assert.ok(members.every((m) => m.parentId === enumSymbol?.id));
});

test("a method defined out-of-class (Class::Method) has no parentId but the right qualifiedName", () => {
  const parsed = parseCpp(
    "greeter.cpp",
    `std::string Greeter::Greet(const std::string& name) {\n  return name;\n}\n`,
  );
  const method = parsed.symbols.find((s) => s.name === "Greet");
  assert.equal(method?.kind, "method");
  assert.equal(method?.qualifiedName, "Greeter.Greet");
  assert.equal(method?.parentId, undefined);
});

test("a namespace-qualified out-of-class constructor (Ns::Class::Class) keeps only the class as owner", () => {
  const parsed = parseCpp(
    "greeter.cpp",
    `acme::Greeter::Greeter(int start) {}\n`,
  );
  const ctor = parsed.symbols.find((s) => s.kind === "constructor");
  assert.equal(ctor?.name, "Greeter");
  assert.equal(ctor?.qualifiedName, "Greeter.Greeter");
});

test('#include <x> and #include "x" both become namespace-wildcard imports; using X::Y is a named import', () => {
  const parsed = parseCpp(
    "f.cpp",
    `#include <iostream>\n#include "greeter.h"\nusing std::cout;\n`,
  );
  assert.deepEqual(
    parsed.imports.map((i) => ({
      module: i.module,
      wildcard: i.wildcard ?? false,
      localName: i.localName,
    })),
    [
      { module: "iostream", wildcard: true, localName: undefined },
      { module: "greeter.h", wildcard: true, localName: undefined },
      { module: "std", wildcard: false, localName: "cout" },
    ],
  );
});

test("a method call records its receiver and argument count; this->Foo() and a->Foo() both carry a receiver", () => {
  const parsed = parseCpp(
    "c.cpp",
    `class C {\n void Run() {\n  Helper(1, 2);\n  this->Bar();\n  obj->Baz(3);\n }\n};\n`,
  );
  const bare = parsed.calls.find((c) => c.calleeName === "Helper")!;
  assert.equal(bare.receiverText, undefined);
  assert.equal(bare.argumentCount, 2);
  const viaThis = parsed.calls.find((c) => c.calleeName === "Bar")!;
  assert.equal(viaThis.receiverText, "this");
  const viaPointer = parsed.calls.find((c) => c.calleeName === "Baz")!;
  assert.equal(viaPointer.receiverText, "obj");
  assert.equal(viaPointer.argumentCount, 1);
});

test("a call to a method only defined out-of-class (header prototype + .cpp definition) resolves same-type, not ambiguous", () => {
  const { root, index } = indexedCppProject({
    "greeter.h": `class Greeter {\n public:\n  void Run();\n private:\n  void Helper();\n};\n`,
    "greeter.cpp": `void Greeter::Run() { Helper(); }\nvoid Greeter::Helper() {}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Helper")!;
  assert.equal(call.resolutionKind, "same-type");
  assert.ok(call.resolvedTargetId);
  rmSync(root, { recursive: true, force: true });
});

test("a method inherited from a base class resolves across files", () => {
  const { root, index } = indexedCppProject({
    "base.h": `class Base {\n public:\n  void Foo() {}\n};\n`,
    "derived.h": `#include "base.h"\nclass Derived : public Base {\n public:\n  void Bar() { Foo(); }\n};\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Foo")!;
  const target = index.symbols.find((s) => s.id === call.resolvedTargetId);
  assert.equal(target?.name, "Foo");
  assert.equal(call.resolutionKind, "inherited");
  rmSync(root, { recursive: true, force: true });
});

test("a function behind a macro-guarded #ifndef/#endif block is still indexed", () => {
  // The common versioned-namespace idiom (`FMT_BEGIN_NAMESPACE` expanding to `namespace fmt {
  // ...`) wraps a whole header's content this way: the macro's own #ifndef guard, not a real
  // `namespace` keyword, is what the grammar sees at that point in the file.
  const { root, index } = indexedCppProject({
    "guarded.h": `#ifndef FMT_BEGIN_NAMESPACE\n#define FMT_BEGIN_NAMESPACE namespace fmt {\nFMT_BEGIN_NAMESPACE\nint guarded_function() { return 1; }\n}\n#endif\n`,
  });
  assert.ok(index.symbols.some((s) => s.name === "guarded_function"));
  rmSync(root, { recursive: true, force: true });
});

test("a class member behind #ifdef/#else is still indexed on both branches", () => {
  const { root, index } = indexedCppProject({
    "platform.h": `class Platform {\n public:\n#ifdef _WIN32\n  void WindowsOnly() {}\n#else\n  void PosixOnly() {}\n#endif\n};\n`,
  });
  const names = index.symbols
    .filter((s) => s.qualifiedName?.startsWith("Platform."))
    .map((s) => s.name);
  assert.ok(names.includes("WindowsOnly"));
  assert.ok(names.includes("PosixOnly"));
  rmSync(root, { recursive: true, force: true });
});
