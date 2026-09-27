import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeTransactionContext } from "../src/planner/composition.js";
import "../src/languages/java/enterprise/transactions.js"; // side-effect: registers the extractor

const root = mkdtempSync(join(tmpdir(), "context-slice-java-enterprise-tx-"));
cpSync(join(process.cwd(), "tests/fixtures/java-enterprise"), root, { recursive: true });
const index = new ProjectIndex(root);
index.rebuild();

const relationsFor = (fileName: string) =>
  index.enterpriseRelations.filter(
    (relation) =>
      relation.kind === "TRANSACTION_BOUNDARY" && relation.filePath.split("/").pop() === fileName,
  );

test("bare-transactional-negative: a bare @Transactional method produces zero relations", () => {
  assert.equal(relationsFor("BareTransactionalService.java").length, 0);
});

test("comment-negative: @Transactional mentioned only in a comment produces zero relations", () => {
  assert.equal(relationsFor("TransactionalCommentedWidget.java").length, 0);
});

test("readOnly: matches the real-repository pattern (readOnly = true only)", () => {
  const relations = relationsFor("TransactionalReadOnlyService.java");
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetLabel, "readOnly=true");
  assert.deepEqual(relations[0].evidence, ["readOnly = true"]);
});

test("multi-attribute: readOnly, timeout, and propagation are all captured together", () => {
  const relations = relationsFor("TransactionalMultiAttributeService.java");
  assert.equal(relations.length, 1);
  assert.equal(relations[0].evidence.length, 3);
  assert.equal(relations[0].targetLabel, "readOnly=false, timeout=30, propagation=Propagation.REQUIRES_NEW");
});

test("self-invocation: the callee's own relation exists, keyed to the callee method only", () => {
  const relations = relationsFor("SelfInvokedTransactionalService.java");
  assert.equal(relations.length, 1);
  const callee = index.symbols.find(
    (s) => s.name === "findById" && s.filePath.endsWith("SelfInvokedTransactionalService.java"),
  )!;
  assert.equal(relations[0].sourceSymbolId, callee.id);
});

test("self-invocation: composed evidence for the caller never implies proxy interception across the self-call", () => {
  const caller = index.symbols.find(
    (s) => s.name === "lookupOrder" && s.filePath.endsWith("SelfInvokedTransactionalService.java"),
  )!;
  const callee = index.symbols.find(
    (s) => s.name === "findById" && s.filePath.endsWith("SelfInvokedTransactionalService.java"),
  )!;

  // Both caller and callee are in the composed slice (caller is the target, callee is an
  // already-included related symbol reached via the self-call) — the scenario Review Focus
  // item 3 calls out.
  const candidates = composeTransactionContext(
    index,
    caller,
    new Set([callee.id]),
    new Set([caller.id, callee.id]),
  );

  // Exactly one candidate: the callee's own static attribute, not a claim about the call.
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].rendered, /readOnly=true/);

  const text = candidates
    .map((c) => c.rendered + " " + c.evidence.join(" "))
    .join(" ")
    .toLowerCase();
  assert.ok(!text.includes("proxy"));
  assert.ok(!text.includes("self-invocation") || !text.includes("triggers"));
  // Broader read: nothing here should read as a claim about what happens when lookupOrder
  // calls findById — only findById's own written attribute value is stated.
  assert.ok(!text.includes("applies"));
  assert.ok(!text.includes("bypass"));
  assert.ok(!text.includes("intercept"));
});

test.after(() => rmSync(root, { recursive: true, force: true }));
