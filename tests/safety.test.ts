import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

test("không đọc file ngoài repository root", () => {
  const index = new ProjectIndex(join(process.cwd(), "test-fixtures/java"));
  index.rebuild();
  const symbol = index.resolveSymbol("PaymentService")[0];
  assert.throws(() => index.sourceFor({ ...symbol, filePath: "../outside.java" }), /ngoài repository root/);
});
