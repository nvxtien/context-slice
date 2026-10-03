import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

function withRepo(files: Record<string, string>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-int-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const build = (dir: string) => {
  const index = new ProjectIndex(dir);
  index.rebuild();
  return index;
};

test("use serde::Serialize is external, not lib.rs (cold and warm)", () => {
  withRepo(
    { "src/lib.rs": "use serde::Serialize;\npub struct A;\n" },
    (dir) => {
      for (let i = 0; i < 2; i++) {
        const imp = build(dir).imports.find(
          (r) => r.importedName === "Serialize",
        );
        assert.ok(imp);
        assert.equal(imp!.externalPackage, "serde");
        assert.equal(imp!.resolvedFile, undefined);
      }
    },
  );
});

test("a local module named like a dependency does not resolve to itself", () => {
  withRepo(
    {
      "src/lib.rs": "pub mod serde;\n",
      "src/serde.rs": "use serde::Serializer;\npub struct S;\n",
    },
    (dir) => {
      const imp = build(dir).imports.find(
        (r) => r.importedName === "Serializer",
      );
      assert.ok(imp);
      assert.equal(imp!.resolvedFile, undefined);
      assert.equal(imp!.externalPackage, "serde");
    },
  );
});

test("colliding module paths across crates stay unresolved", () => {
  withRepo(
    {
      "crates/a/src/lib.rs": "pub mod x;\n",
      "crates/a/src/x.rs": "pub struct Y;\n",
      "crates/a/src/y.rs": "use crate::x::Y;\n",
      "crates/b/src/lib.rs": "pub mod x;\n",
      "crates/b/src/x.rs": "pub struct Y;\n",
      "crates/b/src/y.rs": "use crate::x::Y;\n",
    },
    (dir) => {
      const imps = build(dir).imports.filter((r) => r.importedName === "Y");
      assert.equal(imps.length, 2);
      for (const imp of imps) {
        assert.equal(imp.resolvedFile, undefined);
        assert.equal(imp.externalPackage, undefined);
      }
    },
  );
});

test("aliased pub use re-export carries names, file and symbolId", () => {
  withRepo(
    {
      "src/lib.rs": "pub mod a;\npub use crate::a::Foo as Bar;\n",
      "src/a.rs": "pub struct Foo;\n",
    },
    (dir) => {
      const index = build(dir);
      const exp = index.exports.find((e) => e.exportedName === "Bar");
      assert.ok(exp);
      assert.equal(exp!.sourceName, "Foo");
      assert.ok(exp!.resolvedFile?.endsWith("src/a.rs"));
      const sym = index.symbols.find((s) => s.name === "Foo");
      assert.ok(sym);
      assert.equal(exp!.symbolId, sym!.id);
    },
  );
});

test("wildcard pub use chain resolves through to the symbol", () => {
  withRepo(
    {
      "src/lib.rs": "pub mod a;\npub mod b;\npub use crate::b::Foo;\n",
      "src/b.rs": "pub use crate::a::*;\n",
      "src/a.rs": "pub struct Foo;\n",
    },
    (dir) => {
      const index = build(dir);
      const exp = index.exports.find(
        (e) => e.exportedName === "Foo" && e.filePath.endsWith("lib.rs"),
      );
      assert.ok(exp);
      const sym = index.symbols.find((s) => s.name === "Foo");
      assert.equal(exp!.symbolId, sym!.id);
    },
  );
});

test("mutual pub use cycle terminates with no symbolId", () => {
  withRepo(
    {
      "src/lib.rs": "pub mod a;\npub mod b;\n",
      "src/a.rs": "pub use crate::b::Ghost;\n",
      "src/b.rs": "pub use crate::a::Ghost;\n",
    },
    (dir) => {
      const index = build(dir);
      const exps = index.exports.filter((e) => e.exportedName === "Ghost");
      assert.equal(exps.length, 2);
      for (const e of exps) assert.equal(e.symbolId, undefined);
    },
  );
});

// --- locally bound first segments are not external crates (D3) ---
test("use of a same-file enum's variants is not external", () => {
  withRepo(
    { "src/lib.rs": "enum Command { A, B }\nuse Command::*;\n" },
    (dir) => {
      const imp = build(dir).imports.find((r) => r.wildcard);
      assert.ok(imp);
      assert.equal(imp!.externalPackage, undefined);
      assert.equal(imp!.resolvedFile, undefined);
    },
  );
});

test("first segment bound by another use in the same file is not external", () => {
  withRepo(
    {
      "src/lib.rs":
        "pub mod parse;\nuse crate::parse::{Parse, ParseError};\nuse ParseError::EndOfStream;\n",
      "src/parse.rs":
        "pub struct Parse;\npub enum ParseError { EndOfStream }\n",
    },
    (dir) => {
      const imp = build(dir).imports.find(
        (r) => r.importedName === "EndOfStream",
      );
      assert.ok(imp);
      assert.equal(imp!.externalPackage, undefined);
      assert.equal(imp!.resolvedFile, undefined);
    },
  );
});

test("an unbound external crate is still external", () => {
  withRepo(
    { "src/lib.rs": "use serde::Serialize;\npub struct A;\n" },
    (dir) => {
      assert.equal(
        build(dir).imports.find((r) => r.importedName === "Serialize")!
          .externalPackage,
        "serde",
      );
    },
  );
});

test("a binding in one file does not affect another file's external import", () => {
  withRepo(
    {
      "src/lib.rs": "pub mod a;\npub mod b;\n",
      "src/a.rs": "pub struct serde;\nuse serde::X;\n",
      "src/b.rs": "use serde::Y;\n",
    },
    (dir) => {
      const imports = build(dir).imports;
      const a = imports.find((r) => r.importedName === "X")!;
      const b = imports.find((r) => r.importedName === "Y")!;
      assert.equal(a.externalPackage, undefined);
      assert.equal(b.externalPackage, "serde");
    },
  );
});

test("a fn or const named like a crate does not shadow the crate", () => {
  withRepo(
    {
      "src/lib.rs":
        "use serde::X;\nstruct S;\nimpl S { fn serde(&self) {} }\nfn serde() {}\nconst serde2: u8 = 0;\n",
    },
    (dir) => {
      assert.equal(
        build(dir).imports.find((r) => r.importedName === "X")!.externalPackage,
        "serde",
      );
    },
  );
});

test("self in a use group binds the module name locally", () => {
  withRepo(
    {
      "src/lib.rs":
        "use crate::frame::{self, Frame};\nuse frame::Error::Incomplete;\npub struct A;\n",
    },
    (dir) => {
      const imp = build(dir).imports.find(
        (r) => r.importedName === "Incomplete",
      );
      assert.ok(imp);
      assert.equal(imp!.externalPackage, undefined);
    },
  );
});
