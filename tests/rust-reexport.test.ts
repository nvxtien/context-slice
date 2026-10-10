import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

function loadFixture() {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-modules-"));
  cpSync(join(process.cwd(), "tests/fixtures/rust-modules"), dir, {
    recursive: true,
  });
  const index = new ProjectIndex(dir);
  index.rebuild();
  return { dir, index };
}

test("crate:: and super:: imports resolve to the right files", () => {
  const { dir, index } = loadFixture();
  const serviceImports = index.imports.filter((i) =>
    i.filePath.endsWith("service.rs"),
  );
  const orderRepoImport = serviceImports.find(
    (i) => i.importedName === "OrderRepository",
  );
  assert.ok(orderRepoImport, "OrderRepository import not found");
  assert.ok(
    orderRepoImport!.resolvedFile?.endsWith("repository/mod.rs"),
    `expected repository/mod.rs, got ${orderRepoImport!.resolvedFile}`,
  );

  const aliasedImport = serviceImports.find((i) => i.localName === "Postgres");
  assert.ok(aliasedImport, "aliased Postgres import not found");
  assert.ok(
    aliasedImport!.resolvedFile?.endsWith("repository/postgres.rs"),
    `expected repository/postgres.rs, got ${aliasedImport!.resolvedFile}`,
  );

  const postgresImports = index.imports.filter((i) =>
    i.filePath.endsWith("repository/postgres.rs"),
  );
  const superImport = postgresImports.find((i) => i.module === "super");
  assert.ok(superImport, "super:: import not found");
  assert.ok(
    superImport!.resolvedFile?.endsWith("repository/mod.rs"),
    `expected repository/mod.rs, got ${superImport!.resolvedFile}`,
  );
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

test("pub use re-exports resolve to the file they point at", () => {
  const { dir, index } = loadFixture();
  const libExports = index.exports.filter((e) => e.filePath.endsWith("lib.rs"));
  const orderServiceExport = libExports.find(
    (e) => e.exportedName === "OrderService",
  );
  assert.ok(orderServiceExport, "OrderService re-export not found");
  assert.ok(
    orderServiceExport!.resolvedFile?.endsWith("service.rs"),
    `expected service.rs, got ${orderServiceExport!.resolvedFile}`,
  );

  const repoExports = index.exports.filter((e) =>
    e.filePath.endsWith("repository/mod.rs"),
  );
  const postgresExport = repoExports.find(
    (e) => e.exportedName === "PostgresRepository",
  );
  assert.ok(postgresExport, "self:: pub use re-export not found");
  assert.ok(
    postgresExport!.resolvedFile?.endsWith("repository/postgres.rs"),
    `expected repository/postgres.rs, got ${postgresExport!.resolvedFile}`,
  );
  index.close();
  rmSync(dir, { recursive: true, force: true });
});
