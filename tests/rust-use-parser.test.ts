// tests/rust-use-parser.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseRust } from "../src/languages/rust/parse.js";

test("parses a simple crate-anchored use", () => {
  const { imports } = parseRust("a.rs", "use crate::service::create_order;\n");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].module, "crate::service");
  assert.equal(imports[0].importedName, "create_order");
  assert.equal(imports[0].localName, "create_order");
  assert.equal(imports[0].wildcard, undefined);
});

test("parses an aliased use", () => {
  const { imports } = parseRust(
    "a.rs",
    "use crate::service::create_order as make_order;\n",
  );
  assert.equal(imports.length, 1);
  assert.equal(imports[0].module, "crate::service");
  assert.equal(imports[0].importedName, "create_order");
  assert.equal(imports[0].localName, "make_order");
});

test("parses a grouped use into one record per item", () => {
  const { imports } = parseRust(
    "a.rs",
    "use crate::service::{create_order, cancel_order};\n",
  );
  assert.equal(imports.length, 2);
  assert.deepEqual(imports.map((i) => i.importedName).sort(), [
    "cancel_order",
    "create_order",
  ]);
  for (const record of imports) assert.equal(record.module, "crate::service");
});

test("parses a wildcard use", () => {
  const { imports } = parseRust("a.rs", "use crate::service::*;\n");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].module, "crate::service");
  assert.equal(imports[0].wildcard, true);
  assert.equal(imports[0].importedName, undefined);
});

test("parses super:: and self:: anchors", () => {
  const { imports: superImports } = parseRust(
    "a.rs",
    "use super::repository::OrderRepository;\n",
  );
  assert.equal(superImports[0].module, "super::repository");
  assert.equal(superImports[0].importedName, "OrderRepository");

  const { imports: selfImports } = parseRust(
    "a.rs",
    "use self::helpers::validate;\n",
  );
  assert.equal(selfImports[0].module, "self::helpers");
  assert.equal(selfImports[0].importedName, "validate");
});

test("a bare single-segment use imports the module/crate name itself", () => {
  const { imports } = parseRust("a.rs", "use serde;\n");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].module, "serde");
  assert.equal(imports[0].importedName, "serde");
});

// --- general use-tree parsing (D2) ---
const shape = (src: string) =>
  parseRust("a.rs", src).imports.map(
    (i) =>
      `${i.module}|${i.importedName ?? ""}|${i.localName ?? ""}|${i.wildcard ? "*" : ""}`,
  );

test("top-level use list becomes one import per leaf", () => {
  assert.deepEqual(shape("use { a::b, c::d };\n"), ["a|b|b|", "c|d|d|"]);
});

test("self in a group imports the module itself", () => {
  assert.deepEqual(shape("use crate::frame::{self, Frame};\n"), [
    "crate|frame|frame|",
    "crate::frame|Frame|Frame|",
  ]);
  assert.deepEqual(shape("use a::{self, b};\n"), ["a|a|a|", "a|b|b|"]);
  assert.deepEqual(shape("use a::{self as x};\n"), ["a|a|x|"]);
});

test("nested groups recurse with the extended prefix", () => {
  assert.deepEqual(shape("use a::{b::{c, d}, e};\n"), [
    "a::b|c|c|",
    "a::b|d|d|",
    "a|e|e|",
  ]);
  assert.deepEqual(shape("use std::{fmt, io::Write};\n"), [
    "std|fmt|fmt|",
    "std::io|Write|Write|",
  ]);
});

test("wildcards inside groups", () => {
  assert.deepEqual(shape("use a::{b::*, c};\n"), ["a::b|||*", "a|c|c|"]);
  assert.deepEqual(shape("use a::{*};\n"), ["a|||*"]);
});

test("aliased paths, self:: anchor, leading ::", () => {
  assert.deepEqual(shape("use a::b as c;\n"), ["a|b|c|"]);
  assert.deepEqual(shape("use self::x;\n"), ["self|x|x|"]);
  assert.deepEqual(shape("use ::std::x;\n"), ["std|x|x|"]);
  assert.deepEqual(shape("use crate::{a, super::b};\n"), [
    "crate|a|a|",
    "crate::super|b|b|",
  ]);
});

test("degenerate shapes emit nothing", () => {
  assert.deepEqual(shape("use *;\n"), []);
  assert.deepEqual(shape("use {self};\n"), []);
});

test("pub use of nested / self / wildcard groups yields matching exports", () => {
  const { exports } = parseRust(
    "a.rs",
    "pub use a::{self, b::{c as d, *}, e::f};\n",
  );
  assert.deepEqual(
    exports.map(
      (e) =>
        `${e.fromModule}|${e.sourceName ?? ""}|${e.exportedName}|${e.wildcard ? "*" : ""}`,
    ),
    ["a|a|a|", "a::b|c|d|", "a::b|||*", "a::e|f|f|"],
  );
});
