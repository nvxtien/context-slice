import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import "../src/languages/java/enterprise/jpa-entity.js"; // side-effect: registers extractor + resolver
import "../src/languages/java/enterprise/spring-data.js"; // side-effect: registers extractor + resolver

const root = mkdtempSync(join(tmpdir(), "context-slice-java-enterprise-jpa-"));
cpSync(join(process.cwd(), "tests/fixtures/java-enterprise"), root, {
  recursive: true,
});
const index = new ProjectIndex(root);
index.rebuild();

const relationsFor = (fileName: string) =>
  index.enterpriseRelations.filter(
    (relation) => relation.filePath.split("/").pop() === fileName,
  );

test("JpaEntityWithRelations: collection @OneToMany and bare @ManyToOne both resolve exact", () => {
  const relations = relationsFor("JpaEntityWithRelations.java").filter(
    (r) => r.kind === "ENTITY_RELATION",
  );
  assert.equal(relations.length, 2);

  const toLines = relations.find((r) => r.targetLabel === "WorkOrderLine")!;
  assert.ok(toLines, "expected an ENTITY_RELATION targeting WorkOrderLine");
  assert.equal(toLines.confidence, "exact");
  assert.ok(toLines.targetSymbolId);
  assert.match(toLines.evidence.join(" "), /OneToMany.*lines/);
  assert.match(toLines.evidence.join(" "), /fetch = FetchType.LAZY/);
  assert.match(toLines.evidence.join(" "), /cascade = CascadeType.ALL/);
  assert.match(
    toLines.evidence.join(" "),
    /@JoinColumn\(name = "work_order_id"\)/,
  );

  const toTechnician = relations.find((r) => r.targetLabel === "Technician")!;
  assert.ok(toTechnician, "expected an ENTITY_RELATION targeting Technician");
  assert.equal(toTechnician.confidence, "exact");
  assert.ok(toTechnician.targetSymbolId);
  assert.match(
    toTechnician.evidence.join(" "),
    /ManyToOne.*assignedTechnician/,
  );
  // Bare @ManyToOne: no explicit fetch/cascade/mappedBy anywhere in its evidence.
  const bareEvidence = toTechnician.evidence.join(" ");
  assert.ok(!bareEvidence.includes("fetch"));
  assert.ok(!bareEvidence.includes("cascade"));
  assert.ok(!bareEvidence.includes("mappedBy"));
});

test("JpaEntityBidirectional + InvoicePayment: mappedBy on the inverse side, @JoinColumn on the owning side", () => {
  const inverse = relationsFor("JpaEntityBidirectional.java").filter(
    (r) => r.kind === "ENTITY_RELATION",
  );
  assert.equal(inverse.length, 1);
  assert.equal(inverse[0].targetLabel, "InvoicePayment");
  assert.equal(inverse[0].confidence, "exact");
  assert.match(inverse[0].evidence.join(" "), /mappedBy = "invoice"/);

  const owning = relationsFor("InvoicePayment.java").filter(
    (r) => r.kind === "ENTITY_RELATION",
  );
  assert.equal(owning.length, 1);
  assert.equal(owning[0].targetLabel, "Invoice");
  assert.equal(owning[0].confidence, "exact");
  assert.match(
    owning[0].evidence.join(" "),
    /@JoinColumn\(name = "invoice_id"\)/,
  );
  assert.ok(!owning[0].evidence.join(" ").includes("mappedBy"));
});

test("JpaRepositoryInterface: extends JpaRepository<WorkOrder, Long> with one derived-query method", () => {
  const relations = relationsFor("JpaRepositoryInterface.java");
  const persists = relations.find((r) => r.kind === "PERSISTS_ENTITY")!;
  assert.ok(persists);
  assert.equal(persists.targetLabel, "WorkOrder");
  assert.equal(persists.confidence, "exact");
  assert.ok(persists.targetSymbolId);
  assert.match(
    persists.evidence.join(" "),
    /extends JpaRepository<WorkOrder, Long>/,
  );

  const query = relations.find((r) => r.kind === "REPOSITORY_QUERY")!;
  assert.ok(query);
  assert.equal(query.confidence, "exact");
  assert.match(query.evidence.join(" "), /property: description/);
});

test("JpaRepositoryDerivedQuery: compound And-joined derived query splits at the real word boundary", () => {
  const relations = relationsFor("JpaRepositoryDerivedQuery.java");
  const persists = relations.find((r) => r.kind === "PERSISTS_ENTITY")!;
  assert.equal(persists.targetLabel, "WorkOrderLine");
  assert.equal(persists.confidence, "exact");

  const query = relations.find((r) => r.kind === "REPOSITORY_QUERY")!;
  const evidenceText = query.evidence.join(" ");
  assert.match(evidenceText, /property: partName/);
  assert.match(evidenceText, /property: quantity/);
});

test("JpaRepositoryWithQuery: @Query text captured verbatim, no derived-query properties", () => {
  const relations = relationsFor("JpaRepositoryWithQuery.java");
  const persists = relations.find((r) => r.kind === "PERSISTS_ENTITY")!;
  assert.equal(persists.targetLabel, "Technician");
  assert.equal(persists.confidence, "exact");

  const query = relations.find((r) => r.kind === "REPOSITORY_QUERY")!;
  assert.ok(query);
  assert.equal(query.confidence, "exact");
  assert.ok(
    query.evidence.some((e) =>
      e.includes("SELECT t FROM Technician t WHERE t.active = true"),
    ),
  );
  assert.ok(!query.evidence.some((e) => e.startsWith("property:")));
});

test("AmbiguousJpaRelationEntity: two same-simple-name Status entities never guess a winner", () => {
  const relations = relationsFor("AmbiguousJpaRelationEntity.java").filter(
    (r) => r.kind === "ENTITY_RELATION",
  );
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetLabel, "Status");
  assert.equal(relations[0].confidence, "unresolved");
  assert.equal(relations[0].targetSymbolId, undefined);
});

test("JpaEntityCommentedWidget: @Entity/@OneToMany mentioned only in comments produce no relation", () => {
  const relations = relationsFor("JpaEntityCommentedWidget.java");
  assert.equal(relations.length, 0);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
