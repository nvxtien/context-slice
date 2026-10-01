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

test("a type alias (with '=') produces a 'type' symbol", () => {
  const parsed = parseGo("alias.go", `package main\n\ntype Alias = int\n`);
  const alias = parsed.symbols.find((s) => s.name === "Alias");
  assert.ok(alias, "expected a symbol for Alias");
  assert.equal(alias!.kind, "type");
});

test("a pointer-receiver method on a generic struct resolves parentId and supertypes", () => {
  const source = `package main\n\ntype Stack[T any] struct {\n\titems []T\n}\n\nfunc (s *Stack[T]) Push(v T) {}\n`;
  const parsed = parseGo("stack.go", source);
  const struct = parsed.symbols.find((s) => s.name === "Stack");
  const method = parsed.symbols.find((s) => s.name === "Push");
  assert.ok(struct, "expected a symbol for Stack");
  assert.ok(method, "expected a symbol for Push");
  assert.deepEqual(method!.supertypes, ["Stack"]);
  assert.equal(method!.parentId, struct!.id);
});

test("same-named methods on different structs in one file get distinct, receiver-qualified ids", () => {
  const source = `package main\n\ntype A struct {}\n\nfunc (a A) String() string {\n\treturn "a"\n}\n\ntype B struct {}\n\nfunc (b B) String() string {\n\treturn "b"\n}\n`;
  const parsed = parseGo("stringers.go", source);
  const methods = parsed.symbols.filter((s) => s.kind === "method" && s.name === "String");
  assert.equal(methods.length, 2, "expected two String() methods");
  const [first, second] = methods;
  assert.notEqual(first!.id, second!.id);
  assert.ok(first!.id.includes("A."), `expected ${first!.id} to reference receiver A`);
  assert.ok(second!.id.includes("B."), `expected ${second!.id} to reference receiver B`);
});

test("a plain import produces a namespace ImportRecord", () => {
  const parsed = parseGo("main.go", `package main\n\nimport "fmt"\n\nfunc main() {}\n`);
  const imp = parsed.imports.find((i) => i.module === "fmt");
  assert.ok(imp, "expected an import record for fmt");
  assert.equal(imp!.kind, "namespace");
});

test("an aliased import carries its alias as localName", () => {
  const parsed = parseGo("main.go", `package main\n\nimport f "fmt"\n\nfunc main() {}\n`);
  const imp = parsed.imports.find((i) => i.module === "fmt");
  assert.equal(imp!.localName, "f");
});

test("a blank import is a side-effect import", () => {
  const parsed = parseGo("main.go", `package main\n\nimport _ "net/http/pprof"\n\nfunc main() {}\n`);
  const imp = parsed.imports.find((i) => i.module === "net/http/pprof");
  assert.ok(imp, "expected an import record");
  assert.equal(imp!.kind, "side-effect");
});

test("a dot import is a wildcard namespace import with no localName", () => {
  const parsed = parseGo("main.go", `package main\n\nimport . "math"\n\nfunc main() {}\n`);
  const imp = parsed.imports.find((i) => i.module === "math");
  assert.ok(imp, "expected an import record");
  assert.equal(imp!.wildcard, true);
  assert.equal(imp!.localName, undefined);
});

test("a grouped import block produces one record per spec", () => {
  const source = `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {}\n`;
  const parsed = parseGo("main.go", source);
  const fmtImp = parsed.imports.find((i) => i.module === "fmt");
  const osImp = parsed.imports.find((i) => i.module === "os");
  assert.ok(fmtImp && osImp, "expected both fmt and os as separate import records");
});

test("an exported function has 'exported' in its modifiers", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n`);
  const fn = parsed.symbols.find((s) => s.name === "Add");
  assert.ok(fn!.modifiers.includes("exported"));
});

test("an unexported function does not have 'exported' in its modifiers", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n`);
  const fn = parsed.symbols.find((s) => s.name === "add");
  assert.equal(fn!.modifiers.includes("exported"), false);
});

test("a struct's exported and unexported fields are marked independently", () => {
  const source = `package main\n\ntype User struct {\n\tName string\n\tsecret string\n}\n`;
  const parsed = parseGo("user.go", source);
  const nameField = parsed.symbols.find((s) => s.kind === "field" && s.name === "Name");
  const secretField = parsed.symbols.find((s) => s.kind === "field" && s.name === "secret");
  assert.ok(nameField!.modifiers.includes("exported"));
  assert.equal(secretField!.modifiers.includes("exported"), false);
});

test("a direct call inside a function body produces an unresolved CallEdge", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc helper() {}\n\nfunc main() {\n\thelper()\n}\n`);
  const main = parsed.symbols.find((s) => s.name === "main" && s.kind === "function")!;
  const call = parsed.calls.find((c) => c.calleeName === "helper");
  assert.ok(call, "expected a call edge for helper");
  assert.equal(call!.callerId, main.id);
  assert.equal(call!.confidence, "unresolved");
  assert.equal(call!.resolutionKind, "unresolved");
});

test("a selector call with a plain identifier operand carries receiverText", () => {
  const source = `package main\n\ntype User struct{}\nfunc (u *User) Save() {}\n\nfunc main() {\n\tu := &User{}\n\tu.Save()\n}\n`;
  const parsed = parseGo("main.go", source);
  const call = parsed.calls.find((c) => c.calleeName === "Save");
  assert.ok(call, "expected a call edge for Save");
  assert.equal(call!.receiverText, "u");
});

test("a selector call with a chained (non-identifier) operand leaves receiverText undefined", () => {
  const source = `package main\n\nfunc main() {\n\ta.b.Save()\n}\n`;
  const parsed = parseGo("main.go", source);
  const call = parsed.calls.find((c) => c.calleeName === "Save");
  assert.ok(call, "expected a call edge for Save even with a chained operand");
  assert.equal(call!.receiverText, undefined);
});

test("a call wrapped in a go statement is tagged as a goroutine launch", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc helper() {}\n\nfunc main() {\n\tgo helper()\n}\n`);
  const call = parsed.calls.find((c) => c.calleeName === "helper");
  assert.ok(call!.evidence.includes("goroutine launch"));
});

test("a call wrapped in a defer statement is tagged as deferred", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc cleanup() {}\n\nfunc main() {\n\tdefer cleanup()\n}\n`);
  const call = parsed.calls.find((c) => c.calleeName === "cleanup");
  assert.ok(call!.evidence.includes("deferred call"));
});

test("a call nested inside a go statement's own call arguments is NOT itself tagged", () => {
  const source = `package main\n\nfunc inner() int { return 1 }\nfunc outer(n int) {}\n\nfunc main() {\n\tgo outer(inner())\n}\n`;
  const parsed = parseGo("main.go", source);
  const outerCall = parsed.calls.find((c) => c.calleeName === "outer");
  const innerCall = parsed.calls.find((c) => c.calleeName === "inner");
  assert.ok(outerCall!.evidence.includes("goroutine launch"));
  assert.ok(!innerCall!.evidence.includes("goroutine launch"), "the nested call must not inherit the goroutine tag");
});

test("a call inside a nested if block still attributes to the enclosing function", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc helper() {}\n\nfunc main() {\n\tif true {\n\t\thelper()\n\t}\n}\n`);
  const main = parsed.symbols.find((s) => s.name === "main" && s.kind === "function")!;
  const call = parsed.calls.find((c) => c.calleeName === "helper");
  assert.equal(call!.callerId, main.id);
});

test("a call inside a closure still attributes to the enclosing named function", () => {
  const source = `package main\n\nfunc closureCall() {}\n\nfunc main() {\n\tfn := func() {\n\t\tclosureCall()\n\t}\n\tfn()\n}\n`;
  const parsed = parseGo("main.go", source);
  const main = parsed.symbols.find((s) => s.name === "main" && s.kind === "function")!;
  const call = parsed.calls.find((c) => c.calleeName === "closureCall");
  assert.equal(call!.callerId, main.id);
});

test("a call inside a method body attributes to the method symbol", () => {
  const source = `package main\n\nfunc helper() {}\n\ntype User struct{}\nfunc (u *User) Save() {\n\thelper()\n}\n`;
  const parsed = parseGo("main.go", source);
  const method = parsed.symbols.find((s) => s.kind === "method" && s.name === "Save")!;
  const call = parsed.calls.find((c) => c.calleeName === "helper");
  assert.equal(call!.callerId, method.id);
});

test("argumentCount is correctly computed for a multi-argument call", () => {
  const parsed = parseGo("main.go", `package main\n\nfunc add(a, b, c int) int { return a + b + c }\n\nfunc main() {\n\tadd(1, 2, 3)\n}\n`);
  const call = parsed.calls.find((c) => c.calleeName === "add");
  assert.equal(call!.argumentCount, 3);
});

test("an immediately-invoked anonymous function launched as a goroutine produces no garbage edge, but its nested call is still found", () => {
  const source = `package main\n\nfunc helper() {}\n\nfunc main() {\n\tgo func() {\n\t\thelper()\n\t}()\n}\n`;
  const parsed = parseGo("main.go", source);
  const main = parsed.symbols.find((s) => s.name === "main" && s.kind === "function")!;
  const emptyNameCall = parsed.calls.find((c) => c.calleeName === "");
  assert.equal(emptyNameCall, undefined, "no call edge should be emitted for the unnamed IIFE invocation");
  const helperCall = parsed.calls.find((c) => c.calleeName === "helper");
  assert.ok(helperCall, "expected a call edge for helper nested inside the closure");
  assert.equal(helperCall!.callerId, main.id);
});
