import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CATEGORIES,
  collectTraitMethods,
  selectTraitSupplement,
  enumerateCallSites,
  quotaFor,
  selectSample,
  splitFor,
  type CallSite,
} from "../benchmarks/rust-call-oracle.js";

const sites = (src: string) => enumerateCallSites(src, "src/lib.rs");
const cat = (body: string) =>
  sites(`fn f(p: u8) { let l = 1; ${body} }`).sites.map(
    (s) => `${s.calleeName}:${s.category}`,
  );

test("every category is produced", () => {
  const src = `
mod m {
  struct T;
  impl T {
    fn run(&self, p: u8) {
      let l = 1;
      self.a();
      self.f.b();
      p.c();
      l.d();
      x().e();
      Self::g();
      Foo::h();
      a::b::i();
      Vec::<u8>::new();
      j();
      Some(1);
      <T as Tr>::k();
      println!("x");
    }
  }
}`;
  const { sites: s } = sites(src);
  const got = new Map(s.map((x) => [x.calleeName, x.category]));
  assert.equal(got.get("a"), "self-method");
  assert.equal(got.get("b"), "field-method");
  assert.equal(got.get("c"), "param-method");
  assert.equal(got.get("d"), "local-method");
  assert.equal(got.get("e"), "chained-method");
  assert.equal(got.get("g"), "assoc-Self");
  assert.equal(got.get("h"), "assoc-Type");
  assert.equal(got.get("i"), "path-module");
  assert.equal(got.get("new"), "path-generic");
  assert.equal(got.get("j"), "bare-fn");
  assert.equal(got.get("Some"), "bare-closure-or-ctor");
  assert.equal(got.get("k"), "qualified-trait");
  assert.equal(got.get("println"), "macro-invocation");
  assert.equal(new Set(got.values()).size, 13);
  assert.equal(CATEGORIES.length, 13);
  assert.equal(s[0].callerQualifiedName, "m::T::run");
});

test("tie-breaks", () => {
  assert.deepEqual(cat("f2::<u8>();"), ["f2:path-generic"]);
  assert.deepEqual(cat("Self::g::<u8>();"), ["g:path-generic"]);
  assert.deepEqual(cat("<T as Tr>::k::<u8>();"), ["k:qualified-trait"]);
  assert.deepEqual(cat("l.m::<u8>();"), ["m:local-method"]); // method turbofish: by receiver
  assert.deepEqual(cat("E::V(1);"), ["V:bare-closure-or-ctor"]); // uppercase name beats Uppercase:: path
  assert.deepEqual(cat("l(1);"), ["l:bare-closure-or-ctor"]); // calling a let-bound/param name
  assert.deepEqual(cat("io::Error::new();"), ["new:assoc-Type"]);
  assert.deepEqual(cat("std::mem::swap();"), ["swap:path-module"]);
  assert.deepEqual(
    sites("fn f() { (self.h)(1); }").sites.map((s) => s.category),
    ["bare-closure-or-ctor"],
  );
  // param wins over a shadowing let (listed order)
  assert.deepEqual(
    sites("fn f(p: u8) { let p = 2; p.q(); }").sites.map((s) => s.category),
    ["param-method"],
  );
  // a let inside a nested fn does not leak to the outer fn
  const n = sites("fn o() { fn i() { let z = 1; } z.w(); }").sites;
  assert.equal(n.find((s) => s.calleeName === "w")!.category, "chained-method");
});

test("macro token_tree contents are hidden, not enumerated", () => {
  const r = sites('fn f() { println!("{}", g(1)); vec![h(2), 3]; }');
  assert.deepEqual(
    r.sites.map((s) => s.calleeName),
    ["println", "vec"],
  );
  assert.equal(r.hiddenInMacro, 2);
});

test("calls outside function bodies are ignored; positions point at callee name", () => {
  const r = sites("const C: u8 = k();\nfn f() {\n  a\n    .b();\n}");
  assert.equal(r.sites.length, 1);
  assert.equal(r.sites[0].line, 4);
  assert.equal(r.sites[0].col, 5);
  const dup = sites("fn f() { a().b(); }").sites;
  assert.equal(new Set(dup.map((s) => `${s.line}:${s.col}`)).size, 2);
});

test("large sources parse", () => {
  const big = "fn f() { g(); }\n" + "// pad\n".repeat(8000);
  assert.equal(sites(big).sites.length, 1);
});

test("split rule: sha1 first 4 hex % 10 < 6", () => {
  for (let i = 0; i < 40; i++) {
    const n = parseInt(
      createHash("sha1")
        .update(`walkdir:src/lib.rs:${i}:4`)
        .digest("hex")
        .slice(0, 4),
      16,
    );
    assert.equal(
      splitFor("walkdir", "src/lib.rs", i, 4),
      n % 10 < 6 ? "dev" : "held-out",
    );
  }
  // known hash inputs: sha1("a:b:1:2") starts with 4 hex digits parsed as an integer
  const k = parseInt(
    createHash("sha1").update("a:b.rs:1:2").digest("hex").slice(0, 4),
    16,
  );
  assert.equal(splitFor("a", "b.rs", 1, 2), k % 10 < 6 ? "dev" : "held-out");
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) seen.add(splitFor("r", "f.rs", i, 0));
  assert.deepEqual([...seen].sort(), ["dev", "held-out"]);
});

const mk = (category: string, line: number) =>
  ({
    repo: "r",
    file: "a.rs",
    line,
    col: 0,
    callerQualifiedName: "f",
    callText: "",
    calleeName: "x",
    category,
  }) as CallSite;

test("quota: <=3 takes all, else proportional clamp 1..5", () => {
  assert.equal(quotaFor(3, 300), 3);
  assert.equal(quotaFor(1, 300), 1);
  assert.equal(quotaFor(4, 1000), 1);
  assert.equal(quotaFor(500, 1000), 5);
  assert.equal(quotaFor(100, 1000), 3);
});

test("selectSample: per category, ordered by sha1 ascending, all when <=3", () => {
  const all = [
    ...Array.from({ length: 50 }, (_, i) => mk("bare-fn", i + 1)),
    ...[1, 2, 3].map((i) => mk("qualified-trait", i)),
  ];
  const out = selectSample(all);
  assert.equal(out.filter((s) => s.category === "qualified-trait").length, 3);
  const bare = out.filter((s) => s.category === "bare-fn");
  assert.ok(bare.length >= 1 && bare.length <= 5);
  const h = (s: CallSite) =>
    createHash("sha1").update(`r:a.rs:${s.line}:0`).digest("hex");
  const expected = all
    .filter((s) => s.category === "bare-fn")
    .sort((a, b) => (h(a) < h(b) ? -1 : 1))
    .slice(0, bare.length);
  assert.deepEqual(
    bare.map((s) => s.line),
    expected.map((s) => s.line),
  );
  assert.ok(out.every((s) => s.split === "dev" || s.split === "held-out"));
  assert.deepEqual(selectSample(all), out);
});

test("categories partition: counts sum to total", () => {
  const r = sites("fn f(p: u8) { a(); p.b(); x!(1); Foo::c(); S(1); }");
  const sum = CATEGORIES.reduce(
    (n, c) => n + r.sites.filter((s) => s.category === c).length,
    0,
  );
  assert.equal(sum, r.sites.length);
});

// ---- trait-candidate supplement ----
test("collectTraitMethods: signature and default methods as Trait::method", () => {
  const src =
    "pub trait Tr { fn sig(&self); fn dflt(&self) { } const C: u8 = 1; }\nstruct S; impl S { fn inh(&self) {} }";
  assert.deepEqual(collectTraitMethods(src).sort(), ["Tr::dflt", "Tr::sig"]);
  assert.deepEqual(collectTraitMethods("fn f() {}"), []);
});

const tsite = (line: number, name = "sig"): CallSite =>
  ({
    repo: "r",
    file: "a.rs",
    line,
    col: 0,
    callerQualifiedName: "f",
    callText: `x.${name}()`,
    calleeName: name,
    category: "local-method",
  }) as CallSite;
const hk = (line: number) =>
  createHash("sha1").update(`r:a.rs:${line}:0`).digest("hex");

test("supplement: matches by callee name, drops already-sampled, skips macros, lists traitMethods", () => {
  const all = [
    tsite(1),
    tsite(2),
    tsite(3, "other"),
    { ...tsite(4), category: "macro-invocation" } as CallSite,
  ];
  const r = selectTraitSupplement(
    "r",
    all,
    ["Tr::sig", "Other::sig"],
    new Set(["a.rs:1:0"]),
  );
  assert.equal(r.candidates, 2); // sites 1 and 2 (macro excluded), before dropping
  assert.equal(r.dropped, 1);
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.line, 2);
  assert.equal(e.supplement, "trait-candidate");
  assert.deepEqual(e.traitMethods, ["Other::sig", "Tr::sig"]);
  assert.equal(e.split, splitFor("r", "a.rs", 2, 0));
});

test("supplement: cap at 12 by sha1 ascending; <=12 takes all; no traits -> empty", () => {
  const all = Array.from({ length: 15 }, (_, i) => tsite(i + 1));
  const r = selectTraitSupplement("r", all, ["Tr::sig"], new Set());
  assert.equal(r.candidates, 15);
  assert.equal(r.entries.length, 12);
  const want = all
    .map((s) => s.line)
    .sort((a, b) => (hk(a) < hk(b) ? -1 : 1))
    .slice(0, 12);
  assert.deepEqual(
    r.entries.map((e) => e.line),
    want,
  );
  assert.equal(
    selectTraitSupplement("r", all.slice(0, 12), ["Tr::sig"], new Set()).entries
      .length,
    12,
  );
  assert.deepEqual(selectTraitSupplement("r", all, [], new Set()), {
    candidates: 0,
    dropped: 0,
    entries: [],
  });
});
