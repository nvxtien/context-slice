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
import {
  calculateContextMetrics,
  contextComposition,
  duplicateContextTokensByKey,
  fitsContextWindows,
  validateManualBaselines,
  type ContextEntry,
  type ManualBaseline,
} from "./developer-context.js";

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
type BenchmarkPackage = {
  entries: ContextEntry[];
  text: string;
  tokens: number;
  files: string[];
  wholeFiles: number;
  preparationSteps: number;
  toolCalls: number;
  fallbacks: number;
};

const root = process.cwd();
const budgets = [256, 512, 1_024, 2_048, 4_096, 8_192];
const contextBudgets = [8_192, 16_384, 32_768];
const outputDir = join(root, "benchmarks/results");

const repositories = JSON.parse(
  readFileSync(join(root, "benchmarks/repositories.json"), "utf8"),
) as Repository[];
const tasks = JSON.parse(
  readFileSync(join(root, "benchmarks/tasks.json"), "utf8"),
) as Task[];
const manualBaselines = JSON.parse(
  readFileSync(join(root, "benchmarks/manual-context.json"), "utf8"),
) as ManualBaseline[];

function sourceText(repositoryRoot: string, paths: string[]) {
  return paths
    .map((path) => {
      const full = join(repositoryRoot, path);
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
) {
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

function requiredFactTokens(
  facts: Fact[],
  text: string,
  target: SymbolRecord | undefined,
) {
  const lines = new Set<string>();
  for (const fact of facts) {
    if (fact.verification.type === "source-fragment") {
      for (const line of text.split("\n"))
        if (
          (fact.verification.patterns ?? []).some((pattern) =>
            line.includes(pattern),
          )
        )
          lines.add(line);
    } else if (target) {
      lines.add(target.signature ?? target.name);
    }
  }
  return estimateTokens([...lines].join("\n"));
}

function packageFromEntries(
  entries: ContextEntry[],
  fields: Pick<
    BenchmarkPackage,
    "files" | "wholeFiles" | "preparationSteps" | "toolCalls" | "fallbacks"
  >,
): BenchmarkPackage {
  return {
    entries,
    text: entries.map((entry) => entry.text).join("\n\n"),
    tokens: contextComposition(entries).total,
    ...fields,
  };
}

function manualPackage(
  repositoryRoot: string,
  baseline: ManualBaseline,
): BenchmarkPackage {
  const entries = baseline.files.map((filePath): ContextEntry => ({
    category: /(?:\/test\/|Test\.java$)/.test(filePath)
      ? "tests"
      : "target-source",
    filePath,
    text: readFileSync(join(repositoryRoot, filePath), "utf8"),
    wholeFile: true,
  }));
  return packageFromEntries(entries, {
    files: baseline.files,
    wholeFiles: baseline.files.length,
    preparationSteps: baseline.files.length + 1,
    toolCalls: 0,
    fallbacks: 0,
  });
}

function contextEntries(
  index: ProjectIndex,
  target: SymbolRecord,
): ContextEntry[] {
  const entries: ContextEntry[] = [
    {
      category: "target-source",
      symbolId: target.id,
      filePath: target.filePath,
      text: target.source,
    },
  ];
  const seen = new Set([target.id]);
  for (const symbol of index.callers(target)) {
    if (seen.has(symbol.id)) continue;
    seen.add(symbol.id);
    entries.push({
      category: "caller-context",
      symbolId: symbol.id,
      filePath: symbol.filePath,
      text: `${symbol.qualifiedName}\n${symbol.source}`,
    });
  }
  for (const symbol of index.dependencies(target)) {
    if (seen.has(symbol.id)) continue;
    seen.add(symbol.id);
    entries.push({
      category: "callee-context",
      symbolId: symbol.id,
      filePath: symbol.filePath,
      text: `${symbol.qualifiedName}\n${symbol.source}`,
    });
  }
  return entries;
}

function selectEntries(entries: ContextEntry[], budget: number) {
  const selected: ContextEntry[] = [];
  let used = 0;
  for (const entry of entries) {
    const tokens = estimateTokens(entry.text);
    if (selected.length === 0 || used + tokens <= budget) {
      selected.push(entry);
      used += tokens;
    }
  }
  return selected;
}

function contextPackage(
  index: ProjectIndex,
  target: SymbolRecord,
  budget?: number,
) {
  const entries = contextEntries(index, target);
  return packageFromEntries(
    budget === undefined ? entries : selectEntries(entries, budget),
    {
      files: [
        ...new Set(
          entries
            .map((entry) => entry.filePath)
            .filter((filePath): filePath is string => Boolean(filePath)),
        ),
      ],
      wholeFiles: 0,
      preparationSteps: 1,
      toolCalls: 1,
      fallbacks: 0,
    },
  );
}

function cacheMetrics(repositoryRoot: string) {
  rmSync(join(repositoryRoot, ".context-slice"), {
    recursive: true,
    force: true,
  });
  const coldIndex = new ProjectIndex(repositoryRoot);
  const cold = coldIndex.rebuild();
  const warm = coldIndex.rebuild();
  const filePath = coldIndex.symbols[0]?.filePath;
  let update = {
    filesParsed: 0,
    cacheHits: 0,
    filesScanned: 0,
    symbolsUpdated: 0,
    elapsedMs: 0,
  };
  if (filePath) {
    const full = join(repositoryRoot, filePath);
    const original = readFileSync(full, "utf8");
    try {
      writeFileSync(
        full,
        `${original}\n// ContextSlice v0.6 temporary cache probe\n`,
      );
      update = new ProjectIndex(repositoryRoot).rebuild();
    } finally {
      writeFileSync(full, original);
    }
  }
  return { cold, warm, update, index: coldIndex };
}

function factResults(
  task: Task,
  target: SymbolRecord | undefined,
  rendered: string,
  groundTruthText: string,
  baselineText: string,
  budget: number,
): FactResult[] {
  return task.requiredFacts.map((fact) => ({
    id: fact.id,
    preserved: factCheck(fact, rendered, target, groundTruthText),
    attribution: factCheck(fact, rendered, target, groundTruthText)
      ? "UNKNOWN"
      : attribution(
          fact,
          target,
          target?.source ?? "",
          rendered,
          baselineText,
          budget,
        ),
  }));
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    : null;
}

function sumComposition(rows: Record<string, number>[]) {
  const keys = [
    "target-source",
    "caller-context",
    "callee-context",
    "annotations",
    "types",
    "tests",
    "diff",
    "metadata",
    "total",
  ];
  return Object.fromEntries(
    keys.map((key) => [
      key,
      rows.reduce((sum, row) => sum + (row[key] ?? 0), 0),
    ]),
  );
}

function evaluateTask(
  repository: Repository,
  repositoryRoot: string,
  index: ProjectIndex,
  task: Task,
  baseline: ManualBaseline,
) {
  const target = targetFor(index, task.targetSymbol);
  const manual = manualPackage(repositoryRoot, baseline);
  const groundTruthText = sourceText(repositoryRoot, task.groundTruthFiles);
  const baselineText = manual.text;
  const fullContext = target
    ? contextPackage(index, target)
    : packageFromEntries([], {
        files: [],
        wholeFiles: 0,
        preparationSteps: 1,
        toolCalls: 1,
        fallbacks: 0,
      });
  const budgetRows = budgets.map((budget) => {
    const selected = target
      ? contextPackage(index, target, budget)
      : fullContext;
    const facts = factResults(
      task,
      target,
      selected.text,
      groundTruthText,
      baselineText,
      budget,
    );
    return {
      budget,
      selected,
      facts,
      preserved: facts.filter((fact) => fact.preserved).length,
    };
  });
  const sufficient = budgetRows.find(
    (row) => row.preserved === task.requiredFacts.length,
  );
  const representative = sufficient ?? budgetRows.at(-1)!;
  const fallbackFiles =
    representative.preserved === task.requiredFacts.length
      ? 0
      : baseline.files.length;
  const manualFacts = task.requiredFacts.map((fact) =>
    factCheck(fact, manual.text, target, groundTruthText),
  );
  const manualMetrics = calculateContextMetrics({
    manualTokens: manual.tokens,
    contextSliceTokens: manual.tokens,
    requiredFactsTotal: task.requiredFacts.length,
    requiredFactsPreserved: manualFacts.filter(Boolean).length,
    requiredFactTokens: requiredFactTokens(
      task.requiredFacts,
      manual.text,
      target,
    ),
    manualWholeFiles: manual.wholeFiles,
    contextSliceWholeFiles: manual.wholeFiles,
    fallbackFiles: 0,
    contextBudget: 8_192,
  });
  const sliceTokens =
    representative.selected.tokens + (fallbackFiles ? manual.tokens : 0);
  return {
    repository: repository.id,
    scale: repository.scale,
    task: task.id,
    category: task.category,
    description: task.task,
    targetSymbol: task.targetSymbol,
    groundTruth: task.groundTruth,
    baselineFiles: baseline.files,
    manualTokens: manual.tokens,
    contextSliceTokens: representative.selected.tokens,
    suppliedContextTokens: sliceTokens,
    tokenAccounting: "estimated",
    metrics: calculateContextMetrics({
      manualTokens: manual.tokens,
      contextSliceTokens: sliceTokens,
      requiredFactsTotal: task.requiredFacts.length,
      requiredFactsPreserved: representative.preserved,
      requiredFactTokens: requiredFactTokens(
        task.requiredFacts,
        representative.selected.text,
        target,
      ),
      manualWholeFiles: manual.wholeFiles,
      contextSliceWholeFiles: fallbackFiles,
      fallbackFiles,
      contextBudget: 8_192,
    }),
    manualMetrics,
    manualRequiredFactRecall:
      manualFacts.filter(Boolean).length / Math.max(manualFacts.length, 1),
    requiredFactsTotal: task.requiredFacts.length,
    requiredFactsPreserved: representative.preserved,
    requiredFactRecall:
      representative.preserved / Math.max(task.requiredFacts.length, 1),
    retrievalRecall: target ? 1 : 0,
    minimumSufficientBudget: sufficient?.budget ?? null,
    minimumSufficientContextTokens: sufficient?.selected.tokens ?? null,
    wholeFilesAvoided: Math.max(baseline.files.length - fallbackFiles, 0),
    wholeFileFallback: fallbackFiles > 0,
    wholeFilesFallbackTotal: fallbackFiles,
    manualEffort: {
      filesManuallyOpened: manual.files.length,
      filesCopiedIntoContext: manual.files.length,
      wholeFilesIncluded: manual.wholeFiles,
      contextPreparationSteps: manual.preparationSteps,
      contextSliceToolCalls: 0,
      wholeFileFallbacks: 0,
    },
    contextSliceEffort: {
      filesManuallyOpened: 0,
      filesCopiedIntoContext: 0,
      wholeFilesIncluded: fallbackFiles,
      contextPreparationSteps: representative.selected.preparationSteps,
      contextSliceToolCalls: representative.selected.toolCalls,
      wholeFileFallbacks: fallbackFiles,
    },
    contextComposition: contextComposition(representative.selected.entries),
    manualFileTokens: Object.fromEntries(
      manual.entries.map((entry) => [
        entry.filePath,
        estimateTokens(entry.text),
      ]),
    ),
    contextEntryTokens: representative.selected.entries.map((entry) => ({
      key: entry.symbolId ?? entry.filePath ?? entry.category,
      tokens: estimateTokens(entry.text),
    })),
    contextWindowFit: {
      manual: fitsContextWindows(manual.tokens),
      contextSlice: fitsContextWindows(sliceTokens),
    },
    contextBudgetPressure: Object.fromEntries(
      contextBudgets.map((budget) => [
        `${budget / 1_024}K`,
        sliceTokens / budget,
      ]),
    ),
    facts: representative.facts,
    budgetSweep: budgetRows.map((row) => ({
      budget: row.budget,
      contextTokens: row.selected.tokens,
      requiredFactsPreserved: row.preserved,
      requiredFactRecall:
        row.preserved / Math.max(task.requiredFacts.length, 1),
      facts: row.facts,
    })),
    targetFound: Boolean(target),
  };
}

function longTaskExperiment(rows: any[]) {
  return repositories.map((repository) => {
    const steps = rows
      .filter((row) => row.repository === repository.id)
      .slice(0, 4);
    const manualEntries = steps.flatMap((row) =>
      Object.entries(row.manualFileTokens).map(([key, tokens]) => ({
        key,
        tokens: Number(tokens),
      })),
    );
    const sliceEntries = steps.flatMap((row) => row.contextEntryTokens);
    const manualTokens = steps.reduce((sum, row) => sum + row.manualTokens, 0);
    const contextSliceTokens = steps.reduce(
      (sum, row) => sum + row.suppliedContextTokens,
      0,
    );
    return {
      repository: repository.id,
      steps: steps.map((row) => row.task),
      manualCumulativeContextTokens: manualTokens,
      contextSliceCumulativeContextTokens: contextSliceTokens,
      manualDuplicateContextTokens: duplicateContextTokensByKey(manualEntries),
      contextSliceDuplicateContextTokens:
        duplicateContextTokensByKey(sliceEntries),
      duplicateContextReduction:
        manualTokens > 0
          ? 1 -
            duplicateContextTokensByKey(sliceEntries) /
              Math.max(duplicateContextTokensByKey(manualEntries), 1)
          : 0,
      contextBudgetPressure: Object.fromEntries(
        contextBudgets.map((budget) => [
          `${budget / 1_024}K`,
          contextSliceTokens / budget,
        ]),
      ),
    };
  });
}

function historicalMetrics() {
  const v04Path = join(
    root,
    "benchmarks/results/v0.4-symbol-index-hardening.json",
  );
  const v05Path = join(
    root,
    "benchmarks/results/v0.5-semantic-call-resolution.json",
  );
  const v04 = existsSync(v04Path)
    ? JSON.parse(readFileSync(v04Path, "utf8"))
    : undefined;
  const v05 = existsSync(v05Path)
    ? JSON.parse(readFileSync(v05Path, "utf8"))
    : undefined;
  return {
    v04: {
      retrievalRecall: v04?.comparison?.v04?.retrievalRecall ?? "N/A",
      requiredFactRecall: v04?.comparison?.v04?.requiredFactRecall ?? "N/A",
      semanticCallRecall: "N/A",
      semanticCallPrecision: "N/A",
      medianTokenContextReduction:
        v04?.comparison?.v03?.medianTokenReduction ?? "N/A",
      wholeFileAvoidance: "N/A",
      wholeFileFallbackRate: "N/A",
    },
    v05: {
      retrievalRecall: v04?.comparison?.v04?.retrievalRecall ?? "N/A",
      requiredFactRecall: v04?.comparison?.v04?.requiredFactRecall ?? "N/A",
      semanticCallRecall: v05?.semanticFixture?.semanticCallRecall ?? "N/A",
      semanticCallPrecision:
        v05?.semanticFixture?.semanticCallPrecision ?? "N/A",
      medianTokenContextReduction: "N/A",
      wholeFileAvoidance: "N/A",
      wholeFileFallbackRate: "N/A",
    },
  };
}

function percentage(value: unknown) {
  return typeof value === "number"
    ? `${(value * 100).toFixed(2)}%`
    : String(value);
}

function markdown(report: any) {
  const rows = report.taskResults.map(
    (row: any) =>
      `| ${row.repository} | ${row.task} | ${row.manualTokens} | ${row.suppliedContextTokens} | ${(row.metrics.contextWindowReduction * 100).toFixed(2)}% | ${(row.requiredFactRecall * 100).toFixed(0)}% | ${row.wholeFilesAvoided} | ${row.minimumSufficientBudget ?? "UNSATISFIED"} |`,
  );
  const aggregate = report.aggregate;
  return [
    "# ContextSlice v0.6 Developer Context Efficiency",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Executive Summary",
    "",
    "ContextSlice helps developers reduce context-window usage and token consumption when working with coding assistants such as Codex and Claude Code.",
    "",
    `- Tasks evaluated: ${aggregate.totalTasks}`,
    `- Overall required-fact recall: ${(aggregate.overallRequiredFactRecall * 100).toFixed(2)}% (estimated deterministic check)`,
    `- Overall retrieval recall: ${(aggregate.overallRetrievalRecall * 100).toFixed(2)}% (estimated deterministic check)`,
    `- Median context-window reduction: ${(aggregate.medianContextWindowReduction * 100).toFixed(2)}% (estimated)`,
    `- Whole-file fallback rate: ${(aggregate.wholeFileFallbackRate * 100).toFixed(2)}% (measured from benchmark packages)`,
    "",
    "## Product Positioning",
    "",
    "Less code in context. Fewer tokens. Same required information.",
    "",
    "## Manual Baseline Methodology",
    "",
    "Manual mode uses the auditable file lists and per-file reasoning in `benchmarks/manual-context.json`. Each listed file is treated as opened and copied whole; baselines are not inflated with unrelated files.",
    "",
    "## Repository / Task Set",
    "",
    ...repositories.map(
      (repository) =>
        `- ${repository.id} (${repository.scale}): ${repository.url} @ ${repository.commit}; scope: ${repository.scope}`,
    ),
    "",
    "## Main Result Table",
    "",
    "| Repo | Task | Manual tokens | ContextSlice tokens | Reduction | Fact recall | Whole files avoided | Min sufficient budget |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    "## Context-Window Reduction / Token Reduction",
    "",
    `- Context-window reduction: ${(aggregate.medianContextWindowReduction * 100).toFixed(2)}% median, ${(aggregate.meanContextWindowReduction * 100).toFixed(2)}% mean (estimated tokens).`,
    `- Input-token reduction: ${(aggregate.medianInputTokenReduction * 100).toFixed(2)}% median (estimated; assistant telemetry unavailable).`,
    `- Median manual context: ${aggregate.medianManualContextTokens} tokens; median ContextSlice context: ${aggregate.medianContextSliceTokens} tokens.`,
    `- Context-window reduction range: ${(aggregate.minimumContextWindowReduction * 100).toFixed(2)}% to ${(aggregate.maximumContextWindowReduction * 100).toFixed(2)}%.`,
    "",
    "## Developer Context Efficiency / Irrelevant Context Elimination",
    "",
    `- Median developer context efficiency: ${(aggregate.medianManualDeveloperContextEfficiency * 100).toFixed(4)}% manual vs ${(aggregate.medianDeveloperContextEfficiency * 100).toFixed(4)}% ContextSlice (required facts per estimated context token).`,
    `- Median irrelevant-context elimination / manual context waste: ${(aggregate.medianIrrelevantContextElimination * 100).toFixed(2)}% (estimated deterministic fact-to-line mapping).`,
    `- Median ContextSlice waste ratio: ${(aggregate.medianContextWasteRatio * 100).toFixed(2)}% (estimated).`,
    "",
    "## Required-Fact Preservation / Retrieval Recall",
    "",
    `- Required-fact recall: ${(aggregate.overallRequiredFactRecall * 100).toFixed(2)}%.`,
    `- Retrieval recall: ${(aggregate.overallRetrievalRecall * 100).toFixed(2)}%.`,
    aggregate.overallRequiredFactRecall === 1 &&
    aggregate.overallRetrievalRecall === 1
      ? "- Release guardrail: preserved at 100%; reduction is reported as successful for these tasks."
      : "- Release guardrail: below 100%; reduction must not be presented as successful for every task.",
    "",
    "## Minimum Sufficient Context",
    "",
    `- Median minimum sufficient budget: ${aggregate.medianMinimumSufficientBudget ?? "N/A"}.`,
    "- Unsatisfied tasks remain in the aggregate rather than being removed.",
    "",
    "## Context Composition",
    "",
    "| Category | Estimated tokens |",
    "|---|---:|",
    ...Object.entries(aggregate.contextComposition)
      .filter(([key]) => key !== "total")
      .map(([key, value]) => `| ${key} | ${value} |`),
    `| total | ${aggregate.contextComposition.total} |`,
    "",
    "## Context-Window Fit Thresholds",
    "",
    "Thresholds are benchmark thresholds, not claims about current model limits.",
    "",
    `- Manual context fit counts: ${JSON.stringify(aggregate.manualContextWindowFitCounts)}`,
    `- ContextSlice context fit counts: ${JSON.stringify(aggregate.contextSliceWindowFitCounts)}`,
    "",
    "## Developer Effort / Whole-File Fallback",
    "",
    `- Whole-file avoidance rate: ${(aggregate.wholeFileAvoidanceRate * 100).toFixed(2)}% (estimated from recorded file packages).`,
    `- Whole-file fallback rate: ${(aggregate.wholeFileFallbackRate * 100).toFixed(2)}%.`,
    `- Whole files used as fallback: ${aggregate.wholeFilesFallbackTotal}.`,
    "",
    "## Multi-Step Cumulative Context",
    "",
    ...report.multiStep.map(
      (sequence: any) =>
        `- ${sequence.repository}: manual ${sequence.manualCumulativeContextTokens} tokens vs ContextSlice ${sequence.contextSliceCumulativeContextTokens} tokens; duplicate-context reduction ${(sequence.duplicateContextReduction * 100).toFixed(2)}% (estimated).`,
    ),
    "",
    "## Cache Responsiveness",
    "",
    ...report.cache.map(
      (row: any) =>
        `- ${row.repository}: cold index ${row.coldIndexMs} ms, warm lookup ${row.warmQueryMs} ms, single-file refresh ${row.singleFileRefreshMs} ms.`,
    ),
    "",
    "## Longitudinal Comparison",
    "",
    "| Metric | v0.4 | v0.5 | v0.6 |",
    "|---|---:|---:|---:|",
    `| Retrieval recall | ${percentage(report.historical.v04.retrievalRecall)} | ${percentage(report.historical.v05.retrievalRecall)} | ${percentage(aggregate.overallRetrievalRecall)} |`,
    `| Required-fact recall | ${percentage(report.historical.v04.requiredFactRecall)} | ${percentage(report.historical.v05.requiredFactRecall)} | ${percentage(aggregate.overallRequiredFactRecall)} |`,
    `| Semantic call recall | ${report.historical.v04.semanticCallRecall} | ${report.historical.v05.semanticCallRecall} | N/A |`,
    `| Semantic call precision | ${report.historical.v04.semanticCallPrecision} | ${report.historical.v05.semanticCallPrecision} | N/A |`,
    `| Median token/context reduction | ${percentage(report.historical.v04.medianTokenContextReduction)} | ${percentage(report.historical.v05.medianTokenContextReduction)} | ${(aggregate.medianContextWindowReduction * 100).toFixed(2)}% |`,
    `| Whole-file avoidance | ${report.historical.v04.wholeFileAvoidance} | ${report.historical.v05.wholeFileAvoidance} | ${(aggregate.wholeFileAvoidanceRate * 100).toFixed(2)}% |`,
    `| Whole-file fallback rate | ${report.historical.v04.wholeFileFallbackRate} | ${report.historical.v05.wholeFileFallbackRate} | ${(aggregate.wholeFileFallbackRate * 100).toFixed(2)}% |`,
    "",
    "## Optional Assistant Telemetry",
    "",
    "Codex telemetry: unavailable. Claude telemetry: unavailable. All core numbers above are deterministic repository-based estimates or explicitly labeled measurements.",
    "",
    "## Limitations",
    "",
    "The benchmark estimates tokens with the existing deterministic estimator, models manual context from declared baselines, and does not claim model-specific context limits or productivity gains from latency alone.",
    "",
    "## Next Step",
    "",
    "Use the measured fallback and context-composition rows to decide which developer workflows need richer symbol/type/test retrieval in a later version.",
    "",
  ].join("\n");
}

function run() {
  validateManualBaselines(
    manualBaselines,
    tasks.map((task) => task.id),
  );
  mkdirSync(outputDir, { recursive: true });
  const taskResults: any[] = [];
  const cache: any[] = [];
  for (const repository of repositories) {
    const repositoryRoot = resolve(root, repository.source);
    const repositoryTasks = tasks.filter(
      (task) => task.repository === repository.id,
    );
    if (!existsSync(repositoryRoot)) {
      for (const task of repositoryTasks) {
        const emptyMetrics = calculateContextMetrics({
          manualTokens: 0,
          contextSliceTokens: 0,
          requiredFactsTotal: task.requiredFacts.length,
          requiredFactsPreserved: 0,
          requiredFactTokens: 0,
          manualWholeFiles: 0,
          contextSliceWholeFiles: 0,
          fallbackFiles: 0,
          contextBudget: 8_192,
        });
        taskResults.push({
          repository: repository.id,
          task: task.id,
          targetFound: false,
          requiredFactsTotal: task.requiredFacts.length,
          requiredFactsPreserved: 0,
          manualRequiredFactRecall: 0,
          requiredFactRecall: 0,
          retrievalRecall: 0,
          manualTokens: 0,
          suppliedContextTokens: 0,
          metrics: emptyMetrics,
          manualMetrics: emptyMetrics,
          contextComposition: { total: 0 },
          wholeFilesAvoided: 0,
          wholeFileFallback: false,
          wholeFilesFallbackTotal: 0,
          baselineFiles: [],
        });
      }
      continue;
    }
    const timing = cacheMetrics(repositoryRoot);
    const index = timing.index;
    cache.push({
      repository: repository.id,
      coldIndexMs: timing.cold.elapsedMs,
      warmQueryMs: timing.warm.elapsedMs,
      singleFileRefreshMs: timing.update.elapsedMs,
    });
    for (const task of repositoryTasks) {
      const baseline = manualBaselines.find(
        (candidate) => candidate.taskId === task.id,
      )!;
      taskResults.push(
        evaluateTask(repository, repositoryRoot, index, task, baseline),
      );
    }
  }

  const factsTotal = taskResults.reduce(
    (sum, row) => sum + row.requiredFactsTotal,
    0,
  );
  const factsPreserved = taskResults.reduce(
    (sum, row) => sum + row.requiredFactsPreserved,
    0,
  );
  const manualFactsTotal = taskResults.reduce(
    (sum, row) => sum + row.requiredFactsTotal,
    0,
  );
  const manualFactsPreserved = taskResults.reduce(
    (sum, row) =>
      sum + Math.round(row.manualRequiredFactRecall * row.requiredFactsTotal),
    0,
  );
  const reductions = taskResults.map(
    (row) => row.metrics.contextWindowReduction,
  );
  const inputReductions = taskResults.map(
    (row) => row.metrics.inputTokenReduction,
  );
  const composition = sumComposition(
    taskResults.map((row) => row.contextComposition ?? { total: 0 }),
  );
  const manualWindowFitCounts = Object.fromEntries(
    ["8K", "16K", "32K", "64K", "128K"].map((label) => [
      label,
      taskResults.filter(
        (row) =>
          row.manualTokens <=
          (
            {
              "8K": 8_192,
              "16K": 16_384,
              "32K": 32_768,
              "64K": 65_536,
              "128K": 131_072,
            } as Record<string, number>
          )[label],
      ).length,
    ]),
  );
  const sliceWindowFitCounts = Object.fromEntries(
    ["8K", "16K", "32K", "64K", "128K"].map((label) => [
      label,
      taskResults.filter(
        (row) =>
          row.suppliedContextTokens <=
          (
            {
              "8K": 8_192,
              "16K": 16_384,
              "32K": 32_768,
              "64K": 65_536,
              "128K": 131_072,
            } as Record<string, number>
          )[label],
      ).length,
    ]),
  );
  const aggregate = {
    totalTasks: taskResults.length,
    totalRequiredFacts: factsTotal,
    overallRequiredFactRecall: factsPreserved / Math.max(factsTotal, 1),
    overallManualRequiredFactRecall:
      manualFactsPreserved / Math.max(manualFactsTotal, 1),
    overallRetrievalRecall:
      taskResults.reduce((sum, row) => sum + row.retrievalRecall, 0) /
      Math.max(taskResults.length, 1),
    medianContextWindowReduction: percentile(reductions, 0.5) ?? 0,
    meanContextWindowReduction:
      reductions.reduce((sum, value) => sum + value, 0) /
      Math.max(reductions.length, 1),
    minimumContextWindowReduction: Math.min(...reductions),
    maximumContextWindowReduction: Math.max(...reductions),
    medianInputTokenReduction: percentile(inputReductions, 0.5) ?? 0,
    medianManualContextTokens:
      percentile(
        taskResults.map((row) => row.manualTokens),
        0.5,
      ) ?? 0,
    medianContextSliceTokens:
      percentile(
        taskResults.map((row) => row.suppliedContextTokens),
        0.5,
      ) ?? 0,
    wholeFileAvoidanceRate:
      taskResults.reduce((sum, row) => sum + row.wholeFilesAvoided, 0) /
      Math.max(
        taskResults.reduce((sum, row) => sum + row.baselineFiles.length, 0),
        1,
      ),
    wholeFileFallbackRate:
      taskResults.filter((row) => row.wholeFileFallback).length /
      Math.max(taskResults.length, 1),
    wholeFilesFallbackTotal: taskResults.reduce(
      (sum, row) => sum + row.wholeFilesFallbackTotal,
      0,
    ),
    medianMinimumSufficientBudget: percentile(
      taskResults
        .map((row) => row.minimumSufficientBudget)
        .filter((value): value is number => typeof value === "number"),
      0.5,
    ),
    medianDeveloperContextEfficiency:
      percentile(
        taskResults.map((row) => row.metrics.developerContextEfficiency),
        0.5,
      ) ?? 0,
    medianManualDeveloperContextEfficiency:
      percentile(
        taskResults.map((row) => row.manualMetrics.developerContextEfficiency),
        0.5,
      ) ?? 0,
    medianContextWasteRatio:
      percentile(
        taskResults.map((row) => row.metrics.contextWasteRatio),
        0.5,
      ) ?? 0,
    medianIrrelevantContextElimination:
      percentile(
        taskResults.map((row) => row.manualMetrics.contextWasteRatio),
        0.5,
      ) ?? 0,
    contextComposition: composition,
    manualContextWindowFitCounts: manualWindowFitCounts,
    contextSliceWindowFitCounts: sliceWindowFitCounts,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    productPositioning: "developer context efficiency",
    repositories,
    taskCount: tasks.length,
    manualBaselineFile: "benchmarks/manual-context.json",
    tokenAccounting: "estimated unless optional telemetry is present",
    aggregate,
    taskResults,
    multiStep: longTaskExperiment(taskResults),
    cache,
    historical: historicalMetrics(),
    telemetry: { codex: null, claude: null },
  };
  writeFileSync(
    join(outputDir, "v0.6-developer-context-efficiency.json"),
    JSON.stringify(report, null, 2),
  );
  writeFileSync(
    join(outputDir, "v0.6-developer-context-efficiency.md"),
    markdown(report),
  );
  console.log(markdown(report));
}

run();
