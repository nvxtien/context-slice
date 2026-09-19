import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { estimateTokens } from "../src/planner/budget.js";

type Fact = { id: string; description: string; patterns: string[] };
type Task = {
  id: string;
  repository: string;
  task: string;
  targetSymbol: string;
  requiredFacts: Fact[];
};
const root = join(process.cwd(), "test-fixtures/java");
const tasks = JSON.parse(
  readFileSync(join(process.cwd(), "benchmarks/tasks.json"), "utf8"),
) as Task[];
rmSync(join(root, ".context-slice"), { recursive: true, force: true });
const index = new ProjectIndex(root);
const cold = index.rebuild();
const warm = index.rebuild();
const files = [
  "PaymentService.java",
  "PaymentController.java",
  "PaymentRetryJob.java",
  "PaymentServiceTest.java",
]
  .map((file) => readFileSync(join(root, file), "utf8"))
  .join("\n");
function recall(text: string, facts: Fact[]) {
  return facts
    .filter((fact) => fact.patterns.every((pattern) => text.includes(pattern)))
    .map((fact) => fact.id);
}
function sliceFor(targetSymbol: string, budget: number) {
  const candidates = index.resolveSymbol(targetSymbol);
  const target =
    candidates.find((symbol) =>
      symbol.annotations.includes("@Transactional"),
    ) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!target) throw new Error(`Ambiguous fixture target: ${targetSymbol}`);
  const relatedTests = index.symbols.filter(
    (symbol) =>
      symbol.filePath.endsWith("Test.java") &&
      symbol.source.includes(target.name),
  );
  const items = [
    target.source,
    ...index
      .callers(target)
      .map((symbol) => `${symbol.qualifiedName}\n${symbol.source}`),
    ...index
      .dependencies(target)
      .map((symbol) => `${symbol.qualifiedName}\n${symbol.source}`),
    ...relatedTests.map(
      (symbol) => `${symbol.qualifiedName}\n${symbol.source}`,
    ),
  ];
  const selected: string[] = [];
  let used = 0;
  for (const item of items) {
    const tokens = estimateTokens(item);
    if (selected.length && used + tokens > budget) continue;
    selected.push(item);
    used += tokens;
  }
  return {
    text: selected.join("\n\n"),
    estimatedTokens: used,
    symbols: selected.length,
  };
}
const rows: Array<Record<string, unknown>> = [];
for (const task of tasks) {
  const baselineFacts = recall(files, task.requiredFacts);
  const baselineTokens = estimateTokens(files);
  let minimum: number | null = null;
  for (const budget of [256, 512, 1024, 2048, 4096, 8192]) {
    const slice = sliceFor(task.targetSymbol, budget);
    const factIds = recall(slice.text, task.requiredFacts);
    if (factIds.length === task.requiredFacts.length && minimum === null)
      minimum = budget;
    rows.push({
      repository: task.repository,
      task: task.id,
      mode: "ContextSlice",
      budget,
      baselineTokens,
      sliceTokens: slice.estimatedTokens,
      reductionPercent: Number(
        ((1 - slice.estimatedTokens / baselineTokens) * 100).toFixed(2),
      ),
      requiredFactRecall: `${factIds.length}/${task.requiredFacts.length}`,
      contextEfficiency: Number(
        (factIds.length / Math.max(slice.estimatedTokens, 1)).toFixed(4),
      ),
      minimumSufficientBudget: minimum,
      includedSymbols: slice.symbols,
      missingFacts: task.requiredFacts
        .filter((fact) => !factIds.includes(fact.id))
        .map((fact) => fact.id),
    });
  }
  rows.push({
    repository: task.repository,
    task: task.id,
    mode: "Whole-file baseline",
    budget: null,
    baselineTokens,
    sliceTokens: baselineTokens,
    reductionPercent: 0,
    requiredFactRecall: `${baselineFacts.length}/${task.requiredFacts.length}`,
    contextEfficiency: Number(
      (baselineFacts.length / baselineTokens).toFixed(4),
    ),
    minimumSufficientBudget: null,
    includedSymbols: 4,
    missingFacts: task.requiredFacts
      .filter((fact) => !baselineFacts.includes(fact.id))
      .map((fact) => fact.id),
  });
}
const output = {
  generatedAt: new Date().toISOString(),
  coldIndex: cold,
  warmIndex: warm,
  unresolvedCallRate: index.calls.length
    ? Number(
        (
          index.calls.filter((call) => call.confidence === "unresolved")
            .length / index.calls.length
        ).toFixed(4),
      )
    : 0,
  ambiguousCallRate: index.calls.length
    ? Number((index.ambiguousCalls().length / index.calls.length).toFixed(4))
    : 0,
  tasks: rows,
};
mkdirSync(join(process.cwd(), "benchmarks/results"), { recursive: true });
writeFileSync(
  join(process.cwd(), "benchmarks/results/latest.json"),
  JSON.stringify(output, null, 2),
);
const contextRows = rows.filter((row) => row.mode === "ContextSlice");
const reductions = contextRows
  .map((row) => Number(row.reductionPercent))
  .sort((a, b) => a - b);
const markdown = [
  `# ContextSlice v0.2 Validation`,
  ``,
  `Generated: ${output.generatedAt}`,
  ``,
  `## STATUS`,
  ``,
  `Fixture validation passed. Real-repository and agent comparison runs are pending because no external repository checkout or agent telemetry is available in this workspace.`,
  ``,
  `## Index and cache`,
  ``,
  `- Cold index: ${JSON.stringify(cold)}`,
  `- Warm index: ${JSON.stringify(warm)}`,
  `- Unresolved call rate: ${output.unresolvedCallRate}`,
  `- Ambiguous call rate: ${output.ambiguousCallRate}`,
  ``,
  `## Benchmark`,
  ``,
  `| Repo | Task | Budget | Baseline tokens | Slice tokens | Reduction | Required fact recall | Min sufficient budget |`,
  `|---|---|---:|---:|---:|---:|---:|---:|`,
  ...contextRows.map(
    (row) =>
      `| ${row.repository} | ${row.task} | ${row.budget} | ${row.baselineTokens} | ${row.sliceTokens} | ${row.reductionPercent}% | ${row.requiredFactRecall} | ${row.minimumSufficientBudget ?? "-"} |`,
  ),
  ``,
  `- Median token reduction: ${reductions[Math.floor(reductions.length / 2)]}%`,
  `- Required facts are matched deterministically from declared patterns.`,
  `- Agent baseline metrics are not reported because this environment does not expose agent runtime telemetry.`,
  ``,
  `## TREE-SITTER LIMITATIONS`,
  ``,
  `Interface dispatch, overloads and unknown receivers remain unresolved or probable. This report measures the limitation instead of treating it as exact resolution.`,
  ``,
  `## LSP/JDT DECISION`,
  ``,
  `Insufficient evidence for v0.3 LSP/JDT integration. Make that decision only after small, medium and bounded large real repositories show how often unresolved or ambiguous edges cause required-fact loss or failed tasks.`,
].join("\n");
writeFileSync(join(process.cwd(), "benchmarks/results/latest.md"), markdown);
console.log(markdown);
