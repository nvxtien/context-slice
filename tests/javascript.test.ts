import assert from "node:assert/strict";
import test from "node:test";
import { parseTypeScript } from "../src/languages/typescript/parse.js";
import { adapterFor } from "../src/languages/adapter.js";
import "../src/languages/javascript/index.js";

test("a .js file's symbols are tagged with language 'javascript'", () => {
  const parsed = parseTypeScript("math.js", "function add(a, b) { return a + b; }");
  const fn = parsed.symbols.find((symbol) => symbol.name === "add");
  assert.ok(fn, "expected a symbol for the top-level function");
  assert.equal(fn!.language, "javascript");
});

test("a .ts file's symbols are still tagged with language 'typescript' (regression pin)", () => {
  const parsed = parseTypeScript("math.ts", "function add(a: number, b: number): number { return a + b; }");
  const fn = parsed.symbols.find((symbol) => symbol.name === "add");
  assert.ok(fn, "expected a symbol for the top-level function");
  assert.equal(fn!.language, "typescript");
});

test("a .jsx file parses JSX syntax without error and is tagged 'javascript'", () => {
  const parsed = parseTypeScript(
    "widget.jsx",
    "function Widget() { return <div>hello</div>; }",
  );
  assert.equal(parsed.parseError, false);
  const fn = parsed.symbols.find((symbol) => symbol.name === "Widget");
  assert.ok(fn, "expected a symbol for the Widget function");
  assert.equal(fn!.language, "javascript");
});

test(".mjs and .cjs files are both tagged 'javascript'", () => {
  for (const filePath of ["module.mjs", "module.cjs"]) {
    const parsed = parseTypeScript(filePath, "function run() {}");
    const fn = parsed.symbols.find((symbol) => symbol.name === "run");
    assert.ok(fn, `expected a symbol for ${filePath}`);
    assert.equal(fn!.language, "javascript");
  }
});

test("the language registry routes .js/.jsx/.mjs/.cjs files to the javascript adapter", () => {
  for (const filePath of ["math.js", "widget.jsx", "module.mjs", "module.cjs"]) {
    const adapter = adapterFor(filePath);
    assert.ok(adapter, `expected an adapter for ${filePath}`);
    assert.equal(adapter!.id, "javascript");
  }
});
