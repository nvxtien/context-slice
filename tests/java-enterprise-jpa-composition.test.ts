import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeJpaContext } from "../src/planner/composition.js";
import { buildPreview } from "../src/workflow/preview.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-java-jpa-"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/Owner.java"),
    [
      "@Entity",
      "class Owner {",
      "    @OneToMany(fetch = FetchType.EAGER)",
      "    private java.util.List<Pet> pets;",
      "    void addPet(Pet p) { p.getName(); pets.add(p); }",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src/main/java/Pet.java"),
    "@Entity\nclass Pet {\n    String getName() { return null; }\n}",
  );
  writeFileSync(
    join(root, "src/main/java/OwnerRepository.java"),
    "interface OwnerRepository extends JpaRepository<Owner, Integer> {\n    java.util.List<Owner> findByLastName(String n);\n}",
  );
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("a member of an entity class surfaces its class's relationship relation when the target entity is relevant", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "addPet")!;
  const getName = index.symbols.find((s) => s.name === "getName")!;
  const candidates = composeJpaContext(index, target, new Set([getName.id]), new Set([target.id]));
  assert.ok(candidates.some((c) => c.rendered.includes("Pet")));
});

test("a class relationship relation is not surfaced when its target entity is not relevant (no spam)", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "addPet")!;
  const candidates = composeJpaContext(index, target, new Set(), new Set([target.id]));
  assert.ok(!candidates.some((c) => c.rendered.includes("// Entity relationship")));
});

test("a repository interface target surfaces its own PERSISTS_ENTITY relation", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "OwnerRepository")!;
  const candidates = composeJpaContext(index, target, new Set(), new Set([target.id]));
  assert.ok(candidates.some((c) => c.rendered.includes("Owner")));
});

test("a derived-query method target surfaces its own REPOSITORY_QUERY relation", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "findByLastName")!;
  const candidates = composeJpaContext(index, target, new Set(), new Set([target.id]));
  assert.ok(candidates.some((c) => c.rendered.includes("lastName")));
});

test("composeJpaContext is a no-op for non-Java targets", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "addPet")!;
  const fakeRustTarget = { ...target, language: "rust" as const };
  assert.deepEqual(composeJpaContext(index, fakeRustTarget, new Set(), new Set()), []);
});

test("buildPreview surfaces JPA context end to end", () => {
  const index = fixture();
  const preview = buildPreview(index, "explain addPet");
  assert.ok(preview.included.some((item) => item.reason === "enterprise relation"));
});

function multiRelationFixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-java-jpa-multi-"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/Order.java"),
    [
      "@Entity",
      "class Order {",
      "    @ManyToOne",
      "    private Customer customer;",
      "    @ManyToOne",
      "    private Vet vet;",
      "    void place() { customer.getId(); }",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(root, "src/main/java/Customer.java"), "@Entity\nclass Customer {\n    long getId() { return 0; }\n}");
  writeFileSync(join(root, "src/main/java/Vet.java"), "@Entity\nclass Vet {\n    String getName() { return null; }\n}");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("only the relationship whose target owns a related symbol surfaces (no full relationship-graph dump)", () => {
  const index = multiRelationFixture();
  const target = index.symbols.find((s) => s.name === "place")!;
  const getId = index.symbols.find((s) => s.name === "getId")!;
  const candidates = composeJpaContext(index, target, new Set([getId.id]), new Set([target.id]));
  const entityRelationCandidates = candidates.filter((c) => c.rendered.includes("// Entity relationship"));
  assert.equal(entityRelationCandidates.length, 1);
  assert.ok(entityRelationCandidates[0].rendered.includes("Customer"));
  assert.ok(!entityRelationCandidates.some((c) => c.rendered.includes("Vet")));
});

function sameTargetFixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-java-jpa-same-target-"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/Invoice.java"),
    [
      "@Entity",
      "class Invoice {",
      "    @ManyToOne",
      "    private Address billingAddress;",
      "    @ManyToOne",
      "    private Address shippingAddress;",
      "    void ship() { shippingAddress.format(); billingAddress.format(); }",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(root, "src/main/java/Address.java"), "@Entity\nclass Address {\n    String format() { return null; }\n}");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("two same-kind relations to the same target type both surface as distinct candidates", () => {
  const index = sameTargetFixture();
  const target = index.symbols.find((s) => s.name === "ship")!;
  const format = index.symbols.find((s) => s.name === "format")!;
  const candidates = composeJpaContext(index, target, new Set([format.id]), new Set([target.id]));
  const entityRelationCandidates = candidates.filter((c) => c.rendered.includes("// Entity relationship"));
  assert.equal(entityRelationCandidates.length, 2);
  assert.ok(entityRelationCandidates.some((c) => c.rendered.includes("billingAddress")));
  assert.ok(entityRelationCandidates.some((c) => c.rendered.includes("shippingAddress")));
});

test("buildPreview on a Rust target never produces a JPA-sourced composition item", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-jpa-guard-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "f"\nversion = "0.1.0"\n');
  writeFileSync(join(root, "src/lib.rs"), "pub fn target() {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  const preview = buildPreview(index, "target");
  assert.ok(
    preview.included.every(
      (item) => !item.rendered.includes("// Entity relationship") &&
        !item.rendered.includes("// Repository") &&
        !item.rendered.includes("// Query"),
    ),
  );
});
