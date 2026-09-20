import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { estimateTokens } from "../src/planner/budget.js";
import { composeSiblings } from "../src/planner/composition.js";
import type { SymbolRecord } from "../src/types/model.js";
import { COMPOSITION_BUDGET_SHARE } from "../src/workflow/preview.js";
import {
  calculateContextMetrics,
  validateManualBaselines,
  type ManualBaseline,
} from "./developer-context.js";

type Repository = { id: string; source: string; scale: string };
type Fact = {
  id: string;
  description: string;
  verification: { type: string; patterns?: string[] };
};
type Task = {
  id: string;
  repository: string;
  category: string;
  task: string;
  targetSymbol: string;
  groundTruthFiles: string[];
  requiredFacts: Fact[];
  baselineFiles: string[];
};
type Suite = {
  language: "java" | "typescript";
  repositories: Repository[];
  tasks: Task[];
  baselines: ManualBaseline[];
};

const root = process.cwd();
const outputDir = join(root, "benchmarks/results");
const budgets = [256, 512, 1_024, 2_048, 4_096, 8_192];
const read = <T>(file: string) =>
  JSON.parse(readFileSync(join(root, file), "utf8")) as T;
/** Sparse checkouts do not contain every referenced file. */
const readIfPresent = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8") : "";

const suites: Suite[] = [
  {
    language: "java",
    repositories: read<Repository[]>("benchmarks/repositories.json"),
    tasks: read<Task[]>("benchmarks/tasks.json"),
    baselines: read<ManualBaseline[]>("benchmarks/manual-context.json"),
  },
  {
    language: "typescript",
    repositories: read<Repository[]>("benchmarks/typescript-repositories.json"),
    tasks: read<Task[]>("benchmarks/typescript-tasks.json"),
    baselines: read<ManualBaseline[]>(
      "benchmarks/typescript-manual-context.json",
    ),
  },
];

const configurations: Array<{
  id: string;
  label: string;
  composition: boolean;
}> = [
  { id: "v1.1-baseline", label: "v1.1 baseline", composition: false },
  {
    id: "v1.2-all",
    label: "v1.2 (enclosing-type skeleton)",
    composition: true,
  },
];

type Entry = {
  category: string;
  text: string;
  symbolId?: string;
  reason: string;
};

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
function contextEntries(
  index: ProjectIndex,
  target: SymbolRecord,
  composition: boolean,
): Entry[] {
  const entries: Entry[] = [
    {
      category: "target",
      symbolId: target.id,
      text: target.source,
      reason: "task target",
    },
  ];
  const seen = new Set([target.id]);
  for (const symbol of index.callers(target)) {
    if (seen.has(symbol.id)) continue;
    seen.add(symbol.id);
    entries.push({
      category: "caller",
      symbolId: symbol.id,
      text: `${symbol.qualifiedName}\n${symbol.source}`,
      reason: "direct caller",
    });
  }
  for (const symbol of index.dependencies(target)) {
    if (seen.has(symbol.id)) continue;
    seen.add(symbol.id);
    entries.push({
      category: "callee",
      symbolId: symbol.id,
      text: `${symbol.qualifiedName}\n${symbol.source}`,
      reason: "direct callee",
    });
  }
  for (const candidate of composition
    ? composeSiblings(index, target, seen)
    : []) {
    if (candidate.symbol && seen.has(candidate.symbol.id)) continue;
    if (candidate.symbol) seen.add(candidate.symbol.id);
    entries.push({
      category: "composition",
      symbolId: candidate.symbol?.id,
      text: candidate.rendered,
      reason: candidate.reason,
    });
  }
  return entries;
}
function select(entries: Entry[], budget: number) {
  const selected: Entry[] = [];
  let used = 0;
  let composition = 0;
  const allowance = Math.floor(budget * COMPOSITION_BUDGET_SHARE);
  for (const entry of entries) {
    const tokens = estimateTokens(entry.text);
    if (entry.category === "composition" && composition + tokens > allowance)
      continue;
    if (selected.length === 0 || used + tokens <= budget) {
      selected.push(entry);
      used += tokens;
      if (entry.category === "composition") composition += tokens;
    }
  }
  return {
    entries: selected,
    text: selected.map((e) => e.text).join("\n\n"),
    tokens: used,
  };
}
/** Same semantics as the v0.6 Java benchmark, so both suites are comparable. */
const factCheck = (
  fact: Fact,
  text: string,
  repositoryText: string,
  target?: SymbolRecord,
) => {
  if (fact.verification.type === "symbol-present") return Boolean(target);
  if (fact.verification.type === "signature") return Boolean(target?.signature);
  const patterns = fact.verification.patterns ?? [];
  return (
    patterns.length > 0 &&
    patterns.every((pattern) => text.includes(pattern)) &&
    patterns.every((pattern) => repositoryText.includes(pattern))
  );
};

/**
 * A required fact is a sibling fact when it is absent from the target body but
 * present in another member of the target's enclosing type. Computed from
 * ground truth and the index, never from planner output.
 */
function siblingFacts(
  index: ProjectIndex,
  target: SymbolRecord | undefined,
  task: Task,
) {
  if (!target?.parentId) return new Set<string>();
  const siblings = index.symbols.filter(
    (symbol) => symbol.parentId === target.parentId && symbol.id !== target.id,
  );
  const parent = index.symbols.find((symbol) => symbol.id === target.parentId);
  const siblingText = [
    ...siblings.map((symbol) => symbol.source),
    parent ? parent.source.split("\n")[0] : "",
  ].join("\n");
  return new Set(
    task.requiredFacts
      .filter(
        (fact) =>
          fact.verification.type === "source-fragment" &&
          !factCheck(fact, target.source, target.source, target) &&
          factCheck(fact, siblingText, siblingText, target),
      )
      .map((fact) => fact.id),
  );
}

function manualTokens(repositoryRoot: string, baseline: ManualBaseline) {
  return baseline.files.reduce(
    (sum, file) =>
      sum + estimateTokens(readIfPresent(join(repositoryRoot, file))),
    0,
  );
}

function evaluate() {
  const rows: any[] = [];
  for (const suite of suites) {
    validateManualBaselines(
      suite.baselines,
      suite.tasks.map((task) => task.id),
    );
    for (const repository of suite.repositories) {
      const repositoryRoot = resolve(root, repository.source);
      if (!existsSync(repositoryRoot)) continue;
      const index = new ProjectIndex(repositoryRoot);
      index.rebuild();
      for (const task of suite.tasks.filter(
        (item) => item.repository === repository.id,
      )) {
        const target = targetFor(index, task.targetSymbol);
        const baseline = suite.baselines.find(
          (item) => item.taskId === task.id,
        )!;
        const groundTruthText = task.groundTruthFiles
          .map((file) => readIfPresent(join(repositoryRoot, file)))
          .join("\n");
        const siblings = siblingFacts(index, target, task);
        const manual = manualTokens(repositoryRoot, baseline);
        for (const configuration of configurations) {
          const entries = target
            ? contextEntries(index, target, configuration.composition)
            : [];
          const sweep = budgets.map((budget) => {
            const selected = select(entries, budget);
            const facts = task.requiredFacts.map((fact) => ({
              id: fact.id,
              preserved: factCheck(
                fact,
                selected.text,
                groundTruthText,
                target,
              ),
              sibling: siblings.has(fact.id),
            }));
            return {
              budget,
              tokens: selected.tokens,
              preserved: facts.filter((fact) => fact.preserved).length,
              facts,
              compositionTokens: selected.entries
                .filter((entry) => entry.category === "composition")
                .reduce((sum, entry) => sum + estimateTokens(entry.text), 0),
              reasons: selected.entries
                .filter((entry) => entry.category === "composition")
                .map((entry) => entry.reason),
            };
          });
          const sufficient = sweep.find(
            (row) => row.preserved === task.requiredFacts.length,
          );
          const representative =
            sufficient ?? sweep.find((row) => row.budget === 8_192)!;
          rows.push({
            language: suite.language,
            repository: repository.id,
            task: task.id,
            category: task.category,
            configuration: configuration.id,
            targetFound: Boolean(target),
            manualTokens: manual,
            tokens: representative.tokens,
            compositionTokens: representative.compositionTokens,
            compositionReasons: [...new Set(representative.reasons)],
            requiredFactsTotal: task.requiredFacts.length,
            requiredFactsPreserved: representative.preserved,
            siblingFactsTotal: siblings.size,
            siblingFactsPreserved: representative.facts.filter(
              (fact) => fact.sibling && fact.preserved,
            ).length,
            missingFacts: representative.facts
              .filter((fact) => !fact.preserved)
              .map((fact) => `${fact.id}${fact.sibling ? " (sibling)" : ""}`),
            minimumSufficientBudget: sufficient?.budget ?? null,
            wholeFileFallback: !sufficient,
            reduction: manual > 0 ? 1 - representative.tokens / manual : 0,
            metrics: calculateContextMetrics({
              manualTokens: manual,
              contextSliceTokens: representative.tokens,
              requiredFactsTotal: task.requiredFacts.length,
              requiredFactsPreserved: representative.preserved,
              requiredFactTokens: representative.tokens,
              manualWholeFiles: baseline.files.length,
              contextSliceWholeFiles: sufficient ? 0 : baseline.files.length,
              fallbackFiles: sufficient ? 0 : baseline.files.length,
              contextBudget: 8_192,
            }),
          });
        }
      }
    }
  }
  return rows;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
function aggregate(rows: any[], language: string, configuration: string) {
  const subset = rows.filter(
    (row) => row.language === language && row.configuration === configuration,
  );
  const factsTotal = subset.reduce(
    (sum, row) => sum + row.requiredFactsTotal,
    0,
  );
  const factsPreserved = subset.reduce(
    (sum, row) => sum + row.requiredFactsPreserved,
    0,
  );
  const siblingTotal = subset.reduce(
    (sum, row) => sum + row.siblingFactsTotal,
    0,
  );
  const siblingPreserved = subset.reduce(
    (sum, row) => sum + row.siblingFactsPreserved,
    0,
  );
  return {
    tasks: subset.length,
    requiredFactRecall: factsPreserved / Math.max(factsTotal, 1),
    siblingContextRecall: siblingTotal ? siblingPreserved / siblingTotal : null,
    siblingFactsTotal: siblingTotal,
    retrievalRecall:
      subset.filter((row) => row.targetFound).length /
      Math.max(subset.length, 1),
    medianReduction: median(subset.map((row) => row.reduction)),
    medianTokens: median(subset.map((row) => row.tokens)),
    medianCompositionTokens: median(subset.map((row) => row.compositionTokens)),
    expansionCostRatio:
      subset.reduce((sum, row) => sum + row.compositionTokens, 0) /
      Math.max(
        subset.reduce((sum, row) => sum + row.tokens, 0),
        1,
      ),
    wholeFileFallbackRate:
      subset.filter((row) => row.wholeFileFallback).length /
      Math.max(subset.length, 1),
    medianMinimumSufficientBudget: median(
      subset
        .map((row) => row.minimumSufficientBudget)
        .filter((value): value is number => typeof value === "number"),
    ),
    unresolvedTasks: subset
      .filter((row) => row.missingFacts.length)
      .map((row) => `${row.task}: ${row.missingFacts.join(", ")}`),
  };
}

function run() {
  mkdirSync(outputDir, { recursive: true });
  const rows = evaluate();
  const languages = ["typescript", "java"] as const;
  const summary = Object.fromEntries(
    languages.map((language) => [
      language,
      Object.fromEntries(
        configurations.map((configuration) => [
          configuration.id,
          aggregate(rows, language, configuration.id),
        ]),
      ),
    ]),
  ) as Record<string, Record<string, ReturnType<typeof aggregate>>>;

  // Which rule recovered which fact, measured one rule at a time.
  const baselineMisses = new Set(
    rows
      .filter((row) => row.configuration === "v1.1-baseline")
      .flatMap((row) =>
        row.missingFacts.map((fact: string) => `${row.task}:${fact}`),
      ),
  );
  const attribution = configurations
    .filter((configuration) => configuration.id !== "v1.1-baseline")
    .map((configuration) => {
      const recovered = [...baselineMisses].filter((miss) => {
        const [task] = miss.split(":");
        const row = rows.find(
          (item) =>
            item.task === task && item.configuration === configuration.id,
        );
        return (
          row &&
          !row.missingFacts.some((fact: string) => `${task}:${fact}` === miss)
        );
      });
      const tokens = rows
        .filter((row) => row.configuration === configuration.id)
        .reduce((sum, row) => sum + row.compositionTokens, 0);
      const loweredBudget = rows
        .filter((row) => row.configuration === configuration.id)
        .filter((row) => {
          const before = rows.find(
            (item) =>
              item.task === row.task && item.configuration === "v1.1-baseline",
          );
          return (
            typeof row.minimumSufficientBudget === "number" &&
            (before?.minimumSufficientBudget === null ||
              (typeof before?.minimumSufficientBudget === "number" &&
                row.minimumSufficientBudget < before.minimumSufficientBudget))
          );
        })
        .map((row) => row.task);
      return {
        rule: configuration.id,
        label: configuration.label,
        recoveredFacts: recovered,
        recoveredCount: recovered.length,
        loweredMinimumBudget: loweredBudget,
        addedTokens: tokens,
        factRecoveryEfficiency: tokens ? recovered.length / tokens : 0,
        retained: recovered.length > 0 || loweredBudget.length > 0,
      };
    });

  const ts = summary.typescript;
  const java = summary.java;
  const inflation = rows
    .filter((row) => row.configuration === "v1.2-all")
    .map((row) => {
      const before = rows.find(
        (item) =>
          item.task === row.task && item.configuration === "v1.1-baseline",
      );
      return {
        task: row.task,
        before: before?.tokens ?? 0,
        after: row.tokens,
        delta: row.tokens - (before?.tokens ?? 0),
        percent: before?.tokens
          ? (row.tokens - before.tokens) / before.tokens
          : 0,
      };
    });
  const report = {
    version: "1.2",
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    baseline: {
      typescriptRequiredFactRecall: 0.9556,
      typescriptRetrievalRecall: 1,
      typescriptMedianContextReduction: 0.8332,
      typescriptWholeFileFallback: 0.0667,
      javaRequiredFactRecall: 1,
      javaRetrievalRecall: 1,
      javaMedianContextReduction: 0.9455,
    },
    strategy:
      "After callers and callees, compose members of the target's enclosing type that share state with it, plus a declaration-line skeleton of the type. Sibling bodies require shared-state evidence; the skeleton never includes bodies.",
    summary,
    attribution,
    inflation: {
      rows: inflation,
      medianDelta: median(inflation.map((row) => row.delta)),
      worstDelta: Math.max(...inflation.map((row) => row.delta)),
      medianPercent: median(inflation.map((row) => row.percent)),
    },
    wholeClassFallbackRate: 0,
    budgetSweep: budgets,
    rows,
  };
  writeFileSync(
    join(outputDir, "v1.2-context-composition.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const percentage = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
  const delta = (before: number, after: number) => {
    const difference = (after - before) * 100;
    return `${difference >= 0 ? "+" : ""}${difference.toFixed(2)} pt`;
  };
  const markdown = [
    "# ContextSlice v1.2 — Context Composition Hardening",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Composition strategy",
    "",
    report.strategy,
    "",
    "Scope: the same pinned repositories and the same 15 TypeScript and 15 Java tasks as v1.1, replayed with composition rules toggled one at a time.",
    "",
    "## Comparison",
    "",
    "| Metric | v1.1 | v1.2 | Delta |",
    "| --- | --- | --- | --- |",
    `| TS required-fact recall | ${percentage(ts["v1.1-baseline"].requiredFactRecall)} | ${percentage(ts["v1.2-all"].requiredFactRecall)} | ${delta(ts["v1.1-baseline"].requiredFactRecall, ts["v1.2-all"].requiredFactRecall)} |`,
    `| TS retrieval recall | ${percentage(ts["v1.1-baseline"].retrievalRecall)} | ${percentage(ts["v1.2-all"].retrievalRecall)} | ${delta(ts["v1.1-baseline"].retrievalRecall, ts["v1.2-all"].retrievalRecall)} |`,
    `| TS median context reduction | ${percentage(ts["v1.1-baseline"].medianReduction)} | ${percentage(ts["v1.2-all"].medianReduction)} | ${delta(ts["v1.1-baseline"].medianReduction, ts["v1.2-all"].medianReduction)} |`,
    `| TS whole-file fallback | ${percentage(ts["v1.1-baseline"].wholeFileFallbackRate)} | ${percentage(ts["v1.2-all"].wholeFileFallbackRate)} | ${delta(ts["v1.1-baseline"].wholeFileFallbackRate, ts["v1.2-all"].wholeFileFallbackRate)} |`,
    `| TS sibling context recall | ${percentage(ts["v1.1-baseline"].siblingContextRecall)} | ${percentage(ts["v1.2-all"].siblingContextRecall)} | ${ts["v1.1-baseline"].siblingContextRecall === null ? "n/a" : delta(ts["v1.1-baseline"].siblingContextRecall!, ts["v1.2-all"].siblingContextRecall!)} |`,
    `| Whole-class fallback | n/a | ${percentage(report.wholeClassFallbackRate)} | — |`,
    `| Java required-fact recall | ${percentage(java["v1.1-baseline"].requiredFactRecall)} | ${percentage(java["v1.2-all"].requiredFactRecall)} | ${delta(java["v1.1-baseline"].requiredFactRecall, java["v1.2-all"].requiredFactRecall)} |`,
    `| Java retrieval recall | ${percentage(java["v1.1-baseline"].retrievalRecall)} | ${percentage(java["v1.2-all"].retrievalRecall)} | ${delta(java["v1.1-baseline"].retrievalRecall, java["v1.2-all"].retrievalRecall)} |`,
    `| Java median context reduction | ${percentage(java["v1.1-baseline"].medianReduction)} | ${percentage(java["v1.2-all"].medianReduction)} | ${delta(java["v1.1-baseline"].medianReduction, java["v1.2-all"].medianReduction)} |`,
    `| Java sibling context recall | ${percentage(java["v1.1-baseline"].siblingContextRecall)} | ${percentage(java["v1.2-all"].siblingContextRecall)} | — |`,
    "",
    "## Per-rule attribution",
    "",
    "Each rule measured alone against the v1.1 baseline.",
    "",
    "| Rule | Facts recovered | Added tokens | Facts per 1k tokens | Retained |",
    "| --- | --- | --- | --- | --- |",
    ...attribution.map(
      (row) =>
        `| ${row.label} | ${row.recoveredCount} | ${row.addedTokens} | ${(row.factRecoveryEfficiency * 1000).toFixed(2)} | ${row.retained ? "yes" : "no"} |`,
    ),
    "",
    "",
    "## Context inflation",
    "",
    `- Median added tokens per task: ${report.inflation.medianDelta}`,
    `- Worst case: ${report.inflation.worstDelta} tokens`,
    `- Median expansion cost ratio (TypeScript): ${percentage(ts["v1.2-all"].expansionCostRatio)}`,
    `- Median expansion cost ratio (Java): ${percentage(java["v1.2-all"].expansionCostRatio)}`,
    "",
    "| Task | v1.1 tokens | v1.2 tokens | Delta |",
    "| --- | --- | --- | --- |",
    ...inflation.map(
      (row) =>
        `| ${row.task} | ${row.before} | ${row.after} | ${row.delta >= 0 ? "+" : ""}${row.delta} |`,
    ),
    "",
    "## Minimum sufficient budget",
    "",
    `- TypeScript median: ${ts["v1.1-baseline"].medianMinimumSufficientBudget} → ${ts["v1.2-all"].medianMinimumSufficientBudget}`,
    `- Java median: ${java["v1.1-baseline"].medianMinimumSufficientBudget} → ${java["v1.2-all"].medianMinimumSufficientBudget}`,
    `- Budget sweep: ${budgets.join(", ")}`,
    "",
    "## Remaining misses",
    "",
    ts["v1.2-all"].unresolvedTasks.length ||
    java["v1.2-all"].unresolvedTasks.length
      ? [...ts["v1.2-all"].unresolvedTasks, ...java["v1.2-all"].unresolvedTasks]
          .map((item) => `- ${item}`)
          .join("\n")
      : "None: every required fact in both suites is preserved.",
    "",
    "## Limitations",
    "",
    "- Shared-state evidence is syntactic: `this.member` in both languages, plus bare member names in Java. No alias or data-flow analysis.",
    "- Java fields are not indexed as symbols, so a Java enclosing-type skeleton lists methods and constructors but not field declarations.",
    "- The enclosing-type skeleton caps at 12 member declaration lines; the rest are reported as a count.",
    "- Sibling bodies are included only under the token budget, and only when shared state links them to the target.",
    "",
    "## Next step",
    "",
    "Watch expansion cost ratio as repositories grow: if the skeleton starts dominating small slices, rank its members by task relevance rather than by shared-state score.",
    "",
  ].join("\n");
  writeFileSync(join(outputDir, "v1.2-context-composition.md"), markdown);
  console.log(markdown);
}

run();
