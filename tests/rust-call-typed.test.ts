import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

// Part B: typed receivers (params, fields, lets, chained calls), bounds, external classification.
function withRepo<T>(
  files: Record<string, string>,
  run: (dir: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-typed-"));
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
const norm = (q?: string) => q?.replace(/impl (?:\S+ for )?([^:]+)::/g, "$1::");
function edges(dir: string, callee: string, caller?: string) {
  const index = new ProjectIndex(dir);
  index.rebuild();
  const byId = new Map(index.symbols.map((s) => [s.id, s]));
  return index.calls
    .filter(
      (c) =>
        c.calleeName === callee &&
        (!caller || byId.get(c.callerId)?.qualifiedName?.endsWith(caller)),
    )
    .map((c) => ({
      target: c.resolvedTargetId
        ? norm(byId.get(c.resolvedTargetId)?.qualifiedName)
        : undefined,
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
const exact = (e: ReturnType<typeof one>, target: string) =>
  assert.deepEqual(
    [e.target, e.conf, e.kind],
    [target, "exact", "declared-type"],
    JSON.stringify(e),
  );
const unresolved = (e: ReturnType<typeof one>, prefix: string) => {
  assert.equal(e.conf, "unresolved", JSON.stringify(e));
  assert.equal(e.target, undefined);
  assert.equal(e.pkg, undefined);
  assert.ok(
    e.ev.some((x) => x.startsWith(prefix)),
    `${prefix} in ${JSON.stringify(e.ev)}`,
  );
};
const probableDecl = (e: ReturnType<typeof one>, target: string) => {
  assert.deepEqual(
    [e.target, e.conf, e.kind],
    [target, "probable", "interface"],
    JSON.stringify(e),
  );
  assert.ok(
    e.ev.some((x) => x.startsWith("trait:")),
    JSON.stringify(e.ev),
  );
};

const AB =
  "pub struct A;\nimpl A { pub fn new() -> Self { A } pub fn run(&self) {} }\npub struct B;\nimpl B { pub fn new() -> B { B } pub fn run(&self) {} }\n";

test("parameter types: plain, &, &mut and Box<> receivers resolve to the declared type's method", () => {
  withRepo(
    {
      "src/lib.rs": `${AB}fn a(x: A) { x.run(); }\nfn b(x: &B) { x.run(); }\nfn c(mut x: &mut A) { x.run(); }\nfn d(x: Box<B>) { x.run(); }\n`,
    },
    (dir) => {
      exact(one(dir, "run", "a"), "A::run");
      exact(one(dir, "run", "b"), "B::run");
      exact(one(dir, "run", "c"), "A::run");
      exact(one(dir, "run", "d"), "B::run");
      assert.ok(one(dir, "run", "a").ev.some((x) => x.startsWith("inherent:")));
    },
  );
});

test("a wrapper method name is never pushed through to the inner type", () => {
  withRepo(
    {
      "src/lib.rs":
        "struct A;\nimpl A { fn clone(&self) -> A { A } }\nfn t(x: std::sync::Arc<A>) { x.clone(); }\n",
    },
    (dir) => unresolved(one(dir, "clone", "t"), "ambiguous:"),
  );
});

test("self.field.m() uses the struct's declared field type, with generic arguments substituted", () => {
  withRepo(
    {
      "src/lib.rs":
        `${AB}struct S { a: A, b: Box<B> }\nimpl S { fn t(&self) { self.a.run(); self.b.run(); } }\n` +
        "struct W<I, P> { it: I, p: P }\nimpl<P> W<B, P> { fn u(&self) { self.it.run(); } }\nimpl<I> W<I, u8> { fn v(&self) { self.it.run(); } }\n",
    },
    (dir) => {
      assert.deepEqual(
        edges(dir, "run", "S::t").map((e) => e.target),
        ["A::run", "B::run"],
      );
      exact(one(dir, "run", "::u"), "B::run");
      unresolved(one(dir, "run", "::v"), "no-type:"); // unbounded generic field: never a same-named type
    },
  );
});

test("let bindings: annotation, constructor return type (Self / named / via ?), struct literal, Default", () => {
  withRepo(
    {
      "src/lib.rs":
        `${AB}pub struct E;\nimpl A { fn load() -> Result<A, E> { Ok(A) } }\n#[derive(Default)]\npub struct D;\nimpl D { fn go(&self) {} }\n` +
        "fn a() { let x: A = make(); x.run(); }\nfn make() -> A { A }\nfn b() { let mut x = B::new(); x.run(); }\nfn c() -> Result<(), E> { let x = A::load()?; x.run(); Ok(()) }\n" +
        "fn d() { let x = B {}; x.run(); }\nfn e() { let x = D::default(); x.go(); }\nfn f() { let x = make(); x.run(); }\n",
    },
    (dir) => {
      exact(one(dir, "run", "a"), "A::run");
      exact(one(dir, "run", "b"), "B::run");
      exact(one(dir, "run", "c"), "A::run");
      exact(one(dir, "run", "d"), "B::run");
      exact(one(dir, "go", "e"), "D::go");
      exact(one(dir, "run", "f"), "A::run");
    },
  );
});

test("chained calls: T::new().m(), x.to_b().m(), Result alias with ?, unwrap on Option", () => {
  withRepo(
    {
      "src/lib.rs":
        `${AB}pub struct E;\npub type Result<T> = std::result::Result<T, E>;\nimpl A { fn to_b(&self) -> B { B } fn try_b(&self) -> Result<B> { Ok(B) } fn opt_b(&self) -> Option<B> { None } }\n` +
        "fn a() { A::new().run(); }\nfn b(x: A) { x.to_b().run(); }\nfn c(x: A) -> Result<()> { x.try_b()?.run(); Ok(()) }\nfn d(x: A) { x.opt_b().unwrap().run(); }\n",
    },
    (dir) => {
      exact(one(dir, "run", "a"), "A::run");
      exact(one(dir, "run", "b"), "B::run");
      exact(one(dir, "run", "c"), "B::run");
      exact(one(dir, "run", "d"), "B::run");
    },
  );
});

test("negative: shadowed / re-bound names never resolve", () => {
  withRepo(
    {
      "src/lib.rs": `${AB}fn a() { let x = A::new(); let x = B::new(); x.run(); }\nfn b(x: A) { { let x = B::new(); } x.run(); }\nfn c() { let x = A::new(); let f = |x: B| x.run(); }\n`,
    },
    (dir) => {
      unresolved(one(dir, "run", "a"), "no-type:");
      unresolved(one(dir, "run", "b"), "no-type:");
      unresolved(one(dir, "run", "c"), "no-type:");
    },
  );
});

test("negative: unknown receiver type with a project method name stays unresolved with candidates", () => {
  withRepo(
    {
      "src/lib.rs": `${AB}fn a(x: Mystery) { x.run(); }\nfn b(v: Vec<u8>) { for x in v { x.run(); } }\n`,
    },
    (dir) => {
      for (const f of ["a", "b"]) {
        const e = one(dir, "run", f);
        unresolved(e, "no-type:");
        assert.ok(
          e.ev.join(" ").includes("candidates=2"),
          JSON.stringify(e.ev),
        );
      }
    },
  );
});

test("negative: a generic param named like a struct is a bound, never the struct (probable trait decl)", () => {
  withRepo(
    {
      "src/lib.rs": `${AB}pub trait Tr { fn run(&self); }\nfn a<A: Tr>(x: A) { x.run(); }\nfn b<A>(x: &A) where A: Tr { x.run(); }\nfn c(x: &dyn Tr) { x.run(); }\nfn d(x: impl Tr) { x.run(); }\nfn e(x: Box<dyn Tr>) { x.run(); }\nfn f<A>(x: A) { x.run(); }\n`,
    },
    (dir) => {
      for (const f of ["a", "b", "c", "d", "e"])
        probableDecl(one(dir, "run", f), "Tr::run");
      unresolved(one(dir, "run", "f"), "no-");
    },
  );
});

test("negative: a generic return type from another fn is unknown, not a bound", () => {
  withRepo(
    {
      "src/lib.rs": `${AB}pub trait Tr { fn run(&self); }\nstruct W<T>(T);\nimpl<T: Tr> W<T> { fn get(&self) -> &T { &self.0 } }\nfn a(w: W<A>) { w.get().run(); }\n`,
    },
    (dir) => unresolved(one(dir, "run", "a"), "no-type:"),
  );
});

test("types are resolved per module scope: an inline mod's own type wins", () => {
  withRepo(
    {
      "src/lib.rs": `${AB}mod m {\n  pub struct A;\n  impl A { pub fn run(&self) {} }\n  fn t(x: A) { x.run(); }\n}\n`,
    },
    (dir) => exact(one(dir, "run", "m::t"), "m::A::run"),
  );
});

test("trait impl method on a typed receiver needs the trait in scope", () => {
  withRepo(
    {
      "src/lib.rs":
        "mod m;\npub struct A;\nfn a(x: A) { x.go(); }\nfn b(x: A) { use crate::m::Tr; x.go(); }\n",
      "src/m.rs":
        "pub trait Tr { fn go(&self); }\nimpl Tr for crate::A { fn go(&self) {} }\n",
    },
    (dir) => {
      unresolved(one(dir, "go", "a"), "no-type:trait-not-in-scope");
      assert.equal(one(dir, "go", "b").conf, "exact");
    },
  );
});

test("external classification: std receiver or unknown receiver with no project method => external", () => {
  withRepo(
    {
      "src/lib.rs":
        `${AB}trait Ext { fn run(&self); }\nimpl Ext for String { fn run(&self) {} }\n` +
        "fn a(s: String) { s.len(); }\nfn b(s: String) { s.run(); }\nfn c(x: Mystery) { x.frobnicate(); }\nfn d(x: std::sync::Mutex<A>) { x.lock(); }\nfn e<I: Iterator>(i: I) { i.count(); }\n",
    },
    (dir) => {
      const a = one(dir, "len", "a");
      assert.deepEqual([a.kind, a.pkg], ["external-package", "std"]);
      unresolved(one(dir, "run", "b"), "ambiguous:"); // an in-repo trait impl for String also defines run
      const c = one(dir, "frobnicate", "c");
      assert.deepEqual(
        [c.kind, c.conf, c.pkg],
        ["external-package", "probable", "std-or-dependency"],
      );
      assert.equal(one(dir, "lock", "d").kind, "external-package");
      assert.equal(one(dir, "count", "e").kind, "external-package");
    },
  );
});

test("a path through a private `use` of an ancestor module resolves (crate-root re-import)", () => {
  withRepo(
    {
      "src/lib.rs": "mod parse;\nmod cmd;\nuse parse::Parse;\n",
      "src/parse.rs":
        "pub struct Parse;\nimpl Parse { pub fn new() -> Parse { Parse } pub fn next(&self) {} }\n",
      "src/cmd.rs":
        "use crate::Parse;\nfn t() { let p = Parse::new(); p.next(); }\n",
    },
    (dir) => {
      assert.equal(one(dir, "new", "t").target, "parse::Parse::new");
      exact(one(dir, "next", "t"), "parse::Parse::next");
    },
  );
});

test("negative: nested wrappers are never external std when the inner type is in-repo", () => {
  withRepo(
    {
      "src/lib.rs":
        `use std::sync::Arc;\nuse std::rc::Rc;\nuse std::pin::Pin;\n${AB}pub trait Tr { fn run(&self); }\n` +
        "fn a(x: Arc<Box<A>>) { x.run(); }\nfn b(x: Rc<Rc<B>>) { x.run(); }\nfn c(x: Pin<Box<A>>) { x.run(); }\nfn d(x: Arc<Box<dyn Tr>>) { x.run(); }\nfn e(x: Arc<Box<A>>) { x.clone(); }\n",
    },
    (dir) => {
      exact(one(dir, "run", "a"), "A::run");
      exact(one(dir, "run", "b"), "B::run");
      unresolved(one(dir, "run", "c"), "no-type:"); // Pin derefs to its pointer's target: not modelled
      probableDecl(one(dir, "run", "d"), "Tr::run");
      assert.notEqual(one(dir, "clone", "e").kind, "declared-type");
    },
  );
});

test("negative: a sibling's glob sees only pub `use` records, not private ones", () => {
  withRepo(
    {
      "src/lib.rs": "mod a;\nmod b;\nmod c;\n",
      "src/c.rs":
        "pub struct String;\nimpl String { pub fn len(&self) -> usize { 0 } }\n",
      "src/b.rs": "use crate::c::String;\n",
      "src/a.rs": "use crate::b::*;\nfn t(s: String) { s.len(); }\n",
    },
    (dir) => {
      const e = one(dir, "len", "a::t");
      assert.equal(e.target, undefined, JSON.stringify(e));
    },
  );
});

test("negative: `Trait::default()` never types the receiver as the trait", () => {
  withRepo(
    {
      "src/lib.rs": `${AB}pub trait Tr { fn run(&self); }\nfn t() { Tr::default().run(); }\n`,
    },
    (dir) => assert.notEqual(one(dir, "run", "t").kind, "interface"),
  );
});

test("negative: a blanket impl of an in-scope trait makes a unique method ambiguous; out of scope it does not", () => {
  withRepo(
    {
      "src/lib.rs":
        "mod ext;\npub struct A;\npub trait Tr { fn go(&self); }\nimpl Tr for A { fn go(&self) {} }\nfn a(x: A) { use crate::ext::Ext; x.go(); }\nfn b(x: A) { x.go(); }\n",
      "src/ext.rs":
        "pub trait Ext { fn go(&self); }\nimpl<T: ?Sized> Ext for &T { fn go(&self) {} }\n",
    },
    (dir) => {
      unresolved(one(dir, "go", "a"), "ambiguous:");
      assert.equal(one(dir, "go", "b").conf, "exact");
    },
  );
});

test("perf guard: long method chains resolve in linear time", () => {
  const chain = ".n()".repeat(80);
  const fns = Array.from(
    { length: 50 },
    (_, i) => `fn f${i}(b: B) { b${chain}.run(); }`,
  ).join("\n");
  withRepo(
    {
      "src/lib.rs": `pub struct B;\nimpl B { pub fn n(&self) -> B { B } pub fn run(&self) {} }\n${fns}\n`,
    },
    (dir) => {
      const t0 = Date.now();
      exact(one(dir, "run", "f7"), "B::run");
      assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
    },
  );
});

test("negative: a receiver of a generic external wrapper with a project method name is not external", () => {
  withRepo(
    {
      "src/lib.rs": `${AB}fn a(x: std::cell::RefCell<A>) { x.borrow().run(); }\n`,
    },
    (dir) => unresolved(one(dir, "run", "a"), "no-type:"),
  );
});
