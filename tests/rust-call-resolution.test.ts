import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

type Files = Record<string, string>;
function withRepo<T>(files: Files, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-res-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// impl blocks are path segments named `impl X` / `impl Tr for X`: show them as `X`.
const norm = (q?: string) => q?.replace(/impl (?:\S+ for )?([^:]+)::/g, "$1::");

/** Resolved edges of every call to `callee` made from a symbol whose qualifiedName ends with `caller`. */
function edges(dir: string, callee: string, caller?: string) {
  const index = new ProjectIndex(dir);
  index.rebuild();
  return summarize(index, callee, caller);
}
function summarize(index: ProjectIndex, callee: string, caller?: string) {
  const byId = new Map(index.symbols.map((s) => [s.id, s]));
  return index.calls
    .filter((c) => c.calleeName === callee && (!caller || byId.get(c.callerId)?.qualifiedName?.endsWith(caller)))
    .map((c) => ({
      target: c.resolvedTargetId ? norm(byId.get(c.resolvedTargetId)?.qualifiedName) : undefined,
      targetFile: c.resolvedTargetId ? byId.get(c.resolvedTargetId)?.filePath : undefined,
      conf: c.confidence,
      kind: c.resolutionKind,
      ev: c.evidence,
      pkg: c.externalPackage,
    }));
}
const one = (dir: string, callee: string, caller?: string) => {
  const list = edges(dir, callee, caller);
  assert.equal(list.length, 1, JSON.stringify(list));
  return list[0];
};
const unresolved = (e: ReturnType<typeof one>, prefix: string) => {
  assert.equal(e.conf, "unresolved", JSON.stringify(e));
  assert.equal(e.target, undefined);
  assert.equal(e.kind, "unresolved");
  assert.ok(e.ev.some((x) => x.startsWith(prefix)), `${prefix} in ${JSON.stringify(e.ev)}`);
};

// ---- self.m()
test("self.m(): unique inherent method is exact / this-member", () => {
  withRepo({ "src/lib.rs": "struct A;\nimpl A { fn m(&self) {} fn c(&self) { self.m(); } }\n" }, (dir) => {
    const e = one(dir, "m", "A::c");
    assert.deepEqual([e.target, e.conf, e.kind], ["A::m", "exact", "this-member"]);
    assert.ok(e.ev[0].startsWith("inherent:"));
  });
});

test("self.m(): unique method across several impl blocks and files, trait impl evidence", () => {
  withRepo(
    {
      "src/lib.rs": "mod other;\nuse crate::other::Tr;\npub struct A;\nimpl A { fn c(&self) { self.m(); self.t(); } }\n",
      "src/other.rs": "use crate::A;\npub trait Tr { fn t(&self); }\nimpl A { fn m(&self) {} }\nimpl Tr for A { fn t(&self) {} }\n",
    },
    (dir) => {
      const m = one(dir, "m", "A::c");
      assert.deepEqual([m.target, m.targetFile, m.conf, m.kind], ["other::A::m", "src/other.rs", "exact", "this-member"]);
      const t = one(dir, "t", "A::c");
      assert.equal(t.conf, "exact");
      assert.ok(t.ev[0].startsWith("trait:"));
    },
  );
});

test("self.m(): a trait impl and an inherent impl both define m => ambiguous, unresolved", () => {
  withRepo(
    { "src/lib.rs": "trait Tr { fn m(&self); }\nstruct A;\nimpl A { fn m(&self) {} }\nimpl Tr for A { fn m(&self) {} fn c(&self) { self.m(); } }\n" },
    (dir) => unresolved(one(dir, "m", "A::c"), "ambiguous:2"),
  );
});

test("self.m() in a trait default method targets the trait declaration as probable/interface", () => {
  withRepo({ "src/lib.rs": "trait Tr { fn m(&self); fn d(&self) { self.m(); } }\n" }, (dir) => {
    const e = one(dir, "m", "Tr::d");
    assert.deepEqual([e.target, e.conf, e.kind], ["Tr::m", "probable", "interface"]);
    assert.ok(e.ev[0].startsWith("trait:"));
  });
});

test("self.m() found only as a default method of a trait the type implements is probable/interface", () => {
  withRepo(
    { "src/lib.rs": "trait Tr { fn d(&self) {} }\nstruct A;\nimpl Tr for A {}\nimpl A { fn c(&self) { self.d(); } }\n" },
    (dir) => {
      const e = one(dir, "d", "A::c");
      assert.deepEqual([e.target, e.conf, e.kind], ["Tr::d", "probable", "interface"]);
    },
  );
});

test("self.m() with a method no impl or trait defines is unresolved with no-symbol", () => {
  withRepo({ "src/lib.rs": "struct A;\nimpl A { fn c(&self) { self.len(); } }\n" }, (dir) =>
    unresolved(one(dir, "len", "A::c"), "no-symbol:"),
  );
});

test("two distinct types with the same name in different modules are never merged", () => {
  withRepo(
    {
      "src/lib.rs": "mod a;\nmod b;\n",
      "src/a.rs": "pub struct T;\nimpl T { fn m(&self) {} fn c(&self) { self.m(); } }\n",
      "src/b.rs": "pub struct T;\nimpl T { fn m(&self) {} fn c(&self) { self.m(); } }\n",
    },
    (dir) => {
      const list = edges(dir, "m", "T::c");
      assert.deepEqual(list.map((e) => [e.targetFile, e.conf]).sort(), [["src/a.rs", "exact"], ["src/b.rs", "exact"]]);
    },
  );
});

test("an impl block in a different file than its type is found by Self type resolution", () => {
  withRepo(
    {
      "src/lib.rs": "mod ty;\nmod imp;\n",
      "src/ty.rs": "pub struct S;\n",
      "src/imp.rs": "use crate::ty::S;\nimpl S { fn one(&self) {} fn two(&self) { self.one(); } }\n",
    },
    (dir) => assert.equal(one(dir, "one", "S::two").target, "imp::S::one"),
  );
});

test("receivers of unknown type stay unresolved, with the candidate count", () => {
  withRepo(
    { "src/lib.rs": "struct A;\nimpl A { fn run(&self) {} }\nstruct B;\nimpl B { fn run(&self) {} }\nfn f(x: Mystery) { x.run(); }\n" },
    (dir) => {
      const e = one(dir, "run", "f");
      unresolved(e, "no-type:");
      assert.ok(e.ev.join(" ").includes("candidates=2"));
    },
  );
});

// ---- Type::f / Self::f
test("Self::f() and Type::f() associated functions are static", () => {
  withRepo(
    { "src/lib.rs": "struct A;\nimpl A { fn new() -> A { A } fn make() -> A { Self::new() } }\nfn g() { A::new(); }\n" },
    (dir) => {
      for (const caller of ["A::make", "g"]) {
        const e = one(dir, "new", caller);
        assert.deepEqual([e.target, e.conf, e.kind], ["A::new", "exact", "static"]);
      }
    },
  );
});

test("Type imported from another file (and via `as` alias) resolves to that type's impl", () => {
  withRepo(
    {
      "src/lib.rs": "mod m;\nmod n;\nfn g() { m::h(); }\n",
      "src/m.rs": "pub struct A;\nimpl A { pub fn new() -> A { A } }\n",
      "src/n.rs": "use crate::m::A as Renamed;\nfn h() { Renamed::new(); }\n",
    },
    (dir) => assert.equal(one(dir, "new", "n::h").target, "m::A::new"),
  );
});

test("two same-named types: the imported one wins over the other module's", () => {
  withRepo(
    {
      "src/lib.rs": "mod a;\nmod b;\nmod c;\n",
      "src/a.rs": "pub struct T;\nimpl T { pub fn new() {} }\n",
      "src/b.rs": "pub struct T;\nimpl T { pub fn new() {} }\n",
      "src/c.rs": "use crate::b::T;\nfn f() { T::new(); }\n",
    },
    (dir) => assert.equal(one(dir, "new", "c::f").targetFile, "src/b.rs"),
  );
});

test("enum variant constructors are not symbols: unresolved no-symbol:variant", () => {
  withRepo({ "src/lib.rs": "enum E { V(u8) }\nfn f() { E::V(1); }\n" }, (dir) => unresolved(one(dir, "V", "f"), "no-symbol:variant"));
});

test("assoc fn on an external type is external-package", () => {
  withRepo(
    { "src/lib.rs": "use std::collections::HashMap;\nuse serde_json::Value;\nfn f() { HashMap::new(); Value::from(1); Vec::new(); }\n" },
    (dir) => {
      const all = edges(dir, "new", "f");
      assert.deepEqual(all.map((e) => e.pkg).sort(), ["std", "std"]);
      assert.equal(one(dir, "from", "f").pkg, "serde_json");
      assert.ok(all.every((e) => e.kind === "external-package"));
    },
  );
});

test("Type::f with an unknown type is unresolved", () => {
  withRepo({ "src/lib.rs": "fn f() { Mystery::go(); }\n" }, (dir) => unresolved(one(dir, "go", "f"), "no-type:unknown-type"));
});

test("Trait::f() associated call targets the declaration as probable/interface", () => {
  withRepo({ "src/lib.rs": "trait Tr { fn make() -> u8; }\nfn f() { Tr::make(); }\n" }, (dir) => {
    const e = one(dir, "make", "f");
    assert.deepEqual([e.target, e.conf, e.kind], ["Tr::make", "probable", "interface"]);
  });
});

// ---- module paths
test("module paths: crate::, self::, super::, alias and use-alias of a module", () => {
  withRepo(
    {
      "src/lib.rs": "mod util;\nmod svc;\npub fn root() {}\nfn t() { crate::util::helper(); util::helper(); self::root(); }\n",
      "src/util.rs": "pub fn helper() {}\n",
      "src/svc.rs": "use crate::util;\nuse crate::util as u2;\nfn a() { util::helper(); u2::helper(); super::root(); crate::util::helper(); }\n",
    },
    (dir) => {
      const t = edges(dir, "helper", "t");
      assert.equal(t.length, 2);
      for (const e of t) assert.deepEqual([e.target, e.conf, e.kind], ["util::helper", "exact", "namespace-import"]);
      const a = edges(dir, "helper", "a");
      assert.equal(a.length, 3);
      assert.ok(a.every((e) => e.target === "util::helper" && e.conf === "exact"));
      assert.equal(one(dir, "root", "t").target, "root");
      assert.equal(one(dir, "root", "a").target, "root");
    },
  );
});

test("module path follows a pub use chain", () => {
  withRepo(
    {
      "src/lib.rs": "mod a;\nmod facade;\nfn t() { facade::helper(); }\n",
      "src/a.rs": "pub fn helper() {}\n",
      "src/facade.rs": "pub use crate::a::helper;\n",
    },
    (dir) => assert.equal(one(dir, "helper", "t").target, "a::helper"),
  );
});

test("anchored path to a missing module is unresolved, never external", () => {
  withRepo({ "src/lib.rs": "fn t() { crate::nope::f(); }\nfn f() {}\n" }, (dir) => {
    const e = one(dir, "f", "t");
    assert.equal(e.conf, "unresolved");
    assert.equal(e.pkg, undefined);
  });
});

test("crate::Type::f() does not fall back to a same-named root fn", () => {
  withRepo({ "src/lib.rs": "struct Foo;\nfn new() {}\nfn t() { crate::Foo::new(); }\n" }, (dir) =>
    assert.equal(one(dir, "new", "t").target, undefined),
  );
});

test("unresolved external crate path is external-package; std paths too", () => {
  withRepo({ "src/lib.rs": "fn t() { serde_json::to_string(1); std::mem::swap(a, b); }\n" }, (dir) => {
    assert.deepEqual([one(dir, "to_string", "t").pkg, one(dir, "to_string", "t").kind], ["serde_json", "external-package"]);
    assert.equal(one(dir, "swap", "t").pkg, "std");
  });
});

test("inline mod: super:: and self:: resolve inside the same file", () => {
  withRepo(
    { "src/lib.rs": "fn helper() {}\nmod inner { pub fn g() {} pub fn t() { super::helper(); self::g(); } }\nfn u() { inner::g(); }\n" },
    (dir) => {
      const h = one(dir, "helper", "inner::t");
      assert.deepEqual([h.target, h.conf], ["helper", "exact"]);
      assert.equal(edges(dir, "g", "inner::t")[0].target, "inner::g");
      assert.equal(edges(dir, "g", "u")[0].target, "inner::g");
    },
  );
});

// ---- bare calls
test("bare f(): same-file fn, nested fn, imported, aliased import", () => {
  withRepo(
    {
      "src/lib.rs": "mod m;\nmod n;\nfn f() {}\nfn t() { f(); }\n",
      "src/m.rs": "pub fn g() {}\n",
      "src/n.rs": "use crate::m::g;\nuse crate::m::g as h;\nfn a() { g(); h(); fn inner() {} inner(); }\n",
    },
    (dir) => {
      const f = one(dir, "f", "t");
      assert.deepEqual([f.target, f.conf, f.kind], ["f", "exact", "same-file"]);
      const g = one(dir, "g", "a");
      assert.deepEqual([g.target, g.kind], ["m::g", "imported"]);
      const h = one(dir, "h", "a");
      assert.deepEqual([h.target, h.kind], ["m::g", "aliased-import"]);
      assert.equal(one(dir, "inner", "a").target, "n::a::inner");
    },
  );
});

test("bare f() resolved through a pub use re-export", () => {
  withRepo(
    { "src/lib.rs": "mod a;\nmod b;\n", "src/a.rs": "pub fn f() {}\n", "src/b.rs": "pub use crate::a::f;\n", "src/c.rs": "use crate::b::f;\nfn t() { f(); }\n" },
    (dir) => assert.equal(one(dir, "f", "t").target, "a::f"),
  );
});

test("tuple struct constructor is a constructor edge; Some/Ok/drop are std", () => {
  withRepo({ "src/lib.rs": "struct P(u8);\nfn t() { P(1); Some(1); Ok(1); drop(2); }\n" }, (dir) => {
    const p = one(dir, "P", "t");
    assert.deepEqual([p.target, p.kind, p.conf], ["P", "constructor", "exact"]);
    for (const n of ["Some", "Ok", "drop"]) {
      const e = one(dir, n, "t");
      assert.deepEqual([e.kind, e.pkg, e.conf], ["external-package", "std", "probable"]);
    }
  });
});

test("unknown bare function is unresolved", () => {
  withRepo({ "src/lib.rs": "fn t() { mystery(); }\n" }, (dir) => unresolved(one(dir, "mystery", "t"), "no-type:"));
});

test("a local let binding or parameter shadows an outer/imported fn", () => {
  withRepo(
    {
      "src/lib.rs": "mod m;\nuse m::g;\nfn f() {}\nfn a() { let f = || 1; f(); }\nfn b(g: fn()) { g(); }\nfn c() { let h = 1; f(); }\n",
      "src/m.rs": "pub fn g() {}\n",
    },
    (dir) => {
      unresolved(one(dir, "f", "a"), "no-type:local-binding");
      unresolved(one(dir, "g", "b"), "no-type:local-binding");
      assert.equal(one(dir, "f", "c").target, "f"); // a different binding does not shadow
    },
  );
});

test("a pattern binding (match arm / if let / for) shadows; a variant name in a pattern does not", () => {
  withRepo(
    { "src/lib.rs": "fn f() {}\nfn a(o: Option<u8>) { if let Some(f) = o { f(); } }\nfn b(o: Option<u8>) { if let Some(x) = o { f(); } }\n" },
    (dir) => {
      unresolved(one(dir, "f", "a"), "no-type:local-binding");
      assert.equal(one(dir, "f", "b").target, "f");
    },
  );
});

test("cfg-gated duplicate fns with the same name stay unresolved (ambiguous)", () => {
  withRepo(
    { "src/lib.rs": "#[cfg(unix)]\nfn f() {}\n#[cfg(not(unix))]\nfn f() {}\nfn t() { f(); }\n" },
    (dir) => unresolved(one(dir, "f", "t"), "ambiguous:2"),
  );
});

test("glob-import name collision is ambiguous; a single glob provider resolves", () => {
  withRepo(
    {
      "src/lib.rs": "mod a;\nmod b;\nmod c;\nmod d;\n",
      "src/a.rs": "pub fn f() {}\npub fn only() {}\n",
      "src/b.rs": "pub fn f() {}\n",
      "src/c.rs": "use crate::a::*;\nuse crate::b::*;\nfn t() { f(); only(); }\n",
      "src/d.rs": "use serde::*;\nuse crate::a::*;\nfn t() { only(); }\n",
    },
    (dir) => {
      unresolved(one(dir, "f", "c::t"), "ambiguous:2");
      assert.equal(one(dir, "only", "c::t").target, "a::only");
      unresolved(one(dir, "only", "d::t"), "no-type:glob-unknown"); // an unknown glob may also provide `only`
    },
  );
});

test("unresolved external crate import: bare call is external, not an in-repo fn", () => {
  withRepo({ "src/lib.rs": "use rand::random;\nfn t() { random(); }\n" }, (dir) => {
    const e = one(dir, "random", "t");
    assert.deepEqual([e.kind, e.pkg, e.conf], ["external-package", "rand", "exact"]);
  });
});

test("macro calls stay unresolved; a call hidden in a macro is not an edge", () => {
  withRepo({ "src/lib.rs": "fn f() {}\nfn t() { println!(\"{}\", f()); vec![f()]; }\n" }, (dir) => {
    const m = one(dir, "println", "t");
    unresolved(m, "macro:");
    assert.deepEqual(edges(dir, "f", "t"), []);
  });
});

test("parenthesised callee and qualified trait paths are left unresolved", () => {
  withRepo({ "src/lib.rs": "trait Tr { fn m(x: u8); }\nfn t() { <u8 as Tr>::m(1); }\nstruct S { cb: fn() }\nimpl S { fn u(&self) { (self.cb)(); } }\n" }, (dir) => {
    const q = one(dir, "m", "t");
    unresolved(q, "no-type:");
    assert.ok(q.ev.includes("qualified:Tr"));
    unresolved(one(dir, "cb", "S::u"), "no-type:callee-expression");
  });
});

// ---- cache behaviour
test("warm rebuild reproduces cold edges; unresolved edges are re-resolved after another file changes", () => {
  withRepo(
    {
      "src/lib.rs": "mod a;\nmod b;\nfn t() { crate::a::f(); }\n",
      "src/a.rs": "pub struct S;\nimpl S { pub fn m(&self) {} pub fn c(&self) { self.m(); self.n(); (self.cb)(); } }\n",
      "src/b.rs": "pub fn x() {}\n",
    },
    (dir) => {
      const snap = (i: ProjectIndex) =>
        JSON.stringify(
          i.calls.map((c) => [c.filePath, c.range, c.resolvedTargetId, c.confidence, c.resolutionKind, c.evidence, c.externalPackage]).sort(),
        );
      const cold = new ProjectIndex(dir);
      cold.rebuild();
      const first = snap(cold);
      cold.rebuild();
      assert.equal(snap(cold), first);
      const reopened = new ProjectIndex(dir);
      reopened.rebuild();
      assert.equal(snap(reopened), first);
      // another file adds the missing method n: the previously unresolved edge picks it up
      writeFileSync(join(dir, "src/b.rs"), "use crate::a::S;\nimpl S { pub fn n(&self) {} }\n");
      reopened.rebuild();
      const fresh = new ProjectIndex(dir);
      fresh.rebuild();
      assert.equal(snap(reopened), snap(fresh));
      assert.equal(summarize(reopened, "n", "S::c")[0].target, "b::S::n");
    },
  );
});

test("T::f() with a generic T (fn or impl level) never resolves to a same-named type; bounds do not count as params", () => {
  withRepo(
    {
      "src/lib.rs":
        "struct T;\nimpl T { fn make() {} }\nfn a<T: Default>() { T::make(); }\nstruct W<T>(T);\nimpl<T> W<T> { fn b() { T::make(); } }\nfn c<I: IntoIterator<Item = String>>() { String::new(); T::make(); }\n",
    },
    (dir) => {
      const list = edges(dir, "make");
      assert.deepEqual(list.map((e) => e.conf), ["unresolved", "unresolved", "exact"]);
      assert.ok(list[0].ev.includes("no-type:generic-param"));
      assert.equal(one(dir, "new", "c").pkg, "std"); // `String` appears in a bound only
    },
  );
});

test("an enum-variant glob cannot hide an extern crate path; an unknown module glob still can", () => {
  withRepo({ "src/lib.rs": "enum Color { R }\nfn t() { use Color::*; serde_json::to_string(1); }\n" }, (dir) =>
    assert.equal(one(dir, "to_string", "t").pkg, "serde_json"),
  );
  withRepo({ "src/lib.rs": "use other_crate::*;\nfn t() { serde_json::to_string(1); }\n" }, (dir) =>
    unresolved(one(dir, "to_string", "t"), "no-type:unknown-type"),
  );
});
