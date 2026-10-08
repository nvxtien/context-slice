import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { languageSnapshots } from "../src/indexer/language-snapshot.js";
import { QueryIndex } from "../src/indexer/query-index.js";

test("language snapshots isolate records before adapter resolution", () => {
  const index = new ProjectIndex(
    join(process.cwd(), "tests/fixtures/symbol-index"),
  );
  index.rebuild();
  const snapshots = languageSnapshots(
    index.symbols,
    index.calls,
    index.imports,
    index.exports,
  );
  for (const snapshot of snapshots.values()) {
    assert.ok(
      snapshot.symbols.every((symbol) => symbol.language === snapshot.id),
    );
    assert.ok(
      snapshot.imports.every((record) => record.language === snapshot.id),
    );
    assert.ok(
      snapshot.exports.every((record) => record.language === snapshot.id),
    );
    assert.ok(
      snapshot.calls.every((call) => (call.language ?? "java") === snapshot.id),
    );
  }
});

test("query index owns derived symbol and call lookups", () => {
  const index = new ProjectIndex(
    join(process.cwd(), "tests/fixtures/symbol-index"),
  );
  index.rebuild();
  const query = new QueryIndex();
  query.rebuild(index.symbols, index.calls);
  const target = index.symbols.find((symbol) => symbol.name === "run")!;
  assert.equal(query.symbolById(target.id), target);
  assert.deepEqual(
    query.callsFor(target),
    index.calls.filter((call) => call.callerId === target.id),
  );
});

test("query index can add lazy-loaded calls without rebuilding symbols", () => {
  const index = new ProjectIndex(
    join(process.cwd(), "tests/fixtures/symbol-index"),
  );
  index.rebuild();
  const query = new QueryIndex();
  query.rebuild(index.symbols, []);
  query.addCalls(index.calls);
  const target = index.symbols.find((symbol) => symbol.name === "run")!;
  assert.deepEqual(
    query.callsFor(target),
    index.calls.filter((call) => call.callerId === target.id),
  );
});
