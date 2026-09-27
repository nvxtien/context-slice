import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";
import { extractEnterpriseRelations, __resetEnterpriseExtractorsForTests } from "../src/languages/java/enterprise/registry.js";
import "../src/languages/java/enterprise/transactions.js"; // side-effect: registers the extractor

function relationsFor(source: string, filePath = "src/main/java/PaymentService.java") {
  const { symbols } = parseJava(filePath, source);
  return { symbols, relations: extractEnterpriseRelations(symbols, filePath, source) };
}

test("a bare @Transactional produces no relation", () => {
  const source = `
class PaymentService {
    @Transactional
    void charge(String id) {}
}
`;
  const { relations } = relationsFor(source);
  assert.equal(relations.length, 0);
});

test("empty-parens @Transactional() behaves the same as bare", () => {
  const source = `
class PaymentService {
    @Transactional()
    void charge(String id) {}
}
`;
  const { relations } = relationsFor(source);
  assert.equal(relations.length, 0);
});

test("readOnly = true is extracted with exact confidence", () => {
  const source = `
class ClinicService {
    @Transactional(readOnly = true)
    Owner findOwner(long id) { return null; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/ClinicService.java");
  const method = symbols.find((s) => s.name === "findOwner")!;
  const rel = relations.find((r) => r.kind === "TRANSACTION_BOUNDARY" && r.sourceSymbolId === method.id)!;
  assert.ok(rel, "expected a TRANSACTION_BOUNDARY relation");
  assert.equal(rel.confidence, "exact");
  assert.equal(rel.targetLabel, "readOnly=true");
  assert.deepEqual(rel.evidence, ["readOnly = true"]);
});

test("multiple explicit attributes are all captured together", () => {
  const source = `
class OrderService {
    @Transactional(readOnly = false, timeout = 30, propagation = Propagation.REQUIRES_NEW)
    void place(String id) {}
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/OrderService.java");
  const method = symbols.find((s) => s.name === "place")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.equal(rel.evidence.length, 3);
  assert.ok(rel.evidence.some((e) => e.includes("readOnly")));
  assert.ok(rel.evidence.some((e) => e.includes("timeout")));
  assert.ok(rel.evidence.some((e) => e.includes("propagation")));
});

test("rollbackFor and noRollbackFor are both recognized", () => {
  const source = `
class RiskyService {
    @Transactional(rollbackFor = IllegalStateException.class, noRollbackFor = ValidationException.class)
    void run() {}
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/RiskyService.java");
  const method = symbols.find((s) => s.name === "run")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.equal(rel.evidence.length, 2);
});

test("isolation is recognized", () => {
  const source = `
class LedgerService {
    @Transactional(isolation = Isolation.SERIALIZABLE)
    void post() {}
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/LedgerService.java");
  const method = symbols.find((s) => s.name === "post")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.equal(rel.evidence.length, 1);
  assert.match(rel.evidence[0], /isolation/);
});

test("@Transactional inside a comment produces no relation", () => {
  const source = `
class PlainUtil {
    // example: @Transactional(readOnly = true)
    void helper() {}
}
`;
  const { relations } = relationsFor(source, "src/main/java/PlainUtil.java");
  assert.equal(relations.length, 0);
});
