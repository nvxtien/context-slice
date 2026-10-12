// Mirrors rust-tasks-integrity.test.ts's ground-truth check for the v1.10 C/C++/C#/Kotlin task
// sets: this is what keeps a "required fact" from silently drifting out of sync with the real
// pinned checkout it claims to quote.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = <T>(f: string) =>
  JSON.parse(readFileSync(join(process.cwd(), f), "utf8")) as T;
type Task = {
  id: string;
  repository: string;
  groundTruthFiles: string[];
  baselineFiles: string[];
  requiredFacts: { id: string; verification: { patterns: string[] } }[];
};

const languages = [
  {
    name: "C",
    repositories: "benchmarks/c-repositories.json",
    tasks: "benchmarks/c-tasks.json",
    manualContext: "benchmarks/c-manual-context.json",
  },
  {
    name: "C++",
    repositories: "benchmarks/cpp-repositories.json",
    tasks: "benchmarks/cpp-tasks.json",
    manualContext: "benchmarks/cpp-manual-context.json",
  },
  {
    name: "C#",
    repositories: "benchmarks/csharp-repositories.json",
    tasks: "benchmarks/csharp-tasks.json",
    manualContext: "benchmarks/csharp-manual-context.json",
  },
  {
    name: "Kotlin",
    repositories: "benchmarks/kotlin-repositories.json",
    tasks: "benchmarks/kotlin-tasks.json",
    manualContext: "benchmarks/kotlin-manual-context.json",
  },
];

for (const language of languages) {
  const repos = read<{ id: string; source: string }[]>(language.repositories);
  const tasks = read<Task[]>(language.tasks);
  const baselines = read<{ taskId: string; files: string[] }[]>(
    language.manualContext,
  );
  const checkedOut = repos.every((r) =>
    existsSync(join(process.cwd(), r.source)),
  );

  test(`${language.name}: every task has a unique id, a baseline, and at least one fact`, () => {
    assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
    for (const t of tasks) {
      assert.ok(
        baselines.some((b) => b.taskId === t.id),
        t.id,
      );
      assert.ok(t.requiredFacts.length >= 1, t.id);
      assert.deepEqual(
        t.baselineFiles,
        baselines.find((b) => b.taskId === t.id)!.files,
      );
    }
  });

  test(
    `${language.name}: every fact pattern occurs verbatim in a ground-truth file`,
    { skip: !checkedOut && "run npm run benchmark:checkouts" },
    () => {
      for (const t of tasks) {
        const root = repos.find((r) => r.id === t.repository)!.source;
        const text = t.groundTruthFiles
          .map((f) => readFileSync(join(process.cwd(), root, f), "utf8"))
          .join("\n");
        for (const f of t.requiredFacts)
          for (const p of f.verification.patterns)
            assert.ok(text.includes(p), `${t.id}/${f.id}: ${p}`);
      }
    },
  );
}
