import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";
import {
  extractEnterpriseRelations,
  __resetEnterpriseExtractorsForTests,
} from "../src/languages/java/enterprise/registry.js";
import "../src/languages/java/enterprise/spring-mvc.js"; // side-effect: registers the extractor

function relationsFor(
  source: string,
  filePath = "src/main/java/OrderController.java",
) {
  const { symbols } = parseJava(filePath, source); // parseJava(filePath, source) — confirmed 2-arg signature, src/parser/java-parser.ts:73
  return {
    symbols,
    relations: extractEnterpriseRelations(symbols, filePath, source),
  };
}

test("composes class-level and method-level literal paths into one exact route", () => {
  const source = `
package com.example;

@RestController
@RequestMapping("/orders")
class OrderController {
    @PostMapping("/{id}")
    Order update(@PathVariable Long id) { return null; }
}
`;
  const { symbols, relations } = relationsFor(source);
  const handler = symbols.find(
    (s) => s.name === "update" && s.kind === "method",
  )!;
  const route = relations.find(
    (r) => r.kind === "ROUTE_TO_HANDLER" && r.sourceSymbolId === handler.id,
  );
  assert.ok(route, "expected a ROUTE_TO_HANDLER relation for update()");
  assert.equal(route!.targetLabel, "POST /orders/{id}");
  assert.equal(route!.confidence, "exact");
  assert.equal(route!.family, "spring-mvc");
  assert.match(route!.evidence.join(" "), /RequestMapping.*orders/);
  assert.match(route!.evidence.join(" "), /PostMapping.*\{id\}/);
});

test("a method-only mapping with no class-level prefix has no leading artifact", () => {
  const source = `
@RestController
class HealthController {
    @GetMapping("/health")
    String health() { return "ok"; }
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/HealthController.java",
  );
  const handler = symbols.find((s) => s.name === "health")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET /health");
});

test("two overloaded handlers with the same HTTP method get distinct correct routes", () => {
  const source = `
@RestController
@RequestMapping("/pets")
class PetController {
    @PutMapping("/{id}")
    void update(Long id) {}
    @PutMapping("/{id}/vaccinate")
    void update(Long id, boolean vaccinate) {}
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/PetController.java",
  );
  const [first, second] = symbols.filter(
    (s) => s.name === "update" && s.kind === "method",
  );
  const r1 = relations.find((r) => r.sourceSymbolId === first.id)!;
  const r2 = relations.find((r) => r.sourceSymbolId === second.id)!;
  assert.equal(r1.targetLabel, "PUT /pets/{id}");
  assert.equal(r2.targetLabel, "PUT /pets/{id}/vaccinate");
});

test("a non-literal class-level path is not resolved and is marked unresolved, not guessed", () => {
  const source = `
@RestController
@RequestMapping(SomeConfig.BASE_PATH)
class DynamicController {
    @GetMapping("/x")
    void x() {}
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/DynamicController.java",
  );
  const handler = symbols.find((s) => s.name === "x")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.confidence, "unresolved");
  assert.ok(
    !route.targetLabel || route.targetLabel.includes("SomeConfig.BASE_PATH"),
    "must not fabricate a path",
  );
});

test("a same-class static final String constant resolves through one hop", () => {
  const source = `
@RestController
@RequestMapping(BASE)
class ConstController {
    static final String BASE = "/api/v2";
    @GetMapping("/ping")
    void ping() {}
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/ConstController.java",
  );
  const handler = symbols.find((s) => s.name === "ping")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET /api/v2/ping");
  assert.equal(route.confidence, "probable");
});

test("a non-controller class with an annotation-shaped string in a comment produces no relation", () => {
  const source = `
class PlainUtil {
    // example: @RequestMapping("/fake")
    void helper() {}
}
`;
  const { relations } = relationsFor(source, "src/main/java/PlainUtil.java");
  assert.equal(relations.length, 0);
});

test("a produces-only mapping argument is not a path and must not fabricate an exact route", () => {
  const source = `
@RestController
class MediaController {
    @GetMapping(produces = "application/json")
    String list() { return "[]"; }
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/MediaController.java",
  );
  const handler = symbols.find((s) => s.name === "list")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.notEqual(route.confidence, "exact");
  assert.ok(
    !route.targetLabel || !route.targetLabel.includes("application/json"),
    "must not treat produces= as a path",
  );
});

test("a value= argument built via string concatenation is unresolved, not exact", () => {
  const source = `
@RestController
class ConcatController {
    @GetMapping(value = Paths.P + "/x")
    void x() {}
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/ConcatController.java",
  );
  const handler = symbols.find((s) => s.name === "x")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.confidence, "unresolved");
  assert.ok(
    !route.targetLabel || !route.targetLabel.includes("GET /x"),
    "must not treat concatenation as a literal",
  );
});

test("an array-literal mapping value is never resolved to an exact single route", () => {
  const source = `
@RestController
class MultiPathController {
    @GetMapping({"/a", "/b"})
    void both() {}
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/MultiPathController.java",
  );
  const handler = symbols.find((s) => s.name === "both")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.notEqual(route.confidence, "exact");
  assert.equal(route.confidence, "probable");
  assert.equal(route.targetLabel, "GET /a");
});

test("a real handler preceded by an ordinary explanatory comment on a previous line is still extracted", () => {
  // Reproduces spring-petclinic's VisitController shape: an unrelated "//" explanatory comment
  // directly above a genuine, clean mapping annotation line must not be mistaken for the
  // annotation itself being commented out (that guard only applies within the annotation's own
  // physical line, per the "annotation-shaped string in a comment" test above).
  const source = `
@Controller
class VisitController {
    // Spring MVC calls method loadPetWithVisit(...) before initNewVisitForm is
    // called
    @GetMapping("/owners/{ownerId}/pets/{petId}/visits/new")
    String initNewVisitForm() { return "pets/createOrUpdateVisitForm"; }
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/VisitController.java",
  );
  const handler = symbols.find(
    (s) => s.name === "initNewVisitForm" && s.kind === "method",
  )!;
  const route = relations.find(
    (r) => r.kind === "ROUTE_TO_HANDLER" && r.sourceSymbolId === handler.id,
  );
  assert.ok(
    route,
    "expected a ROUTE_TO_HANDLER relation despite the preceding comment lines",
  );
  assert.equal(
    route!.targetLabel,
    "GET /owners/{ownerId}/pets/{petId}/visits/new",
  );
  assert.equal(route!.confidence, "exact");
});

test("a multi-line mapping annotation argument is not lost", () => {
  const source = `
@RestController
class ReportController {
    @GetMapping(
        "/reports/summary"
    )
    String summary() { return "ok"; }
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/ReportController.java",
  );
  const handler = symbols.find((s) => s.name === "summary")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET /reports/summary");
  assert.equal(route.confidence, "exact");
});

test("a mapping annotation stacked with an unrelated annotation still extracts the right argument", () => {
  const source = `
@RestController
class AuditedController {
    @Deprecated
    @GetMapping("/legacy/list")
    String legacyList() { return "[]"; }
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/AuditedController.java",
  );
  const handler = symbols.find((s) => s.name === "legacyList")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET /legacy/list");
  assert.equal(route.confidence, "exact");
});

test("a fully-qualified mapping annotation name is still recognized", () => {
  const source = `
@RestController
class QualifiedController {
    @org.springframework.web.bind.annotation.GetMapping("/qualified")
    String q() { return "ok"; }
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/QualifiedController.java",
  );
  const handler = symbols.find((s) => s.name === "q")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET /qualified");
  assert.equal(route.confidence, "exact");
});

test("a bare mapping annotation with no arguments produces a probable route with no path", () => {
  const source = `
@RestController
class BareController {
    @GetMapping
    String all() { return "[]"; }
}
`;
  const { symbols, relations } = relationsFor(
    source,
    "src/main/java/BareController.java",
  );
  const handler = symbols.find((s) => s.name === "all")!;
  const route = relations.find((r) => r.sourceSymbolId === handler.id)!;
  assert.equal(route.targetLabel, "GET");
  assert.equal(route.confidence, "probable");
});
