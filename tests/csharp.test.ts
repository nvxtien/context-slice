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
import { parseCsharp } from "../src/languages/csharp/parse.js";
import { adapterFor } from "../src/languages/adapter.js";
import { ProjectIndex } from "../src/indexer/index.js";
import "../src/languages/csharp/index.js";

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

function indexedCsharpProject(files: Files): {
  root: string;
  index: ProjectIndex;
} {
  const dir = mkdtempSync(join(tmpdir(), "cs-csharp-res-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const index = new ProjectIndex(dir);
  index.rebuild();
  openIndexes.add(index);
  return { root: dir, index };
}

test("adapterFor resolves .cs to the C# adapter", () => {
  assert.equal(adapterFor("Foo.cs")?.id, "csharp");
});

test("an interface produces an 'interface' symbol with its method as a member", () => {
  const parsed = parseCsharp(
    "IGreeter.cs",
    `public interface IGreeter {\n    string Greet(string name);\n}\n`,
  );
  const iface = parsed.symbols.find((s) => s.kind === "interface");
  assert.equal(iface?.name, "IGreeter");
  const method = parsed.symbols.find((s) => s.kind === "method");
  assert.equal(method?.name, "Greet");
  assert.equal(method?.parentId, iface?.id);
  assert.equal(method?.body, undefined, "an interface method has no body");
});

test("a class's base_list entry is recorded as a supertype", () => {
  const parsed = parseCsharp(
    "Derived.cs",
    `public interface IGreeter {}\npublic class Derived : IGreeter {\n    public void Greet() {}\n}\n`,
  );
  const derived = parsed.symbols.find((s) => s.name === "Derived");
  assert.deepEqual(derived?.supertypes, ["IGreeter"]);
});

test("a record's primary-constructor base call (`: Base(x)`) is recorded as a supertype", () => {
  const parsed = parseCsharp(
    "Point.cs",
    `public record Base(int X);\npublic record Point(int X, int Y) : Base(X);\n`,
  );
  const point = parsed.symbols.find((s) => s.name === "Point");
  assert.deepEqual(point?.supertypes, ["Base"]);
});

test("a nested class's qualifiedName is prefixed with its owner, two levels deep", () => {
  const parsed = parseCsharp(
    "Outer.cs",
    `public class Outer {\n    public class Inner {\n        public void Deep() {}\n        public class Innermost {}\n    }\n}\n`,
  );
  const inner = parsed.symbols.find((s) => s.name === "Inner");
  assert.equal(inner?.qualifiedName, "Outer.Inner");
  const deep = parsed.symbols.find((s) => s.name === "Deep");
  assert.equal(deep?.qualifiedName, "Outer.Inner.Deep");
  const innermost = parsed.symbols.find((s) => s.name === "Innermost");
  assert.equal(innermost?.qualifiedName, "Outer.Inner.Innermost");
});

test("a record's primary-constructor parameters become 'property' members", () => {
  const parsed = parseCsharp(
    "Point.cs",
    `public record Point(int X, int Y);\n`,
  );
  const record = parsed.symbols.find((s) => s.kind === "record");
  assert.equal(record?.name, "Point");
  const props = parsed.symbols.filter((s) => s.kind === "property");
  assert.deepEqual(props.map((p) => p.name).sort(), ["X", "Y"]);
  assert.equal(props[0].parentId, record?.id);
});

test("a field declaration with multiple declarators emits one symbol per name", () => {
  const parsed = parseCsharp(
    "C.cs",
    `public class C {\n    private int a, b;\n}\n`,
  );
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(fields.map((f) => f.name).sort(), ["a", "b"]);
  assert.ok(fields.every((f) => f.modifiers.includes("private")));
});

test("an enum's members become 'field' symbols owned by it", () => {
  const parsed = parseCsharp(
    "Color.cs",
    `public enum Color { Red, Green, Blue }\n`,
  );
  const enumSymbol = parsed.symbols.find((s) => s.kind === "enum");
  const members = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(
    members.map((m) => m.name),
    ["Red", "Green", "Blue"],
  );
  assert.ok(members.every((m) => m.parentId === enumSymbol?.id));
});

test("a call inside an expression-bodied property is captured, not silently dropped", () => {
  const parsed = parseCsharp(
    "C.cs",
    `public class C {\n    public int Value => Compute();\n}\n`,
  );
  const call = parsed.calls.find((c) => c.calleeName === "Compute");
  assert.ok(call, "expected a call edge for Compute() inside the arrow body");
  const owner = parsed.symbols.find((s) => s.id === call!.callerId);
  assert.equal(owner?.kind, "property");
});

test("a call inside a get/set accessor body is captured", () => {
  const parsed = parseCsharp(
    "C.cs",
    `public class C {\n    private int x;\n    public int Prop {\n        get => Read();\n        set { Write(value); }\n    }\n}\n`,
  );
  assert.ok(parsed.calls.find((c) => c.calleeName === "Read"));
  assert.ok(parsed.calls.find((c) => c.calleeName === "Write"));
});

test("imports: a plain using, a using-static, and an aliased using", () => {
  const parsed = parseCsharp(
    "Imports.cs",
    `using System;\nusing static System.Math;\nusing Json = System.Text.Json;\n`,
  );
  assert.deepEqual(
    parsed.imports.map((i) => ({
      module: i.module,
      wildcard: i.wildcard ?? false,
      localName: i.localName,
    })),
    [
      { module: "System", wildcard: true, localName: undefined },
      { module: "System.Math", wildcard: true, localName: undefined },
      { module: "System.Text.Json", wildcard: false, localName: "Json" },
    ],
  );
});

test("a method call records its receiver and argument count; a bare call has no receiver", () => {
  const parsed = parseCsharp(
    "Call.cs",
    `public class C {\n    public void Run() {\n        Helper(1, 2);\n        obj.Method(3);\n    }\n}\n`,
  );
  const bare = parsed.calls.find((c) => c.calleeName === "Helper")!;
  assert.equal(bare.receiverText, undefined);
  assert.equal(bare.argumentCount, 2);
  const withReceiver = parsed.calls.find((c) => c.calleeName === "Method")!;
  assert.equal(withReceiver.receiverText, "obj");
  assert.equal(withReceiver.argumentCount, 1);
});

test("a null-conditional call (obj?.Method()) is captured with its receiver", () => {
  const parsed = parseCsharp(
    "Call.cs",
    `public class C {\n    public void Run() {\n        obj?.Method(1);\n    }\n}\n`,
  );
  const call = parsed.calls.find((c) => c.calleeName === "Method")!;
  assert.equal(call.receiverText, "obj");
});

test("a this.Method() call resolves within the same type", () => {
  const { root, index } = indexedCsharpProject({
    "C.cs": `public class C {\n    public void Run() {\n        this.Foo();\n    }\n    public void Foo() {}\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Foo")!;
  assert.equal(call.resolutionKind, "same-type");
  rmSync(root, { recursive: true, force: true });
});

test("a method inherited from a base class resolves across files", () => {
  const { root, index } = indexedCsharpProject({
    "Base.cs": `public class Base {\n    public void Foo() {}\n}\n`,
    "Derived.cs": `public class Derived : Base {\n    public void Bar() {\n        Foo();\n    }\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Foo")!;
  const target = index.symbols.find((s) => s.id === call.resolvedTargetId);
  assert.equal(target?.name, "Foo");
  assert.equal(call.resolutionKind, "inherited");
  rmSync(root, { recursive: true, force: true });
});

test("an overloaded method call resolves to the overload matching the call site's argument count", () => {
  const { root, index } = indexedCsharpProject({
    "C.cs": `public class C {\n    public void Run() {\n        Write(1);\n    }\n    public void Write(int a) {}\n    public void Write(int a, int b) {}\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Write")!;
  const target = index.symbols.find((s) => s.id === call.resolvedTargetId);
  assert.ok(target?.signature?.includes("Write(int a)"));
  assert.equal(call.confidence, "exact");
  rmSync(root, { recursive: true, force: true });
});

test("a call that still matches 2+ overloads by argument count stays unresolved", () => {
  const { root, index } = indexedCsharpProject({
    "C.cs": `public class C {\n    public void Run() {\n        Write(1, 2);\n    }\n    public void Write(int a, int b) {}\n    public void Write(string a, string b) {}\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "Write")!;
  assert.equal(call.confidence, "unresolved");
  rmSync(root, { recursive: true, force: true });
});

test("a top-level statement file (C# 9+ minimal Program.cs) has its calls captured, not silently dropped", () => {
  const parsed = parseCsharp(
    "Program.cs",
    `var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\napp.MapGet("/", () => "Hello World!");\napp.Run();\n`,
  );
  assert.equal(parsed.parseError, false);
  const calleeNames = parsed.calls.map((c) => c.calleeName).sort();
  assert.deepEqual(calleeNames, ["Build", "CreateBuilder", "MapGet", "Run"]);
  const owner = parsed.symbols.find((s) => s.metadata?.moduleScope === true);
  assert.ok(owner, "expected a synthetic module-scope owner symbol");
  assert.ok(
    parsed.calls.every((c) => c.callerId === owner!.id),
    "every top-level call should be owned by the synthetic module-scope symbol",
  );
});
