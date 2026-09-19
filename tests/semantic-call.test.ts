import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

test("resolves same-class, interface, inherited and constructor calls", () => {
  const index = new ProjectIndex(
    join(process.cwd(), "tests/fixtures/semantic-calls"),
  );
  index.rebuild();
  const caller = index.resolveSymbol("Service.run")[0];
  assert.ok(caller);
  const edges = index.calls.filter((call) => call.callerId === caller.id);
  const edge = (name: string) => edges.find((call) => call.calleeName === name);
  assert.equal(edge("local")?.confidence, "exact");
  assert.equal(edge("local")?.resolutionKind, "same-type");
  assert.equal(edge("save")?.confidence, "probable");
  assert.equal(edge("save")?.resolutionKind, "interface");
  assert.equal(edge("inherited")?.resolutionKind, "inherited");
  assert.equal(edge("Item")?.resolutionKind, "constructor");
});

test("keeps unknown library and fluent receivers unresolved", () => {
  const index = new ProjectIndex(
    join(process.cwd(), "tests/fixtures/semantic-calls"),
  );
  index.rebuild();
  const caller = index.resolveSymbol("StaticAndChain.run")[0];
  const edges = index.calls.filter((call) => call.callerId === caller.id);
  assert.equal(
    edges.find((call) => call.calleeName === "requireNonNull")?.confidence,
    "unresolved",
  );
  assert.equal(
    edges.find((call) => call.calleeName === "trim")?.confidence,
    "unresolved",
  );
});
