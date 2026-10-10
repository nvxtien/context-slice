import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

// Fix round 3: local-glob layers over named imports, local fns vs globs, provider dedupe, inline-mod
// detection by body, innermost block wins.
function withRepo<T>(
  files: Record<string, string>,
  run: (dir: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-layers-"));
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
  const result = index.calls
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
  index.close();
  return result;
}
const one = (dir: string, callee: string, caller?: string) => {
  const list = edges(dir, callee, caller);
  assert.equal(list.length, 1, JSON.stringify(list));
  return list[0];
};
const notResolved = (e: ReturnType<typeof one>) => {
  assert.equal(e.target, undefined, JSON.stringify(e));
  assert.notEqual(e.conf, "exact", JSON.stringify(e));
};
const mT = "pub struct T;\nimpl T { pub fn new() {} }\n";

// 1: a fn-local glob beats a file-level named import in path calls
test("a fn-local glob shadows a file-level named import for Type::f() and mod::f()", () => {
  const base = {
    "src/n.rs": mT + "pub mod sub;\n",
    "src/n/sub.rs": "pub fn f() {}\n",
  };
  withRepo(
    {
      ...base,
      "src/m.rs": mT,
      "src/lib.rs":
        "mod m;\nmod n;\nuse n::T;\nfn t() { use crate::m::*; T::new(); }\n",
    },
    (dir) => assert.equal(one(dir, "new", "t").targetFile, "src/m.rs"),
  );
  withRepo(
    {
      ...base,
      "src/m.rs": "pub mod sub;\n",
      "src/m/sub.rs": "pub fn f() {}\n",
      "src/lib.rs":
        "mod m;\nmod n;\nuse n::sub;\nfn t() { use crate::m::*; sub::f(); }\n",
    },
    (dir) => assert.notEqual(one(dir, "f", "t").targetFile, "src/n/sub.rs"),
  );
  withRepo(
    {
      ...base,
      "src/lib.rs": "mod n;\nuse n::T;\nfn t() { use regex::*; T::new(); }\n",
    },
    (dir) => notResolved(one(dir, "new", "t")),
  );
});

// 2: a local fn beats a local glob
test("a fn-local fn wins over a fn-local glob import", () => {
  withRepo(
    {
      "src/lib.rs": "mod m;\nfn t() { fn f() {} use m::*; f(); }\n",
      "src/m.rs": "pub fn f() {}\n",
    },
    (dir) => assert.equal(one(dir, "f", "t").target, "t::f"),
  );
});

// 3: an export is not a second provider
test("a `pub use` in the parent is one provider for `use super::*`, not two", () => {
  const x = {
    "src/x.rs": "pub struct T;\nimpl T { pub fn new() {} }\npub fn f() {}\n",
  };
  for (const vis of ["pub use", "pub(crate) use"])
    withRepo(
      {
        ...x,
        "src/lib.rs": `mod x;\n${vis} x::{T, f};\nmod tests { use super::*; fn t() { T::new(); f(); } }\n`,
      },
      (dir) => {
        assert.equal(one(dir, "new", "tests::t").targetFile, "src/x.rs");
        assert.equal(one(dir, "f", "tests::t").targetFile, "src/x.rs");
      },
    );
});

// 4: inline mods (also empty / re-export-only) are never replaced by an orphan file, for relative paths too
test("a relative path through an inline mod never resolves to a same-named orphan file", () => {
  const orphan = { "src/m.rs": "pub fn g() {}\npub struct T;\n" };
  for (const inline of [
    "mod m { pub fn g() {} }",
    "mod m { pub use crate::x::g; }",
    "mod m {}",
  ])
    withRepo(
      {
        ...orphan,
        "src/x.rs": "pub fn g() {}\n",
        "src/lib.rs": `mod x;\n${inline}\nfn t() { m::g(); }\n`,
      },
      (dir) => assert.notEqual(one(dir, "g", "t").targetFile, "src/m.rs"),
    );
  withRepo(
    {
      ...orphan,
      "src/lib.rs": "mod m { pub fn g() {} }\nuse m::g;\nfn t() { g(); }\n",
    },
    (dir) => assert.notEqual(one(dir, "g", "t").targetFile, "src/m.rs"),
  );
  withRepo(
    {
      ...orphan,
      "src/lib.rs": "mod m { pub fn g() {} }\nfn t() { use m::*; g(); }\n",
    },
    (dir) => assert.notEqual(one(dir, "g", "t").targetFile, "src/m.rs"),
  );
});

// 5: the innermost enclosing block wins
test("an inner-block glob beats an outer-block named import; same block keeps the named import", () => {
  const files = {
    "src/a.rs": "pub fn f() {}\n",
    "src/m.rs": "pub fn f() {}\n",
  };
  withRepo(
    {
      ...files,
      "src/lib.rs": "mod a;\nmod m;\nfn t() { use a::f; { use m::*; f(); } }\n",
    },
    (dir) => assert.equal(one(dir, "f", "t").targetFile, "src/m.rs"),
  );
  withRepo(
    {
      ...files,
      "src/lib.rs": "mod a;\nmod m;\nfn t() { use a::f; use m::*; f(); }\n",
    },
    (dir) => assert.equal(one(dir, "f", "t").targetFile, "src/a.rs"),
  );
});
