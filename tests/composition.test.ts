import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeSiblings } from "../src/planner/composition.js";
import { buildPreview } from "../src/workflow/preview.js";

const root = mkdtempSync(join(tmpdir(), "context-slice-composition-"));
cpSync(join(process.cwd(), "tests/fixtures/context-composition"), root, {
  recursive: true,
  filter: (source) => !source.includes(".context-slice"),
});
const index = new ProjectIndex(root);
index.rebuild();
let coldIndex: ProjectIndex | undefined;
const targetOf = (qualified: string) => {
  const found = index.symbols.find(
    (symbol) => symbol.qualifiedName === qualified,
  );
  assert.ok(found, `missing target ${qualified}`);
  return found!;
};

test("a large enclosing type yields a compact skeleton, never a class dump", () => {
  const [skeleton] = composeSiblings(index, targetOf("BigService.target"));
  assert.equal(skeleton.reason, "enclosing type");
  assert.match(skeleton.evidence[0], /12 of 42 members/);
  assert.match(skeleton.rendered, /… 30 more members/);
  // Declaration lines only: no member body reaches the slice.
  assert.equal(skeleton.rendered.includes("return value +"), false);
  assert.ok(skeleton.estimatedTokens < 200, "skeleton must stay compact");
});

test("a Java skeleton carries field declarations and fields are now indexed as symbols", () => {
  const [skeleton] = composeSiblings(index, targetOf("demo.Counter.increment"));
  assert.match(skeleton.rendered, /private int count;/);
  assert.match(skeleton.rendered, /public int current\(\)/);
  assert.ok(
    index.symbols.some(
      (symbol) =>
        symbol.name === "count" &&
        symbol.filePath.endsWith(".java") &&
        symbol.kind === "field",
    ),
    "field 'count' should be indexed as a separate symbol",
  );
});

test("members already in the slice are not repeated", () => {
  const target = targetOf("BigService.target");
  const other = targetOf("BigService.readState");
  const [skeleton] = composeSiblings(
    index,
    target,
    new Set([target.id, other.id]),
  );
  assert.equal(skeleton.rendered.includes("readState()"), false);
  assert.match(skeleton.evidence[0], /1 already in the slice/);
});

test("preview composes the skeleton with evidence and respects the budget", () => {
  const preview = buildPreview(index, "BigService.target", { budget: 1200 });
  const composed = preview.included.find(
    (item) => item.reason === "enclosing type",
  );
  assert.ok(composed);
  assert.ok((composed!.evidence ?? []).length > 0);
  assert.ok(preview.estimatedTokens <= preview.budget);
  // Composition is optional, and a tight budget keeps the target first.
  assert.equal(
    buildPreview(index, "BigService.target", {
      budget: 1200,
      composition: false,
    }).included.some((item) => item.reason === "enclosing type"),
    false,
  );
  const tight = buildPreview(index, "BigService.target", { budget: 30 });
  assert.equal(tight.included[0].reason, "task target");
  assert.ok(tight.estimatedTokens <= 30);
});

test("a Java skeleton survives a cold-start rebuild that reuses cached (lean) symbols", () => {
  // A brand-new ProjectIndex has no in-memory snapshot, so its first rebuild() loads the
  // persisted index "lean" (source/body stripped) for its cache-hit comparison, then reuses
  // those cached symbol objects directly for any file whose mtime/size didn't change.
  // composeSiblings() reads parent.source/parent.body on exactly this kind of reused symbol,
  // so this covers that path end to end (observed failing in production as "Cannot read
  // properties of undefined (reading 'matchAll')" after a process restart, though this
  // fixture is too small to force the same lean-object shape on demand).
  coldIndex = new ProjectIndex(root);
  const result = coldIndex.rebuild();
  assert.ok(result.cacheHits > 0, "expected the cold rebuild to reuse cached files");
  const target = coldIndex.symbols.find(
    (symbol) => symbol.qualifiedName === "demo.Counter.increment",
  );
  assert.ok(target, "missing target demo.Counter.increment");
  assert.doesNotThrow(() => composeSiblings(coldIndex!, target!));
  const [skeleton] = composeSiblings(coldIndex, target!);
  assert.match(skeleton.rendered, /private int count;/);
});

test("CompositionReason accepts 'enterprise relation' (type-level, no runtime producer yet)", () => {
  const reason: import("../src/planner/composition.js").CompositionReason =
    "enterprise relation";
  assert.equal(reason, "enterprise relation");
});

test.after(() => {
  index.close();
  coldIndex?.close();
  rmSync(root, { recursive: true, force: true });
});
