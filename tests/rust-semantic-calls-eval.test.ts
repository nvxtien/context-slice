import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { CallEdge, SymbolRecord } from "../src/types/model.js";
import {
  attributeFailure,
  buildReport,
  classifyOutcome,
  formatReport,
  gateSplit,
  indexRepo,
  matchLabelToEdge,
  scoreEntries,
  validateLabels,
  type Label,
} from "../benchmarks/v1.5-rust-semantic-calls.js";

const rng = (l: number, c: number, el: number, ec: number) => ({ startLine: l, startColumn: c, endLine: el, endColumn: ec });
const edge = (o: Partial<CallEdge> & { calleeName: string }): CallEdge => ({
  callerId: "c",
  filePath: "src/a.rs",
  range: rng(1, 0, 1, 30),
  confidence: "unresolved",
  resolutionKind: "unresolved",
  evidence: [],
  ...o,
});
const sym = (id: string, filePath: string, line: number, qualifiedName = "X::y"): SymbolRecord =>
  ({ id, filePath, qualifiedName, name: "y", range: rng(line, 0, line + 2, 1) }) as unknown as SymbolRecord;
const label = (o: Partial<Label> & { expected: Label["expected"] }): Label => ({
  repo: "r",
  file: "src/a.rs",
  line: 1,
  col: 5,
  callerQualifiedName: "f",
  callText: "x.y()",
  calleeName: "y",
  category: "self-method",
  split: "dev",
  ...o,
});
const R = (line: number, file = "src/b.rs"): Label["expected"] => ({
  kind: "resolved",
  target: { file, qualifiedName: "X::y", kind: "method", line },
  confidence: "exact",
  why: "",
});
const EXT: Label["expected"] = { kind: "external", confidence: "exact", why: "" };
const symbols = new Map([["t10", sym("t10", "src/b.rs", 10)], ["t20", sym("t20", "src/b.rs", 20)]]);
const claim = (id: string, confidence: "exact" | "probable" = "exact", evidence: string[] = []) =>
  edge({ calleeName: "y", resolvedTargetId: id, confidence, resolutionKind: "declared-type", evidence });

test("matching: range containment + calleeName, same file only", () => {
  const l = label({ expected: EXT });
  const e = edge({ calleeName: "y" });
  assert.equal(matchLabelToEdge(l, [e]), e);
  assert.equal(matchLabelToEdge(l, [edge({ calleeName: "z" })]), undefined);
  assert.equal(matchLabelToEdge(l, [edge({ calleeName: "y", filePath: "src/other.rs" })]), undefined);
  assert.equal(matchLabelToEdge(l, [edge({ calleeName: "y", range: rng(2, 0, 2, 9) })]), undefined);
  assert.equal(matchLabelToEdge(l, [edge({ calleeName: "y", range: rng(1, 6, 1, 9) })]), undefined); // starts after the token
  assert.equal(matchLabelToEdge(l, [edge({ calleeName: "y", range: rng(1, 0, 1, 5) })]), undefined); // ends at token start (exclusive)
  // multi-line call containing the token
  const ml = edge({ calleeName: "y", range: rng(1, 0, 4, 2) });
  assert.equal(matchLabelToEdge(l, [ml]), ml);
});

test("matching: nested calls pick the smallest containing range", () => {
  const outer = edge({ calleeName: "f", range: rng(1, 0, 1, 10) });
  const inner = edge({ calleeName: "f", range: rng(1, 2, 1, 9) });
  const at = (col: number) => label({ col, calleeName: "f", expected: EXT });
  assert.equal(matchLabelToEdge(at(2), [outer, inner]), inner);
  assert.equal(matchLabelToEdge(at(2), [inner, outer]), inner);
  assert.equal(matchLabelToEdge(at(0), [outer, inner]), outer);
});

test("outcomes: correct / wrong / unresolved / external / no-edge; target by file+startLine only", () => {
  const l = label({ expected: R(10) });
  assert.deepEqual(classifyOutcome(l, undefined, symbols), { kind: "no-edge", evidence: [] });
  assert.equal(classifyOutcome(l, edge({ calleeName: "y" }), symbols).kind, "unresolved");
  const ok = classifyOutcome(l, claim("t10"), symbols);
  assert.deepEqual([ok.kind, ok.correct, ok.confidence], ["resolved", true, "exact"]);
  assert.equal(classifyOutcome(l, claim("t20"), symbols).correct, false);
  // same qualifiedName text but wrong line => wrong; different text but right line => correct
  const other = new Map([["z", sym("z", "src/b.rs", 20, "X::y")], ["q", sym("q", "src/b.rs", 10, "Totally::different")]]);
  assert.equal(classifyOutcome(l, claim("z"), other).correct, false);
  assert.equal(classifyOutcome(l, claim("q"), other).correct, true);
  // right line, wrong file
  assert.equal(classifyOutcome(l, claim("t10"), new Map([["t10", sym("t10", "src/c.rs", 10)]])).correct, false);
  const ext = classifyOutcome(label({ expected: EXT }), edge({ calleeName: "y", resolutionKind: "external-package", externalPackage: "std" }), symbols);
  assert.equal(ext.kind, "external");
  assert.equal(classifyOutcome(label({ expected: EXT }), edge({ calleeName: "y", externalPackage: "std" }), symbols).kind, "external");
  const ev = classifyOutcome(l, edge({ calleeName: "y", evidence: ["trait:Foo::y", "inherent:Bar", "no-type:x", "other:z"] }), symbols);
  assert.deepEqual(ev.evidence, ["inherent:", "trait:", "no-type:"]);
});

test("metrics: exact vs probable, precision, external agreement, false positives with k/n", () => {
  const rows = [
    // resolved labels
    { l: label({ expected: R(10) }), o: classifyOutcome(label({ expected: R(10) }), claim("t10"), symbols) }, // exact correct
    { l: label({ expected: R(10) }), o: classifyOutcome(label({ expected: R(10) }), claim("t10", "probable"), symbols) }, // probable correct
    { l: label({ expected: R(10) }), o: classifyOutcome(label({ expected: R(10) }), claim("t20"), symbols) }, // wrong exact
    { l: label({ expected: R(10) }), o: classifyOutcome(label({ expected: R(10) }), claim("t20", "probable"), symbols) }, // wrong probable
    { l: label({ expected: R(10) }), o: classifyOutcome(label({ expected: R(10) }), edge({ calleeName: "y" }), symbols) }, // miss
    { l: label({ expected: R(10) }), o: classifyOutcome(label({ expected: R(10) }), undefined, symbols) }, // no edge
    // external labels
    { l: label({ expected: EXT }), o: classifyOutcome(label({ expected: EXT }), edge({ calleeName: "y", resolutionKind: "external-package" }), symbols) }, // agree
    { l: label({ expected: EXT }), o: classifyOutcome(label({ expected: EXT }), claim("t10"), symbols) }, // FP
    { l: label({ expected: EXT }), o: classifyOutcome(label({ expected: EXT }), edge({ calleeName: "y" }), symbols) }, // neutral
    // unresolvable label with a claim => FP
    { l: label({ expected: { kind: "unresolvable", confidence: "exact", why: "" } }), o: classifyOutcome(label({ expected: { kind: "unresolvable", confidence: "exact", why: "" } }), claim("t10"), symbols) },
  ];
  const m = scoreEntries(rows);
  assert.deepEqual(m.recallExact, { k: 1, n: 6 });
  assert.deepEqual(m.recallInclProbable, { k: 2, n: 6 });
  assert.deepEqual(m.precision, { k: 2, n: 6 }); // claims: 2 correct + 2 wrong + external FP + unresolvable FP
  assert.deepEqual(m.externalAgreement, { k: 1, n: 3 });
  assert.deepEqual(m.falsePositiveEdgeRate, { k: 4, n: 10 });
  assert.deepEqual([m.wrongExact, m.wrongProbable], [3, 1]);
  assert.deepEqual(m.externalBreakdown, { agree: 1, claimedResolved: 1, unresolved: 1, noEdge: 0 });
  assert.deepEqual(m.coverage, { k: 9, n: 10 });
  // empty set: precision is 0/0, never NaN
  assert.deepEqual(scoreEntries([]).precision, { k: 0, n: 0 });
});

test("report: macro block and supplement are kept out of the headline; split filtering", () => {
  const mk = (l: Label, e?: CallEdge) => ({ l, o: classifyOutcome(l, e, symbols) });
  const rows = [
    mk(label({ expected: R(10) }), claim("t10")),
    mk(label({ expected: R(10), split: "held-out" }), claim("t20")),
    mk(label({ category: "macro-invocation", calleeName: "vec", expected: EXT }), edge({ calleeName: "vec", evidence: ["macro:vec"] })),
    mk(label({ category: "macro-invocation", calleeName: "vec", expected: EXT }), edge({ calleeName: "vec" })), // unresolved but no macro: evidence
    mk(label({ category: "macro-invocation", calleeName: "vec", expected: EXT }), undefined),
    mk(label({ expected: R(10), supplement: "trait-candidate", traitMethods: ["T::y"] }), claim("t20", "probable", ["trait:T"])),
  ];
  const dev = buildReport(rows, { split: "dev", counts: undefined });
  assert.deepEqual(dev.pooled.recallExact, { k: 1, n: 1 }); // held-out, macro, supplement all excluded
  assert.deepEqual(dev.macro, { n: 3, unresolvedWithMacroEvidence: 1, macroUnresolvedRate: { k: 1, n: 3 }, claimedResolved: 0 });
  assert.equal(dev.supplement.n, 1);
  assert.deepEqual(dev.supplement.metrics.recallExact, { k: 0, n: 1 });
  assert.deepEqual(dev.supplement.metrics.recallInclProbable, { k: 0, n: 1 }); // wrong target
  assert.equal(dev.bySplit.dev.n, 1);
  assert.equal(dev.bySplit["held-out"], undefined); // not scored on a dev run
  const all = buildReport(rows, { split: "all", counts: undefined });
  assert.deepEqual(all.pooled.recallExact, { k: 1, n: 2 });
  assert.equal(all.bySplit["held-out"].n, 1);
  const text = formatReport(all);
  assert.match(text, /1\/2/);
  assert.match(text, /tiny|small/i);
  assert.doesNotMatch(text, /confidence interval|significan|±/i);
});

test("failure attribution: deterministic rules, UNKNOWN never hidden", () => {
  const ctx = { symbolExists: (f: string, l: number) => !(f === "src/gone.rs"), parseErrorFiles: new Set(["src/bad.rs"]) };
  const at = (l: Label, e?: CallEdge) => attributeFailure(l, classifyOutcome(l, e, symbols), ctx);
  const un = edge({ calleeName: "y" });
  assert.equal(at(label({ expected: R(10) }), claim("t10")), null); // correct: not a failure
  assert.equal(at(label({ expected: EXT }), un), null); // neutral
  assert.equal(at(label({ expected: R(10) }), undefined), "UNKNOWN");
  assert.equal(at(label({ file: "src/bad.rs", expected: R(10) }), undefined), "PARSER");
  assert.equal(at(label({ expected: R(10, "src/gone.rs") }), un), "SYMBOL_INDEX");
  assert.equal(at(label({ category: "macro-invocation", expected: { kind: "unresolvable", confidence: "exact", why: "" } }), claim("t10")), "MACRO_EXPANSION_LIMIT");
  assert.equal(at(label({ expected: { ...R(10), target: { file: "src/b.rs", qualifiedName: "T::y", kind: "trait-method-decl", line: 10 } } }), un), "TRAIT_RESOLUTION");
  assert.equal(at(label({ expected: R(10) }), edge({ calleeName: "y", evidence: ["trait:T"] })), "TRAIT_RESOLUTION");
  assert.equal(at(label({ expected: R(10) }), edge({ calleeName: "y", evidence: ["inherent:T"] })), "IMPL_RESOLUTION");
  assert.equal(at(label({ category: "self-method", expected: R(10) }), un), "IMPL_RESOLUTION");
  assert.equal(at(label({ category: "chained-method", expected: R(10) }), edge({ calleeName: "y", receiverText: "<call>" })), "RUST_STATIC_LIMIT");
  assert.equal(at(label({ category: "bare-fn", expected: R(10, "src/b.rs") }), un), "USE_RESOLUTION"); // cross-file
  assert.equal(at(label({ category: "bare-fn", expected: R(10, "src/a.rs") }), un), "CALL_RESOLUTION"); // same file
  assert.equal(at(label({ category: "bare-fn", expected: EXT }), claim("t10")), "CALL_RESOLUTION"); // claimed on external
  assert.equal(at(label({ category: "bare-fn", expected: { kind: "unresolvable", confidence: "exact", why: "" } }), undefined), "UNKNOWN");
});

test("labels: empty calleeName is refused", () => {
  assert.doesNotThrow(() => validateLabels([label({ expected: EXT })]));
  assert.throws(() => validateLabels([label({ calleeName: "", expected: EXT })]), /calleeName/);
});

test("split gating: held-out/all refused without --final and nothing is logged", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsc-gate-"));
  try {
    const log = join(dir, "HELDOUT_RUNS.log");
    for (const s of ["held-out", "all"] as const) {
      const g = gateSplit(s, false, log);
      assert.equal(g.ok, false);
      assert.match(g.ok ? "" : g.message, /--final/);
    }
    assert.equal(existsSync(log), false);
    assert.equal(gateSplit("dev", false, log).ok, true);
    assert.equal(gateSplit("dev", true, log).ok, true); // --final with dev is harmless, logs nothing
    assert.equal(existsSync(log), false);
    assert.equal(gateSplit("bogus" as never, false, log).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI refuses --split held-out/all without --final, exit non-zero, log untouched", () => {
  const script = join(process.cwd(), "benchmarks/v1.5-rust-semantic-calls.ts");
  const log = join(process.cwd(), "benchmarks/rust-semantic-calls/HELDOUT_RUNS.log");
  const before = existsSync(log) ? readFileSync(log, "utf8") : null;
  for (const s of ["held-out", "all"]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", script, "--split", s], { encoding: "utf8" });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /refus/i);
  }
  const after = existsSync(log) ? readFileSync(log, "utf8") : null;
  assert.equal(after, before);
});

test("--out inside the repo tree is refused on a dev run", () => {
  const script = join(process.cwd(), "benchmarks/v1.5-rust-semantic-calls.ts");
  const r = spawnSync(process.execPath, ["--import", "tsx", script, "--out", join(process.cwd(), "benchmarks/results/x.json")], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /outside/i);
  assert.equal(existsSync(join(process.cwd(), "benchmarks/results/x.json")), false);
});

test("synthetic Rust project: real index edges match labels, cold == warm", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsc-proj-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/lib.rs"), "struct S;\nimpl S {\n    fn m(&self) {}\n}\nfn f(s: &S) {\n    s.m();\n    g(g(1));\n}\nfn g(x: i32) -> i32 { x }\n");
    const idx = indexRepo(dir);
    assert.equal(idx.coldWarmIdentical, true);
    const at = (line: number, col: number, calleeName: string) =>
      matchLabelToEdge(label({ file: "src/lib.rs", line, col, calleeName, expected: EXT }), idx.calls);
    const m = at(6, 6, "m");
    assert.ok(m);
    assert.equal(m.range.startLine, 6);
    const inner = at(7, 6, "g");
    const outer = at(7, 4, "g");
    assert.ok(inner && outer && inner !== outer);
    assert.ok(inner.range.startColumn > outer.range.startColumn);
    assert.equal(at(7, 4, "nope"), undefined);
    // the method symbol is found by (file, line): the SYMBOL_INDEX check
    assert.ok(idx.symbolExists("src/lib.rs", 3));
    assert.equal(idx.symbolExists("src/lib.rs", 99), false);
    assert.equal(existsSync(join(dir, ".context-slice")), true); // cache lived in the (temp) dir we passed
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
