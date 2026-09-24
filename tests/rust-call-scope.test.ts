import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

// Fix round 1: scoping / shadowing / crate-root / trait-visibility negatives. Each fixture is ordinary
// compiling Rust where a naive resolver would emit a WRONG exact edge; all must stay unresolved.
function withRepo<T>(files: Record<string, string>, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-scope-"));
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
/** Never an exact/probable in-repo edge; optionally with an evidence prefix. */
const notResolved = (e: ReturnType<typeof one>, prefix?: string) => {
  assert.equal(e.target, undefined, JSON.stringify(e));
  assert.notEqual(e.conf, "exact", JSON.stringify(e));
  if (prefix) assert.ok(e.ev.some((x) => x.startsWith(prefix)), `${prefix} in ${JSON.stringify(e.ev)}`);
};

// ---- CRITICAL 1: inline-mod scope for types and tuple constructors
test("inline-mod type is not visible from the file scope: an import wins", () => {
  withRepo(
    {
      "src/lib.rs": "mod x;\nuse x::T;\nmod inner { pub struct T; impl T { pub fn new() {} } }\nfn t() { T::new(); }\n",
      "src/x.rs": "pub struct T;\nimpl T { pub fn new() {} }\n",
    },
    (dir) => assert.equal(one(dir, "new", "t").targetFile, "src/x.rs"),
  );
});

test("inline-mod type vs an external or glob import at file scope is never taken", () => {
  withRepo({ "src/lib.rs": "use ext::T;\nmod inner { pub struct T; impl T { pub fn new() {} } }\nfn t() { T::new(); }\n" }, (dir) => {
    const e = one(dir, "new", "t");
    assert.equal(e.target, undefined);
    assert.equal(e.pkg, "ext");
  });
  withRepo(
    {
      "src/lib.rs": "mod x;\nuse x::*;\nmod tests { pub struct T; impl T { pub fn new() {} } }\nfn t() { T::new(); }\n",
      "src/x.rs": "pub struct T;\nimpl T { pub fn new() {} }\n",
    },
    (dir) => assert.equal(one(dir, "new", "t").targetFile, "src/x.rs"),
  );
});

test("same-named types in two inline mods stay separate", () => {
  withRepo(
    {
      "src/lib.rs":
        "mod a { pub struct T; impl T { pub fn new() {} } pub fn f() { T::new(); } }\nmod b { pub struct T; impl T { pub fn new() {} } pub fn g() { T::new(); } }\n",
    },
    (dir) => {
      assert.equal(one(dir, "new", "a::f").target, "a::T::new");
      assert.equal(one(dir, "new", "b::g").target, "b::T::new");
    },
  );
});

test("inline-mod caller uses its own `use`, not a same-named file-level type; file-level items are not inherited", () => {
  withRepo(
    {
      "src/lib.rs":
        "mod x;\nstruct T;\nimpl T { fn new() {} }\nmod tests { use crate::x::T; fn f() { T::new(); } }\nmod bare { fn g() { T::new(); } }\n",
      "src/x.rs": "pub struct T;\nimpl T { pub fn new() {} }\n",
    },
    (dir) => {
      assert.equal(one(dir, "new", "tests::f").targetFile, "src/x.rs");
      notResolved(one(dir, "new", "bare::g")); // nothing brings T into `bare`
    },
  );
});

test("inline-mod tuple struct is not a bare constructor at file scope", () => {
  withRepo(
    { "src/lib.rs": "mod x;\nuse x::W;\nmod inner { pub struct W(pub u8); }\nfn t() { W(1); }\n", "src/x.rs": "pub struct W(pub u8);\n" },
    (dir) => assert.equal(one(dir, "W", "t").targetFile, "src/x.rs"),
  );
  withRepo({ "src/lib.rs": "mod inner { pub struct W(pub u8); }\nfn t() { W(1); }\n" }, (dir) => notResolved(one(dir, "W", "t")));
});

// ---- IMPORTANT 2 / MINOR 7: function-local `use` and local fns
test("a fn-local `use` shadows a module-level fn and type", () => {
  withRepo({ "src/lib.rs": "fn f() {}\nfn t() { use ext::f; f(); }\n" }, (dir) => {
    const e = one(dir, "f", "t");
    assert.equal(e.target, undefined);
    assert.equal(e.pkg, "ext");
  });
  withRepo(
    {
      "src/lib.rs": "mod a;\nstruct T;\nimpl T { fn new() {} }\nfn t() { use crate::a::T; T::new(); }\n",
      "src/a.rs": "pub struct T;\nimpl T { pub fn new() {} }\n",
    },
    (dir) => assert.equal(one(dir, "new", "t").targetFile, "src/a.rs"),
  );
});

test("a `use` in a nested block that does not enclose the call does not count", () => {
  withRepo({ "src/lib.rs": "fn f() {}\nfn t() { { use ext::f; f(); } f(); }\n" }, (dir) => {
    const list = edges(dir, "f", "t").sort((a, b) => (a.pkg ? -1 : 1) - (b.pkg ? -1 : 1));
    assert.equal(list[0].pkg, "ext"); // inside the block
    assert.equal(list[1].target, "f"); // after the block: the module-level fn
  });
});

test("a local fn in a nested block does not resolve a call outside that block", () => {
  withRepo({ "src/lib.rs": "fn h() {}\nfn t() { { fn h() {} h(); } h(); }\n" }, (dir) => {
    const list = edges(dir, "h", "t");
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((e) => e.target).sort(), ["h", "t::h"]);
  });
  withRepo({ "src/lib.rs": "fn t() { { fn h() {} } h(); }\n" }, (dir) => notResolved(one(dir, "h", "t")));
});

// ---- IMPORTANT 3: generic params read from the syntax tree, whatever the head qualifiers
test("T::new() with a generic T never resolves to a same-named struct (any fn/impl/trait head)", () => {
  const src = [
    "struct T;",
    "impl T { fn new() {} }",
    "struct Foo<T>(T);",
    "struct X;",
    "trait Tr { fn h(); }",
    "pub(crate) fn a<T>() { T::new(); }",
    "pub(super) fn b<T: Default>() { T::new(); }",
    "pub async fn c<T>() { T::new(); }",
    "pub const fn d<T>() { T::new(); }",
    "pub unsafe extern \"C\" fn e<T>() { T::new(); }",
    "unsafe impl<T> Tr for X { fn h() { T::new(); } }",
    "impl<T> Foo<T> { fn m() { T::new(); } }",
    "trait Tt<T> { fn d2() { T::new(); } }",
    "fn k<'a, T: 'a, const N: usize>() { T::new(); }",
  ].join("\n");
  withRepo({ "src/lib.rs": src }, (dir) => {
    const list = edges(dir, "new");
    assert.equal(list.length, 9);
    for (const e of list) {
      notResolved(e);
      assert.ok(e.ev.includes("no-type:generic-param"), JSON.stringify(e.ev));
    }
  });
});
