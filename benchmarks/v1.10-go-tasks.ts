import { runTaskBenchmark } from "./task-harness.js";

runTaskBenchmark({
  version: "1.10-go-tasks",
  title: "ContextSlice v1.10 — Go Task Evaluation",
  note: "Small sample (n=8 tasks, gorilla/mux and chi); not comparable to the larger Rust/Java/TypeScript/Python samples.",
  repositoriesFile: "benchmarks/go-task-repositories.json",
  tasksFile: "benchmarks/go-tasks.json",
  manualContextFile: "benchmarks/go-manual-context.json",
  outputBaseName: "v1.10-go-tasks",
  changedFileExtension: ".go",
});
