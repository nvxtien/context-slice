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
      "    void addPet(Pet p) { pets.add(p); }",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(root, "src/main/java/Pet.java"), "@Entity\nclass Pet {}");
  writeFileSync(
    join(root, "src/main/java/OwnerRepository.java"),
    "interface OwnerRepository extends JpaRepository<Owner, Integer> {\n    java.util.List<Owner> findByLastName(String n);\n}",
  );
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("a member of an entity class surfaces its class's relationship relation", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "addPet")!;
  const candidates = composeJpaContext(index, target, new Set(), new Set([target.id]));
  assert.ok(candidates.some((c) => c.rendered.includes("Pet")));
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
