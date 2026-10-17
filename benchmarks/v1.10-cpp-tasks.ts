import { runTaskBenchmark } from "./task-harness.js";

runTaskBenchmark({
  version: "1.10-cpp-tasks",
  title: "ContextSlice v1.10 — C++ Task Evaluation",
  note: "Small sample (n=8 tasks, fmt only); not comparable to the larger Rust/Java/TypeScript/Python samples.",
  repositoriesFile: "benchmarks/cpp-repositories.json",
  tasksFile: "benchmarks/cpp-tasks.json",
  manualContextFile: "benchmarks/cpp-manual-context.json",
  outputBaseName: "v1.10-cpp-tasks",
  changedFileExtension: ".cc",
});
