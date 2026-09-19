import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { typeScriptDiagnostics } from "../src/languages/typescript/index.js";
import { estimateTokens } from "../src/planner/budget.js";
import { buildPreview } from "../src/workflow/preview.js";
import type { CallEdge, SymbolRecord } from "../src/types/model.js";
import {
  calculateContextMetrics,
  contextComposition,
  validateManualBaselines,
  type ContextEntry,
  type ManualBaseline,
} from "./developer-context.js";

type Repository = {
  id: string;
  scale: string;
  url: string;
  commit: string;
  source: string;
  scope: string;
  kind: string;
};
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
type ExpectedEdge = {
  callee: string;
  target: string | null;
  confidence: string;
  kind: string;
  category: string;
};
type GroundTruthCalls = {
  id: string;
  fixture: string;
  caller: string;
  expected: ExpectedEdge[];
};

const root = process.cwd();
const outputDir = join(root, "benchmarks/results");
const budgets = [512, 1_024, 2_048, 4_096, 8_192];
const read = <T>(file: string) =>
  JSON.parse(readFileSync(join(root, file), "utf8")) as T;
const repositories = read<Repository[]>(
  "benchmarks/typescript-repositories.json",
);
const tasks = read<Task[]>("benchmarks/typescript-tasks.json");
const manualBaselines = read<ManualBaseline[]>(
  "benchmarks/typescript-manual-context.json",
);
const groundTruthCalls = read<GroundTruthCalls[]>(
  "benchmarks/typescript-semantic-calls.json",
);
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
    : 0;
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
const packageOf = (entries: ContextEntry[]) => ({
  entries,
  text: entries.map((entry) => entry.text).join("\n\n"),
  tokens: contextComposition(entries).total,
});
function manualPackage(repositoryRoot: string, baseline: ManualBaseline) {
  const entries = baseline.files.map((filePath): ContextEntry => ({
    category: /(?:\/test\/|\.(?:test|spec)\.tsx?$)/.test(filePath)
      ? "tests"
      : "target-source",
    filePath,
    text: readFileSync(join(repositoryRoot, filePath), "utf8"),
    wholeFile: true,
  }));
  return { ...packageOf(entries), wholeFiles: baseline.files.length };
}
function factCheck(fact: Fact, text: string, repositoryText: string) {
  const patterns = fact.verification.patterns ?? [];
  return (
    patterns.every((pattern) => text.includes(pattern)) &&
    patterns.every((pattern) => repositoryText.includes(pattern))
  );
}
/**
 * Why a required fact is missing. TYPE_RESOLUTION is claimed only when the fact
 * sits behind a call the resolver could not follow, not merely because the slice
 * did not include a neighbouring declaration.
 */
function attribution(
  fact: Fact,
  target: SymbolRecord | undefined,
  selected: string,
  full: string,
  budget: number,
  index: ProjectIndex,
  repositoryRoot: string,
) {
  if (!target) return "RETRIEVAL";
  if (factCheck(fact, full, full) && !factCheck(fact, selected, full))
    return `CONTEXT_BUDGET_${budget}`;
  const unresolved = index.calls.filter(
    (call) => call.callerId === target.id && !call.resolvedTargetId,
  );
  const patterns = fact.verification.patterns ?? [];
  const behindUnresolvedCall = unresolved.some((call) => {
    const candidates = index.symbols.filter(
      (symbol) => symbol.name === call.calleeName,
    );
    return candidates.some((candidate) => {
      const source = existsSync(join(repositoryRoot, candidate.filePath))
        ? readFileSync(join(repositoryRoot, candidate.filePath), "utf8")
        : "";
      return patterns.every((pattern) => source.includes(pattern));
    });
  });
  return behindUnresolvedCall ? "TYPE_RESOLUTION" : "CONTEXT_COMPOSITION";
}
function requiredFactTokens(facts: Fact[], text: string) {
  const lines = new Set<string>();
  for (const fact of facts)
    for (const line of text.split("\n"))
      if ((fact.verification.patterns ?? []).some((p) => line.includes(p)))
        lines.add(line);
  return estimateTokens([...lines].join("\n"));
}

function semanticCallMetrics() {
  const rows: Array<Record<string, unknown>> = [];
  for (const fixture of [...new Set(groundTruthCalls.map((g) => g.fixture))]) {
    const index = new ProjectIndex(resolve(root, "tests/fixtures", fixture));
    index.rebuild();
    for (const ground of groundTruthCalls.filter(
      (g) => g.fixture === fixture,
    )) {
      const caller = index.symbols.find(
        (symbol) => symbol.id === ground.caller,
      );
      const edges = caller
        ? index.calls.filter((call) => call.callerId === caller.id)
        : [];
      for (const expected of ground.expected) {
        const actual: CallEdge | undefined = edges.find(
          (edge) => edge.calleeName === expected.callee,
        );
        const target = actual?.resolvedTargetId ?? null;
        rows.push({
          fixture,
          task: ground.id,
          category: expected.category,
          callee: expected.callee,
          found: Boolean(actual),
          targetMatches: target === expected.target,
          confidenceMatches: actual?.confidence === expected.confidence,
          kindMatches: actual?.resolutionKind === expected.kind,
          expectedTarget: expected.target,
          actualTarget: target,
          actualKind: actual?.resolutionKind,
        });
      }
    }
  }
  const resolvable = rows.filter((row) => row.expectedTarget !== null);
  const correct = resolvable.filter((row) => row.targetMatches).length;
  const claimed = rows.filter((row) => row.actualTarget !== null).length;
  const truePositives = rows.filter(
    (row) => row.actualTarget !== null && row.targetMatches,
  ).length;
  const falsePositives = rows.filter(
    (row) => row.actualTarget !== null && !row.targetMatches,
  ).length;
  const byCategory = Object.fromEntries(
    [...new Set(rows.map((row) => row.category as string))].map((category) => {
      const subset = rows.filter((row) => row.category === category);
      return [
        category,
        {
          edges: subset.length,
          correct: subset.filter((row) => row.targetMatches).length,
          recall:
            subset.filter((row) => row.targetMatches).length / subset.length,
        },
      ];
    }),
  );
  return {
    edgesEvaluated: rows.length,
    resolvableEdges: resolvable.length,
    semanticCallRecall: resolvable.length ? correct / resolvable.length : 1,
    semanticCallPrecision: claimed ? truePositives / claimed : 1,
    falsePositiveEdgeRate: rows.length ? falsePositives / rows.length : 0,
    falseNegativeEdgeRate: resolvable.length
      ? (resolvable.length - correct) / resolvable.length
      : 0,
    confidenceAgreement:
      rows.filter((row) => row.confidenceMatches).length / rows.length,
    kindAgreement: rows.filter((row) => row.kindMatches).length / rows.length,
    byCategory,
    failures: rows.filter((row) => !row.targetMatches),
  };
}

function repositoryMetrics(repository: Repository) {
  const repositoryRoot = resolve(root, repository.source);
  if (!existsSync(repositoryRoot)) return undefined;
  rmSync(join(repositoryRoot, ".context-slice"), {
    recursive: true,
    force: true,
  });
  const coldIndex = new ProjectIndex(repositoryRoot);
  const cold = coldIndex.rebuild();
  const warm = new ProjectIndex(repositoryRoot).rebuild();
  const changedFile = coldIndex.symbols.find(
    (symbol) =>
      symbol.filePath.endsWith(".ts") && !symbol.filePath.endsWith(".d.ts"),
  )?.filePath;
  let singleFileRefreshMs = 0;
  if (changedFile) {
    const file = join(repositoryRoot, changedFile);
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, `${original}\n// context-slice v1.1 refresh probe\n`);
      singleFileRefreshMs = new ProjectIndex(repositoryRoot).rebuild()
        .elapsedMs;
    } finally {
      writeFileSync(file, original);
    }
  }
  const index = new ProjectIndex(repositoryRoot);
  index.rebuild();
  const diagnostics = index.diagnostics();
  const imports = typeScriptDiagnostics({
    root: index.root,
    symbols: index.symbols,
    calls: index.calls,
    imports: index.imports,
    exports: index.exports,
    sourceOf: (symbol) => index.sourceFor(symbol),
  });
  const previewTask = tasks.find((task) => task.repository === repository.id);
  const previewStarted = performance.now();
  if (previewTask) buildPreview(index, previewTask.task, {});
  const previewMs = Math.round(performance.now() - previewStarted);
  return {
    index,
    repositoryRoot,
    report: {
      repository: repository.id,
      scale: repository.scale,
      kind: repository.kind,
      commit: repository.commit,
      scope: repository.scope,
      files: cold.filesByExtension,
      parseErrors: cold.parseErrors,
      symbols: diagnostics.symbolsIndexed,
      functions: diagnostics.functionsIndexed,
      classes: diagnostics.classesIndexed,
      interfaces: diagnostics.interfacesIndexed,
      types: diagnostics.typesIndexed,
      reactComponents: diagnostics.componentsIndexed,
      callEdges: diagnostics.callEdgesTotal,
      callEdgesExact: diagnostics.callEdgesExact,
      callEdgesProbable: diagnostics.callEdgesProbable,
      callEdgesUnresolved: diagnostics.callEdgesUnresolved,
      externalCallEdges: diagnostics.externalCallEdges,
      resolutionKindCounts: diagnostics.resolutionKindCounts,
      imports,
      performance: {
        coldIndexMs: cold.elapsedMs,
        warmIndexMs: warm.elapsedMs,
        singleFileRefreshMs,
        previewMs,
        filesIndexed: cold.files,
      },
    },
  };
}

function evaluateTask(task: Task, index: ProjectIndex, repositoryRoot: string) {
  const target = targetFor(index, task.targetSymbol);
  const baseline = manualBaselines.find((item) => item.taskId === task.id)!;
  const manual = manualPackage(repositoryRoot, baseline);
  const groundTruthText = task.groundTruthFiles
    .map((file) => readFileSync(join(repositoryRoot, file), "utf8"))
    .join("\n");
  const entries = target ? contextEntries(index, target) : [];
  const full = packageOf(entries);
  const rows = budgets.map((budget) => {
    const selected = packageOf(target ? selectEntries(entries, budget) : []);
    const facts = task.requiredFacts.map((fact) => ({
      id: fact.id,
      preserved: factCheck(fact, selected.text, groundTruthText),
      attribution: factCheck(fact, selected.text, groundTruthText)
        ? "PRESERVED"
        : attribution(
            fact,
            target,
            selected.text,
            full.text,
            budget,
            index,
            repositoryRoot,
          ),
    }));
    return {
      budget,
      selected,
      facts,
      preserved: facts.filter((fact) => fact.preserved).length,
    };
  });
  const sufficient = rows.find(
    (row) => row.preserved === task.requiredFacts.length,
  );
  const representative = sufficient ?? rows.at(-1)!;
  const wholeFileFallback =
    representative.preserved !== task.requiredFacts.length;
  const metrics = calculateContextMetrics({
    manualTokens: manual.tokens,
    contextSliceTokens: representative.selected.tokens,
    requiredFactsTotal: task.requiredFacts.length,
    requiredFactsPreserved: representative.preserved,
    requiredFactTokens: requiredFactTokens(
      task.requiredFacts,
      representative.selected.text,
    ),
    manualWholeFiles: manual.wholeFiles,
    contextSliceWholeFiles: wholeFileFallback ? baseline.files.length : 0,
    fallbackFiles: wholeFileFallback ? baseline.files.length : 0,
    contextBudget: 8_192,
  });
  return {
    task: task.id,
    repository: task.repository,
    category: task.category,
    targetSymbol: task.targetSymbol,
    targetFound: Boolean(target),
    targetId: target?.id,
    retrievalRecall: target ? 1 : 0,
    requiredFactsTotal: task.requiredFacts.length,
    requiredFactsPreserved: representative.preserved,
    requiredFactRecall: representative.preserved / task.requiredFacts.length,
    manualTokens: manual.tokens,
    manualFiles: baseline.files.length,
    suppliedContextTokens: representative.selected.tokens,
    contextItems: representative.selected.entries.length,
    minimumSufficientBudget: sufficient?.budget ?? null,
    wholeFileFallback,
    metrics,
    composition: contextComposition(representative.selected.entries),
    facts: representative.facts,
  };
}

function markdown(report: any) {
  const percentage = (value: number) => `${(value * 100).toFixed(2)}%`;
  const java = report.javaComparison;
  return [
    "# ContextSlice v1.1 — TypeScript and TSX Support",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Executive summary",
    "",
    `- Repositories: ${report.repositories.length} pinned TypeScript/TSX repositories (${report.repositories.map((r: any) => `${r.repository} ${r.scale}`).join(", ")})`,
    `- Tasks: ${report.aggregate.totalTasks} (${report.aggregate.categories})`,
    `- Required-fact recall: ${percentage(report.aggregate.requiredFactRecall)}`,
    `- Retrieval recall: ${percentage(report.aggregate.retrievalRecall)}`,
    `- Median context reduction versus manual whole-file baselines: ${percentage(report.aggregate.medianContextReduction)}`,
    `- Whole-file fallback rate: ${percentage(report.aggregate.wholeFileFallbackRate)}`,
    `- Semantic call recall: ${percentage(report.semanticCalls.semanticCallRecall)}; precision: ${percentage(report.semanticCalls.semanticCallPrecision)}`,
    "",
    "Scope: these numbers come from the 15 TypeScript tasks below. They are not comparable to the Java benchmark's numbers, which use different repositories and tasks.",
    "",
    "## Architecture",
    "",
    "- Language adapters register file extensions, a parser and a call resolver; the core index stays language-neutral and stores a language per file, symbol and call.",
    "- Java keeps its existing regex/Tree-sitter parser; TypeScript and TSX use Tree-sitter AST traversal.",
    "- Cache schema is versioned; an incompatible cache is dropped and rebuilt.",
    "",
    "## Repositories",
    "",
    "| Repository | Scale | Kind | Files | Symbols | Call edges | Exact | Unresolved | External |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.repositories.map(
      (r: any) =>
        `| ${r.repository} | ${r.scale} | ${r.kind} | ${JSON.stringify(r.files)} | ${r.symbols} | ${r.callEdges} | ${r.callEdgesExact} | ${r.callEdgesUnresolved} | ${r.externalCallEdges} |`,
    ),
    "",
    "## Import and export resolution",
    "",
    "| Repository | Imports | Resolved | Relative | Re-exports resolved | External | Unresolved | Asset |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.repositories.map(
      (r: any) =>
        `| ${r.repository} | ${r.imports.importsTotal} | ${r.imports.importsResolved} | ${percentage(r.imports.relativeImportResolutionRate)} | ${percentage(r.imports.reexportResolutionRate)} | ${r.imports.externalImports} | ${r.imports.unresolvedImports} | ${r.imports.assetImports} |`,
    ),
    "",
    "## Tasks",
    "",
    "| Task | Category | Manual tokens | ContextSlice tokens | Reduction | Fact recall | Min sufficient budget |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.taskResults.map(
      (row: any) =>
        `| ${row.task} | ${row.category} | ${row.manualTokens} | ${row.suppliedContextTokens} | ${percentage(row.metrics.contextWindowReduction)} | ${percentage(row.requiredFactRecall)} | ${row.minimumSufficientBudget ?? "n/a"} |`,
    ),
    "",
    "## Semantic call resolution",
    "",
    `- Edges evaluated: ${report.semanticCalls.edgesEvaluated} (${report.semanticCalls.resolvableEdges} expected to resolve to repository source)`,
    `- Recall: ${percentage(report.semanticCalls.semanticCallRecall)}; precision: ${percentage(report.semanticCalls.semanticCallPrecision)}`,
    `- False positive edge rate: ${percentage(report.semanticCalls.falsePositiveEdgeRate)}; false negative edge rate: ${percentage(report.semanticCalls.falseNegativeEdgeRate)}`,
    "",
    "| Category | Edges | Correct | Recall |",
    "| --- | --- | --- | --- |",
    ...Object.entries(report.semanticCalls.byCategory).map(
      ([category, value]: [string, any]) =>
        `| ${category} | ${value.edges} | ${value.correct} | ${percentage(value.recall)} |`,
    ),
    "",
    "## Performance",
    "",
    "| Repository | Files | Cold index | Warm index | Single-file refresh | Preview |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.repositories.map(
      (r: any) =>
        `| ${r.repository} | ${r.performance.filesIndexed} | ${r.performance.coldIndexMs} ms | ${r.performance.warmIndexMs} ms | ${r.performance.singleFileRefreshMs} ms | ${r.performance.previewMs} ms |`,
    ),
    "",
    "Timings are from one local machine and one pinned checkout each.",
    "",
    "## Java regression",
    "",
    java
      ? `Java v0.6 benchmark re-run at this commit: required-fact recall ${percentage(java.requiredFactRecall)}, retrieval recall ${percentage(java.retrievalRecall)}, median context reduction ${percentage(java.medianContextWindowReduction)} across ${java.totalTasks} tasks.`
      : "Java v0.6 results were not available in this run.",
    "",
    "## Comparison",
    "",
    "| Metric | Java v1.0 benchmark | TypeScript v1.1 benchmark |",
    "| --- | --- | --- |",
    `| Repositories | 3 pinned Java repositories | 3 pinned TypeScript/TSX repositories |`,
    `| Tasks | ${java?.totalTasks ?? "n/a"} | ${report.aggregate.totalTasks} |`,
    `| Retrieval recall | ${java ? percentage(java.retrievalRecall) : "n/a"} | ${percentage(report.aggregate.retrievalRecall)} |`,
    `| Required-fact recall | ${java ? percentage(java.requiredFactRecall) : "n/a"} | ${percentage(report.aggregate.requiredFactRecall)} |`,
    `| Median context reduction | ${java ? percentage(java.medianContextWindowReduction) : "n/a"} | ${percentage(report.aggregate.medianContextReduction)} |`,
    `| Whole-file fallback | ${java ? percentage(java.wholeFileFallbackRate) : "n/a"} | ${percentage(report.aggregate.wholeFileFallbackRate)} |`,
    "",
    "The two columns measure different repositories and different tasks. Neither column says one language is better supported than the other.",
    "",
    "## tsserver decision",
    "",
    `- Required facts lost to missing type resolution: ${report.tsserverDecision.factsLostToTypeResolution} of ${report.tsserverDecision.requiredFactsTotal}`,
    `- Tasks harmed: ${report.tsserverDecision.tasksHarmed}`,
    `- Unresolved imports across repositories: ${report.tsserverDecision.unresolvedImports}`,
    `- Decision: ${report.tsserverDecision.decision}`,
    "",
    report.tsserverDecision.rationale,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item: string) => `- ${item}`),
    "",
    "## Next step",
    "",
    report.nextStep,
    "",
  ].join("\n");
}

function run() {
  validateManualBaselines(
    manualBaselines,
    tasks.map((task) => task.id),
  );
  mkdirSync(outputDir, { recursive: true });
  const repositoryReports: any[] = [];
  const taskResults: any[] = [];
  for (const repository of repositories) {
    const measured = repositoryMetrics(repository);
    if (!measured) {
      repositoryReports.push({ repository: repository.id, status: "N/A" });
      continue;
    }
    repositoryReports.push(measured.report);
    for (const task of tasks.filter(
      (item) => item.repository === repository.id,
    ))
      taskResults.push(
        evaluateTask(task, measured.index, measured.repositoryRoot),
      );
  }
  const semanticCalls = semanticCallMetrics();
  const factsTotal = taskResults.reduce(
    (sum, row) => sum + row.requiredFactsTotal,
    0,
  );
  const factsPreserved = taskResults.reduce(
    (sum, row) => sum + row.requiredFactsPreserved,
    0,
  );
  const reductions = taskResults.map(
    (row) => row.metrics.contextWindowReduction,
  );
  const aggregate = {
    totalTasks: taskResults.length,
    categories: [...new Set(tasks.map((task) => task.category))].join(", "),
    requiredFactsTotal: factsTotal,
    requiredFactsPreserved: factsPreserved,
    requiredFactRecall: factsPreserved / Math.max(factsTotal, 1),
    retrievalRecall:
      taskResults.reduce((sum, row) => sum + row.retrievalRecall, 0) /
      Math.max(taskResults.length, 1),
    medianContextReduction: percentile(reductions, 0.5),
    meanContextReduction:
      reductions.reduce((sum, value) => sum + value, 0) /
      Math.max(reductions.length, 1),
    medianManualTokens: percentile(
      taskResults.map((row) => row.manualTokens),
      0.5,
    ),
    medianContextSliceTokens: percentile(
      taskResults.map((row) => row.suppliedContextTokens),
      0.5,
    ),
    medianMinimumSufficientBudget: percentile(
      taskResults
        .map((row) => row.minimumSufficientBudget)
        .filter((value): value is number => typeof value === "number"),
      0.5,
    ),
    wholeFileFallbackRate:
      taskResults.filter((row) => row.wholeFileFallback).length /
      Math.max(taskResults.length, 1),
  };
  const javaPath = join(outputDir, "v0.6-developer-context-efficiency.json");
  const java = existsSync(javaPath)
    ? JSON.parse(readFileSync(javaPath, "utf8")).aggregate
    : undefined;
  const javaComparison = java
    ? {
        totalTasks: java.totalTasks,
        requiredFactRecall: java.overallRequiredFactRecall,
        retrievalRecall: java.overallRetrievalRecall,
        medianContextWindowReduction: java.medianContextWindowReduction,
        wholeFileFallbackRate: java.wholeFileFallbackRate,
      }
    : undefined;
  const typeResolutionFailures = taskResults.flatMap((row) =>
    row.facts.filter((fact: any) => fact.attribution === "TYPE_RESOLUTION"),
  );
  const tasksHarmed = taskResults.filter((row) =>
    row.facts.some((fact: any) => fact.attribution === "TYPE_RESOLUTION"),
  ).length;
  const unresolvedImports = repositoryReports.reduce(
    (sum, report) => sum + (report.imports?.unresolvedImports ?? 0),
    0,
  );
  const tsserverDecision = {
    requiredFactsTotal: factsTotal,
    factsLostToTypeResolution: typeResolutionFailures.length,
    tasksHarmed,
    unresolvedImports,
    decision:
      typeResolutionFailures.length === 0
        ? "Do not add tsserver or the TypeScript Compiler API."
        : "Re-evaluate: measured required-fact loss is attributable to missing type resolution.",
    rationale:
      typeResolutionFailures.length === 0
        ? "No required fact in this benchmark was lost because a type could not be inferred. Structural resolution (imports, re-exports, declared receiver types, class members) covered every measured task, so a compiler service would add a dependency and a project-system without a measured benefit. Unresolved calls with inferred receivers remain reported as unresolved rather than guessed."
        : "Required facts were lost to missing type inference; revisit the decision with these cases.",
  };
  const report = {
    version: "1.1",
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    tokenAccounting:
      "estimated deterministic context size; not assistant telemetry",
    repositories: repositoryReports,
    aggregate,
    taskResults,
    semanticCalls,
    javaComparison,
    tsserverDecision,
    limitations: [
      "Benchmark scope is 15 tasks across 3 pinned repositories; results do not generalize to all TypeScript projects.",
      "Context sizes are deterministic estimates from the built-in estimator, not assistant token telemetry.",
      "Call resolution is structural. Calls whose receiver type requires inference stay unresolved by design.",
      "Monorepo imports that leave the checked-out packages are reported as unresolved rather than guessed.",
      "CommonJS require and module.exports are parsed safely but not resolved.",
      "Excalidraw is measured as a sparse checkout of its TypeScript packages, not the whole repository.",
    ],
    nextStep:
      "Use the unresolved-call and unresolved-import categories to decide whether a later version needs richer type resolution for TypeScript.",
  };
  writeFileSync(
    join(outputDir, "v1.1-typescript-support.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(
    join(outputDir, "v1.1-typescript-support.md"),
    markdown(report),
  );
  console.log(markdown(report));
}

run();
