import assert from "node:assert/strict";
import test from "node:test";
import { parseRust } from "../src/languages/rust/parse.js";

test("a file with top-level use declarations gets a synthetic import symbol", () => {
  const source = [
    "use std::fs;",
    "use crate::util::helper;",
    "",
    "pub fn run() {",
    '    fs::read_to_string("x").ok();',
    "}",
  ].join("\n");
  const parsed = parseRust("src/lib.rs", source);
  const moduleSymbol = parsed.symbols.find(
    (s) => s.kind === "namespace" && s.metadata?.moduleScope === true,
  );
  assert.ok(moduleSymbol, "expected a synthetic module/import symbol");
  assert.equal(moduleSymbol!.filePath, "src/lib.rs");
  assert.equal(moduleSymbol!.id, "src/lib.rs::module::src/lib.rs");
  assert.match(moduleSymbol!.source, /use std::fs;/);
  assert.match(moduleSymbol!.source, /use crate::util::helper;/);
  // The real function symbol must be unaffected and still present.
  assert.ok(
    parsed.symbols.some((s) => s.kind === "function" && s.name === "run"),
  );
});

test("a file with no top-level use declarations gets no synthetic symbol", () => {
  const source = 'pub fn main() {\n    println!("hi");\n}\n';
  const parsed = parseRust("src/main.rs", source);
  assert.equal(
    parsed.symbols.some(
      (s) => s.kind === "namespace" && s.metadata?.moduleScope === true,
    ),
    false,
  );
});

test("a use declaration inside a nested inline mod is not pulled into the file-level symbol", () => {
  const source = [
    "use std::fs;",
    "",
    "mod inner {",
    "    use std::io;",
    "    pub fn f() {}",
    "}",
  ].join("\n");
  const parsed = parseRust("src/lib.rs", source);
  const moduleSymbol = parsed.symbols.find(
    (s) => s.kind === "namespace" && s.metadata?.moduleScope === true,
  );
  assert.ok(moduleSymbol);
  assert.match(moduleSymbol!.source, /use std::fs;/);
  assert.doesNotMatch(moduleSymbol!.source, /use std::io;/);
});
