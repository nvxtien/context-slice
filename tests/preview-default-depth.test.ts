import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { buildPreview } from "../src/workflow/preview.js";

/** outerCaller -> midCaller -> target: outerCaller is two call hops from the target, so a
 * depth-1 default would never discover it, no matter how relevant it is to the task. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-default-depth-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "f"\nversion = "0.1.0"\n',
  );
  writeFileSync(
    join(root, "src/lib.rs"),
    [
      "pub fn target() {}",
      "pub fn mid_caller() { target(); }",
      "pub fn outer_caller_billing_reconciliation() { mid_caller(); }",
    ].join("\n"),
  );
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("a caller-of-a-caller two hops away is considered by default, not just one hop", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "target")!;

  const preview = buildPreview(index, target.id, {
    intent: "billing reconciliation",
  });

  assert.ok(
    preview.included.some(
      (item) => item.symbol === "outer_caller_billing_reconciliation",
    ),
    "a 2-hop caller relevant to the task should be discovered under the default depth",
  );
});
