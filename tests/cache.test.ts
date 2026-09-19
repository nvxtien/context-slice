import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

test("cache lạnh, cache ấm và cập nhật một file", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-"));
  mkdirSync(join(root, "java"));
  for (const file of readdirSync(join(process.cwd(), "test-fixtures/java"))) if (file.endsWith(".java")) cpSync(join(process.cwd(), "test-fixtures/java", file), join(root, "java", file));
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
