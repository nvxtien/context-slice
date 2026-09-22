import assert from "node:assert/strict";
import test from "node:test";
import type { EnterpriseRelation } from "../src/types/enterprise.js";

test("EnterpriseRelation accepts a fully-specified relation shape", () => {
  const relation: EnterpriseRelation = {
    kind: "ROUTE_TO_HANDLER",
    family: "spring-mvc",
    sourceSymbolId: "OrderController.java::com.example::OrderController::method::update()",
    targetSymbolId: undefined,
    targetLabel: "POST /orders/{id}",
    confidence: "exact",
    evidence: ['@PostMapping("/{id}") on OrderController.update'],
    range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 10 },
    filePath: "OrderController.java",
  };
  assert.equal(relation.kind, "ROUTE_TO_HANDLER");
});
