import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { buildPreview } from "../src/workflow/preview.js";

/** A target whose enclosing-type skeleton (composeSiblings, processed first in the fixed
 * concatenation order) is irrelevant to the task text, while its DI dependency relation
 * (composeDependencyContext, processed fourth) names the task's exact concern. Before the
 * fix, the composition budget was spent in source order — the irrelevant skeleton would claim
 * it and the relevant dependency would be omitted purely for being discovered later. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-composition-ranking-"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/OrderService.java"),
    [
      "@Service",
      "class OrderService {",
      "    private final BillingGateway billingGateway;",
      "    OrderService(BillingGateway billingGateway) { this.billingGateway = billingGateway; }",
      "    Order create(long id) { return billingGateway.charge(id); }",
      "    void unrelatedOne() {}",
      "    void unrelatedTwo() {}",
      "    void unrelatedThree() {}",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src/main/java/BillingGateway.java"),
    [
      "class BillingGateway {",
      "    Order charge(long id) { return null; }",
      "}",
    ].join("\n"),
  );
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("a relevant dependency relation is not starved by an earlier, irrelevant sibling skeleton", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "create")!;

  // A budget that leaves just enough composition share for ONE of: the sibling skeleton or
  // the dependency relation line, never both — forcing the ranking to pick.
  const preview = buildPreview(index, target.id, {
    intent: "billing gateway charge",
    budget: 260,
  });

  const dependency = preview.included.find(
    (item) => item.reason === "enterprise relation",
  );
  const siblingSkeleton = preview.included.find(
    (item) => item.reason === "enclosing type",
  );
  assert.ok(
    dependency,
    "the billing-gateway dependency, which matches the task, should win the composition share",
  );
  assert.equal(
    siblingSkeleton,
    undefined,
    "the irrelevant sibling skeleton should lose out, not claim the share by being processed first",
  );
});
