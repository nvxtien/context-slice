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

test("a struct's fields each produce their own 'field' symbol", () => {
  const source = `package main\n\ntype User struct {\n\tName string\n\tAge  int\n}\n`;
  const parsed = parseGo("user.go", source);
  const struct = parsed.symbols.find((s) => s.name === "User");
  const nameField = parsed.symbols.find((s) => s.kind === "field" && s.name === "Name");
  const ageField = parsed.symbols.find((s) => s.kind === "field" && s.name === "Age");
  assert.ok(nameField && ageField, "expected both fields as symbols");
  assert.equal(nameField!.parentId, struct!.id);
  assert.equal(ageField!.parentId, struct!.id);
});

test("an embedded field (no explicit name) uses its type name as the field name", () => {
  const source = `package main\n\ntype Base struct {\n\tID int\n}\n\ntype Derived struct {\n\tBase\n\tName string\n}\n`;
  const parsed = parseGo("derived.go", source);
  const derived = parsed.symbols.find((s) => s.name === "Derived");
  const embedded = parsed.symbols.find(
    (s) => s.kind === "field" && s.name === "Base" && s.parentId === derived!.id,
  );
  assert.ok(embedded, "expected an embedded 'Base' field on Derived");
});

test("an interface type produces an 'interface' symbol", () => {
  const parsed = parseGo("greeter.go", `package main\n\ntype Greeter interface {\n\tGreet() string\n}\n`);
  const iface = parsed.symbols.find((s) => s.name === "Greeter");
  assert.ok(iface, "expected a symbol for Greeter");
  assert.equal(iface!.kind, "interface");
});

test("a non-struct type alias produces a 'type' symbol", () => {
  const parsed = parseGo("id.go", `package main\n\ntype UserID int\n`);
  const alias = parsed.symbols.find((s) => s.name === "UserID");
  assert.ok(alias, "expected a symbol for UserID");
  assert.equal(alias!.kind, "type");
});

test("a grouped type block produces one symbol per spec", () => {
  const source = `package main\n\ntype (\n\tA int\n\tB string\n)\n`;
  const parsed = parseGo("grouped.go", source);
  const a = parsed.symbols.find((s) => s.name === "A");
  const b = parsed.symbols.find((s) => s.name === "B");
  assert.ok(a && b, "expected both A and B as separate symbols");
  assert.equal(a!.kind, "type");
  assert.equal(b!.kind, "type");
});

test("a package-level const produces a 'variable' symbol", () => {
  const parsed = parseGo("consts.go", `package main\n\nconst MaxUsers = 100\n`);
  const sym = parsed.symbols.find((s) => s.name === "MaxUsers");
  assert.ok(sym, "expected a symbol for MaxUsers");
  assert.equal(sym!.kind, "variable");
});

test("a grouped const block produces one symbol per spec", () => {
  const source = `package main\n\nconst (\n\tX = 1\n\tY = 2\n)\n`;
  const parsed = parseGo("grouped-const.go", source);
  const x = parsed.symbols.find((s) => s.name === "X");
  const y = parsed.symbols.find((s) => s.name === "Y");
  assert.ok(x && y, "expected both X and Y as separate symbols");
});

test("a package-level var produces a 'variable' symbol", () => {
  const parsed = parseGo("vars.go", `package main\n\nvar DefaultTimeout int\n`);
  const sym = parsed.symbols.find((s) => s.name === "DefaultTimeout");
  assert.ok(sym, "expected a symbol for DefaultTimeout");
  assert.equal(sym!.kind, "variable");
});
