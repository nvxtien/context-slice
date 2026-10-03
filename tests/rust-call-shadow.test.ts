import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

// Fix round 2: local globs, inline-mod anchors, local items, trait scope via the enclosing impl, `use super::*`.
function withRepo<T>(
  files: Record<string, string>,
  run: (dir: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-shadow-"));
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
      targetFile: c.resolvedTargetId
        ? byId.get(c.resolvedTargetId)?.filePath
        : undefined,
      conf: c.confidence,
      ev: c.evidence,
    }));
}
const one = (dir: string, callee: string, caller?: string) => {
  const list = edges(dir, callee, caller);
  assert.equal(list.length, 1, JSON.stringify(list));
  return list[0];
};
const notResolved = (e: ReturnType<typeof one>, prefix?: string) => {
  assert.equal(e.target, undefined, JSON.stringify(e));
  assert.notEqual(e.conf, "exact", JSON.stringify(e));
  if (prefix)
    assert.ok(
      e.ev.some((x) => x.startsWith(prefix)),
      `${prefix} in ${JSON.stringify(e.ev)}`,
    );
};

// I1: function-local glob imports shadow module-level items
test("a fn-local glob import shadows module-level fns, types, ctors and named imports", () => {
  withRepo(
    {
      "src/lib.rs": "mod m;\nfn f() {}\nfn t() { use m::*; f(); }\n",
      "src/m.rs": "pub fn f() {}\n",
    },
    (dir) => assert.equal(one(dir, "f", "t").targetFile, "src/m.rs"),
  );
  withRepo(
    {
      "src/lib.rs":
        "mod m;\nstruct T;\nimpl T { fn new() {} }\nfn t() { use crate::m::*; T::new(); }\n",
      "src/m.rs": "pub struct T;\nimpl T { pub fn new() {} }\n",
    },
    (dir) => assert.equal(one(dir, "new", "t").targetFile, "src/m.rs"),
  );
  withRepo(
    {
      "src/lib.rs": "mod a;\nmod m;\nuse a::f;\nfn t() { use m::*; f(); }\n",
      "src/a.rs": "pub fn f() {}\n",
      "src/m.rs": "pub fn f() {}\n",
    },
    (dir) => assert.equal(one(dir, "f", "t").targetFile, "src/m.rs"),
  );
  withRepo(
    {
      "src/lib.rs":
        "struct Ident(u8);\nenum Token { Ident(u8) }\nfn t() { use Token::*; Ident(1); }\n",
    },
    (dir) => notResolved(one(dir, "Ident", "t")),
  );
  withRepo(
    { "src/lib.rs": "fn max() {}\nfn t() { use std::cmp::*; max(); }\n" },
    (dir) => notResolved(one(dir, "max", "t")),
  );
});

// M1: an inline mod in the anchor file is never replaced by a same-named orphan file
test("use/path through an inline mod never resolves to a same-named file", () => {
  const orphan = { "src/inner.rs": "pub fn f() {}\n" };
  withRepo(
    {
      ...orphan,
      "src/lib.rs":
        "mod inner { pub fn f() {} }\nuse self::inner::f;\nfn t() { f(); }\n",
    },
    (dir) => assert.notEqual(one(dir, "f", "t").targetFile, "src/inner.rs"),
  );
  withRepo(
    {
      ...orphan,
      "src/lib.rs":
        "mod inner { pub fn f() {} }\nfn t() { self::inner::f(); crate::inner::f(); }\n",
    },
    (dir) => {
      for (const e of edges(dir, "f", "t"))
        assert.notEqual(e.targetFile, "src/inner.rs");
    },
  );
});

// M2: fn-local struct / mod / const shadow outer items
test("fn-local struct, mod and const shadow outer items", () => {
  withRepo(
    {
      "src/lib.rs":
        "struct T;\nimpl T { fn new() {} }\nfn t() { struct T; impl T { fn new() {} } T::new(); }\n",
    },
    (dir) => {
      const e = one(dir, "new", "t");
      assert.ok(
        e.target === undefined || e.target.startsWith("t::"),
        JSON.stringify(e),
      );
    },
  );
  withRepo(
    {
      "src/lib.rs":
        "mod m { pub fn f() {} }\nfn t() { mod m { pub fn f() {} } m::f(); }\n",
    },
    (dir) => {
      const e = one(dir, "f", "t");
      assert.ok(
        e.target === undefined || e.target.startsWith("t::"),
        JSON.stringify(e),
      );
    },
  );
  withRepo(
    { "src/lib.rs": "fn f() {}\nfn t() { const f: fn() = || {}; f(); }\n" },
    (dir) => notResolved(one(dir, "f", "t")),
  );
});

// M3: the caller's own enclosing `impl Trait for X` puts the trait in scope
test("a method call inside `impl Trait for X` sees that trait", () => {
  withRepo(
    {
      "src/lib.rs": "mod tr;\nmod imp;\n",
      "src/tr.rs":
        "pub trait Tr { fn a(&self); fn b(&self); }\npub struct X;\n",
      "src/imp.rs":
        "use crate::tr::X;\nimpl crate::tr::Tr for X { fn a(&self) { self.b(); } fn b(&self) {} }\n",
    },
    (dir) => assert.equal(one(dir, "b", "X::a").conf, "exact"),
  );
  withRepo(
    {
      "src/lib.rs":
        "struct E;\nimpl std::error::Error for E { fn source(&self) -> u8 { 1 } fn d(&self) { self.source(); } }\n",
    },
    (dir) => assert.equal(one(dir, "source", "E::d").conf, "exact"),
  );
});

// M4: `use super::*` also brings the parent scope's own imports
test("use super::* consults the parent scope's non-glob imports, conservatively", () => {
  const x = {
    "src/x.rs": "pub struct T;\nimpl T { pub fn new() {} }\npub fn h() {}\n",
  };
  withRepo(
    {
      ...x,
      "src/lib.rs":
        "mod x;\nuse x::{T, h};\nmod tests { use super::*; fn t() { T::new(); h(); } }\n",
    },
    (dir) => {
      assert.equal(one(dir, "new", "tests::t").targetFile, "src/x.rs");
      assert.equal(one(dir, "h", "tests::t").targetFile, "src/x.rs");
    },
  );
  withRepo(
    {
      ...x,
      "src/z.rs": "pub struct T;\nimpl T { pub fn new() {} }\n",
      "src/lib.rs":
        "mod x;\nmod z;\nuse x::T;\nmod tests { use super::*; use crate::z::*; fn t() { T::new(); } }\n",
    },
    (dir) => notResolved(one(dir, "new", "tests::t"), "ambiguous:"),
  );
});
