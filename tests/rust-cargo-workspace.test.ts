import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

type Files = Record<string, string>;
function withRepo<T>(files: Files, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-cargo-"));
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

test("a use path into a sibling workspace crate (block members list) resolves to that crate's file", () => {
  withRepo(
    {
      "Cargo.toml": `[workspace]\nmembers = [\n    "api",\n    "store",\n]\n`,
      "api/Cargo.toml": `[package]\nname = "api"\nversion = "0.1.0"\n`,
      "api/src/lib.rs": `use store::Store;\n\nfn make() -> Store {\n    Store {}\n}\n`,
      "store/Cargo.toml": `[package]\nname = "store"\nversion = "0.1.0"\n`,
      "store/src/lib.rs": `pub struct Store {}\n`,
    },
    (dir) => {
      const index = new ProjectIndex(dir);
      index.rebuild();
      const record = index.imports.find((r) => r.importedName === "Store")!;
      assert.equal(record.resolvedFile, "store/src/lib.rs");
    },
  );
});

test("a use path into a nested module of a sibling crate resolves correctly", () => {
  withRepo(
    {
      "Cargo.toml": `[workspace]\nmembers = ["api", "store"]\n`,
      "api/Cargo.toml": `[package]\nname = "api"\nversion = "0.1.0"\n`,
      "api/src/lib.rs": `use store::repository::Repo;\n\nfn make() -> Repo {\n    Repo {}\n}\n`,
      "store/Cargo.toml": `[package]\nname = "store"\nversion = "0.1.0"\n`,
      "store/src/lib.rs": `pub mod repository;\n`,
      "store/src/repository.rs": `pub struct Repo {}\n`,
    },
    (dir) => {
      const index = new ProjectIndex(dir);
      index.rebuild();
      const record = index.imports.find((r) => r.importedName === "Repo")!;
      assert.equal(record.resolvedFile, "store/src/repository.rs");
    },
  );
});

test("two workspace crates each with their own src/lib.rs are NOT ambiguous with each other (per-crate module index)", () => {
  withRepo(
    {
      "Cargo.toml": `[workspace]\nmembers = ["api", "store"]\n`,
      "api/Cargo.toml": `[package]\nname = "api"\nversion = "0.1.0"\n`,
      "api/src/lib.rs": `pub fn run() {}\n`,
      "store/Cargo.toml": `[package]\nname = "store"\nversion = "0.1.0"\n`,
      "store/src/lib.rs": `use api::run;\n\nfn go() {\n    run();\n}\n`,
    },
    (dir) => {
      const index = new ProjectIndex(dir);
      index.rebuild();
      const record = index.imports.find((r) => r.importedName === "run")!;
      assert.equal(record.resolvedFile, "api/src/lib.rs");
    },
  );
});

test("a use path naming a crate NOT in the workspace stays external", () => {
  withRepo(
    {
      "Cargo.toml": `[workspace]\nmembers = ["api"]\n`,
      "api/Cargo.toml": `[package]\nname = "api"\nversion = "0.1.0"\n`,
      "api/src/lib.rs": `use serde::Serialize;\n\nfn go() {}\n`,
    },
    (dir) => {
      const index = new ProjectIndex(dir);
      index.rebuild();
      const record = index.imports.find((r) => r.importedName === "Serialize")!;
      assert.equal(record.resolvedFile, undefined);
      assert.equal(record.externalPackage, "serde");
    },
  );
});

test("workspace members listed via a simple glob (dir/*) are discovered", () => {
  withRepo(
    {
      "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n`,
      "crates/api/Cargo.toml": `[package]\nname = "api"\nversion = "0.1.0"\n`,
      "crates/api/src/lib.rs": `use store::Store;\n\nfn make() -> Store {\n    Store {}\n}\n`,
      "crates/store/Cargo.toml": `[package]\nname = "store"\nversion = "0.1.0"\n`,
      "crates/store/src/lib.rs": `pub struct Store {}\n`,
    },
    (dir) => {
      const index = new ProjectIndex(dir);
      index.rebuild();
      const record = index.imports.find((r) => r.importedName === "Store")!;
      assert.equal(record.resolvedFile, "crates/store/src/lib.rs");
    },
  );
});

test("without a Cargo.toml, single-crate module resolution still works (no regression)", () => {
  withRepo(
    {
      "src/lib.rs": `mod service;\nuse service::run;\n\nfn go() {\n    run();\n}\n`,
      "src/service.rs": `pub fn run() {}\n`,
    },
    (dir) => {
      const index = new ProjectIndex(dir);
      index.rebuild();
      const record = index.imports.find((r) => r.importedName === "run")!;
      assert.equal(record.resolvedFile, "src/service.rs");
    },
  );
});
