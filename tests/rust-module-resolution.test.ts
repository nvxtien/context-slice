import assert from "node:assert/strict";
import test from "node:test";
import {
  rustModuleIndex,
  resolveRustModule,
} from "../src/languages/rust/resolve.js";

const FILES = [
  "src/lib.rs",
  "src/service.rs",
  "src/repository/mod.rs",
  "src/repository/postgres.rs",
];

test("rustModuleIndex maps every file to its module path and back", () => {
  const index = rustModuleIndex(FILES);
  assert.deepEqual(index.byFile.get("src/service.rs"), ["service"]);
  assert.deepEqual(index.byFile.get("src/repository/postgres.rs"), [
    "repository",
    "postgres",
  ]);
  assert.equal(index.byModule.get("service"), "src/service.rs");
  assert.equal(
    index.byModule.get("repository::postgres"),
    "src/repository/postgres.rs",
  );
  assert.equal(index.byModule.get(""), "src/lib.rs");
});

test("crate:: resolves absolutely from any file", () => {
  const index = rustModuleIndex(FILES);
  const resolved = resolveRustModule(
    ["crate", "repository", "postgres", "PostgresRepository"],
    "src/service.rs",
    index,
  );
  assert.equal(resolved.file, "src/repository/postgres.rs");
});

test("super:: resolves relative to the current file's parent module", () => {
  const index = rustModuleIndex(FILES);
  // From src/repository/postgres.rs (module path ["repository","postgres"]),
  // super:: goes to ["repository"] -> src/repository/mod.rs.
  const resolved = resolveRustModule(
    ["super", "OrderRepository"],
    "src/repository/postgres.rs",
    index,
  );
  assert.equal(resolved.file, "src/repository/mod.rs");
});

test("self:: resolves relative to the current file's own module", () => {
  const index = rustModuleIndex(FILES);
  // From src/repository/mod.rs (module path ["repository"]), self::postgres
  // targets ["repository","postgres"] -> src/repository/postgres.rs.
  const resolved = resolveRustModule(
    ["self", "postgres", "PostgresRepository"],
    "src/repository/mod.rs",
    index,
  );
  assert.equal(resolved.file, "src/repository/postgres.rs");
});

test("an anchored target is never external; a module-only miss falls back to the crate root file", () => {
  const index = rustModuleIndex(FILES);
  const resolved = resolveRustModule(
    ["crate", "does_not_exist", "Thing"],
    "src/service.rs",
    index,
  );
  // Full path with a missing module: neither key matches -> unresolved.
  assert.equal(resolved.file, undefined);
  assert.equal(resolved.externalPackage, undefined);
  // Module-only path: documented file-granularity fallback to the crate root.
  const moduleOnly = resolveRustModule(["crate", "nope"], "src/service.rs", index);
  assert.equal(moduleOnly.file, "src/lib.rs");
  assert.equal(moduleOnly.externalPackage, undefined);
});

test("module-only external path is external, not the crate root", () => {
  const index = rustModuleIndex(FILES);
  assert.deepEqual(resolveRustModule(["serde"], "src/service.rs", index), {
    externalPackage: "serde",
  });
  assert.deepEqual(resolveRustModule(["serde"], "src/lib.rs", index), {
    externalPackage: "serde",
  });
});

test("non-anchored path resolves to a child module of the current module first", () => {
  const index = rustModuleIndex(FILES);
  assert.equal(
    resolveRustModule(["postgres"], "src/repository/mod.rs", index).file,
    "src/repository/postgres.rs",
  );
  assert.equal(resolveRustModule(["service"], "src/lib.rs", index).file, "src/service.rs");
});

test("a module named like a dependency never resolves to itself", () => {
  const index = rustModuleIndex([...FILES, "src/serde.rs"]);
  assert.deepEqual(resolveRustModule(["serde"], "src/serde.rs", index), {
    externalPackage: "serde",
  });
});

test("colliding module paths are ambiguous and resolve to nothing", () => {
  const index = rustModuleIndex(["crates/a/src/lib.rs", "crates/b/src/lib.rs"]);
  assert.equal(index.byModule.has(""), false);
  assert.ok(index.ambiguous.has(""));
  assert.deepEqual(resolveRustModule(["crate", "X"], "crates/b/src/lib.rs", index), {});
});

test("a bare (non-anchored) target falling outside the crate is external", () => {
  const index = rustModuleIndex(FILES);
  const resolved = resolveRustModule(["serde", "Serialize"], "src/service.rs", index);
  assert.equal(resolved.file, undefined);
  assert.equal(resolved.externalPackage, "serde");
});
