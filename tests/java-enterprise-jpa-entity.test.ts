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

test("a field's @JoinColumn with a nested-annotation argument no longer drops the whole relation", () => {
  const visit = `
@Entity
class Visit {
    @ManyToOne
    @JoinColumn(foreignKey = @ForeignKey(name = "fk_pet"))
    private Pet pet;
}
`;
  const pet = `@Entity\nclass Pet {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/Visit.java": visit, "src/main/java/Pet.java": pet });
  const visitClass = symbols.find((s) => s.name === "Visit")!;
  const petClass = symbols.find((s) => s.name === "Pet")!;
  const rel = relations.find((r) => r.kind === "ENTITY_RELATION" && r.sourceSymbolId === visitClass.id)!;
  assert.ok(rel, "expected an ENTITY_RELATION despite the nested-paren @JoinColumn argument");
  assert.equal(rel.targetSymbolId, petClass.id);
  assert.equal(rel.targetLabel, "Pet");
});

test("a multi-declarator relationship field produces a relation for each declarator", () => {
  const owner = `
@Entity
class Owner {
    @OneToMany
    private java.util.List<Pet> pets, favorites;
}
`;
  const pet = `@Entity\nclass Pet {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/Owner.java": owner, "src/main/java/Pet.java": pet });
  const ownerClass = symbols.find((s) => s.name === "Owner")!;
  const entityRelations = relations.filter((r) => r.kind === "ENTITY_RELATION" && r.sourceSymbolId === ownerClass.id);
  assert.equal(entityRelations.length, 2, "both pets and favorites must produce their own relation");
  for (const rel of entityRelations) {
    assert.equal(rel.targetLabel, "Pet");
  }
});

test("a fully-qualified relationship annotation name is still recognized", () => {
  const order = `
@Entity
class Order {
    @javax.persistence.ManyToOne
    private Customer customer;
}
`;
  const customer = `@Entity\nclass Customer {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/Order.java": order, "src/main/java/Customer.java": customer });
  const orderClass = symbols.find((s) => s.name === "Order")!;
  const customerClass = symbols.find((s) => s.name === "Customer")!;
  const rel = relations.find((r) => r.kind === "ENTITY_RELATION" && r.sourceSymbolId === orderClass.id)!;
  assert.ok(rel, "expected a relation for a fully-qualified @ManyToOne");
  assert.equal(rel.targetSymbolId, customerClass.id);
});
