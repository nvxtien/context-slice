import { runTaskBenchmark } from "./task-harness.js";

runTaskBenchmark({
  version: "1.10-javascript-tasks",
  title: "ContextSlice v1.10 — JavaScript Task Evaluation",
  note: "Small sample (n=8 tasks, express and chalk); not comparable to the larger Rust/Java/TypeScript/Python samples.",
  repositoriesFile: "benchmarks/javascript-repositories.json",
  tasksFile: "benchmarks/javascript-tasks.json",
  manualContextFile: "benchmarks/javascript-manual-context.json",
  outputBaseName: "v1.10-javascript-tasks",
  changedFileExtension: ".js",
});
