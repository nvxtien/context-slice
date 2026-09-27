import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeDependencyContext } from "../src/planner/composition.js";
import { buildPreview } from "../src/workflow/preview.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-java-di-"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/OrderService.java"),
    [
      "@Service",
      "class OrderService {",
      "    private final OrderRepository repo;",
      "    OrderService(OrderRepository repo) { this.repo = repo; }",
      "    Order create(long id) { return repo.findById(id); }",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src/main/java/OrderRepository.java"),
    ["class OrderRepository {", "    Order findById(long id) { return null; }", "}"].join("\n"),
  );
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("a dependency relevant to an already-related callee is surfaced", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "create")!;
  const findById = index.symbols.find((s) => s.name === "findById")!;
  const candidates = composeDependencyContext(index, target, new Set([findById.id]), new Set([target.id]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reason, "enterprise relation");
  assert.match(candidates[0].rendered, /OrderRepository/);
});

test("a dependency with no related callee in context is not surfaced (no spam)", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "create")!;
  const candidates = composeDependencyContext(index, target, new Set(), new Set([target.id]));
  assert.equal(candidates.length, 0);
});

test("composeDependencyContext is a no-op for non-Java targets", () => {
  const index = fixture();
  const target = index.symbols.find((s) => s.name === "create")!;
  const fakeRustTarget = { ...target, language: "rust" as const };
  assert.deepEqual(composeDependencyContext(index, fakeRustTarget, new Set(), new Set()), []);
});

test("buildPreview surfaces the dependency line end to end", () => {
  const index = fixture();
  const preview = buildPreview(index, "explain create");
  assert.ok(preview.included.some((item) => item.reason === "enterprise relation"));
});

function rustFixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-di-guard-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "f"\nversion = "0.1.0"\n');
  writeFileSync(join(root, "src/lib.rs"), "pub fn create() {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("buildPreview on a non-Java target never produces a dependency-injection composition item", () => {
  const index = rustFixture();
  const preview = buildPreview(index, "create");
  assert.ok(preview.included.every((item) => item.reason !== "enterprise relation"));
});
