import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = <T>(f: string) => JSON.parse(readFileSync(join(process.cwd(), f), "utf8")) as T;
type Task = { id: string; repository: string; category: string; targetSymbol: string;
  groundTruthFiles: string[]; baselineFiles: string[];
  requiredFacts: { id: string; verification: { patterns: string[] } }[] };
const repos = read<{ id: string; source: string }[]>("benchmarks/rust-repositories.json");
const tasks = read<Task[]>("benchmarks/rust-tasks.json");
const baselines = read<{ taskId: string; files: string[] }[]>("benchmarks/rust-manual-context.json");
const checkedOut = repos.every((r) => existsSync(join(process.cwd(), r.source)));

test("15 tasks, 5 per repository, all four categories, unique ids", () => {
  assert.equal(tasks.length, 15);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 15);
  for (const r of repos) assert.equal(tasks.filter((t) => t.repository === r.id).length, 5);
  for (const c of ["locate", "explain", "change", "impact"])
    assert.ok(tasks.some((t) => t.category === c), c);
});
test("each repository has 2 explain, 1 locate, 1 change, 1 impact", () => {
  for (const r of repos) {
    const n = (c: string) => tasks.filter((t) => t.repository === r.id && t.category === c).length;
    assert.deepEqual([n("explain"), n("locate"), n("change"), n("impact")], [2, 1, 1, 1], r.id);
  }
});
test("every task has a baseline and 3-4 facts", () => {
  for (const t of tasks) {
    assert.ok(baselines.some((b) => b.taskId === t.id), t.id);
    assert.ok(t.requiredFacts.length >= 3 && t.requiredFacts.length <= 4, t.id);
    assert.deepEqual(t.baselineFiles, baselines.find((b) => b.taskId === t.id)!.files);
  }
});
test("every fact pattern occurs verbatim in a ground-truth file", { skip: !checkedOut && "run npm run benchmark:checkouts" }, () => {
  for (const t of tasks) {
    const root = repos.find((r) => r.id === t.repository)!.source;
    const text = t.groundTruthFiles.map((f) => readFileSync(join(process.cwd(), root, f), "utf8")).join("\n");
    for (const f of t.requiredFacts) for (const p of f.verification.patterns)
      assert.ok(text.includes(p), `${t.id}/${f.id}: ${p}`);
  }
});
