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

test("an unresolvable crate/self/super target stays unresolved, never external", () => {
  const index = rustModuleIndex(FILES);
  const resolved = resolveRustModule(
    ["crate", "does_not_exist", "Thing"],
    "src/service.rs",
    index,
  );
  assert.equal(resolved.file, undefined);
  assert.equal(resolved.externalPackage, undefined);
});

test("a bare (non-anchored) target falling outside the crate is external", () => {
  const index = rustModuleIndex(FILES);
  const resolved = resolveRustModule(["serde", "Serialize"], "src/service.rs", index);
  assert.equal(resolved.file, undefined);
  assert.equal(resolved.externalPackage, "serde");
});
