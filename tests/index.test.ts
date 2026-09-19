import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

test("index tìm được symbol và caller", () => {
  const index = new ProjectIndex(join(process.cwd(), "test-fixtures/java"));
  const summary = index.rebuild();
  assert.ok(summary.symbols > 0);
  assert.equal(index.resolveSymbol("retryPayment").length, 2);
  const service = index.resolveSymbol("PaymentService.retryPayment")[0];
  assert.ok(service);
  assert.ok(index.callers(service).some((s) => s.name === "retry"));
});
