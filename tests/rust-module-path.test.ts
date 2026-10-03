import assert from "node:assert/strict";
import test from "node:test";
import { modulePathFor } from "../src/languages/rust/parse.js";

test("crate root files (lib.rs, main.rs) map to the empty module path", () => {
  assert.deepEqual(modulePathFor("src/lib.rs"), []);
  assert.deepEqual(modulePathFor("src/main.rs"), []);
});

test("a top-level file module maps to its own name", () => {
  assert.deepEqual(modulePathFor("src/service.rs"), ["service"]);
});

test("a directory module (mod.rs) maps to its directory name", () => {
  assert.deepEqual(modulePathFor("src/repository/mod.rs"), ["repository"]);
});

test("a file nested in a directory module maps to the full path", () => {
  assert.deepEqual(modulePathFor("src/repository/postgres.rs"), [
    "repository",
    "postgres",
  ]);
});

test("src/ only matches at a path-segment boundary", () => {
  assert.deepEqual(modulePathFor("crates/mysrc/src/lib.rs"), []);
  // No real `src/` segment: whole path is used (existing fallback behaviour).
  assert.deepEqual(modulePathFor("crates/mysrc/foo.rs"), [
    "crates",
    "mysrc",
    "foo",
  ]);
});
