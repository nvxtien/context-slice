import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import "../src/languages/java/enterprise/spring-mvc.js"; // side-effect: registers the extractor

const root = mkdtempSync(join(tmpdir(), "context-slice-java-enterprise-"));
cpSync(join(process.cwd(), "tests/fixtures/java-enterprise"), root, { recursive: true });
const index = new ProjectIndex(root);
index.rebuild();

const routesFor = (fileName: string) =>
  index.enterpriseRelations.filter(
    (relation) =>
      relation.kind === "ROUTE_TO_HANDLER" && relation.filePath.split("/").pop() === fileName,
  );

test("controller-with-class-route: class + method literal paths compose to one exact route", () => {
  const routes = routesFor("RouteController.java");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].targetLabel, "POST /orders/{id}");
  assert.equal(routes[0].confidence, "exact");
});

test("method-only-route: no class-level mapping produces a clean path, no leading artifact", () => {
  const routes = routesFor("HealthController.java");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].targetLabel, "GET /health");
  assert.equal(routes[0].confidence, "exact");
});

test("dynamic-route-negative: a non-literal class-level path is unresolved, never surfaced as exact/probable", () => {
  const routes = routesFor("DynamicRouteController.java");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].confidence, "unresolved");
});

test("comment-negative: an annotation-shaped comment on a plain class produces no relation", () => {
  const routes = routesFor("PlainUtilWithCommentAnnotation.java");
  assert.equal(routes.length, 0);
});

test("overload-routes: two overloaded handlers each get their own distinct correct route", () => {
  const routes = routesFor("OverloadedRouteController.java");
  assert.equal(routes.length, 2);
  const labels = routes.map((r) => r.targetLabel).sort();
  assert.deepEqual(labels, ["PUT /pets/{id}", "PUT /pets/{id}/vaccinate"]);
  assert.ok(routes.every((r) => r.confidence === "exact"));
  // Distinct source symbols: no cross-contamination from naive first-match correlation.
  assert.notEqual(routes[0].sourceSymbolId, routes[1].sourceSymbolId);
});

test("constant-route: a same-class static final String constant resolves through one hop", () => {
  const routes = routesFor("ConstantRouteController.java");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].targetLabel, "GET /api/v2/ping");
  assert.equal(routes[0].confidence, "probable");
});

test.after(() => rmSync(root, { recursive: true, force: true }));
