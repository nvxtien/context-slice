import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeTransactionContext } from "../src/planner/composition.js";
import { buildPreview } from "../src/workflow/preview.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-java-tx-"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/ClinicService.java"),
    [
      "class ClinicService {",
      "    @Transactional(readOnly = true)",
      "    Owner findOwner(long id) { return repository.find(id); }",
      "    void selfCall() { findOwner(1); }",
      "}",
    ].join("\n"),
  );
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("a transactional target with explicit attributes surfaces one composition candidate", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "findOwner")!;
  const candidates = composeTransactionContext(index, target, new Set(), new Set([target.id]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reason, "enterprise relation");
  assert.match(candidates[0].rendered, /readOnly=true/);
});

test("evidence never implies self-invocation triggers proxy behavior", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "findOwner")!;
  const candidates = composeTransactionContext(index, target, new Set(), new Set([target.id]));
  const text = candidates.map((c) => c.rendered + c.evidence.join(" ")).join(" ").toLowerCase();
  assert.ok(!text.includes("proxy"));
  assert.ok(!text.includes("self-invocation") || !text.includes("triggers"));
});

test("composeTransactionContext is a no-op for non-Java targets", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "findOwner")!;
  const fakeRustTarget = { ...target, language: "rust" as const };
  assert.deepEqual(composeTransactionContext(index, fakeRustTarget, new Set(), new Set()), []);
});

test("buildPreview surfaces the transaction line end to end", () => {
  const index = fixture();
  const preview = buildPreview(index, "explain findOwner");
  assert.ok(preview.included.some((item) => item.reason === "enterprise relation"));
});

function rustFixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-tx-guard-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "f"\nversion = "0.1.0"\n');
  writeFileSync(join(root, "src/lib.rs"), "pub fn find_owner() {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("buildPreview on a non-Java target never produces a TRANSACTION_BOUNDARY-sourced composition item", () => {
  const index = rustFixture();
  const preview = buildPreview(index, "find_owner");
  assert.ok(preview.included.every((item) => item.reason !== "enterprise relation"));
});
