import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";

test("a single annotated field is extracted as a field symbol, source includes its annotation", () => {
  const source = "class Foo {\n    @Autowired\n    private UserRepository userRepository;\n}";
  const { symbols } = parseJava("Foo.java", source);
  const foo = symbols.find((s) => s.kind === "class" && s.name === "Foo")!;
  const field = symbols.find((s) => s.kind === "field")!;
  assert.equal(field.name, "userRepository");
  assert.equal(field.metadata?.declaredType, "UserRepository");
  assert.equal(field.signature, "userRepository: UserRepository");
  assert.deepEqual(field.annotations, ["@Autowired"]);
  assert.deepEqual(field.modifiers, ["private"]);
  assert.equal(field.parentId, foo.id);
  assert.equal(field.bodyRange, undefined);
  assert.equal(field.body, undefined);
  assert.ok(field.source.includes("@Autowired"), "single-declarator field source must include its own annotation");
  assert.ok(field.source.includes("userRepository"));
});

test("a field's source exactly matches its own range slice (the codebase-wide range==source invariant)", () => {
  const source = "class Foo {\n    @Autowired\n    private UserRepository userRepository;\n}";
  const { symbols } = parseJava("Foo.java", source);
  const field = symbols.find((s) => s.kind === "field")!;
  const lines = source.split("\n");
  const startOffset = lines.slice(0, field.range.startLine - 1).reduce((n, l) => n + l.length + 1, 0) + field.range.startColumn;
  const endOffset = lines.slice(0, field.range.endLine - 1).reduce((n, l) => n + l.length + 1, 0) + field.range.endColumn;
  assert.equal(field.source, source.slice(startOffset, endOffset));
});

test("multi-declarator fields produce two distinct, non-overlapping symbols sharing type and modifiers", () => {
  const source = "class Foo {\n    private int a, b = 2;\n}";
  const { symbols } = parseJava("Foo.java", source);
  const fields = symbols.filter((s) => s.kind === "field");
  assert.equal(fields.length, 2);
  const [a, b] = fields;
  assert.equal(a.name, "a");
  assert.equal(b.name, "b");
  assert.equal(a.metadata?.declaredType, "int");
  assert.equal(b.metadata?.declaredType, "int");
  assert.deepEqual(a.modifiers, ["private"]);
  assert.deepEqual(b.modifiers, ["private"]);
  assert.equal(a.source, "a");
  assert.equal(b.source, "b = 2");
  const aEndsBeforeBStarts =
    a.range.endLine < b.range.startLine ||
    (a.range.endLine === b.range.startLine && a.range.endColumn <= b.range.startColumn);
  assert.ok(aEndsBeforeBStarts, "the two declarators' ranges must not overlap");
});

test("a generic field type is kept whole in metadata.declaredType, not stripped", () => {
  const source = 'class Foo {\n    @Column(name = "x")\n    List<Pet> pets;\n}';
  const { symbols } = parseJava("Foo.java", source);
  const field = symbols.find((s) => s.kind === "field")!;
  assert.equal(field.metadata?.declaredType, "List<Pet>");
});

test("an interface constant is extracted as a field symbol despite using a different AST node type", () => {
  const source = "interface I {\n    int X = 1;\n}";
  const { symbols } = parseJava("I.java", source);
  const iface = symbols.find((s) => s.kind === "interface")!;
  const field = symbols.find((s) => s.kind === "field")!;
  assert.equal(field.name, "X");
  assert.equal(field.metadata?.declaredType, "int");
  assert.equal(field.parentId, iface.id);
});

test("an enum's own field (declared after its constants) is extracted", () => {
  const source = "enum Status {\n    ACTIVE, INACTIVE;\n    private final String label;\n}";
  const { symbols } = parseJava("Status.java", source);
  const en = symbols.find((s) => s.kind === "enum")!;
  const field = symbols.find((s) => s.kind === "field")!;
  assert.equal(field.name, "label");
  assert.equal(field.metadata?.declaredType, "String");
  assert.equal(field.parentId, en.id);
});

test("a record's real explicit field is extracted, but its canonical components are not", () => {
  const source = "record R(int x, String y) {\n    private static int counter;\n}";
  const { symbols } = parseJava("R.java", source);
  const fields = symbols.filter((s) => s.kind === "field");
  assert.equal(fields.length, 1, "only the real explicit field, never x/y from the record header");
  assert.equal(fields[0].name, "counter");
});

test("a local variable inside a method body is never extracted as a field", () => {
  const source = "class Foo {\n    void m() {\n        int local = 1;\n    }\n}";
  const { symbols } = parseJava("Foo.java", source);
  assert.equal(symbols.filter((s) => s.kind === "field").length, 0);
});

test("a multi-line annotation argument on a field is not lost (the same bug class the parent AST rewrite fixed for types/methods)", () => {
  const source = [
    "class Foo {",
    "    @SuppressWarnings(",
    '        value = "unchecked"',
    "    )",
    "    private Object raw;",
    "}",
  ].join("\n");
  const { symbols } = parseJava("Foo.java", source);
  const field = symbols.find((s) => s.kind === "field")!;
  assert.deepEqual(field.annotations, ["@SuppressWarnings"]);
  assert.ok(field.source.includes("value"), "the whole multi-line annotation argument must be in the field's own source");
});
