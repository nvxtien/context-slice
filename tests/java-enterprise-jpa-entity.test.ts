import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";
import { extractEnterpriseRelations, resolveEnterpriseRelations, __resetEnterpriseExtractorsForTests } from "../src/languages/java/enterprise/registry.js";
import "../src/languages/java/enterprise/jpa-entity.js"; // side-effect: registers extractor + resolver

function relationsFor(files: Record<string, string>) {
  const allSymbols = [];
  const perFile: { symbols: any[]; relations: any[] }[] = [];
  for (const [filePath, source] of Object.entries(files)) {
    const { symbols } = parseJava(filePath, source);
    allSymbols.push(...symbols);
    perFile.push({ symbols, relations: extractEnterpriseRelations(symbols, filePath, source) });
  }
  const provisional = perFile.flatMap((f) => f.relations);
  const resolved = resolveEnterpriseRelations(provisional, allSymbols);
  return { symbols: allSymbols, relations: resolved };
}

test("a collection-typed @OneToMany resolves its unwrapped element type", () => {
  const owner = `
@Entity
class Owner {
    @OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)
    @JoinColumn(name = "owner_id")
    private final java.util.List<Pet> pets = new java.util.ArrayList<>();
}
`;
  const pet = `@Entity\nclass Pet {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/Owner.java": owner, "src/main/java/Pet.java": pet });
  const ownerClass = symbols.find((s) => s.name === "Owner")!;
  const petClass = symbols.find((s) => s.name === "Pet")!;
  const rel = relations.find((r) => r.kind === "ENTITY_RELATION" && r.sourceSymbolId === ownerClass.id)!;
  assert.ok(rel, "expected an ENTITY_RELATION for Owner.pets");
  assert.equal(rel.targetSymbolId, petClass.id);
  assert.equal(rel.targetLabel, "Pet");
  assert.equal(rel.confidence, "exact");
  assert.match(rel.evidence.join(" "), /OneToMany.*pets/);
  assert.match(rel.evidence.join(" "), /fetch = FetchType.EAGER/);
  assert.match(rel.evidence.join(" "), /cascade = CascadeType.ALL/);
});

test("no explicit fetch/cascade/mappedBy means none appear in evidence", () => {
  const order = `@Entity\nclass Order {\n    @ManyToOne\n    private Customer customer;\n}`;
  const customer = `@Entity\nclass Customer {}`;
  const { relations } = relationsFor({ "src/main/java/Order.java": order, "src/main/java/Customer.java": customer });
  const rel = relations.find((r) => r.kind === "ENTITY_RELATION")!;
  const text = rel.evidence.join(" ");
  assert.ok(!text.includes("fetch"));
  assert.ok(!text.includes("cascade"));
  assert.ok(!text.includes("mappedBy"));
});

test("a bidirectional relationship's explicit mappedBy is captured", () => {
  const order = `@Entity\nclass Order {\n    @OneToMany(mappedBy = "order")\n    private java.util.List<OrderItem> items;\n}`;
  const item = `@Entity\nclass OrderItem {}`;
  const { relations } = relationsFor({ "src/main/java/Order.java": order, "src/main/java/OrderItem.java": item });
  const rel = relations.find((r) => r.kind === "ENTITY_RELATION")!;
  assert.match(rel.evidence.join(" "), /mappedBy = "order"/);
});

test("a relationship target matching zero project symbols produces no relation", () => {
  const order = `@Entity\nclass Order {\n    @ManyToOne\n    private java.math.BigDecimal total;\n}`;
  const { relations } = relationsFor({ "src/main/java/Order.java": order });
  assert.equal(relations.length, 0);
});

test("an ambiguous relationship target (two same-name entities) is unresolved, never guessed", () => {
  const order = `@Entity\nclass Order {\n    @ManyToOne\n    private Status status;\n}`;
  const statusA = `package a;\n@Entity\nclass Status {}`;
  const statusB = `package b;\n@Entity\nclass Status {}`;
  const { relations } = relationsFor({
    "src/main/java/Order.java": order,
    "src/main/java/a/Status.java": statusA,
    "src/main/java/b/Status.java": statusB,
  });
  const rel = relations.find((r) => r.kind === "ENTITY_RELATION")!;
  assert.equal(rel.confidence, "unresolved");
  assert.equal(rel.targetSymbolId, undefined);
});

test("@Entity inside a comment produces no relation", () => {
  const source = `class PlainUtil {\n    // example: @Entity\n    void helper() {}\n}`;
  const { relations } = relationsFor({ "src/main/java/PlainUtil.java": source });
  assert.equal(relations.length, 0);
});
