import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import {
  ALL_COMPOSITION_RULES,
  composeSiblings,
  type CompositionRules,
} from "../src/planner/composition.js";
import { buildPreview } from "../src/workflow/preview.js";
import type { SymbolRecord } from "../src/types/model.js";

let shared: { root: string; index: ProjectIndex } | undefined;
function fixture() {
  if (!shared) {
    const root = mkdtempSync(join(tmpdir(), "context-slice-composition-"));
    cpSync(join(process.cwd(), "tests/fixtures/context-composition"), root, {
      recursive: true,
      filter: (source) => !source.includes(".context-slice"),
    });
    const index = new ProjectIndex(root);
    index.rebuild();
    shared = { root, index };
  }
  return shared;
}
const targetOf = (index: ProjectIndex, qualified: string) => {
  const found = index.symbols.find(
    (symbol) =>
      symbol.qualifiedName === qualified && symbol.kind !== "namespace",
  );
  assert.ok(found, `missing target ${qualified}`);
  return found as SymbolRecord;
};
const compose = (qualified: string, rules?: Partial<CompositionRules>) => {
  const { index } = fixture();
  return composeSiblings(index, targetOf(index, qualified), {
    ...ALL_COMPOSITION_RULES,
    ...rules,
  });
};
const labels = (qualified: string, rules?: Partial<CompositionRules>) =>
  compose(qualified, rules).map((candidate) => candidate.label);

test("a sibling sharing a field with the target is composed in", () => {
  const candidates = compose("Cart.add");
  const getTotal = candidates.find(
    (candidate) => candidate.label === "Cart.getTotal",
  );
  assert.equal(getTotal?.reason, "state accessor");
  assert.match(getTotal!.evidence[0], /reads total/);
  // The field declaration itself is context the target needs.
  assert.ok(
    candidates.some(
      (candidate) =>
        candidate.label === "Cart.total" &&
        candidate.reason === "same-type shared state",
    ),
  );
});

test("unrelated siblings are never composed in", () => {
  // `unrelated` touches only auditLog, which `add` never uses.
  assert.equal(labels("Cart.add").includes("Cart.unrelated"), false);
  assert.equal(
    labels("OrderService.create").includes("OrderService.announce"),
    false,
  );
  assert.equal(
    labels("Checkout.submit").includes("Checkout.unrelatedHelper"),
    false,
  );
  assert.equal(
    labels("demo.Counter.increment").includes("demo.Counter.describe"),
    false,
  );
});

test("constructor dependencies used by the target are composed in", () => {
  const candidates = compose("OrderService.create");
  const dependency = candidates.find(
    (candidate) => candidate.reason === "constructor dependency",
  );
  assert.match(dependency!.evidence[0], /supplies repo/);
  assert.ok(
    candidates.some((candidate) => candidate.label === "OrderService.repo"),
  );
});

test("lexical siblings sharing local state are composed in", () => {
  const candidates = compose("Checkout.submit");
  const preview = candidates.find(
    (candidate) => candidate.label === "Checkout.preview",
  );
  assert.equal(preview?.reason, "lexical shared state");
  assert.match(preview!.evidence[0], /both use draft/);
});

test("Java field sharing works without indexing fields as symbols", () => {
  const { index } = fixture();
  const candidates = compose("demo.Counter.increment");
  assert.ok(
    candidates.some(
      (candidate) =>
        candidate.label === "demo.Counter.count" &&
        candidate.evidence[0] === "target writes count",
    ),
  );
  assert.ok(
    candidates.some((candidate) => candidate.label === "demo.Counter.current"),
  );
  // The field is analysis-only: it must not become a searchable symbol.
  assert.equal(
    index.symbols.some(
      (symbol) => symbol.name === "count" && symbol.filePath.endsWith(".java"),
    ),
    false,
  );
});

test("a large enclosing type yields a compact skeleton, never a class dump", () => {
  const { index } = fixture();
  const candidates = compose("BigService.target");
  const skeleton = candidates.find(
    (candidate) => candidate.reason === "enclosing type",
  );
  assert.ok(skeleton);
  assert.match(skeleton!.evidence[0], /12 of 42 members/);
  assert.match(skeleton!.rendered, /… 30 more members/);
  // Declaration lines only: no member body from the skeleton.
  assert.equal(skeleton!.rendered.includes("return value +"), false);
  assert.ok(skeleton!.estimatedTokens < 200, "skeleton must stay compact");
  const whole = index.symbols.find(
    (symbol) => symbol.qualifiedName === "BigService",
  )!;
  assert.ok(
    skeleton!.estimatedTokens < whole.source.length / 20,
    "skeleton must be far smaller than the class",
  );
});

test("each rule can be disabled independently", () => {
  assert.equal(
    compose("Cart.add", { accessors: false }).some(
      (candidate) => candidate.label === "Cart.getTotal",
    ),
    false,
  );
  assert.equal(
    compose("BigService.target", { enclosingType: false }).some(
      (candidate) => candidate.reason === "enclosing type",
    ),
    false,
  );
  assert.equal(
    compose("Checkout.submit", { lexicalSharedState: false }).length,
    0,
  );
});

test("preview includes composed siblings with evidence and respects the budget", () => {
  const { index } = fixture();
  const preview = buildPreview(index, "Cart.add", { budget: 1200 });
  const composed = preview.included.filter((item) =>
    ["same-type shared state", "state accessor", "enclosing type"].includes(
      item.reason,
    ),
  );
  assert.ok(composed.length >= 2);
  assert.ok(composed.every((item) => (item.evidence ?? []).length > 0));
  assert.ok(preview.estimatedTokens <= preview.budget);
  assert.equal(
    preview.included.some((item) => item.symbol === "Cart.unrelated"),
    false,
  );
  // A tight budget keeps the target and reports what it dropped.
  const tight = buildPreview(index, "Cart.add", { budget: 40 });
  assert.equal(tight.included[0].reason, "task target");
  assert.ok(tight.omitted.length > 0);
  assert.ok(tight.estimatedTokens <= 40);
});

test("composition depends only on the index and the target", () => {
  const { index } = fixture();
  const candidates = composeSiblings(index, targetOf(index, "Cart.add"));
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => candidate.filePath.length > 0));
  assert.ok(candidates.every((candidate) => candidate.evidence.length > 0));
});

test.after(() => {
  if (shared) rmSync(shared.root, { recursive: true, force: true });
});
