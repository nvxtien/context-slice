import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJava } from "../src/parser/java-parser.js";

test("trích xuất class, method, annotation và call", () => {
  const file = join(process.cwd(), "test-fixtures/java/PaymentService.java");
  const parsed = parseJava("PaymentService.java", readFileSync(file, "utf8"));
  assert.ok(
    parsed.symbols.some(
      (s) => s.kind === "class" && s.name === "PaymentService",
    ),
  );
  const methods = parsed.symbols.filter((s) => s.name === "retryPayment");
  assert.equal(methods.length, 2);
  assert.ok(parsed.calls.some((c) => c.calleeName === "save"));
});

test("captures a method whose declaration has a modifier THEN an inline annotation THEN the return type", () => {
  // Real shape from spring-petclinic's VetController: `public @ResponseBody Vets foo()`. The
  // original methodRe only allowed annotations-then-modifiers-then-type (in that fixed order),
  // so this ordering silently dropped the leading `@GetMapping(...)` and `public` entirely from
  // the captured symbol (source started mid-declaration, at " @ResponseBody Vets foo()").
  const source = `
class VetController {
    @GetMapping({ "/vets" })
    public @ResponseBody Vets showResourcesVetList() {
        return null;
    }
}
`;
  const { symbols } = parseJava("VetController.java", source);
  const method = symbols.find((s) => s.name === "showResourcesVetList")!;
  assert.ok(method, "expected the method to be captured at all");
  assert.match(method.source, /^\s*@GetMapping/, "source must include the leading mapping annotation");
  assert.ok(method.source.includes("public"), "source must include the access modifier");
  assert.deepEqual(method.annotations, ["@GetMapping", "@ResponseBody"]);
  assert.deepEqual(method.modifiers, ["public"]);
});

test("a plain modifier-only method's captured source is unaffected by the interleaving fix", () => {
  // Guards against a regression this fix's own first draft introduced: letting modifiers reach
  // backward across a preceding blank line the same way annotations legitimately do, which
  // pulled trailing blank trivia from the PREVIOUS member into this method's own captured source.
  const source = `
class Counter {
  private int count;

  public void increment() {
    count++;
  }
}
`;
  const { symbols } = parseJava("Counter.java", source);
  const method = symbols.find((s) => s.name === "increment")!;
  assert.equal(method.source, "public void increment() {\n    count++;\n  }");
});
