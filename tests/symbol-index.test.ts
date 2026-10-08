import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

function indexFixture() {
  const index = new ProjectIndex(
    join(process.cwd(), "tests/fixtures/symbol-index"),
  );
  index.rebuild();
  return index;
}

test("canonical identity separates packages, overloads and nested types", () => {
  const index = indexFixture();
  assert.equal(index.resolveSymbol("com.example.user.UserService").length, 1);
  assert.ok(index.resolveSymbol("UserService").length >= 2);
  const saves = index.symbols.filter((symbol) => symbol.name === "save");
  assert.ok(saves.length >= 4);
  assert.equal(new Set(saves.map((symbol) => symbol.id)).size, saves.length);
  assert.ok(
    index.symbols.some(
      (symbol) =>
        symbol.qualifiedName === "com.example.user.UserService.Inner.run",
    ),
  );
  assert.ok(
    index.symbols.some(
      (symbol) =>
        symbol.kind === "record" &&
        symbol.qualifiedName?.endsWith("UserService.Event"),
    ),
  );
  assert.ok(
    index.symbols.some(
      (symbol) =>
        symbol.kind === "enum" &&
        symbol.qualifiedName?.endsWith("UserService.Status"),
    ),
  );
});

test("IDs remain stable across reindex and unrelated file changes", () => {
  const index = indexFixture();
  const first = index.symbols.map((symbol) => symbol.id).sort();
  index.rebuild();
  assert.deepEqual(index.symbols.map((symbol) => symbol.id).sort(), first);
});

test("diagnostics expose duplicate names without collisions", () => {
  const diagnostics = indexFixture().diagnostics();
  assert.ok(diagnostics.duplicateSimpleNames > 0);
  assert.equal(diagnostics.symbolIdCollisions, 0);
  assert.ok(diagnostics.interfacesIndexed > 0);
});

test("callsFor uses the caller lookup index", () => {
  const index = indexFixture();
  const target = index.symbols.find((symbol) => symbol.name === "run")!;
  assert.deepEqual(
    index.callsFor(target),
    index.calls.filter((call) => call.callerId === target.id),
  );
});
