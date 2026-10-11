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
import { parseKotlin } from "../src/languages/kotlin/parse.js";
import { adapterFor } from "../src/languages/adapter.js";
import { ProjectIndex } from "../src/indexer/index.js";
import "../src/languages/kotlin/index.js";

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

function indexedKotlinProject(files: Files): {
  root: string;
  index: ProjectIndex;
} {
  const dir = mkdtempSync(join(tmpdir(), "cs-kotlin-res-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const index = new ProjectIndex(dir);
  index.rebuild();
  openIndexes.add(index);
  return { root: dir, index };
}

test("adapterFor resolves .kt and .kts to the Kotlin adapter", () => {
  assert.equal(adapterFor("Foo.kt")?.id, "kotlin");
  assert.equal(adapterFor("build.gradle.kts")?.id, "kotlin");
});

test("an interface produces an 'interface' symbol with its method as a member", () => {
  const parsed = parseKotlin(
    "Greeter.kt",
    `interface Greeter {\n    fun greet(name: String): String\n}\n`,
  );
  const iface = parsed.symbols.find((s) => s.kind === "interface");
  assert.equal(iface?.name, "Greeter");
  const method = parsed.symbols.find((s) => s.kind === "method");
  assert.equal(method?.name, "greet");
  assert.equal(method?.parentId, iface?.id);
});

test("a data class's primary-constructor val/var parameters become fields; a plain parameter does not", () => {
  const parsed = parseKotlin(
    "Counter.kt",
    `data class Counter(private val id: Int, var count: Int, label: String)\n`,
  );
  const cls = parsed.symbols.find((s) => s.kind === "class")!;
  assert.ok(cls.modifiers.includes("data"));
  const fields = parsed.symbols.filter((s) => s.kind === "field");
  assert.deepEqual(fields.map((f) => f.name).sort(), ["count", "id"]);
  assert.ok(fields.find((f) => f.name === "id")!.modifiers.includes("private"));
});

test("a nested class's qualifiedName is prefixed with its owner, two levels deep", () => {
  const parsed = parseKotlin(
    "Outer.kt",
    `class Outer {\n    class Inner {\n        fun deep() {}\n        class Innermost\n    }\n}\n`,
  );
  const inner = parsed.symbols.find((s) => s.name === "Inner")!;
  assert.equal(inner.qualifiedName, "Outer.Inner");
  const deep = parsed.symbols.find((s) => s.name === "deep")!;
  assert.equal(deep.qualifiedName, "Outer.Inner.deep");
  const innermost = parsed.symbols.find((s) => s.name === "Innermost")!;
  assert.equal(innermost.qualifiedName, "Outer.Inner.Innermost");
});

test("an object declaration is a 'class' symbol modified 'object'", () => {
  const parsed = parseKotlin(
    "Singleton.kt",
    `object Singleton {\n    fun foo() {}\n}\n`,
  );
  const obj = parsed.symbols.find((s) => s.kind === "class")!;
  assert.ok(obj.modifiers.includes("object"));
});

test("a class's delegation specifier is recorded as a supertype", () => {
  const parsed = parseKotlin(
    "Derived.kt",
    `interface Greeter\nclass Derived : Greeter {\n    fun greet() {}\n}\n`,
  );
  const derived = parsed.symbols.find((s) => s.name === "Derived")!;
  assert.deepEqual(derived.supertypes, ["Greeter"]);
});

test("imports: a named import, a wildcard import, and an aliased import", () => {
  const parsed = parseKotlin(
    "Imports.kt",
    `import kotlin.math.max\nimport java.util.*\nimport kotlin.math.min as smallest\n`,
  );
  assert.deepEqual(
    parsed.imports.map((i) => ({
      module: i.module,
      wildcard: i.wildcard ?? false,
      localName: i.localName,
    })),
    [
      { module: "kotlin.math.max", wildcard: false, localName: "max" },
      { module: "java.util", wildcard: true, localName: undefined },
      { module: "kotlin.math.min", wildcard: false, localName: "smallest" },
    ],
  );
});

test("a call inside an init block is captured, not silently dropped", () => {
  const parsed = parseKotlin(
    "C.kt",
    `class C {\n    init {\n        setup()\n    }\n}\n`,
  );
  const call = parsed.calls.find((c) => c.calleeName === "setup");
  assert.ok(call, "expected a call edge for setup() inside the init block");
  const owner = parsed.symbols.find((s) => s.id === call!.callerId);
  assert.equal(owner?.kind, "constructor");
  assert.equal(
    owner?.parentId,
    parsed.symbols.find((s) => s.kind === "class")!.id,
  );
});

test("`fun interface` (SAM interface) is a known tree-sitter-kotlin grammar gap: reported as a parse error, not silently misread", () => {
  const parsed = parseKotlin(
    "Callback.kt",
    `fun interface Callback {\n    fun onDone()\n}\n`,
  );
  assert.equal(parsed.parseError, true);
});

test("a method call records its receiver and argument count; a bare call has no receiver", () => {
  const parsed = parseKotlin(
    "Call.kt",
    `class C {\n    fun run() {\n        helper(1, 2)\n        obj.method(3)\n    }\n}\n`,
  );
  const bare = parsed.calls.find((c) => c.calleeName === "helper")!;
  assert.equal(bare.receiverText, undefined);
  assert.equal(bare.argumentCount, 2);
  const withReceiver = parsed.calls.find((c) => c.calleeName === "method")!;
  assert.equal(withReceiver.receiverText, "obj");
  assert.equal(withReceiver.argumentCount, 1);
});

test("a call to a top-level function resolves, unlike a method/constructor-only resolver", () => {
  const { root, index } = indexedKotlinProject({
    "Util.kt": `fun add(a: Int, b: Int): Int = a + b\n`,
    "Main.kt": `fun main() {\n    add(1, 2)\n}\n`,
  });
  const callee = index.symbols.find(
    (s) => s.kind === "function" && s.name === "add",
  )!;
  const call = index.calls.find((c) => c.calleeName === "add")!;
  assert.equal(call.resolvedTargetId, callee.id);
  assert.equal(call.resolutionKind, "same-file");
  rmSync(root, { recursive: true, force: true });
});

test("a method inherited from a supertype resolves across files", () => {
  const { root, index } = indexedKotlinProject({
    "Base.kt": `open class Base {\n    fun foo() {}\n}\n`,
    "Derived.kt": `class Derived : Base() {\n    fun bar() {\n        foo()\n    }\n}\n`,
  });
  const call = index.calls.find((c) => c.calleeName === "foo")!;
  const target = index.symbols.find((s) => s.id === call.resolvedTargetId);
  assert.equal(target?.name, "foo");
  assert.equal(call.resolutionKind, "inherited");
  rmSync(root, { recursive: true, force: true });
});
