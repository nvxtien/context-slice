import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { estimateTokens } from "../src/planner/budget.js";
import type { SymbolRecord } from "../src/types/model.js";

type Verification = {
  type: "source-fragment" | "symbol-present" | "signature";
  patterns?: string[];
};
type Fact = { id: string; description: string; verification: Verification };
type Task = {
  id: string;
  repository: string;
  category: string;
  task: string;
  targetSymbol: string;
  groundTruthFiles: string[];
  groundTruth: string;
  requiredFacts: Fact[];
  baselineFiles: string[];
};
type Repository = {
  id: string;
  scale: string;
  url: string;
  commit: string;
  source: string;
  scope: string;
};
type FactResult = {
  id: string;
  preserved: boolean;
  attribution:
    | "PARSER"
    | "SYMBOL_INDEX"
    | "CALL_RESOLUTION"
    | "RANKING"
    | "TOKEN_BUDGET"
    | "DIFF_MAPPING"
    | "GROUND_TRUTH_ERROR"
    | "UNKNOWN";
};

const cwd = process.cwd();
const repositories = JSON.parse(
  readFileSync(join(cwd, "benchmarks/repositories.json"), "utf8"),
) as Repository[];
const tasks = JSON.parse(
  readFileSync(join(cwd, "benchmarks/tasks.json"), "utf8"),
) as Task[];
const budgets = [256, 512, 1024, 2048, 4096, 8192];
const outputDir = join(cwd, "benchmarks/results");
mkdirSync(outputDir, { recursive: true });

function sourceText(root: string, paths: string[]) {
  return paths
    .map((path) => {
      const full = join(root, path);
      return existsSync(full) ? readFileSync(full, "utf8") : "";
    })
    .join("\n");
}
function targetFor(index: ProjectIndex, name: string) {
  const candidates = index.resolveSymbol(name);
  return candidates.length === 1
    ? candidates[0]
    : candidates.find(
        (candidate) =>
          candidate.name === name.split(".").at(-1) &&
          candidate.qualifiedName === name,
      );
}
function factCheck(
  fact: Fact,
  text: string,
  target: SymbolRecord | undefined,
  repositoryText: string,
): boolean {
  const verification = fact.verification;
  if (verification.type === "symbol-present") return Boolean(target);
  if (verification.type === "signature") return Boolean(target?.signature);
  return (
    Boolean(
      verification.patterns?.every((pattern) => text.includes(pattern)),
    ) &&
    verification.patterns?.every((pattern) =>
      repositoryText.includes(pattern),
    ) === true
  );
}
function attribution(
  fact: Fact,
  target: SymbolRecord | undefined,
  targetText: string,
  sliceText: string,
  baselineText: string,
  budget: number,
): FactResult["attribution"] {
  if (!target) return "SYMBOL_INDEX";
  const patterns = fact.verification.patterns ?? [];
  if (
    patterns.some(
      (pattern) =>
        /\.(find|save|delete|publish|users|get|set)\s*\(/.test(pattern) &&
        !targetText.includes(pattern),
    )
  )
    return "CALL_RESOLUTION";
  if (
    patterns.some(
      (pattern) => pattern.includes("@") && !targetText.includes(pattern),
    )
  )
    return "PARSER";
  if (
    baselineText.includes(patterns[0] ?? "") &&
    budget < estimateTokens(baselineText)
  )
    return "TOKEN_BUDGET";
  if (
    targetText.includes(patterns[0] ?? "") &&
    !sliceText.includes(patterns[0] ?? "")
  )
    return "RANKING";
  return "UNKNOWN";
}
function sliceText(index: ProjectIndex, target: SymbolRecord) {
  const related = [
    target.source,
    ...index
      .callers(target)
      .map((symbol) => `${symbol.qualifiedName}\n${symbol.source}`),
    ...index
      .dependencies(target)
      .map((symbol) => `${symbol.qualifiedName}\n${symbol.source}`),
  ];
  return {
    text: related.join("\n\n"),
    symbols: related.length,
    files: new Set([
      target.filePath,
      ...index.callers(target).map((symbol) => symbol.filePath),
      ...index.dependencies(target).map((symbol) => symbol.filePath),
    ]).size,
  };
}
function cacheMetrics(root: string) {
  rmSync(join(root, ".context-slice"), { recursive: true, force: true });
  const coldIndex = new ProjectIndex(root);
  const cold = coldIndex.rebuild();
  const warm = coldIndex.rebuild();
  const javaFile = coldIndex.symbols[0]?.filePath;
  let update = {
    filesParsed: 0,
    cacheHits: 0,
    filesScanned: 0,
    symbolsUpdated: 0,
    elapsedMs: 0,
  };
  if (javaFile) {
    const file = join(root, javaFile);
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(
        file,
        `${original}\n// ContextSlice v0.3 temporary cache probe\n`,
      );
      update = new ProjectIndex(root).rebuild();
    } finally {
      writeFileSync(file, original);
    }
  }
  return { cold, warm, update };
}

const results: Record<string, unknown>[] = [];
for (const repository of repositories) {
  const root = resolve(cwd, repository.source);
  const repoTasks = tasks.filter((task) => task.repository === repository.id);
  if (!existsSync(root)) {
    results.push({
      repository: repository.id,
      scale: repository.scale,
      status: "N/A",
      reason: "checkout missing",
      tasks: [],
    });
    continue;
  }
  const cache = cacheMetrics(root);
  const index = new ProjectIndex(root);
  const summary = index.rebuild();
  const unresolved = index.calls.filter(
    (call) => call.confidence === "unresolved",
  ).length;
  const ambiguous = index.ambiguousCalls().length;
  for (const task of repoTasks) {
    const target = targetFor(index, task.targetSymbol);
    const groundTruthText = sourceText(root, task.groundTruthFiles);
    const baselineText = sourceText(root, task.baselineFiles);
    const baselineTokens = estimateTokens(baselineText);
    const baseSlice = target
      ? sliceText(index, target)
      : { text: "", symbols: 0, files: 0 };
    let minimum: number | null = null;
    for (const budget of budgets) {
      const selected = target
        ? [
            target.source,
            ...index
              .callers(target)
              .map((symbol) => `${symbol.qualifiedName}\n${symbol.source}`),
            ...index
              .dependencies(target)
              .map((symbol) => `${symbol.qualifiedName}\n${symbol.source}`),
          ].reduce((items, item) => {
            const used = estimateTokens(items.join("\n\n"));
            return used + estimateTokens(item) <= budget || items.length === 0
              ? [...items, item]
              : items;
          }, [] as string[])
        : [];
      const rendered = selected.join("\n\n");
      const factResults: FactResult[] = task.requiredFacts.map((fact) => ({
        id: fact.id,
        preserved: factCheck(fact, rendered, target, groundTruthText),
        attribution: "UNKNOWN",
      }));
      for (const factResult of factResults)
        if (!factResult.preserved) {
          const fact = task.requiredFacts.find(
            (candidate) => candidate.id === factResult.id,
          )!;
          factResult.attribution = attribution(
            fact,
            target,
            target?.source ?? "",
            rendered,
            baselineText,
            budget,
          );
        }
      const preserved = factResults.filter((fact) => fact.preserved).length;
      if (preserved === task.requiredFacts.length && minimum === null)
        minimum = budget;
      results.push({
        repository: repository.id,
        scale: repository.scale,
        status: "validated",
        task: task.id,
        category: task.category,
        targetSymbol: task.targetSymbol,
        groundTruth: task.groundTruth,
        budget,
        baselineTokens,
        sliceTokens: estimateTokens(rendered),
        tokenReductionPercent: Number(
          (
            (1 - estimateTokens(rendered) / Math.max(baselineTokens, 1)) *
            100
          ).toFixed(2),
        ),
        requiredFactsTotal: task.requiredFacts.length,
        requiredFactsPreserved: preserved,
        requiredFactRecall: preserved / Math.max(task.requiredFacts.length, 1),
        minimumSufficientBudget: minimum ?? "UNSATISFIED",
        symbolsIncluded: selected.length,
        filesTouchedByContext: baseSlice.files,
        wholeFilesRequired: task.baselineFiles.length,
        unresolvedCallsSeen: unresolved,
        ambiguousCallsSeen: ambiguous,
        missingFacts: factResults.filter((fact) => !fact.preserved),
        coldIndexMs: cache.cold.elapsedMs,
        warmQueryMs: cache.warm.elapsedMs,
        cacheUpdate: cache.update,
      });
    }
  }
  results.push({
    repository: repository.id,
    scale: repository.scale,
    status: "aggregate",
    javaFiles: summary.files,
    symbols: summary.symbols,
    calls: summary.calls,
    unresolvedCallRate: unresolved / Math.max(index.calls.length, 1),
    ambiguousCallRate: ambiguous / Math.max(index.calls.length, 1),
    cache,
  });
}

const taskRowsAll = results.filter((row) => row.status === "validated");
const taskRows = [
  ...new Set(taskRowsAll.map((row) => `${row.repository}:${row.task}`)),
].map((key) => {
  const rows = taskRowsAll.filter(
    (row) => `${row.repository}:${row.task}` === key,
  );
  const sufficient = rows.find(
    (row) => typeof row.minimumSufficientBudget === "number",
  );
  return sufficient ?? rows.at(-1)!;
});
const allFacts = taskRows.reduce(
  (sum, row) => sum + Number(row.requiredFactsTotal),
  0,
);
const preservedFacts = taskRows.reduce(
  (sum, row) => sum + Number(row.requiredFactsPreserved),
  0,
);
const harmTasks = taskRows.filter(
  (row) =>
    Array.isArray(row.missingFacts) &&
    (row.missingFacts as FactResult[]).some(
      (fact) => fact.attribution === "CALL_RESOLUTION",
    ),
);
const reductions = taskRows
  .map((row) => Number(row.tokenReductionPercent))
  .sort((a, b) => a - b);
const percentile = (p: number) =>
  reductions.length
    ? reductions[
        Math.min(reductions.length - 1, Math.floor(reductions.length * p))
      ]
    : null;
const report = {
  generatedAt: new Date().toISOString(),
  repositories,
  taskCount: taskRows.length,
  totalRequiredFacts: allFacts,
  overallRequiredFactRecall: preservedFacts / Math.max(allFacts, 1),
  medianTokenReduction: percentile(0.5),
  p25TokenReduction: percentile(0.25),
  p75TokenReduction: percentile(0.75),
  resolutionHarmRate:
    harmTasks.length /
    Math.max(new Set(taskRows.map((row) => row.task)).size, 1),
  resolutionFactLossRate:
    taskRows.reduce(
      (sum, row) =>
        sum +
        (row.missingFacts as FactResult[]).filter(
          (fact) => fact.attribution === "CALL_RESOLUTION",
        ).length,
      0,
    ) / Math.max(allFacts, 1),
  parserFailureCount: taskRows.reduce(
    (sum, row) =>
      sum +
      (row.missingFacts as FactResult[]).filter(
        (fact) => fact.attribution === "PARSER",
      ).length,
    0,
  ),
  rankingFailureCount: taskRows.reduce(
    (sum, row) =>
      sum +
      (row.missingFacts as FactResult[]).filter(
        (fact) => fact.attribution === "RANKING",
      ).length,
    0,
  ),
  budgetFailureCount: taskRows.reduce(
    (sum, row) =>
      sum +
      (row.missingFacts as FactResult[]).filter(
        (fact) => fact.attribution === "TOKEN_BUDGET",
      ).length,
    0,
  ),
  resolutionFailureCount: taskRows.reduce(
    (sum, row) =>
      sum +
      (row.missingFacts as FactResult[]).filter(
        (fact) => fact.attribution === "CALL_RESOLUTION",
      ).length,
    0,
  ),
  results,
};
writeFileSync(
  join(outputDir, "v0.3-real-repositories.json"),
  JSON.stringify(report, null, 2),
);
const markdown = [
  `# ContextSlice v0.3 Real Repository Evaluation`,
  ``,
  `Generated: ${report.generatedAt}`,
  ``,
  `## Executive Summary`,
  ``,
  `- Repository tasks evaluated: ${report.taskCount}`,
  `- Overall required-fact recall: ${(report.overallRequiredFactRecall * 100).toFixed(2)}%`,
  `- Median token reduction: ${report.medianTokenReduction ?? "N/A"}%`,
  `- Resolution harm rate: ${(report.resolutionHarmRate * 100).toFixed(2)}%`,
  `- Resolution fact-loss rate: ${(report.resolutionFactLossRate * 100).toFixed(2)}%`,
  ``,
  `## Repository Definitions`,
  ``,
  ...repositories.map(
    (repository) =>
      `- ${repository.id} (${repository.scale}): ${repository.url} @ ${repository.commit}; scope: ${repository.scope}; checkout: ${repository.source}`,
  ),
  ``,
  `## Task Results`,
  ``,
  `| Repo | Task | Budget | Baseline | Slice | Reduction | Fact recall | Min budget | Resolution harm |`,
  `|---|---|---:|---:|---:|---:|---:|---:|---:|`,
  ...taskRows.map(
    (row) =>
      `| ${row.repository} | ${row.task} | ${row.budget} | ${row.baselineTokens} | ${row.sliceTokens} | ${row.tokenReductionPercent}% | ${(Number(row.requiredFactRecall) * 100).toFixed(0)}% | ${row.minimumSufficientBudget} | ${(row.missingFacts as FactResult[]).some((fact) => fact.attribution === "CALL_RESOLUTION") ? "yes" : "no"} |`,
  ),
  ``,
  `## Cache and Resolution`,
  ``,
  `JSON metrics include every budget row plus one representative row per task. Cache metrics include cold, warm and single-file update measurements for every repository. Unresolved and ambiguous rates are reported per repository; no compiler-grade resolution is claimed.`,
  ``,
  `## Failure Attribution`,
  ``,
  `- PARSER: ${report.parserFailureCount}`,
  `- SYMBOL_INDEX: task target missing is retained in task results`,
  `- CALL_RESOLUTION: ${report.resolutionFailureCount}`,
  `- RANKING: ${report.rankingFailureCount}`,
  `- TOKEN_BUDGET: ${report.budgetFailureCount}`,
  ``,
  `## Agent Comparison`,
  ``,
  `N/A: this workspace does not expose Codex/Claude runtime telemetry.`,
  ``,
  `## JDT/LSP Decision`,
  ``,
  report.resolutionFactLossRate >= 0.05
    ? `Evidence supports evaluating compiler-grade resolution in v0.4: resolution fact-loss rate is ${(report.resolutionFactLossRate * 100).toFixed(2)}%.`
    : `Current evidence does not justify JDT/LSP: resolution fact-loss rate is ${(report.resolutionFactLossRate * 100).toFixed(2)}%. Continue measuring across the pinned repositories and retain failed tasks.`,
].join("\n");
writeFileSync(join(outputDir, "v0.3-real-repositories.md"), markdown);
console.log(markdown);
