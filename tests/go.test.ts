import assert from "node:assert/strict";
import test from "node:test";
import { parseGo } from "../src/languages/go/parse.js";
import { adapterFor } from "../src/languages/adapter.js";
import "../src/languages/go/index.js";

test("a package-level function produces a 'function' symbol", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n`);
  const fn = parsed.symbols.find((s) => s.name === "Add");
  assert.ok(fn, "expected a symbol for Add");
  assert.equal(fn!.kind, "function");
  assert.equal(fn!.language, "go");
});

test("a pointer-receiver method resolves parentId to its same-file struct", () => {
  const source = `package main\n\ntype User struct {\n\tName string\n}\n\nfunc (u *User) Validate() error {\n\treturn nil\n}\n`;
  const parsed = parseGo("user.go", source);
  const struct = parsed.symbols.find((s) => s.name === "User");
  const method = parsed.symbols.find((s) => s.name === "Validate");
  assert.ok(struct, "expected a symbol for User");
  assert.ok(method, "expected a symbol for Validate");
  assert.equal(method!.kind, "method");
  assert.deepEqual(method!.supertypes, ["User"]);
  assert.equal(method!.parentId, struct!.id);
});

test("a value-receiver method (no pointer) resolves the same way", () => {
  const source = `package main\n\ntype User struct {\n\tName string\n}\n\nfunc (u User) String() string {\n\treturn u.Name\n}\n`;
  const parsed = parseGo("user.go", source);
  const struct = parsed.symbols.find((s) => s.name === "User");
  const method = parsed.symbols.find((s) => s.name === "String");
  assert.deepEqual(method!.supertypes, ["User"]);
  assert.equal(method!.parentId, struct!.id);
});

test("a method whose receiver struct is in another file keeps supertypes but has no parentId", () => {
  const source = `package main\n\nfunc (u *User) Validate() error {\n\treturn nil\n}\n`;
  const parsed = parseGo("user_methods.go", source);
  const method = parsed.symbols.find((s) => s.name === "Validate");
  assert.ok(method, "expected a symbol for Validate even without the struct in this file");
  assert.deepEqual(method!.supertypes, ["User"]);
  assert.equal(method!.parentId, undefined);
});

test("a generic function still produces a correctly kinded function symbol", () => {
  const parsed = parseGo("generic.go", `package main\n\nfunc Add[T any](a, b T) T {\n\treturn a\n}\n`);
  const fn = parsed.symbols.find((s) => s.name === "Add");
  assert.ok(fn, "expected a symbol for the generic function Add");
  assert.equal(fn!.kind, "function");
});

test("a syntactically broken .go file reports parseError without throwing", () => {
  const parsed = parseGo("broken.go", "func ( { : ;");
  assert.equal(parsed.parseError, true);
  assert.equal(Array.isArray(parsed.symbols), true);
});

test("the language registry routes .go files to the go adapter", () => {
  const adapter = adapterFor("main.go");
  assert.ok(adapter, "expected an adapter for main.go");
  assert.equal(adapter!.id, "go");
});
