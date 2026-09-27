import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";
import { extractEnterpriseRelations, resolveEnterpriseRelations, __resetEnterpriseExtractorsForTests } from "../src/languages/java/enterprise/registry.js";
import "../src/languages/java/enterprise/spring-data.js";

function relationsFor(files: Record<string, string>) {
  const allSymbols = [];
  const provisional = [];
  for (const [filePath, source] of Object.entries(files)) {
    const { symbols } = parseJava(filePath, source);
    allSymbols.push(...symbols);
    provisional.push(...extractEnterpriseRelations(symbols, filePath, source));
  }
  return { symbols: allSymbols, relations: resolveEnterpriseRelations(provisional, allSymbols) };
}

test("extends JpaRepository<Entity, Id> resolves the entity type", () => {
  const repo = `interface OwnerRepository extends JpaRepository<Owner, Integer> {}`;
  const owner = `@Entity\nclass Owner {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/OwnerRepository.java": repo, "src/main/java/Owner.java": owner });
  const repoIface = symbols.find((s) => s.name === "OwnerRepository")!;
  const ownerClass = symbols.find((s) => s.name === "Owner")!;
  const rel = relations.find((r) => r.kind === "PERSISTS_ENTITY" && r.sourceSymbolId === repoIface.id)!;
  assert.equal(rel.targetSymbolId, ownerClass.id);
  assert.equal(rel.confidence, "exact");
  assert.match(rel.evidence.join(" "), /JpaRepository<Owner, ?Integer>/);
});

test("a multi-supertype interface still resolves via the Repository<Entity,Id> portion", () => {
  const repo = `interface SpringDataUserRepository extends UserRepository, Repository<User, String> {}`;
  const user = `@Entity\nclass User {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/SpringDataUserRepository.java": repo, "src/main/java/User.java": user });
  const repoIface = symbols.find((s) => s.name === "SpringDataUserRepository")!;
  const rel = relations.find((r) => r.kind === "PERSISTS_ENTITY" && r.sourceSymbolId === repoIface.id)!;
  assert.ok(rel, "expected PERSISTS_ENTITY even with an unrelated first supertype");
});

test("a derived query method produces conservative structural hints", () => {
  const repo = `interface OwnerRepository extends JpaRepository<Owner, Integer> {\n    java.util.List<Owner> findByLastName(String lastName);\n}`;
  const owner = `@Entity\nclass Owner {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/OwnerRepository.java": repo, "src/main/java/Owner.java": owner });
  const method = symbols.find((s) => s.kind === "method" && s.name === "findByLastName")!;
  const rel = relations.find((r) => r.kind === "REPOSITORY_QUERY" && r.sourceSymbolId === method.id)!;
  assert.equal(rel.confidence, "exact");
  assert.match(rel.evidence.join(" "), /lastName/);
});

test("a compound And-joined property name splits at the top level only", () => {
  const repo = `interface X extends JpaRepository<Order, Long> {\n    java.util.List<Order> findByStatusAndCreatedAtBefore(String status, java.time.Instant t);\n}`;
  const order = `@Entity\nclass Order {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/X.java": repo, "src/main/java/Order.java": order });
  const method = symbols.find((s) => s.kind === "method" && s.name === "findByStatusAndCreatedAtBefore")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.equal(rel.evidence.length, 2);
});

test("a property name containing 'Android' is not mis-split on 'And'", () => {
  const repo = `interface X extends JpaRepository<Device, Long> {\n    java.util.List<Device> findByAndroidVersion(String v);\n}`;
  const device = `@Entity\nclass Device {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/X.java": repo, "src/main/java/Device.java": device });
  const method = symbols.find((s) => s.kind === "method" && s.name === "findByAndroidVersion")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.equal(rel.evidence.length, 1);
  assert.match(rel.evidence[0], /androidVersion/i);
});

test("@Query captures the raw text verbatim", () => {
  const repo = `interface PetTypeRepository extends JpaRepository<PetType, Integer> {\n    @Query("SELECT ptype FROM PetType ptype ORDER BY ptype.name")\n    java.util.List<PetType> findPetTypes();\n}`;
  const petType = `@Entity\nclass PetType {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/PetTypeRepository.java": repo, "src/main/java/PetType.java": petType });
  const method = symbols.find((s) => s.kind === "method" && s.name === "findPetTypes")!;
  const rel = relations.find((r) => r.sourceSymbolId === method.id)!;
  assert.match(rel.evidence.join(" "), /SELECT ptype FROM PetType/);
});

test("a plain CRUD-inherited method with no derived-query shape and no @Query produces nothing", () => {
  const repo = `interface X extends JpaRepository<Order, Long> {\n    void save(Order o);\n}`;
  const order = `@Entity\nclass Order {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/X.java": repo, "src/main/java/Order.java": order });
  const method = symbols.find((s) => s.kind === "method" && s.name === "save");
  if (method) assert.ok(!relations.some((r) => r.sourceSymbolId === method.id));
});

test("nested generics: a generic entity argument is dropped, a generic id argument still parses", () => {
  const repos = `interface A extends Repository<Map<String, Long>, Long> {}\ninterface B extends CrudRepository<User, Map<String, Long>> {}`;
  const user = `@Entity\nclass User {}`;
  const { symbols, relations } = relationsFor({ "src/main/java/Repos.java": repos, "src/main/java/User.java": user });
  const a = symbols.find((s) => s.name === "A")!;
  const b = symbols.find((s) => s.name === "B")!;
  assert.ok(!relations.some((r) => r.sourceSymbolId === a.id));
  const rel = relations.find((r) => r.kind === "PERSISTS_ENTITY" && r.sourceSymbolId === b.id)!;
  assert.equal(rel.targetSymbolId, symbols.find((s) => s.name === "User")!.id);
  assert.ok(rel.evidence.includes("id type: Map<String, Long>"));
});

test("a non-repository interface produces nothing, even with derived-looking methods", () => {
  const src = `interface UserRepository extends Marker {\n    User findByName(String n);\n}`;
  const { relations } = relationsFor({ "src/main/java/UserRepository.java": src, "src/main/java/User.java": `class User {}` });
  assert.equal(relations.length, 0);
});

// --- resolveRepositoryQueryPropagation (Task 5 fix round 1: zero coverage on the propagation
// resolver itself — real-repository recall/precision numbers alone don't exercise the resolver's
// own resolution logic, e.g. its ambiguous/external-supertype guard). ---

test("a plain supertype interface's derived-query method is propagated to the resolved entity", () => {
  const plain = `interface OwnerRepository {\n    java.util.List<Owner> findByLastName(String lastName);\n}`;
  const springData = `interface SpringDataOwnerRepository extends OwnerRepository, Repository<Owner, Integer> {}`;
  const owner = `@Entity\nclass Owner {}`;
  const { symbols, relations } = relationsFor({
    "src/main/java/OwnerRepository.java": plain,
    "src/main/java/SpringDataOwnerRepository.java": springData,
    "src/main/java/Owner.java": owner,
  });
  const plainIface = symbols.find((s) => s.name === "OwnerRepository")!;
  const method = symbols.find((s) => s.kind === "method" && s.name === "findByLastName" && s.parentId === plainIface.id)!;
  const rel = relations.find((r) => r.kind === "REPOSITORY_QUERY" && r.sourceSymbolId === method.id)!;
  assert.ok(rel, "expected the plain interface's own method to carry a propagated REPOSITORY_QUERY relation");
  assert.equal(rel.confidence, "exact");
  assert.match(rel.evidence.join(" "), /lastName/);
  assert.match(rel.evidence.join(" "), /propagated from OwnerRepository via SpringDataOwnerRepository/);
});

test("a method declared on both the plain interface and its @Override sibling gets two relations, one per declaring symbol", () => {
  const plain = `interface OwnerRepository {\n    Owner findById(int id);\n}`;
  const springData = `interface SpringDataOwnerRepository extends OwnerRepository, Repository<Owner, Integer> {\n    @Override\n    Owner findById(int id);\n}`;
  const owner = `@Entity\nclass Owner {}`;
  const { symbols, relations } = relationsFor({
    "src/main/java/OwnerRepository.java": plain,
    "src/main/java/SpringDataOwnerRepository.java": springData,
    "src/main/java/Owner.java": owner,
  });
  const methods = symbols.filter((s) => s.kind === "method" && s.name === "findById");
  assert.equal(methods.length, 2, "expected one findById symbol per declaring interface");
  const queryRelations = relations.filter((r) => r.kind === "REPOSITORY_QUERY" && methods.some((m) => m.id === r.sourceSymbolId));
  assert.equal(queryRelations.length, 2, "both the plain declaration and the override should independently carry a relation");
});

test("propagation is skipped when the supertype name does not resolve to a project interface (external/framework type)", () => {
  const springData = `interface SpringDataOwnerRepository extends SomeExternalMarkerInterface, Repository<Owner, Integer> {}`;
  const owner = `@Entity\nclass Owner {}`;
  const { relations } = relationsFor({ "src/main/java/SpringDataOwnerRepository.java": springData, "src/main/java/Owner.java": owner });
  // No crash, and nothing fabricated beyond the direct PERSISTS_ENTITY fact for the interface itself.
  assert.ok(relations.some((r) => r.kind === "PERSISTS_ENTITY"));
  assert.ok(!relations.some((r) => r.kind === "REPOSITORY_QUERY"));
});

test("propagation is skipped when the supertype name is ambiguous (two same-named project interfaces)", () => {
  const plainA = `interface PetRepository {\n    Pet findById(int id);\n}`;
  const plainB = `interface PetRepository {\n    Pet findByName(String name);\n}`;
  const springData = `interface SpringDataPetRepository extends PetRepository, Repository<Pet, Integer> {}`;
  const pet = `@Entity\nclass Pet {}`;
  const { relations } = relationsFor({
    "src/main/java/a/PetRepository.java": plainA,
    "src/main/java/b/PetRepository.java": plainB,
    "src/main/java/SpringDataPetRepository.java": springData,
    "src/main/java/Pet.java": pet,
  });
  // Ambiguous same-simple-name supertype: never guess which one to propagate from.
  assert.ok(!relations.some((r) => r.kind === "REPOSITORY_QUERY"));
});
