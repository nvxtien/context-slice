import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

test("ProjectIndex indexes a .rs file via the Rust adapter", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-"));
  writeFileSync(
    join(dir, "lib.rs"),
    "pub fn add(a: u32, b: u32) -> u32 { a + b }\n",
  );
  const index = new ProjectIndex(dir);
  index.rebuild();
  const add = index.symbols.find(
    (s) => s.name === "add" && s.language === "rust",
  );
  assert.ok(add, "Rust function 'add' was not indexed");
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

test("target/ directory is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-"));
  writeFileSync(join(dir, "lib.rs"), "pub fn kept() {}\n");
  mkdirSync(join(dir, "target"), { recursive: true });
  writeFileSync(
    join(dir, "target", "generated.rs"),
    "pub fn should_be_ignored() {}\n",
  );
  const index = new ProjectIndex(dir);
  index.rebuild();
  assert.ok(index.symbols.some((s) => s.name === "kept"));
  assert.equal(
    index.symbols.some((s) => s.name === "should_be_ignored"),
    false,
  );
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

test("duplicate impl blocks for the same type do not crash indexing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-"));
  writeFileSync(
    join(dir, "lib.rs"),
    "struct Foo;\nimpl Foo { fn a(&self) {} }\nimpl Foo { fn b(&self) {} }\n",
  );
  const index = new ProjectIndex(dir);
  assert.doesNotThrow(() => index.rebuild());
  const a = index.symbols.find((s) => s.name === "a" && s.language === "rust");
  const b = index.symbols.find((s) => s.name === "b" && s.language === "rust");
  assert.ok(a, "method 'a' was not indexed");
  assert.ok(b, "method 'b' was not indexed");
  assert.notEqual(
    a!.id,
    b!.id,
    "methods from distinct impl blocks got the same id",
  );
  assert.notEqual(
    a!.parentId,
    b!.parentId,
    "the two impl blocks should be distinct parent symbols",
  );
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a mixed Java + Rust repository indexes both languages without crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mixed-"));
  writeFileSync(join(dir, "Main.java"), "class Main { void run() {} }\n");
  writeFileSync(join(dir, "lib.rs"), "pub fn run() {}\n");
  const index = new ProjectIndex(dir);
  const summary = index.rebuild();
  assert.equal(summary.parseErrors, 0);
  assert.ok(index.symbols.some((s) => s.language === "java"));
  assert.ok(index.symbols.some((s) => s.language === "rust"));
  index.close();
  rmSync(dir, { recursive: true, force: true });
});
