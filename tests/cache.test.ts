import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ProjectIndex } from "../src/indexer/index.js";
import { INDEX_VERSION } from "../src/storage/sqlite.js";

test("cold cache, warm cache, and updating a single file", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-"));
  mkdirSync(join(root, "java"));
  for (const file of readdirSync(join(process.cwd(), "test-fixtures/java")))
    if (file.endsWith(".java"))
      cpSync(
        join(process.cwd(), "test-fixtures/java", file),
        join(root, "java", file),
      );
  const projectRoot = join(root, "java");
  const first = new ProjectIndex(projectRoot).rebuild();
  const second = new ProjectIndex(projectRoot).rebuild();
  assert.equal(first.filesParsed, 4);
  assert.equal(second.filesParsed, 0);
  assert.equal(second.cacheHits, 4);
  const file = join(projectRoot, "PaymentService.java");
  writeFileSync(file, `${readFileSync(file, "utf8")}\n// changed\n`);
  const third = new ProjectIndex(projectRoot).rebuild();
  assert.equal(third.filesParsed, 1);
  assert.equal(third.cacheHits, 3);
});

test("cached parse errors remain visible and symbol updates count changed files only", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-summary-"));
  writeFileSync(join(root, "broken.ts"), "export function broken( {\n");
  writeFileSync(join(root, "stable.ts"), "export function stable() {}\n");

  const first = new ProjectIndex(root).rebuild();
  assert.equal(first.parseErrors, 1);
  assert.equal(first.symbolsUpdated, 1);

  const second = new ProjectIndex(root).rebuild();
  assert.equal(second.parseErrors, 1);
  assert.equal(second.symbolsUpdated, 0);

  writeFileSync(join(root, "stable.ts"), "export function changed() {}\n");
  const third = new ProjectIndex(root).rebuild();
  assert.equal(third.filesParsed, 1);
  assert.equal(third.symbolsUpdated, 1);
  assert.equal(third.parseErrors, 1);
});

test("persists file signatures and the call graph digest", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-signatures-"));
  writeFileSync(join(root, "main.ts"), "export function main() {}\n");
  new ProjectIndex(root).rebuild();

  const db = new Database(join(root, ".context-slice/index.sqlite"));
  const columns = db.prepare("PRAGMA table_info(files)").all() as Array<{
    name: string;
  }>;
  assert.deepEqual(
    columns.map((column) => column.name),
    [
      "path",
      "content_hash",
      "language",
      "parse_error",
      "indexing_version",
      "size",
      "mtime_ms",
      "ctime_ms",
    ],
  );
  assert.ok(
    (
      db
        .prepare("SELECT value FROM metadata WHERE key = 'calls_digest'")
        .get() as { value?: string } | undefined
    )?.value,
  );
  db.close();
});

test("a new index hydrates a current cache without rebuilding", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-hydrate-"));
  writeFileSync(join(root, "main.ts"), "export function main() {}\n");
  new ProjectIndex(root).rebuild();

  const index = new ProjectIndex(root);
  (index as unknown as { rebuild: () => never }).rebuild = () => {
    throw new Error("rebuild should not run for a current cache");
  };
  const result = index.refreshIfStale();
  assert.equal(result.freshness.state, "CURRENT");
  assert.equal(result.summary.filesParsed, 0);
  assert.equal(result.summary.cacheHits, 1);
});

test("freshness-gated refresh skips unchanged files and notices add/change/delete", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-freshness-"));
  const file = join(root, "main.ts");
  writeFileSync(file, "export function main() {}\n");
  const index = new ProjectIndex(root);

  const first = index.refreshIfStale();
  assert.strictEqual(index.refreshIfStale(), first);

  writeFileSync(file, "export function changed() {}\n");
  const changed = index.refreshIfStale();
  assert.notStrictEqual(changed, first);

  writeFileSync(join(root, "added.ts"), "export function added() {}\n");
  const added = index.refreshIfStale();
  assert.notStrictEqual(added, changed);

  rmSync(file);
  const deleted = index.refreshIfStale();
  assert.notStrictEqual(deleted, added);
});

test("incremental storage keeps unchanged symbols and removes deleted files", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-storage-"));
  writeFileSync(join(root, "a.ts"), "export function alpha() {}\n");
  writeFileSync(join(root, "b.ts"), "export function beta() {}\n");
  new ProjectIndex(root).rebuild();

  writeFileSync(join(root, "a.ts"), "export function changed() {}\n");
  writeFileSync(join(root, "c.ts"), "export function gamma() {}\n");
  new ProjectIndex(root).rebuild();

  const db = new Database(join(root, ".context-slice/index.sqlite"));
  const paths = () =>
    (
      db.prepare("SELECT path FROM files ORDER BY path").all() as Array<{
        path: string;
      }>
    ).map((row) => row.path);
  assert.deepEqual(paths(), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM symbols WHERE file_path = 'b.ts'",
        )
        .get() as { count: number }
    ).count,
    1,
  );

  rmSync(join(root, "b.ts"));
  new ProjectIndex(root).rebuild();
  assert.deepEqual(paths(), ["a.ts", "c.ts"]);
  db.close();
});

test("rebuild writes only changed symbol rows and skips unchanged database writes", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-storage-audit-"));
  writeFileSync(join(root, "a.ts"), "export function alpha() {}\n");
  writeFileSync(join(root, "b.ts"), "export function beta() {}\n");
  new ProjectIndex(root).rebuild();

  const db = new Database(join(root, ".context-slice/index.sqlite"));
  db.exec(
    "CREATE TABLE deleted_symbols(count INTEGER); INSERT INTO deleted_symbols VALUES (0); CREATE TRIGGER audit_symbol_delete AFTER DELETE ON symbols BEGIN UPDATE deleted_symbols SET count = count + 1; END;",
  );
  db.close();

  writeFileSync(join(root, "a.ts"), "export function changed() {}\n");
  new ProjectIndex(root).rebuild();
  const audited = new Database(join(root, ".context-slice/index.sqlite"));
  assert.equal(
    (
      audited.prepare("SELECT count FROM deleted_symbols").get() as {
        count: number;
      }
    ).count,
    1,
  );
  audited
    .prepare(
      "UPDATE metadata SET value = 'sentinel' WHERE key = 'last_refreshed_at'",
    )
    .run();
  audited.close();

  new ProjectIndex(root).rebuild();
  const unchanged = new Database(join(root, ".context-slice/index.sqlite"));
  assert.equal(
    (
      unchanged
        .prepare("SELECT value FROM metadata WHERE key = 'last_refreshed_at'")
        .get() as { value: string }
    ).value,
    "sentinel",
  );
  unchanged.close();
});

test("re-resolves cached calls when a target file changes", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-ts-"));
  writeFileSync(
    join(root, "caller.ts"),
    'import { target } from "./target.js";\nexport function caller() { return target(); }\n',
  );
  writeFileSync(
    join(root, "target.ts"),
    "export function target() { return 1; }\n",
  );

  const index = new ProjectIndex(root);
  index.rebuild();
  const before = index.calls.find((call) => call.calleeName === "target");
  assert.ok(before?.resolvedTargetId);

  writeFileSync(
    join(root, "target.ts"),
    "export function replacement() { return 2; }\n",
  );
  index.rebuild();

  const after = index.calls.find((call) => call.calleeName === "target");
  assert.equal(after?.resolvedTargetId, undefined);
  assert.equal(after?.confidence, "unresolved");
});

test("body-only changes keep unrelated call resolutions cached", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-ts-"));
  writeFileSync(
    join(root, "caller.ts"),
    'import { target } from "./target.js";\nexport function caller() { return target(); }\n',
  );
  writeFileSync(
    join(root, "unrelated.ts"),
    "function helper() { return 1; }\nexport function unrelated() { return helper(); }\n",
  );
  writeFileSync(
    join(root, "target.ts"),
    "export function target() { return 1; }\n",
  );

  const index = new ProjectIndex(root);
  index.rebuild();
  const before = index.calls.find((call) => call.filePath === "unrelated.ts");
  writeFileSync(
    join(root, "target.ts"),
    "export function target() { return 2; }\n",
  );
  const result = index.rebuild();

  assert.equal(result.filesParsed, 1);
  assert.equal(result.cacheHits, 2);
  const after = index.calls.find((call) => call.filePath === "unrelated.ts");
  assert.equal(after?.resolvedTargetId, before?.resolvedTargetId);
});

test("cache directory ignores itself so the target repository stays clean", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-"));
  cpSync(join(process.cwd(), "test-fixtures/java"), root, {
    recursive: true,
    filter: (source) => !source.includes(".context-slice"),
  });
  new ProjectIndex(root).rebuild();
  assert.equal(
    readFileSync(join(root, ".context-slice/.gitignore"), "utf8"),
    "*\n",
  );
});

test("cache written by an unknown schema version is rebuilt, never reused", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-"));
  cpSync(join(process.cwd(), "test-fixtures/java"), root, {
    recursive: true,
    filter: (source) => !source.includes(".context-slice"),
  });
  new ProjectIndex(root).rebuild();
  const db = new Database(join(root, ".context-slice/index.sqlite"));
  db.prepare(
    "UPDATE metadata SET value = '99.0.0' WHERE key = 'schema_version'",
  ).run();
  db.close();
  const index = new ProjectIndex(root);
  assert.equal(index.inspect().state, "UNINITIALIZED");
  const rebuilt = index.rebuild();
  assert.equal(rebuilt.cacheHits, 0);
  assert.equal(index.inspect().schemaVersion, INDEX_VERSION);
});

function rustProject(big: boolean) {
  const root = mkdtempSync(join(tmpdir(), "context-slice-rs-"));
  writeFileSync(join(root, "a.rs"), "use std::io;\npub fn alpha() {}\n");
  const pad = big ? `// ${"x".repeat(40000)}\n` : "";
  writeFileSync(join(root, "big.rs"), `${pad}pub fn beta() {}\n`);
  return root;
}
const names = (i: ProjectIndex) => i.symbols.map((s) => s.name).sort();

test("cache from an older index version is re-parsed, matching a fresh index", () => {
  // 1.1.0 caches hold pre-fix Rust output (empty >32 KiB files, wrong use trees).
  assert.notEqual(INDEX_VERSION, "1.1.0");
  const root = rustProject(false);
  new ProjectIndex(root).rebuild();
  const db = new Database(join(root, ".context-slice/index.sqlite"));
  db.prepare(
    "UPDATE metadata SET value = '0.0.0-old' WHERE key = 'schema_version'",
  ).run();
  db.close();
  const index = new ProjectIndex(root);
  const rebuilt = index.rebuild();
  assert.ok(rebuilt.filesParsed > 0);
  assert.equal(rebuilt.cacheHits, 0);
  assert.equal(index.inspect().schemaVersion, INDEX_VERSION);
  const fresh = new ProjectIndex(rustProject(false));
  fresh.rebuild();
  assert.deepEqual(names(index), names(fresh));
});

test("large Rust file cached empty under an old version is repopulated", () => {
  const root = rustProject(true);
  new ProjectIndex(root).rebuild();
  const db = new Database(join(root, ".context-slice/index.sqlite"));
  db.prepare("DELETE FROM symbols WHERE file_path = 'big.rs'").run();
  db.prepare(
    "UPDATE metadata SET value = '0.0.0-old' WHERE key = 'schema_version'",
  ).run();
  db.close();
  const index = new ProjectIndex(root);
  index.rebuild();
  assert.ok(index.symbols.some((s) => s.name === "beta"));
});

test("corrupt cache fails with an actionable INDEX_CORRUPT error", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-"));
  cpSync(join(process.cwd(), "test-fixtures/java"), root, {
    recursive: true,
    filter: (source) => !source.includes(".context-slice"),
  });
  mkdirSync(join(root, ".context-slice"), { recursive: true });
  writeFileSync(join(root, ".context-slice/index.sqlite"), "not a database");
  assert.throws(
    () => new ProjectIndex(root),
    (error: any) =>
      error.code === "INDEX_CORRUPT" &&
      /rm -rf \.context-slice/.test(error.remediation),
  );
});
