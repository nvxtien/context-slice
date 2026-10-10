import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import "../src/languages/java/enterprise/dependency-injection.js"; // side-effect: registers the extractor

const root = mkdtempSync(join(tmpdir(), "context-slice-java-enterprise-di-"));
cpSync(join(process.cwd(), "tests/fixtures/java-enterprise"), root, {
  recursive: true,
});
const index = new ProjectIndex(root);
index.rebuild();

const injectionsFor = (fileName: string) =>
  index.enterpriseRelations.filter(
    (relation) =>
      relation.kind === "INJECTS_DEPENDENCY" &&
      relation.filePath.split("/").pop() === fileName,
  );

test("constructor-injection: a Spring-stereotyped service resolves its repository as exact", () => {
  const relations = injectionsFor("ConstructorInjectionService.java");
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetLabel, "OrderRepository");
  assert.equal(relations[0].confidence, "exact");
  assert.ok(relations[0].targetSymbolId);
  assert.match(relations[0].evidence.join(" "), /constructor parameter/);
});

test("field-injection: an @Autowired field on a @Service resolves as exact", () => {
  const relations = injectionsFor("FieldInjectionService.java");
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetLabel, "NotificationGateway");
  assert.equal(relations[0].confidence, "exact");
  assert.ok(relations[0].targetSymbolId);
  assert.match(relations[0].evidence.join(" "), /@Autowired field/);
});

test("qualifier-negative: @Qualifier evidence is captured but cannot break a simple-name tie", () => {
  const relations = injectionsFor("QualifierService.java");
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetLabel, "Validator");
  // Two project classes share the simple name "Validator" — resolution stays unresolved
  // even though a @Qualifier is present, per §14: the qualifier is evidence-only here.
  assert.equal(relations[0].confidence, "unresolved");
  assert.equal(relations[0].targetSymbolId, undefined);
  assert.match(relations[0].evidence.join(" "), /@Qualifier\("Validator"\)/);
});

test("ambiguous-bean-negative: two same-simple-name candidates with no qualifier never guess a winner", () => {
  const relations = injectionsFor("AmbiguousBeanService.java");
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetLabel, "PricingEngine");
  assert.equal(relations[0].confidence, "unresolved");
  assert.equal(relations[0].targetSymbolId, undefined);
});

test("comment-negative: an @Autowired mentioned only in a comment produces no relation", () => {
  const relations = injectionsFor("CommentAutowiredWidget.java");
  assert.equal(relations.length, 0);
});

test.after(() => {
  index.close();
  rmSync(root, { recursive: true, force: true });
});
