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

test("a property-assigned function expression at module level produces a function symbol", () => {
  const parsed = parseTypeScript(
    "legacy.js",
    "Widget.helper = function helper(x) { return x; };",
  );
  const fn = parsed.symbols.find((symbol) => symbol.name === "helper");
  assert.ok(fn, "expected a symbol for the property-assigned function");
  assert.equal(fn!.kind, "function");
  assert.equal(fn!.qualifiedName, "Widget.helper");
});

test("a property-assigned arrow function at module level produces a function symbol, named from the property even when anonymous", () => {
  const parsed = parseTypeScript("legacy.js", "Widget.run = (x) => x + 1;");
  const fn = parsed.symbols.find((symbol) => symbol.qualifiedName === "Widget.run");
  assert.ok(fn, "expected a symbol for the property-assigned arrow function");
  assert.equal(fn!.kind, "function");
});

test("a nested property-assigned function (prototype pattern) produces a function symbol with the full chain", () => {
  const parsed = parseTypeScript(
    "legacy.js",
    "Foo.prototype.method = function method() {};",
  );
  const fn = parsed.symbols.find((symbol) => symbol.name === "method");
  assert.ok(fn, "expected a symbol for the prototype-assigned function");
  assert.equal(fn!.qualifiedName, "Foo.prototype.method");
});

test("calls inside a property-assigned function body are attributed to it", () => {
  const parsed = parseTypeScript(
    "legacy.js",
    "function helper() {}\nWidget.run = function run() { helper(); };",
  );
  const fn = parsed.symbols.find((symbol) => symbol.qualifiedName === "Widget.run")!;
  const call = parsed.calls.find((c) => c.calleeName === "helper")!;
  assert.equal(call.callerId, fn.id);
});

test("a property-assigned function inside a function body (not module level) stays unextracted, matching local lexical-declaration handling", () => {
  const parsed = parseTypeScript(
    "legacy.js",
    "function outer() { const obj = {}; obj.x = function x() {}; }",
  );
  assert.equal(parsed.symbols.find((s) => s.name === "x"), undefined);
});

test("module.exports / exports property assignment is left untouched (CommonJS, out of scope)", () => {
  const parsed = parseTypeScript(
    "legacy.js",
    "module.exports.helper = function helper() {};\nexports.other = function other() {};",
  );
  assert.equal(parsed.symbols.find((s) => s.name === "helper"), undefined);
  assert.equal(parsed.symbols.find((s) => s.name === "other"), undefined);
});

test("the language registry routes .js/.jsx/.mjs/.cjs files to the javascript adapter", () => {
  for (const filePath of ["math.js", "widget.jsx", "module.mjs", "module.cjs"]) {
    const adapter = adapterFor(filePath);
    assert.ok(adapter, `expected an adapter for ${filePath}`);
    assert.equal(adapter!.id, "javascript");
  }
});
