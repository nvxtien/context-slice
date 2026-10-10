import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { parsePython } from "../src/languages/python/parse.js";
import { pythonDiagnostics } from "../src/languages/python/index.js";
import type { CallEdge } from "../src/types/model.js";

const root = mkdtempSync(join(tmpdir(), "context-slice-python-"));
cpSync(join(process.cwd(), "tests/fixtures/python"), root, {
  recursive: true,
  filter: (source) => !source.includes(".context-slice"),
});
const index = new ProjectIndex(root);
index.rebuild();

const byId = (id: string) => index.symbols.find((symbol) => symbol.id === id);
const callTo = (callee: string, receiver?: string) =>
  index.calls.find(
    (call: CallEdge) =>
      call.calleeName === callee &&
      (receiver === undefined || call.receiverText === receiver),
  );

test("python symbols carry canonical, lexical identities", () => {
  for (const id of [
    "src/orders/service.py::class::OrderService",
    "src/orders/service.py::OrderService::constructor::__init__(self, repo)",
    "src/orders/service.py::OrderService::method::create(self, order)",
    "src/orders/service.py::OrderService::getter::total_seen(self)",
    "src/orders/service.py::function::create_order(order)",
    "src/orders/service.py::outer::function::inner()",
    "src/orders/service.py::function::normalize(value)",
    "src/orders/repo/sql.py::SqlRepo::method::dialect()",
    "src/orders/models.py::class::Order",
  ])
    assert.ok(byId(id), `missing symbol ${id}`);
  // A nested function must not collide with a module-level one.
  assert.notEqual(
    byId("src/orders/service.py::outer::function::inner()"),
    byId("src/orders/service.py::function::helper()"),
  );
  assert.equal(
    new Set(index.symbols.map((symbol) => symbol.id)).size,
    index.symbols.length,
  );
});

test("decorators are retained as searchable metadata", () => {
  assert.deepEqual(byId("src/orders/models.py::class::Order")?.annotations, [
    "@dataclass",
  ]);
  assert.deepEqual(
    byId("src/orders/repo/sql.py::SqlRepo::method::dialect()")?.annotations,
    ["@staticmethod"],
  );
  const build = byId("src/orders/service.py::OrderService::method::build(cls)");
  assert.equal(build?.metadata?.classMethod, true);
  assert.equal(
    byId("src/orders/service.py::OrderService::method::create(self, order)")
      ?.metadata?.async,
    true,
  );
  // Dataclass fields are indexed with their annotations.
  assert.ok(byId("src/orders/models.py::Order::property::id"));
});

test("imports, packages and __init__ re-exports resolve", () => {
  const diagnostics = pythonDiagnostics({
    root: index.root,
    symbols: index.symbols,
    calls: index.calls,
    imports: index.imports,
    exports: index.exports,
    sourceOf: (symbol) => index.sourceFor(symbol),
  });
  assert.equal(diagnostics.relativeImportResolutionRate, 1);
  assert.equal(diagnostics.unresolvedImports, 0);
  assert.equal(diagnostics.cyclicExportChains, 0);
  // `from orders import create_order` reaches through the package __init__.
  const viaPackage = index.calls.find(
    (call) =>
      call.calleeName === "create_order" && call.filePath === "src/app.py",
  );
  assert.equal(
    viaPackage?.resolvedTargetId,
    "src/orders/service.py::function::create_order(order)",
  );
  assert.equal(viaPackage?.resolutionKind, "imported");
  const external = index.imports.find((record) => record.module === "requests");
  assert.equal(external?.externalPackage, "requests");
});

test("self, cls and constructor-typed attributes resolve", () => {
  const expectations: Array<[string, string | undefined, string, string]> = [
    [
      "count",
      "self",
      "this-member",
      "src/orders/service.py::OrderService::method::count(self)",
    ],
    [
      "default",
      "cls",
      "this-member",
      "src/orders/service.py::OrderService::method::default(cls)",
    ],
    [
      "save",
      "self.repo",
      "declared-type",
      "src/orders/repo/sql.py::SqlRepo::method::save(self, order)",
    ],
    [
      "_key",
      "self",
      "this-member",
      "src/orders/repo/sql.py::SqlRepo::method::_key(self, order_id)",
    ],
    [
      "build",
      "OrderService",
      "static",
      "src/orders/service.py::OrderService::method::build(cls)",
    ],
  ];
  for (const [callee, receiver, kind, target] of expectations) {
    const call = callTo(callee, receiver);
    assert.equal(call?.resolutionKind, kind, `${callee}: kind`);
    assert.equal(call?.resolvedTargetId, target, `${callee}: target`);
    assert.ok(call?.evidence.length, `${callee}: evidence`);
  }
  // `cls(...)` constructs the enclosing class.
  assert.equal(
    callTo("cls")?.resolvedTargetId,
    "src/orders/service.py::OrderService::constructor::__init__(self, repo)",
  );
});

test("aliased imports and module-level calls resolve", () => {
  assert.equal(
    callTo("check_order")?.resolvedTargetId,
    "src/orders/validation.py::function::validate_order(order)",
  );
  assert.equal(callTo("check_order")?.resolutionKind, "aliased-import");
  // Module-level statements own their calls.
  const moduleCall = index.calls.find(
    (call) => call.filePath === "src/app.py" && call.calleeName === "build",
  );
  assert.ok(moduleCall?.callerId.includes("::module::"));
  assert.equal(
    moduleCall?.resolvedTargetId,
    "src/orders/service.py::OrderService::method::build(cls)",
  );
});

test("dynamic python stays unresolved rather than guessed", () => {
  // Unknown factory return, getattr, monkey patching: no exact edges.
  for (const [callee, receiver] of [
    ["create", "obj"],
    ["describe", "order"],
  ] as const) {
    const call = callTo(callee, receiver);
    assert.equal(call?.confidence, "unresolved", `${callee}`);
    assert.equal(call?.resolvedTargetId, undefined);
  }
  assert.equal(callTo("getattr")?.resolvedTargetId, undefined);
  assert.equal(
    callTo("import_module", "importlib")?.externalPackage,
    "importlib",
  );
  // A monkey-patched attribute must not become a call edge to the class method.
  const patched = byId("src/orders/dynamic.py::Patched::method::run(self)");
  assert.ok(patched);
  assert.equal(
    index.calls.some(
      (call) =>
        call.resolvedTargetId === patched!.id && call.confidence === "exact",
    ),
    false,
  );
});

test("mixed-language repositories keep languages separate", () => {
  const mixed = mkdtempSync(join(tmpdir(), "context-slice-mixed-"));
  cpSync(join(process.cwd(), "tests/fixtures/mixed"), mixed, {
    recursive: true,
    filter: (source) => !source.includes(".context-slice"),
  });
  writeFileSync(
    join(mixed, "script.py"),
    "def retry_payment(payment_id):\n    return audit(payment_id)\n\n\ndef audit(payment_id):\n    return payment_id\n",
  );
  const mixedIndex = new ProjectIndex(mixed);
  mixedIndex.rebuild();
  const languages = new Set(
    mixedIndex.symbols.map((symbol) => symbol.language),
  );
  assert.deepEqual([...languages].sort(), ["java", "python", "typescript"]);
  assert.equal(
    new Set(mixedIndex.symbols.map((symbol) => symbol.id)).size,
    mixedIndex.symbols.length,
  );
  // Each language resolved its own same-name call without crossing over.
  const pythonCall = mixedIndex.calls.find(
    (call) => call.filePath === "script.py" && call.calleeName === "audit",
  );
  assert.equal(
    pythonCall?.resolvedTargetId,
    "script.py::function::audit(payment_id)",
  );
  assert.equal(mixedIndex.inspect().filesByExtension[".py"], 1);
  assert.ok(mixedIndex.search("retry").length >= 2);
  mixedIndex.close();
  rmSync(mixed, { recursive: true, force: true });
});

test("large python modules are parsed, never silently skipped", () => {
  const big = `def head():\n    return 1\n\n${Array.from(
    { length: 4000 },
    (_, at) => `def generated_${at}(value):\n    return value + ${at}\n`,
  ).join("\n")}`;
  assert.ok(big.length > 128_000, "fixture must exceed the binding limit");
  const parsed = parsePython("big.py", big);
  assert.equal(parsed.parseError, false);
  assert.equal(parsed.symbols.length, 4001);
});

test("parse errors are reported without throwing", () => {
  const broken = parsePython("broken.py", "def (:\n  ???\n");
  assert.equal(broken.parseError, true);
  assert.ok(Array.isArray(broken.symbols));
});

test.after(() => rmSync(root, { recursive: true, force: true }));
