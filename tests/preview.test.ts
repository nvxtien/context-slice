import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { estimateTokens } from "../src/planner/budget.js";
import { buildPreview } from "../src/workflow/preview.js";
import { WorkflowError } from "../src/workflow/errors.js";

function indexedFixture() {
  const index = new ProjectIndex(join(process.cwd(), "test-fixtures/java"));
  index.refresh();
  return index;
}

test("preview selects a task target and explains every included item", () => {
  const preview = buildPreview(
    indexedFixture(),
    "explain retryPayment behavior",
  );

  assert.equal(preview.target.name, "retryPayment");
  assert.equal(preview.included[0]?.symbolId, preview.target.id);
  assert.equal(preview.included[0]?.reason, "task target");
  assert.ok(preview.included.every((item) => item.explanation.length > 0));
  assert.ok(preview.included.some((item) => item.reason === "direct caller"));
  assert.ok(preview.estimatedTokens <= preview.budget);
});

test("preview intent ranks related symbols for a symbol slice", () => {
  const index = indexedFixture();
  const target = index.resolveSymbol("PaymentService.retryPayment")[0];
  assert.ok(target);

  const preview = buildPreview(index, target.id, { intent: "audit" });

  const audit = preview.included.findIndex(
    (item) => item.symbol === "demo.PaymentService.audit",
  );
  const controller = preview.included.findIndex(
    (item) => item.symbol === "demo.PaymentController.retry",
  );
  assert.ok(audit >= 0 && controller >= 0 && audit < controller);
});

test("preview stays within a strict budget and explains omissions", () => {
  const index = indexedFixture();
  const target = index
    .resolveSymbol("retryPayment")
    .find((symbol) => symbol.signature?.includes("String id)"));
  assert.ok(target);
  const budget = estimateTokens(target.source) + 1;

  const preview = buildPreview(index, "retryPayment", { budget });

  assert.ok(preview.estimatedTokens <= budget);
  assert.ok(preview.omitted.some((item) => item.reason === "context budget"));
});

test("preview rejects a budget that cannot hold the target source", () => {
  const index = indexedFixture();
  const target = index
    .resolveSymbol("retryPayment")
    .find((symbol) => symbol.signature?.includes("String id)"));
  assert.ok(target);

  assert.throws(
    () =>
      buildPreview(index, "retryPayment", {
        budget: estimateTokens(target.source) - 1,
      }),
    (error: unknown) =>
      error instanceof WorkflowError && error.code === "BUDGET_TOO_SMALL",
  );
});

test("preview reports a baseline (whole-file cost) and the reduction the slice achieves", () => {
  const index = indexedFixture();
  const preview = buildPreview(index, "explain retryPayment behavior");

  const filePaths = new Set(preview.included.map((item) => item.filePath));
  const expectedWholeFileTokens = [...filePaths].reduce(
    (sum, filePath) =>
      sum + estimateTokens(readFileSync(join(index.root, filePath), "utf8")),
    0,
  );

  assert.equal(preview.baseline.files, filePaths.size);
  assert.equal(preview.baseline.wholeFileTokens, expectedWholeFileTokens);
  assert.ok(preview.baseline.wholeFileTokens > preview.estimatedTokens);
  assert.ok(preview.baseline.reduction > 0 && preview.baseline.reduction < 1);
  assert.equal(
    preview.baseline.reduction,
    1 - preview.estimatedTokens / preview.baseline.wholeFileTokens,
  );
});

test("baseline reduction is clamped to [0, 1] and never divides by zero for an empty baseline", () => {
  const preview = buildPreview(indexedFixture(), "explain retryPayment behavior");
  assert.ok(preview.baseline.reduction >= 0 && preview.baseline.reduction <= 1);
});

test("preview keeps benchmark implementations out of the developer context path", () => {
  const source = readFileSync(
    join(process.cwd(), "src/workflow/preview.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /benchmarks\//);
  assert.doesNotMatch(source, /manual-context/);
});
