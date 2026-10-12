import { runTaskBenchmark } from "./task-harness.js";

runTaskBenchmark({
  version: "1.10-kotlin-tasks",
  title: "ContextSlice v1.10 — Kotlin Task Evaluation",
  note: "Small sample (n=2 tasks, kotlin-csv only); not comparable to the larger Rust/Java/TypeScript/Python samples.",
  repositoriesFile: "benchmarks/kotlin-repositories.json",
  tasksFile: "benchmarks/kotlin-tasks.json",
  manualContextFile: "benchmarks/kotlin-manual-context.json",
  outputBaseName: "v1.10-kotlin-tasks",
  changedFileExtension: ".kt",
});
