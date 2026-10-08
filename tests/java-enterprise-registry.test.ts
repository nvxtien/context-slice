import assert from "node:assert/strict";
import test from "node:test";
import {
  registerEnterpriseExtractor,
  extractEnterpriseRelations,
  createEnterpriseRegistry,
  __resetEnterpriseExtractorsForTests,
} from "../src/languages/java/enterprise/registry.js";
import type { EnterpriseRelation } from "../src/types/enterprise.js";

test("returns no relations when no extractor is registered", () => {
  __resetEnterpriseExtractorsForTests();
  assert.deepEqual(extractEnterpriseRelations([], "A.java", "class A {}"), []);
});

test("aggregates relations from every registered extractor", () => {
  __resetEnterpriseExtractorsForTests();
  const relation: EnterpriseRelation = {
    kind: "ROUTE_TO_HANDLER",
    family: "spring-mvc",
    sourceSymbolId: "x",
    confidence: "exact",
    evidence: ["test"],
    range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
    filePath: "A.java",
  };
  registerEnterpriseExtractor(() => [relation]);
  registerEnterpriseExtractor(() => []);
  assert.deepEqual(extractEnterpriseRelations([], "A.java", "class A {}"), [
    relation,
  ]);
});

test("enterprise registry instances do not share registrations", () => {
  __resetEnterpriseExtractorsForTests();
  const first = createEnterpriseRegistry();
  const second = createEnterpriseRegistry();
  const relation: EnterpriseRelation = {
    kind: "ROUTE_TO_HANDLER",
    family: "spring-mvc",
    sourceSymbolId: "isolated",
    confidence: "exact",
    evidence: [],
    range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
    filePath: "A.java",
  };
  first.registerExtractor(() => [relation]);
  assert.deepEqual(first.extractRelations([], "A.java", ""), [relation]);
  assert.deepEqual(second.extractRelations([], "A.java", ""), []);
});
