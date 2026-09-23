import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyUse,
  expectedModuleFile,
  modDeclarations,
  targetContainsName,
} from "../benchmarks/rust-oracles.js";

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rust-oracle-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  return (rel: string) => existsSync(join(root, rel));
}
// Paths are compared repo-relative; the fake root is joined only inside `tree`.
function rel(files: Record<string, string>) {
  const set = new Set(Object.keys(files));
  return (path: string) => set.has(path);
}

test("expectedModuleFile: lib.rs/main.rs/mod.rs declare into their own directory", () => {
  const exists = rel({ "src/a.rs": "", "src/b/mod.rs": "" });
  assert.equal(expectedModuleFile("src/lib.rs", "a", exists), "src/a.rs");
  assert.equal(expectedModuleFile("src/main.rs", "b", exists), "src/b/mod.rs");
  assert.equal(expectedModuleFile("src/mod.rs", "a", exists), "src/a.rs");
});

test("expectedModuleFile: a plain foo.rs declares into foo/", () => {
  const exists = rel({ "src/foo/bar.rs": "", "src/foo/baz/mod.rs": "" });
  assert.equal(expectedModuleFile("src/foo.rs", "bar", exists), "src/foo/bar.rs");
  assert.equal(expectedModuleFile("src/foo.rs", "baz", exists), "src/foo/baz/mod.rs");
  assert.equal(expectedModuleFile("src/foo.rs", "nope", exists), undefined);
  // foo.rs must NOT look beside itself
  assert.equal(expectedModuleFile("src/foo.rs", "x", rel({ "src/x.rs": "" })), undefined);
});

test("expectedModuleFile: inline mod chain extends the directory", () => {
  const exists = rel({ "src/a/b.rs": "" });
  assert.equal(expectedModuleFile("src/lib.rs", "b", exists, ["a"]), "src/a/b.rs");
});

test("expectedModuleFile works against a real temp tree", () => {
  const exists = tree({ "src/lib.rs": "mod a;", "src/a.rs": "" });
  assert.equal(expectedModuleFile("src/lib.rs", "a", exists), "src/a.rs");
});

test("modDeclarations: finds file-backed mods, path/cfg attrs, inline chains", () => {
  const decls = modDeclarations(`
mod plain;
pub mod publ;
#[cfg(test)]
mod tests;
#[path = "elsewhere.rs"]
mod moved;
mod inline { mod inner; }
mod body_only { fn f() {} }
`);
  const by = Object.fromEntries(decls.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(by).sort(), ["inner", "moved", "plain", "publ", "tests"]);
  assert.equal(by.tests.cfg, true);
  assert.equal(by.plain.cfg, false);
  assert.equal(by.moved.pathAttribute, "elsewhere.rs");
  assert.deepEqual(by.inner.inlineChain, ["inline"]);
  assert.deepEqual(by.plain.inlineChain, []);
});

test("classifyUse: anchored vs non-anchored", () => {
  assert.equal(classifyUse({ module: "crate::a" }), "anchored");
  assert.equal(classifyUse({ module: "self" }), "anchored");
  assert.equal(classifyUse({ module: "super::super::x" }), "anchored");
  assert.equal(classifyUse({ module: "std::io" }), "non-anchored");
  assert.equal(classifyUse({ module: "serde" }), "non-anchored");
});

test("targetContainsName: symbol, export, submodule, enum variant, miss", () => {
  const sym = (filePath: string, name: string, kind = "function", source = "") => ({
    filePath,
    name,
    kind,
    source,
  });
  const index = {
    symbols: [
      sym("src/a.rs", "Thing", "class"),
      sym("src/a.rs", "sub", "namespace"),
      sym("src/a.rs", "Kind", "enum", "enum Kind { Alpha, Beta(u8) }"),
    ],
    exports: [{ filePath: "src/a.rs", exportedName: "Reexp" }],
  };
  assert.equal(targetContainsName(index, "src/a.rs", "Thing"), true);
  assert.equal(targetContainsName(index, "src/a.rs", "Reexp"), true);
  assert.equal(targetContainsName(index, "src/a.rs", "sub"), true);
  assert.equal(targetContainsName(index, "src/a.rs", "Beta"), "unverifiable");
  assert.equal(targetContainsName(index, "src/a.rs", "Missing"), false);
  assert.equal(targetContainsName(index, "src/other.rs", "Thing"), false);
});
