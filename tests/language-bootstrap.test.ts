import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { ensureLanguageBootstrap } from "../src/languages/bootstrap.js";
import { languages } from "../src/languages/adapter.js";
import { resolveRepositoryRoot } from "../src/workflow/repository.js";

test("one bootstrap exposes every adapter to indexing and workflow", () => {
  ensureLanguageBootstrap();
  const ids = languages()
    .map((adapter) => adapter.id)
    .sort();
  assert.deepEqual(ids, [
    "go",
    "java",
    "javascript",
    "python",
    "rust",
    "typescript",
  ]);

  const root = mkdtempSync(join(tmpdir(), "context-slice-rust-workflow-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/lib.rs"), "pub fn run() {}\n");
  assert.equal(resolveRepositoryRoot({ cwd: root }), root);

  writeFileSync(
    join(root, "Controller.java"),
    '@RestController\nclass Controller { @GetMapping("/health") void health() {} }\n',
  );
  const index = new ProjectIndex(root);
  index.rebuild();
  assert.ok(
    index.enterpriseRelations.some(
      (relation) => relation.kind === "ROUTE_TO_HANDLER",
    ),
  );
});
