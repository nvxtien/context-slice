import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeImportContext } from "../src/planner/composition.js";
import { buildPreview } from "../src/workflow/preview.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-import-ctx-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "f"\nversion = "0.1.0"\n',
  );
  writeFileSync(join(root, "src/lib.rs"), "pub mod a;\npub mod b;\n");
  writeFileSync(
    join(root, "src/a.rs"),
    "use crate::b::helper;\n\npub fn target() {}\n\npub fn caller_one() { target(); }\n\npub fn caller_two() { target(); }\n",
  );
  writeFileSync(join(root, "src/b.rs"), "pub fn helper() {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("import context attaches a caller file's use declarations once, not per caller", () => {
  const index = fixture();
  const target = index.symbols.find(
    (s) => s.name === "target" && s.kind === "function",
  )!;
  const candidates = composeImportContext(
    index,
    target,
    new Set(["src/a.rs"]),
    new Set([target.id]),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reason, "file imports");
  assert.match(candidates[0].rendered, /use crate::b::helper;/);
});

test("import context is empty for a file with no top-level use declarations", () => {
  const index = fixture();
  const target = index.symbols.find(
    (s) => s.name === "helper" && s.kind === "function",
  )!;
  const candidates = composeImportContext(
    index,
    target,
    new Set(["src/b.rs"]),
    new Set([target.id]),
  );
  assert.equal(candidates.length, 0);
});

test("import context is a no-op for non-Rust targets", () => {
  const index = fixture(); // language mismatch is checked on the symbol, not the index
  const target = index.symbols.find((s) => s.name === "target")!;
  const fakeJavaTarget = { ...target, language: "java" as const };
  assert.deepEqual(
    composeImportContext(
      index,
      fakeJavaTarget,
      new Set(["src/a.rs"]),
      new Set(),
    ),
    [],
  );
});

function crossFileFixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-import-ctx-e2e-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "f"\nversion = "0.1.0"\n',
  );
  writeFileSync(join(root, "src/lib.rs"), "pub mod a;\npub mod b;\n");
  writeFileSync(
    join(root, "src/a.rs"),
    "use crate::b::helper;\n\npub fn caller() { helper(); }\n",
  );
  writeFileSync(join(root, "src/b.rs"), "pub fn helper() {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("buildPreview surfaces a caller file's use declarations for a Rust target", () => {
  const index = crossFileFixture();
  const preview = buildPreview(index, "helper");
  assert.equal(preview.target.name, "helper");
  const importItem = preview.included.find(
    (item) => item.reason === "file imports",
  );
  assert.ok(importItem, "expected an included item with reason 'file imports'");
  assert.match(importItem!.rendered, /use crate::b::helper;/);
  assert.equal(importItem!.filePath, "src/a.rs");
});

test("buildPreview on a non-Rust target never produces a 'file imports' item", () => {
  const index = new ProjectIndex(join(process.cwd(), "test-fixtures/java"));
  index.refresh();
  const preview = buildPreview(index, "explain retryPayment behavior");
  assert.ok(preview.included.every((item) => item.reason !== "file imports"));
});

function multiCallerFixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-import-ctx-multi-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "f"\nversion = "0.1.0"\n',
  );
  writeFileSync(join(root, "src/lib.rs"), "pub mod a;\npub mod b;\n");
  // Both callers of `target` live in src/a.rs (not target's own file, src/b.rs).
  writeFileSync(
    join(root, "src/a.rs"),
    "use crate::b::target;\n\npub fn caller_one() { target(); }\n\npub fn caller_two() { target(); }\n",
  );
  writeFileSync(join(root, "src/b.rs"), "pub fn target() {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("buildPreview dedups a file's imports across multiple callers in the same file", () => {
  const index = multiCallerFixture();
  const preview = buildPreview(index, "target");
  const callers = preview.included.filter(
    (item) => item.reason === "direct caller",
  );
  assert.equal(
    callers.length,
    2,
    "expected both caller_one and caller_two to be included",
  );
  const importItems = preview.included.filter(
    (item) => item.reason === "file imports" && item.filePath === "src/a.rs",
  );
  assert.equal(
    importItems.length,
    1,
    "expected exactly one 'file imports' item for src/a.rs, not one per caller",
  );
});

function largeImportBlockFixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-import-ctx-budget-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "f"\nversion = "0.1.0"\n',
  );
  writeFileSync(join(root, "src/lib.rs"), "pub mod a;\npub mod b;\n");
  // A caller file whose import block alone is a few hundred tokens (~500),
  // to force the composition-budget-share cap to trip deterministically.
  const uses = [
    "use crate::b::target;",
    ...Array.from(
      { length: 80 },
      (_, i) => `use crate::generated::module_${i}::Item${i};`,
    ),
  ].join("\n");
  writeFileSync(
    join(root, "src/a.rs"),
    `${uses}\n\npub fn caller() { target(); }\n`,
  );
  writeFileSync(join(root, "src/b.rs"), "pub fn target() {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("buildPreview omits an import candidate that would exceed the composition budget share", () => {
  const index = largeImportBlockFixture();
  // A small budget keeps compositionAllowance (35% of budget) well under the
  // caller file's ~500-token import block, so the import candidate must be
  // omitted rather than silently dropped or silently pushed over budget.
  const budget = 600;
  const allowance = Math.floor(budget * 0.35);
  const preview = buildPreview(index, "target", { budget });
  const importItem = preview.included.find(
    (item) => item.reason === "file imports",
  );
  const omittedImport = preview.omitted.find(
    (item) =>
      item.reason === "composition budget share" &&
      item.symbol === "Imports in src/a.rs",
  );
  assert.ok(
    !importItem,
    "the oversized import block must not be included once it exceeds the composition allowance",
  );
  assert.ok(
    omittedImport,
    "expected the import candidate to be reported in `omitted`",
  );
  assert.ok(
    omittedImport!.estimatedTokens > allowance,
    "the omitted candidate's token count should actually exceed the allowance that caused the omission",
  );
});
