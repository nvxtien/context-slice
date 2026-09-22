import assert from "node:assert/strict";
import test from "node:test";
import { rustParser, LANGUAGE_ID } from "../src/languages/rust/parse.js";

test("rustParser parses trivial Rust source without throwing", () => {
  const parser = rustParser();
  const tree = parser.parse("fn main() {}");
  assert.equal(tree.rootNode.type, "source_file");
  assert.equal(tree.rootNode.hasError, false);
});

test("LANGUAGE_ID is 'rust'", () => {
  assert.equal(LANGUAGE_ID, "rust");
});
