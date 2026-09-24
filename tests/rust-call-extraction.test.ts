import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { parseRust } from "../src/languages/rust/parse.js";

// receiverText convention: identifier/`self` field chains (<= 3 dots) are the source
// text; any other receiver expression is `<kind>` (`<call>`, `<index>`, ...).
const calls = (body: string) => {
  const parsed = parseRust("src/lib.rs", `fn caller() {\n${body}\n}\n`);
  return parsed.calls.map((c) => ({
    name: c.calleeName,
    recv: c.receiverText,
    args: c.argumentCount,
    ev: c.evidence,
  }));
};
const one = (body: string) => {
  const list = calls(body);
  assert.equal(list.length, 1, JSON.stringify(list));
  return list[0];
};

test("method calls: receiver text and markers", () => {
  assert.deepEqual(one("self.m(1, 2);"), { name: "m", recv: "self", args: 2, ev: [] });
  assert.equal(one("self.a.b.m();").recv, "self.a.b");
  assert.equal(one("x.m();").recv, "x");
  assert.equal(one("self.a.b.c.d.m();").recv, "<field>");
  assert.equal(one("self.0.m();").recv, "self.0");
  assert.deepEqual(
    calls("a().b();").map((c) => [c.name, c.recv]),
    [["b", "<call>"], ["a", undefined]],
  );
  assert.equal(one("v[0].m();").recv, "<index>");
});

test("scoped path calls", () => {
  assert.equal(one("A::f();").recv, "A");
  assert.equal(one("a::b::f();").recv, "a::b");
  assert.equal(one("Self::f();").recv, "Self");
  assert.equal(one("crate::x::f();").recv, "crate::x");
  assert.equal(one("super::f();").recv, "super");
  assert.equal(one("self::f();").recv, "self");
  assert.deepEqual(one("Vec::<u8>::new();"), { name: "new", recv: "Vec", args: 0, ev: [] });
});

test("qualified trait call", () => {
  const c = one("<T as Tr>::m(x);");
  assert.equal(c.name, "m");
  assert.equal(c.recv, "<T as Tr>");
  assert.deepEqual(c.ev, ["qualified:Tr"]);
});

test("bare calls, turbofish, constructors", () => {
  assert.deepEqual(one("f(1);"), { name: "f", recv: undefined, args: 1, ev: [] });
  assert.deepEqual(one("f::<T>(1);"), { name: "f", recv: undefined, args: 1, ev: [] });
  assert.equal(one("Some(1);").name, "Some");
  assert.equal(one("Foo(1, 2);").args, 2);
});

test("parenthesised callee", () => {
  assert.deepEqual(one("(self.cb)(x);"), {
    name: "cb", recv: undefined, args: 1, ev: ["no-type:callee-expression"],
  });
  assert.equal(calls("(get())(x);").find((c) => c.name === "<expr>")?.ev[0], "no-type:callee-expression");
});

test("await and ? add no edges beyond the call itself", () => {
  assert.equal(one("self.m().await;").name, "m");
  assert.equal(one("let _ = f()?;").name, "f");
});

test("macros: no descent into token trees", () => {
  assert.deepEqual(one("println!(\"{}\", g());"), {
    name: "println", recv: undefined, args: 0, ev: ["macro:println"],
  });
  const m = one("a::b::foo!(1);");
  assert.equal(m.name, "foo");
  assert.equal(m.recv, "a::b");
  assert.deepEqual(m.ev, ["macro:foo"]);
});

test("struct literals are not calls; consts are ignored", () => {
  assert.deepEqual(calls("let s = Foo { a: 1 };"), []);
  const p = parseRust("src/lib.rs", "const X: u8 = f();\nstatic Y: u8 = g();\n");
  assert.deepEqual(p.calls, []);
});

test("caller is the innermost enclosing fn; closures/async belong to it", () => {
  const p = parseRust(
    "src/lib.rs",
    `struct S;
impl S {
  fn outer(&self) {
    let c = |q: u8| q.z();
    let a = async { w() };
    fn inner() { deep(); }
    top();
  }
}\n`,
  );
  const byName = Object.fromEntries(
    p.calls.map((c) => [c.calleeName, p.symbols.find((s) => s.id === c.callerId)!.name]),
  );
  assert.deepEqual(byName, { z: "outer", w: "outer", deep: "inner", top: "outer" });
  const c = p.calls[0];
  assert.equal(c.confidence, "unresolved");
  assert.equal(c.resolutionKind, "unresolved");
  assert.equal(c.language, "rust");
  assert.equal(c.filePath, "src/lib.rs");
  assert.ok(c.range.startLine >= 1);
});

test("impl metadata", () => {
  const p = parseRust(
    "src/lib.rs",
    "impl<T> Tr for Vec<T> {}\nimpl A {}\nimpl<'a> Tr2 for &'a mut m::B<u8> {}\nimpl Tr3 for Box<dyn Tr> {}\nimpl<T> a::Tr4<T> for T {}\n",
  );
  const impls = p.symbols.filter((s) => s.name.startsWith("impl"));
  assert.deepEqual(
    impls.map((s) => [s.metadata?.implSelfType, s.metadata?.implTrait]),
    [["Vec", "Tr"], ["A", undefined], ["B", "Tr2"], ["Box", "Tr3"], ["T", "Tr4"]],
  );
});

test("declaredTypes on structs and functions", () => {
  const p = parseRust(
    "src/lib.rs",
    `struct S { a: u8, b: Vec<String> }
struct T(u8, String);
struct U;
impl S {
  fn r(&self, x: &str) {}
  fn m(&mut self, mut y: Vec<u8>, (a, b): (i32, i32)) {}
  fn o(self) {}
  fn s() {}
}\n`,
  );
  const dt = (n: string) => p.symbols.find((s) => s.name === n)?.metadata?.declaredTypes;
  assert.deepEqual(dt("S"), { a: "u8", b: "Vec<String>" });
  assert.deepEqual(dt("T"), { "0": "u8", "1": "String" });
  assert.equal(dt("U"), undefined);
  assert.deepEqual(dt("r"), { self: "&self", x: "&str" });
  assert.deepEqual(dt("m"), { self: "&mut self", y: "Vec<u8>" });
  assert.deepEqual(dt("o"), { self: "self" });
  assert.equal(dt("s"), undefined);
});

test("ProjectIndex: calls persist and are stable across warm rebuild and one-file edit", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-calls-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "lib.rs"), "pub fn a() { b(); x.m(); }\npub fn b() {}\n");
  writeFileSync(join(dir, "src", "other.rs"), "pub fn c() { Vec::<u8>::new(); println!(\"x\"); }\n");
  const snap = (i: ProjectIndex) =>
    JSON.stringify(
      i.calls
        .filter((c) => c.language === "rust")
        .map((c) => [c.filePath, c.calleeName, c.receiverText, c.argumentCount, c.evidence, c.range])
        .sort(),
    );
  try {
    const cold = new ProjectIndex(dir);
    cold.rebuild();
    const first = snap(cold);
    assert.equal(cold.calls.filter((c) => c.language === "rust").length, 4);
    cold.rebuild(); // warm: all cache hits
    assert.equal(snap(cold), first);
    const reopened = new ProjectIndex(dir); // persisted through SQLite
    reopened.rebuild();
    assert.equal(snap(reopened), first);
    writeFileSync(join(dir, "src", "other.rs"), "pub fn c() { Vec::<u8>::new(); }\n");
    reopened.rebuild();
    assert.equal(reopened.calls.filter((c) => c.language === "rust").length, 3);
    const fresh = new ProjectIndex(dir);
    fresh.rebuild();
    assert.equal(snap(fresh), snap(reopened));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
