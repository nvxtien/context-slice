import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isDirty } from "../src/storage/dirty-marker.js";
import { ProjectFileWatcher } from "../src/storage/file-watcher.js";

test("file watcher marks source changes dirty", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-watcher-"));
  const watcher = new ProjectFileWatcher(root);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!watcher.active) {
      t.skip("filesystem watching is unavailable in this runtime");
      return;
    }
    writeFileSync(join(root, "main.ts"), "export const changed = true;\n");
    for (let attempt = 0; attempt < 20 && !isDirty(root); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(isDirty(root), true);
  } finally {
    watcher.close();
  }
});

test("file watcher marks nested source changes dirty", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-nested-watcher-"));
  mkdirSync(join(root, "src"));
  const watcher = new ProjectFileWatcher(root);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!watcher.active) {
      t.skip("filesystem watching is unavailable in this runtime");
      return;
    }
    writeFileSync(
      join(root, "src", "main.ts"),
      "export const changed = true;\n",
    );
    for (let attempt = 0; attempt < 20 && !isDirty(root); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(isDirty(root), true);
  } finally {
    watcher.close();
  }
});
