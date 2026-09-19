import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJava } from "../src/parser/java-parser.js";

test("trích xuất class, method, annotation và call", () => {
  const file = join(process.cwd(), "test-fixtures/java/PaymentService.java");
  const parsed = parseJava("PaymentService.java", readFileSync(file, "utf8"));
  assert.ok(parsed.symbols.some((s) => s.kind === "class" && s.name === "PaymentService"));
  const methods = parsed.symbols.filter((s) => s.name === "retryPayment");
  assert.equal(methods.length, 2);
  assert.ok(parsed.calls.some((c) => c.calleeName === "save"));
});
