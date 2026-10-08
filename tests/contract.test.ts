import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { INDEX_VERSION, IndexStorage } from "../src/storage/sqlite.js";
import type { IndexStore } from "../src/storage/index-snapshot.js";
import { WorkflowError } from "../src/workflow/errors.js";

test("caller depth expands transitively", () => {
  const index = new ProjectIndex(join(process.cwd(), "test-fixtures/java"));
  index.rebuild();
  const target = index.resolveSymbol("PaymentService.retryPayment")[0];
  assert.ok(target);
  assert.ok(
    index.callersAtDepth(target, 1).some((symbol) => symbol.name === "retry"),
  );
  assert.ok(
    index.callersAtDepth(target, 2).length >=
      index.callersAtDepth(target, 1).length,
  );
});

test("file records use the current index version", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-version-"));
  const fixture = join(process.cwd(), "test-fixtures/java/PaymentService.java");
  const destination = join(root, "PaymentService.java");
  copyFileSync(fixture, destination);
  new ProjectIndex(root).rebuild();
  const db = new Database(join(root, ".context-slice/index.sqlite"));
  const row = db
    .prepare("SELECT indexing_version FROM files WHERE path = ?")
    .get("PaymentService.java") as { indexing_version: string };
  assert.equal(row.indexing_version, INDEX_VERSION);
  db.close();
});

test("SQLite implements the storage boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-store-boundary-"));
  const store: IndexStore = new IndexStorage(root);
  assert.ok(store.metadata());
  store.close();
});

test("corrupt cached JSON raises an actionable index error", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-corrupt-payload-"));
  const storage = new IndexStorage(root);
  storage.save({
    files: new Map(),
    symbols: [],
    calls: [],
    imports: [],
    exports: [],
  });
  storage.close();

  const db = new Database(join(root, ".context-slice/index.sqlite"));
  db.prepare(
    "INSERT INTO symbols(id, file_path, language, payload) VALUES (?, ?, ?, ?)",
  ).run("broken", "Broken.java", "java", "not json");
  db.close();

  assert.throws(
    () => new IndexStorage(root).load(),
    (error: unknown) =>
      error instanceof WorkflowError && error.code === "INDEX_CORRUPT",
  );
});
