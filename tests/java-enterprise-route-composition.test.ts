import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeRouteContext } from "../src/planner/composition.js";
import { buildPreview } from "../src/workflow/preview.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-java-route-"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/OrderController.java"),
    [
      "@RestController",
      '@RequestMapping("/orders")',
      "class OrderController {",
      "    OrderService service;",
      '    @PostMapping("/{id}")',
      "    Order update(Long id) { return service.update(id); }",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src/main/java/OrderService.java"),
    [
      "class OrderService {",
      "    Order update(Long id) { return null; }",
      "}",
    ].join("\n"),
  );
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("a route handler target gets one route composition candidate", () => {
  const index = fixture();
  const target = index.symbols.find(
    (s) => s.name === "update" && s.filePath.includes("Controller"),
  )!;
  const candidates = composeRouteContext(
    index,
    target,
    new Set(),
    new Set([target.id]),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reason, "enterprise relation");
  assert.match(candidates[0].rendered, /POST \/orders\/\{id\}/);
});

test("a service target surfaces its calling route via relatedIds, not a fabricated one", () => {
  const index = fixture();
  const controllerMethod = index.symbols.find(
    (s) => s.name === "update" && s.filePath.includes("Controller"),
  )!;
  const serviceTarget = index.symbols.find(
    (s) => s.name === "update" && s.filePath.includes("Service"),
  )!;
  const candidates = composeRouteContext(
    index,
    serviceTarget,
    new Set([controllerMethod.id]),
    new Set([serviceTarget.id]),
  );
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].rendered, /POST \/orders\/\{id\}/);
});

test("composeRouteContext is a no-op for non-Java targets", () => {
  const index = fixture();
  const target = index.symbols.find(
    (s) => s.name === "update" && s.filePath.includes("Controller"),
  )!;
  const fakeRustTarget = { ...target, language: "rust" as const };
  assert.deepEqual(
    composeRouteContext(index, fakeRustTarget, new Set(), new Set()),
    [],
  );
});

test("buildPreview surfaces the route line end to end for a route handler task", () => {
  const index = fixture();
  const preview = buildPreview(index, "explain update");
  assert.ok(
    preview.included.some((item) => item.reason === "enterprise relation"),
  );
});

function rustFixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-route-guard-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "f"\nversion = "0.1.0"\n',
  );
  writeFileSync(join(root, "src/lib.rs"), "pub fn update() {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  return index;
}

test("buildPreview on a non-Java target never produces an 'enterprise relation' item", () => {
  const index = rustFixture();
  const preview = buildPreview(index, "update");
  assert.ok(
    preview.included.every((item) => item.reason !== "enterprise relation"),
  );
});
