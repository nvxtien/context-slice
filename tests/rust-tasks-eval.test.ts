import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { attributeFact, buildBeforeAfter, buildFindings, contextEntries_, resolveTarget, weakestCategories } from "../benchmarks/v1.5-rust-tasks.js";

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
test("empty pattern list is never PRESERVED; zero-caller symbol has empty callers and no caller entries", () => {
  const index = fixture();
  const b = resolveTarget(index, "B.new", "src/b.rs").symbol!;
  assert.deepEqual(index.callers(b), []);
  assert.equal(contextEntries_(index, b).some((e) => e.category === "caller-context"), false);
  const f = { id: "f", description: "", verification: { type: "source-fragment", patterns: [] } };
  assert.notEqual(attributeFact(f, { target: b, fileParsed: true, selectedText: "x", fullText: "x", groundTruthText: "x", budget: 8 }), "PRESERVED");
});
test("file-scoped retry resolves cross-file ambiguity; same-file ambiguity stays ambiguous", () => {
  const index = fixture();
  assert.equal(resolveTarget(index, "new").error, "ambiguous");
  assert.ok(resolveTarget(index, "new", "src/a.rs").symbol);
  assert.ok(resolveTarget(index, "new", "src/b.rs").symbol);
  const root = mkdtempSync(join(tmpdir(), "cs-rust-amb-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "f"\nversion = "0.1.0"\n');
  writeFileSync(join(root, "src/lib.rs"), "pub mod a;\n");
  writeFileSync(join(root, "src/a.rs"), "pub struct A; pub struct C;\nimpl A { pub fn go(&self) {} }\nimpl C { pub fn go(&self) {} }\n");
  const idx = new ProjectIndex(root);
  idx.rebuild();
  const r = resolveTarget(idx, "go", "src/a.rs");
  assert.equal(r.error, "ambiguous");
  const f = { id: "f", description: "", verification: { type: "source-fragment", patterns: ["x"] } };
  assert.equal(attributeFact(f, { target: undefined, ambiguous: true, fileParsed: true, selectedText: "", fullText: "", groundTruthText: "x", budget: 8 }), "TARGET_AMBIGUOUS");
});
test("findings mark repeated fact-losing causes fix, budget/source report-only", () => {
  const r = (task: string, repository: string, ...a: string[]) => ({ task, repository, facts: a.map((attribution) => ({ attribution })) });
  const f = buildFindings([r("t1", "x", "NOT_SELECTED", "PRESERVED"), r("t2", "x", "NOT_SELECTED"), r("t3", "y", "NOT_IN_SOURCE", "BUDGET"), r("t4", "z", "BUDGET"), r("t5", "z", "TARGET_NOT_FOUND")]);
  const m = Object.fromEntries(f.map((x) => [x.cause, x.marker]));
  assert.deepEqual(m, { NOT_SELECTED: "fix", NOT_IN_SOURCE: "report-only", BUDGET: "report-only", TARGET_NOT_FOUND: "report-only" });
});
test("findings count distinct tasks and mark repeated TARGET_AMBIGUOUS / ADAPTER_EMPTY_FILE for fixing", () => {
  const r = (task: string, repository: string, ...a: string[]) => ({ task, repository, facts: a.map((attribution) => ({ attribution })) });
  const f = buildFindings([r("t1", "x", "TARGET_AMBIGUOUS", "TARGET_AMBIGUOUS"), r("t2", "y", "TARGET_AMBIGUOUS"), r("t3", "x", "ADAPTER_EMPTY_FILE", "ADAPTER_EMPTY_FILE", "ADAPTER_EMPTY_FILE")]);
  const by = Object.fromEntries(f.map((x) => [x.cause, x]));
  assert.deepEqual([by.TARGET_AMBIGUOUS.taskCount, by.TARGET_AMBIGUOUS.repositoryCount, by.TARGET_AMBIGUOUS.marker], [2, 2, "fix"]);
  // Three facts of ONE task in one repo: one task, not repeated.
  assert.deepEqual([by.ADAPTER_EMPTY_FILE.taskCount, by.ADAPTER_EMPTY_FILE.marker], [1, "report-only"]);
});
test("before/after reports per-group deltas, fact changes and regressions; weakest categories tie", () => {
  const s = (v: number) => ({ requiredFactRecall: v, retrievalRecall: v, wholeFileFallbackRate: 1 - v });
  const run = (v: number, a: string, b: string) => ({
    summary: { overall: s(v), byCategory: { explain: s(v), impact: s(1) } },
    tasks: [{ task: "t", category: "explain", facts: [{ id: "a", attribution: a }, { id: "b", attribution: b }] }],
  });
  const ba = buildBeforeAfter(run(0.5, "NOT_SELECTED", "PRESERVED"), run(1, "PRESERVED", "BUDGET"));
  assert.deepEqual(ba.rows[0], { group: "all", factRecall: [0.5, 1], retrievalRecall: [0.5, 1], wholeFileFallback: [0.5, 0] });
  assert.deepEqual(ba.changes.map((c) => `${c.fact}:${c.before}>${c.after}`), ["a:NOT_SELECTED>PRESERVED", "b:PRESERVED>BUDGET"]);
  assert.deepEqual(ba.regressions.map((c) => c.fact), ["b"]);
  assert.deepEqual(weakestCategories({ a: s(0.5), b: s(0.5), c: s(1) }), ["a", "b"]);
});
