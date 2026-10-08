import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
import { ProjectIndex } from "../src/indexer/index.js";

test("refuses to read a file outside the repository root", () => {
  const index = new ProjectIndex(join(process.cwd(), "test-fixtures/java"));
  index.rebuild();
  const symbol = index.resolveSymbol("PaymentService")[0];
  assert.throws(
    () => index.sourceFor({ ...symbol, filePath: "../outside.java" }),
    /escapes repository root/,
  );
});

test("production retrieval never reads benchmark answers", () => {
  // Any import of benchmark ground truth from runtime code would leak answers
  // into retrieval; the runtime must only ever see repository source.
  const runtime = walk(join(process.cwd(), "src"));
  const forbidden =
    /benchmarks\/|requiredFacts|expectedSymbols|manual-context|typescript-tasks|semantic-calls|rust-tasks|rust-manual-context|groundTruth/;
  const offenders = runtime.filter((file) =>
    forbidden.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders, []);
});

test("preview only reads task text, index data and repository source", () => {
  const preview = readFileSync(
    join(process.cwd(), "src/workflow/preview.ts"),
    "utf8",
  );
  for (const forbidden of ["process.env", "fetch("])
    assert.equal(
      preview.includes(forbidden),
      false,
      `preview must not use ${forbidden}`,
    );
});
