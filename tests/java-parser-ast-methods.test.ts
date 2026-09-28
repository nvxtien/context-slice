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

test("duplicate top-level types/methods sharing a canonicalIdentity get deterministic dedup id suffixes (types-then-methods-then-constructors global order, matching the old parser's convention)", () => {
  // Two top-level classes both named "Foo" (illegal Java, but the parser doesn't validate) each
  // declaring a same-signature "dup" method: this is the scenario where two symbols in one file
  // can genuinely share a canonicalIdentity, exercising the dedup id-suffix logic.
  const source = "class Foo {\n    void dup() {}\n}\nclass Foo {\n    void dup() {}\n}\n";
  const { symbols } = parseJava("Dup.java", source);
  const types = symbols.filter((s) => s.kind === "class");
  const methods = symbols.filter((s) => s.kind === "method");
  assert.equal(types.length, 2);
  assert.equal(methods.length, 2);
  assert.equal(types[0].id, types[0].canonicalIdentity);
  assert.equal(types[1].id, `${types[1].canonicalIdentity}#2`);
  assert.equal(methods[0].id, methods[0].canonicalIdentity);
  assert.equal(methods[1].id, `${methods[1].canonicalIdentity}#2`);
});
