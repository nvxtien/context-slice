// tests/rust-use-parser.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseRust } from "../src/languages/rust/parse.js";

test("parses a simple crate-anchored use", () => {
  const { imports } = parseRust(
    "a.rs",
    "use crate::service::create_order;\n",
  );
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
  assert.deepEqual(
    imports.map((i) => i.importedName).sort(),
    ["cancel_order", "create_order"],
  );
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
