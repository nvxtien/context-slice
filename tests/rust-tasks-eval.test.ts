import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { attributeFact, resolveTarget } from "../benchmarks/v1.5-rust-tasks.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-tasks-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "f"\nversion = "0.1.0"\n');
  writeFileSync(join(root, "src/lib.rs"), "pub mod a;\npub mod b;\n");
  writeFileSync(join(root, "src/a.rs"), "pub struct A;\nimpl A { pub fn new() -> A { A } pub fn run(&self) { helper(); } }\nfn helper() {}\n");
  writeFileSync(join(root, "src/b.rs"), "pub struct B;\nimpl B { pub fn new() -> B { B } }\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}
const fact = { id: "f", description: "", verification: { type: "source-fragment", patterns: ["fn helper() {}"] } };
test("ambiguous short name fails loudly, qualified name resolves", () => {
  const index = fixture();
  // Adapter qualified names look like `a::impl A::new`; tasks use `A.new`.
  assert.equal(resolveTarget(index, "new").error, "ambiguous");
  assert.equal(resolveTarget(index, "nope").error, "not-found");
  assert.ok(resolveTarget(index, "A.new", "src/a.rs").symbol);
  assert.ok(resolveTarget(index, "A.new").symbol);
  assert.ok(resolveTarget(index, "helper").symbol);
});
test("fact present only in the unselected callee is NOT_SELECTED", () => {
  const index = fixture();
  const target = resolveTarget(index, "A.run", "src/a.rs").symbol;
  const base = { target, fileParsed: true, groundTruthText: "fn helper() {}", budget: 8 };
  // fullText is the unlimited-budget selection: it never contained the callee.
  assert.equal(attributeFact(fact, { ...base, selectedText: "pub fn run(&self)", fullText: "pub fn run(&self)" }), "NOT_SELECTED");
  // In the unlimited selection but cut by the budget.
  assert.equal(attributeFact(fact, { ...base, selectedText: "pub fn run(&self)", fullText: "pub fn run(&self) fn helper() {}" }), "BUDGET");
  assert.equal(attributeFact(fact, { ...base, selectedText: "fn helper() {}", fullText: "fn helper() {}" }), "PRESERVED");
  assert.equal(attributeFact(fact, { ...base, groundTruthText: "other", selectedText: "", fullText: "" }), "NOT_IN_SOURCE");
});
test("missing target and empty parse are adapter defects", () => {
  const f = { id: "f", description: "", verification: { type: "source-fragment", patterns: ["x"] } };
  assert.equal(attributeFact(f, { target: undefined, fileParsed: true, selectedText: "", fullText: "", groundTruthText: "x", budget: 8 }), "TARGET_NOT_FOUND");
  assert.equal(attributeFact(f, { target: undefined, fileParsed: false, selectedText: "", fullText: "", groundTruthText: "x", budget: 8 }), "ADAPTER_EMPTY_FILE");
});
test("impact of a zero-caller symbol does not crash and never vacuously passes", () => {
  const index = fixture();
  const b = resolveTarget(index, "B.new", "src/b.rs").symbol!;
  assert.deepEqual(index.callers(b), []);
  const f = { id: "f", description: "", verification: { type: "source-fragment", patterns: [] } };
  assert.notEqual(attributeFact(f, { target: b, fileParsed: true, selectedText: "x", fullText: "x", groundTruthText: "x", budget: 8 }), "PRESERVED");
});
