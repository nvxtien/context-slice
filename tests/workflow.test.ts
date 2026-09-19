import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { WorkflowError } from "../src/workflow/errors.js";
import { resolveRepositoryRoot } from "../src/workflow/repository.js";

function javaRepository() {
  const root = mkdtempSync(join(tmpdir(), "context-slice-workflow-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(join(root, "src/main/java/Payment.java"), "class Payment { void retry() {} }");
  return root;
}

test("uses an explicit repository path before the nearest Git root", () => {
  const explicit = javaRepository();
  const nested = join(explicit, "src/main");
  const other = javaRepository();
  assert.equal(resolveRepositoryRoot({ cwd: nested, repository: other }), other);
});

test("finds the nearest Git root from a nested directory", () => {
  const root = javaRepository();
  assert.equal(resolveRepositoryRoot({ cwd: join(root, "src/main/java") }), root);
});

test("rejects repositories without Java source", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-empty-"));
  mkdirSync(join(root, ".git"));
  assert.throws(() => resolveRepositoryRoot({ cwd: root }), (error: unknown) => error instanceof WorkflowError && error.code === "NO_SUPPORTED_SOURCE");
});

test("reports uninitialized, stale, and refreshed index states", () => {
  const root = javaRepository();
  const index = new ProjectIndex(root);
  assert.equal(index.inspect().state, "UNINITIALIZED");

  const first = index.refresh();
  assert.equal(first.freshness.state, "CURRENT");
  assert.equal(first.summary.filesParsed, 1);

  writeFileSync(join(root, "src/main/java/Payment.java"), "class Payment { void retry() { save(); } }");
  assert.equal(index.inspect().state, "STALE");

  const refreshed = index.refresh();
  assert.equal(refreshed.freshness.state, "CURRENT");
  assert.equal(refreshed.summary.filesParsed, 1);
});
