import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FROZEN_DIR, frozenLines } from "../benchmarks/rust-freeze-hash.js";

const MSG =
  "Ground truth is frozen. To change a label, add an entry to CORRECTIONS.md, regenerate FROZEN.sha256 " +
  "(npx tsx benchmarks/rust-freeze-hash.ts, paste output below the # header) and use a commit message starting `docs(bench): correct`.";

const load = (f: string) =>
  JSON.parse(readFileSync(join(FROZEN_DIR, f), "utf8"));

test("frozen ground truth hashes match FROZEN.sha256 (why excluded)", () => {
  const p = join(FROZEN_DIR, "FROZEN.sha256");
  const committed = existsSync(p)
    ? readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
    : [];
  assert.deepEqual(frozenLines(), committed, MSG);
});

test("label entries match sampler fields and resolved entries have target.line", () => {
  const key = (e: any) => `${e.repo}:${e.file}:${e.line}:${e.col}`;
  const samples = new Map<string, any>();
  for (const e of [...load("sample.json"), ...load("sample-trait.json")])
    samples.set(key(e), e);
  let n = 0;
  for (const f of ["walkdir.json", "mini-redis.json", "ripgrep-ignore.json"]) {
    for (const e of load(f)) {
      const { expected, ...sampler } = e;
      assert.deepEqual(
        sampler,
        samples.get(key(e)),
        `${f} ${key(e)}: sampler fields differ. ${MSG}`,
      );
      if (expected.kind === "resolved")
        assert.ok(
          Number.isInteger(expected.target?.line),
          `${key(e)} resolved without target.line`,
        );
      n++;
    }
  }
  assert.equal(n, 99);
});
