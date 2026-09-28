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

test("generic type arguments in extends/implements are stripped to the bare type name, matching the old parser", () => {
  const classSrc = "class Foo extends AbstractFoo<Bar> {}";
  const ifaceSrc = "interface UserRepository extends JpaRepository<User, Long> {}";
  const { symbols: classSyms } = parseJava("Foo.java", classSrc);
  const { symbols: ifaceSyms } = parseJava("R.java", ifaceSrc);
  assert.deepEqual(classSyms.find((s) => s.name === "Foo")!.supertypes, ["AbstractFoo"]);
  assert.deepEqual(ifaceSyms.find((s) => s.name === "UserRepository")!.supertypes, ["JpaRepository"]);
});

test("enum and record kinds are both recognized", () => {
  const source = "enum Status { ACTIVE, INACTIVE }\nrecord Point(int x, int y) {}\n";
  const { symbols } = parseJava("Both.java", source);
  assert.ok(symbols.some((s) => s.kind === "enum" && s.name === "Status"));
  assert.ok(symbols.some((s) => s.kind === "record" && s.name === "Point"));
});
