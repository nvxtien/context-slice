import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";

test("recognizes interface, record, enum, nested class, and unresolved call", () => {
  const source = `interface Gateway { void send(String value); }\nabstract class Base { abstract void run(); }\nclass Outer { static class Inner { void run() { unknown.call(); } } }\nrecord Event(String id) {}\nenum Status { NEW, DONE }`;
  const parsed = parseJava("Hardening.java", source);
  assert.ok(parsed.symbols.some((symbol) => symbol.kind === "interface"));
  assert.ok(
    parsed.symbols.some(
      (symbol) => symbol.kind === "class" && symbol.name === "Inner",
    ),
  );
  assert.ok(parsed.symbols.some((symbol) => symbol.kind === "record"));
  assert.ok(parsed.symbols.some((symbol) => symbol.kind === "enum"));
  assert.ok(
    parsed.calls.some(
      (call) => call.calleeName === "call" && call.confidence === "unresolved",
    ),
  );
});

test("does not pick exact match when multiple methods share a name", () => {
  const parsed = parseJava(
    "Ambiguous.java",
    `class A { void save() {} } class B { void save() {} } class C { void run() { save(); } }`,
  );
  const call = parsed.calls.find((item) => item.calleeName === "save");
  assert.equal(call?.confidence, "unresolved");
});
