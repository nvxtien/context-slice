import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

test("cache lạnh, cache ấm và cập nhật một file", () => {
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
