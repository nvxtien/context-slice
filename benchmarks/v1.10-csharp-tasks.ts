import { runTaskBenchmark } from "./task-harness.js";

runTaskBenchmark({
  version: "1.10-csharp-tasks",
  title: "ContextSlice v1.10 — C# Task Evaluation",
  note: "Small sample (n=8 tasks, serilog only); not comparable to the larger Rust/Java/TypeScript/Python samples.",
  repositoriesFile: "benchmarks/csharp-repositories.json",
  tasksFile: "benchmarks/csharp-tasks.json",
  manualContextFile: "benchmarks/csharp-manual-context.json",
  outputBaseName: "v1.10-csharp-tasks",
  changedFileExtension: ".cs",
});
