import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeSiblings } from "../src/planner/composition.js";
import {
  ALL_PYTHON_RULES,
  pythonDiagnostics,
  resolvePythonCalls,
  type PythonRules,
} from "../src/languages/python/resolve.js";
import { estimateTokens } from "../src/planner/budget.js";
import {
  buildPreview,
  COMPOSITION_BUDGET_SHARE,
} from "../src/workflow/preview.js";
import type { CallEdge, SymbolRecord } from "../src/types/model.js";
import {
  calculateContextMetrics,
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
type GroundTruth = {
  id: string;
  fixture: string;
  caller: string;
  expected: ExpectedEdge[];
};

const root = process.cwd();
const outputDir = join(root, "benchmarks/results");
const budgets = [256, 512, 1_024, 2_048, 4_096, 8_192];
const read = <T>(file: string) =>
  JSON.parse(readFileSync(join(root, file), "utf8")) as T;
const readIfPresent = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8") : "";
const repositories = read<Repository[]>("benchmarks/python-repositories.json");
const tasks = read<Task[]>("benchmarks/python-tasks.json");
const baselines = read<ManualBaseline[]>(
  "benchmarks/python-manual-context.json",
);
const groundTruth = read<GroundTruth[]>(
  "benchmarks/python-semantic-calls.json",
);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

const NO_RULES: PythonRules = {
  selfFieldReceiver: false,
  instanceReceiver: false,
  classReceiver: false,
};
const ruleConfigurations: Array<{
  id: string;
  label: string;
  rules: PythonRules;
}> = [
  { id: "core", label: "core resolution only", rules: NO_RULES },
  {
    id: "self-field",
    label: "+ self attribute receiver",
    rules: { ...NO_RULES, selfFieldReceiver: true },
  },
  {
    id: "instance",
    label: "+ instance receiver",
    rules: { ...NO_RULES, instanceReceiver: true },
  },
  {
    id: "class-receiver",
    label: "+ class receiver",
    rules: { ...NO_RULES, classReceiver: true },
  },
  { id: "all", label: "v1.3 (all rules)", rules: ALL_PYTHON_RULES },
];

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
  for (const candidate of composeSiblings(index, target, seen))
    entries.push({
      category: "types",
      symbolId: candidate.symbol?.id,
      filePath: candidate.filePath,
      text: candidate.rendered,
    });
  return entries;
}
function select(entries: ContextEntry[], budget: number) {
  const selected: ContextEntry[] = [];
  let used = 0;
  let composition = 0;
  const allowance = Math.floor(budget * COMPOSITION_BUDGET_SHARE);
  for (const entry of entries) {
    const tokens = estimateTokens(entry.text);
    if (entry.category === "types" && composition + tokens > allowance)
      continue;
    if (selected.length === 0 || used + tokens <= budget) {
      selected.push(entry);
      used += tokens;
      if (entry.category === "types") composition += tokens;
    }
  }
  return {
    entries: selected,
    text: selected.map((entry) => entry.text).join("\n\n"),
    tokens: used,
  };
}
const factCheck = (fact: Fact, text: string, repositoryText: string) => {
  const patterns = fact.verification.patterns ?? [];
  return (
    patterns.length > 0 &&
    patterns.every((pattern) => text.includes(pattern)) &&
    patterns.every((pattern) => repositoryText.includes(pattern))
  );
};
/** Why a fact is missing, using the shared attribution vocabulary. */
function attribution(
  fact: Fact,
  target: SymbolRecord | undefined,
  selected: string,
  full: string,
  budget: number,
  index: ProjectIndex,
) {
  if (!target) return "TARGET_SELECTION";
  if (factCheck(fact, full, full) && !factCheck(fact, selected, full))
    return `TOKEN_BUDGET_${budget}`;
  const unresolved = index.calls.filter(
    (call) => call.callerId === target.id && !call.resolvedTargetId,
  );
  const patterns = fact.verification.patterns ?? [];
  const behindUnresolved = unresolved.some((call) =>
    index.symbols.some(
      (symbol) =>
        symbol.name === call.calleeName &&
        patterns.every((pattern) => symbol.source.includes(pattern)),
    ),
  );
  if (behindUnresolved)
    return unresolved.some((call) => call.receiverText)
      ? "DYNAMIC_LANGUAGE_LIMIT"
      : "CALL_RESOLUTION";
  return "CONTEXT_COMPOSITION";
}

function semanticCalls(rules: PythonRules) {
  const rows: Array<Record<string, unknown>> = [];
  for (const fixture of [...new Set(groundTruth.map((item) => item.fixture))]) {
    const fixtureRoot = resolve(root, "tests/fixtures", fixture);
    rmSync(join(fixtureRoot, ".context-slice"), {
      recursive: true,
      force: true,
    });
    const index = new ProjectIndex(fixtureRoot);
    index.rebuild();
    // Re-resolve with the requested rule set.
    for (const call of index.calls) {
      call.resolvedTargetId = undefined;
      call.declaredTargetId = undefined;
      call.confidence = "unresolved";
      call.resolutionKind =
        call.resolutionKind === "constructor" ? "constructor" : "unresolved";
      call.externalPackage = undefined;
      call.evidence = [];
    }
    resolvePythonCalls(
      {
        root: index.root,
        symbols: index.symbols,
        calls: index.calls,
        imports: index.imports,
        exports: index.exports,
        sourceOf: (symbol) => index.sourceFor(symbol),
      },
      rules,
    );
    for (const item of groundTruth.filter(
      (entry) => entry.fixture === fixture,
    )) {
      const caller = index.symbols.find((symbol) => symbol.id === item.caller);
      const edges = caller
        ? index.calls.filter((call) => call.callerId === caller.id)
        : [];
      for (const expected of item.expected) {
        const actual: CallEdge | undefined = edges.find(
          (edge) => edge.calleeName === expected.callee,
        );
        rows.push({
          category: expected.category,
          callee: expected.callee,
          expectedTarget: expected.target,
          actualTarget: actual?.resolvedTargetId ?? null,
          targetMatches: (actual?.resolvedTargetId ?? null) === expected.target,
          kindMatches: actual?.resolutionKind === expected.kind,
        });
      }
    }
  }
  const resolvable = rows.filter((row) => row.expectedTarget !== null);
  const claimed = rows.filter((row) => row.actualTarget !== null);
  return {
    edgesEvaluated: rows.length,
    resolvableEdges: resolvable.length,
    semanticCallRecall: resolvable.length
      ? resolvable.filter((row) => row.targetMatches).length / resolvable.length
      : 1,
    semanticCallPrecision: claimed.length
      ? claimed.filter((row) => row.targetMatches).length / claimed.length
      : 1,
    falsePositiveEdgeRate: rows.length
      ? claimed.filter((row) => !row.targetMatches).length / rows.length
      : 0,
    kindAgreement: rows.filter((row) => row.kindMatches).length / rows.length,
    byCategory: Object.fromEntries(
      [...new Set(rows.map((row) => row.category as string))].map(
        (category) => {
          const subset = rows.filter((row) => row.category === category);
          return [
            category,
            {
              edges: subset.length,
              correct: subset.filter((row) => row.targetMatches).length,
            },
          ];
        },
      ),
    ),
    failures: rows.filter((row) => !row.targetMatches),
  };
}

function evaluateRepository(repository: Repository, rules: PythonRules) {
  const repositoryRoot = resolve(root, repository.source);
  if (!existsSync(repositoryRoot)) return undefined;
  rmSync(join(repositoryRoot, ".context-slice"), {
    recursive: true,
    force: true,
  });
  const coldIndex = new ProjectIndex(repositoryRoot);
  const cold = coldIndex.rebuild();
  const warm = new ProjectIndex(repositoryRoot).rebuild();
  const changed = coldIndex.symbols.find((symbol) =>
    symbol.filePath.endsWith(".py"),
  )?.filePath;
  let singleFileRefreshMs = 0;
  if (changed) {
    const file = join(repositoryRoot, changed);
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, `${original}\n# context-slice refresh probe\n`);
      singleFileRefreshMs = new ProjectIndex(repositoryRoot).rebuild()
        .elapsedMs;
    } finally {
      writeFileSync(file, original);
    }
  }
  const index = new ProjectIndex(repositoryRoot);
  index.rebuild();
  if (rules !== ALL_PYTHON_RULES) {
    for (const call of index.calls) {
      call.resolvedTargetId = undefined;
      call.confidence = "unresolved";
      call.externalPackage = undefined;
    }
    resolvePythonCalls(
      {
        root: index.root,
        symbols: index.symbols,
        calls: index.calls,
        imports: index.imports,
        exports: index.exports,
        sourceOf: (symbol) => index.sourceFor(symbol),
      },
      rules,
    );
  }
  const context = {
    root: index.root,
    symbols: index.symbols,
    calls: index.calls,
    imports: index.imports,
    exports: index.exports,
    sourceOf: (symbol: SymbolRecord) => index.sourceFor(symbol),
  };
  const diagnostics = index.diagnostics();
  const python = pythonDiagnostics(context);
  const previewTask = tasks.find((task) => task.repository === repository.id);
  const started = performance.now();
  if (previewTask) buildPreview(index, previewTask.task, {});
  const previewMs = Math.round(performance.now() - started);
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
      classes: diagnostics.classesIndexed,
      functions: diagnostics.functionsIndexed,
      methods: diagnostics.methodsIndexed,
      decoratedSymbols: python.decoratedSymbols,
      callEdges: diagnostics.callEdgesTotal,
      callEdgesExact: diagnostics.callEdgesExact,
      callEdgesUnresolved: diagnostics.callEdgesUnresolved,
      externalCallEdges: diagnostics.externalCallEdges,
      resolutionKindCounts: diagnostics.resolutionKindCounts,
      python,
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
  const baseline = baselines.find((item) => item.taskId === task.id)!;
  const manualTokens = baseline.files.reduce(
    (sum, file) =>
      sum + estimateTokens(readIfPresent(join(repositoryRoot, file))),
    0,
  );
  const groundTruthText = task.groundTruthFiles
    .map((file) => readIfPresent(join(repositoryRoot, file)))
    .join("\n");
  const entries = target ? contextEntries(index, target) : [];
  const full = select(entries, Number.MAX_SAFE_INTEGER);
  const sweep = budgets.map((budget) => {
    const selected = select(entries, budget);
    const facts = task.requiredFacts.map((fact) => ({
      id: fact.id,
      preserved: factCheck(fact, selected.text, groundTruthText),
      attribution: factCheck(fact, selected.text, groundTruthText)
        ? "PRESERVED"
        : attribution(fact, target, selected.text, full.text, budget, index),
    }));
    return {
      budget,
      selected,
      facts,
      preserved: facts.filter((fact) => fact.preserved).length,
    };
  });
  const sufficient = sweep.find(
    (row) => row.preserved === task.requiredFacts.length,
  );
  const representative = sufficient ?? sweep.at(-1)!;
  const fallback = !sufficient;
  return {
    task: task.id,
    repository: task.repository,
    category: task.category,
    targetSymbol: task.targetSymbol,
    targetFound: Boolean(target),
    retrievalRecall: target ? 1 : 0,
    requiredFactsTotal: task.requiredFacts.length,
    requiredFactsPreserved: representative.preserved,
    requiredFactRecall: representative.preserved / task.requiredFacts.length,
    manualTokens,
    manualFiles: baseline.files.length,
    suppliedContextTokens: representative.selected.tokens,
    contextItems: representative.selected.entries.length,
    minimumSufficientBudget: sufficient?.budget ?? null,
    wholeFileFallback: fallback,
    wholeModuleFallback: false,
    reduction:
      manualTokens > 0 ? 1 - representative.selected.tokens / manualTokens : 0,
    metrics: calculateContextMetrics({
      manualTokens,
      contextSliceTokens: representative.selected.tokens,
      requiredFactsTotal: task.requiredFacts.length,
      requiredFactsPreserved: representative.preserved,
      requiredFactTokens: representative.selected.tokens,
      manualWholeFiles: baseline.files.length,
      contextSliceWholeFiles: fallback ? baseline.files.length : 0,
      fallbackFiles: fallback ? baseline.files.length : 0,
      contextBudget: 8_192,
    }),
    facts: representative.facts,
  };
}

function run() {
  validateManualBaselines(
    baselines,
    tasks.map((task) => task.id),
  );
  mkdirSync(outputDir, { recursive: true });
  const repositoryReports: any[] = [];
  const taskResults: any[] = [];
  for (const repository of repositories) {
    const measured = evaluateRepository(repository, ALL_PYTHON_RULES);
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

  // Each resolution rule measured alone on the fixture ground truth.
  const ruleAttribution = ruleConfigurations.map((configuration) => {
    const semantic = semanticCalls(configuration.rules);
    return {
      rule: configuration.id,
      label: configuration.label,
      semanticCallRecall: semantic.semanticCallRecall,
      semanticCallPrecision: semantic.semanticCallPrecision,
      resolvedEdges: semantic.resolvableEdges * semantic.semanticCallRecall,
    };
  });
  const semantic = semanticCalls(ALL_PYTHON_RULES);

  const factsTotal = taskResults.reduce(
    (sum, row) => sum + row.requiredFactsTotal,
    0,
  );
  const factsPreserved = taskResults.reduce(
    (sum, row) => sum + row.requiredFactsPreserved,
    0,
  );
  const aggregate = {
    totalTasks: taskResults.length,
    categories: [...new Set(tasks.map((task) => task.category))].join(", "),
    requiredFactRecall: factsPreserved / Math.max(factsTotal, 1),
    retrievalRecall:
      taskResults.reduce((sum, row) => sum + row.retrievalRecall, 0) /
      Math.max(taskResults.length, 1),
    medianContextReduction: median(taskResults.map((row) => row.reduction)),
    medianManualTokens: median(taskResults.map((row) => row.manualTokens)),
    medianContextTokens: median(
      taskResults.map((row) => row.suppliedContextTokens),
    ),
    medianMinimumSufficientBudget: median(
      taskResults
        .map((row) => row.minimumSufficientBudget)
        .filter((value): value is number => typeof value === "number"),
    ),
    wholeFileFallbackRate:
      taskResults.filter((row) => row.wholeFileFallback).length /
      Math.max(taskResults.length, 1),
    wholeModuleFallbackRate: 0,
  };
  const attributionCounts = Object.fromEntries(
    [
      ...new Set(
        taskResults.flatMap((row) =>
          row.facts
            .filter((fact: any) => !fact.preserved)
            .map((fact: any) => String(fact.attribution).replace(/_\d+$/, "")),
        ),
      ),
    ].map((reason) => [
      reason,
      taskResults.flatMap((row) =>
        row.facts.filter(
          (fact: any) =>
            !fact.preserved &&
            String(fact.attribution).replace(/_\d+$/, "") === reason,
        ),
      ).length,
    ]),
  );
  const dynamicUnresolved = median(
    repositoryReports
      .filter((report) => report.python)
      .map((report) => report.python.dynamicUnresolvedRate),
  );
  const java = existsSync(
    join(outputDir, "v0.6-developer-context-efficiency.json"),
  )
    ? JSON.parse(
        readFileSync(
          join(outputDir, "v0.6-developer-context-efficiency.json"),
          "utf8",
        ),
      ).aggregate
    : undefined;
  const typescript = existsSync(
    join(outputDir, "v1.2-context-composition.json"),
  )
    ? JSON.parse(
        readFileSync(join(outputDir, "v1.2-context-composition.json"), "utf8"),
      ).summary.typescript["v1.2-all"]
    : undefined;

  const report = {
    version: "1.3",
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    tokenAccounting:
      "estimated deterministic context size; not assistant telemetry",
    repositories: repositoryReports,
    aggregate,
    taskResults,
    semanticCalls: semantic,
    ruleAttribution,
    failureAttribution: attributionCounts,
    dynamicUnresolvedRate: dynamicUnresolved,
    comparison: { java, typescript },
    typeCheckerDecision: {
      factsLostToTypeInference: taskResults.flatMap((row) =>
        row.facts.filter(
          (fact: any) => fact.attribution === "DYNAMIC_LANGUAGE_LIMIT",
        ),
      ).length,
      tasksHarmed: taskResults.filter((row) =>
        row.facts.some(
          (fact: any) => fact.attribution === "DYNAMIC_LANGUAGE_LIMIT",
        ),
      ).length,
      unresolvedImports: repositoryReports
        .filter((report) => report.python)
        .reduce((sum, report) => sum + report.python.unresolvedImports, 0),
      decision: "",
      rationale: "",
    },
    limitations: [
      "Benchmark scope is 15 tasks across 3 pinned Python repositories; results do not generalize to all Python projects.",
      "Context sizes are deterministic estimates from the built-in estimator, not assistant telemetry.",
      "Resolution is structural. Receivers needing runtime type inference, monkey patching, getattr and dynamic imports stay unresolved by design.",
      "Django is measured as a sparse checkout of django/db, django/core and django/utils; imports leaving those packages are reported unresolved rather than guessed.",
      "Python fields are not indexed as symbols, so a class skeleton lists methods and class-level assignments only.",
    ],
    nextStep:
      "Watch the dynamic unresolved rate against required-fact loss: it only becomes a product problem when a task actually needs the missing edge.",
  };
  const lost = report.typeCheckerDecision.factsLostToTypeInference;
  report.typeCheckerDecision.decision =
    lost === 0
      ? "Do not add Pyright, mypy or Jedi."
      : "Re-evaluate: required facts were lost to dynamic receiver ambiguity.";
  report.typeCheckerDecision.rationale =
    lost === 0
      ? "No required fact in this benchmark was lost because a Python type could not be inferred. Structural resolution (packages, imports, self/cls, constructor evidence) covered every measured task, so a type checker would add a heavy dependency without a measured benefit. Dynamic calls remain reported as unresolved rather than guessed."
      : "Required facts were lost to dynamic receiver ambiguity; revisit with these cases.";

  writeFileSync(
    join(outputDir, "v1.3-python-support.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const percentage = (value: number) => `${(value * 100).toFixed(2)}%`;
  const markdown = [
    "# ContextSlice v1.3 — Python Support",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Executive summary",
    "",
    `- Repositories: ${repositoryReports.length} pinned Python repositories (${repositoryReports.map((item: any) => `${item.repository} ${item.scale ?? ""}`.trim()).join(", ")})`,
    `- Tasks: ${aggregate.totalTasks} (${aggregate.categories})`,
    `- Required-fact recall: ${percentage(aggregate.requiredFactRecall)}`,
    `- Retrieval recall: ${percentage(aggregate.retrievalRecall)}`,
    `- Median context reduction versus manual whole-file baselines: ${percentage(aggregate.medianContextReduction)}`,
    `- Whole-file fallback: ${percentage(aggregate.wholeFileFallbackRate)}; whole-module fallback: ${percentage(aggregate.wholeModuleFallbackRate)}`,
    `- Semantic call recall: ${percentage(semantic.semanticCallRecall)}; precision: ${percentage(semantic.semanticCallPrecision)}`,
    `- Median dynamic unresolved rate: ${percentage(dynamicUnresolved)} of call edges, which is expected for Python and only matters when a required fact is lost`,
    "",
    "Scope: these numbers come from the 15 Python tasks below. They are not comparable to the Java or TypeScript benchmarks, which use different repositories and tasks.",
    "",
    "## Architecture",
    "",
    "- Python is a language adapter beside Java and TypeScript; the core index is unchanged.",
    "- Tree-sitter parsing, package-aware import resolution, and conservative call resolution. No Pyright, mypy, Jedi or runtime import execution.",
    "",
    "## Repositories",
    "",
    "| Repository | Scale | Kind | Files | Symbols | Decorated | Call edges | Exact | Unresolved | External |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...repositoryReports.map(
      (item: any) =>
        `| ${item.repository} | ${item.scale} | ${item.kind} | ${item.files?.[".py"] ?? 0} | ${item.symbols} | ${item.decoratedSymbols} | ${item.callEdges} | ${item.callEdgesExact} | ${item.callEdgesUnresolved} | ${item.externalCallEdges} |`,
    ),
    "",
    "## Import and package resolution",
    "",
    "| Repository | Imports | Resolved | Relative | Package re-exports | External | Unresolved | self | cls |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...repositoryReports.map(
      (item: any) =>
        `| ${item.repository} | ${item.python.importsTotal} | ${item.python.importsResolved} | ${percentage(item.python.relativeImportResolutionRate)} | ${percentage(item.python.packageReexportResolutionRate)} | ${item.python.externalImports} | ${item.python.unresolvedImports} | ${percentage(item.python.selfMethodResolutionRate)} | ${percentage(item.python.clsMethodResolutionRate)} |`,
    ),
    "",
    "## Tasks",
    "",
    "| Task | Category | Manual tokens | ContextSlice tokens | Reduction | Fact recall | Min sufficient budget |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...taskResults.map(
      (row) =>
        `| ${row.task} | ${row.category} | ${row.manualTokens} | ${row.suppliedContextTokens} | ${percentage(row.metrics.contextWindowReduction)} | ${percentage(row.requiredFactRecall)} | ${row.minimumSufficientBudget ?? "n/a"} |`,
    ),
    "",
    "## Semantic call resolution",
    "",
    `- Edges evaluated: ${semantic.edgesEvaluated} (${semantic.resolvableEdges} expected to resolve to repository source)`,
    `- Recall: ${percentage(semantic.semanticCallRecall)}; precision: ${percentage(semantic.semanticCallPrecision)}; false positive edge rate: ${percentage(semantic.falsePositiveEdgeRate)}`,
    "",
    "| Category | Edges | Correct |",
    "| --- | --- | --- |",
    ...Object.entries(semantic.byCategory).map(
      ([category, value]: [string, any]) =>
        `| ${category} | ${value.edges} | ${value.correct} |`,
    ),
    "",
    "## Per-rule attribution",
    "",
    "Each receiver rule measured alone against the fixture ground truth.",
    "",
    "| Rule | Semantic call recall | Precision |",
    "| --- | --- | --- |",
    ...ruleAttribution.map(
      (row) =>
        `| ${row.label} | ${percentage(row.semanticCallRecall)} | ${percentage(row.semanticCallPrecision)} |`,
    ),
    "",
    "## Failure attribution",
    "",
    Object.keys(attributionCounts).length
      ? Object.entries(attributionCounts)
          .map(([reason, count]) => `- ${reason}: ${count}`)
          .join("\n")
      : "Every required fact in every task was preserved.",
    "",
    "## Performance",
    "",
    "| Repository | Files | Cold index | Warm index | Single-file refresh | Preview |",
    "| --- | --- | --- | --- | --- | --- |",
    ...repositoryReports.map(
      (item: any) =>
        `| ${item.repository} | ${item.performance.filesIndexed} | ${item.performance.coldIndexMs} ms | ${item.performance.warmIndexMs} ms | ${item.performance.singleFileRefreshMs} ms | ${item.performance.previewMs} ms |`,
    ),
    "",
    "Timings are from one local machine and one pinned checkout each.",
    "",
    "## Comparison",
    "",
    "| Metric | Java | TypeScript | Python v1.3 |",
    "| --- | --- | --- | --- |",
    `| Retrieval recall | ${java ? percentage(java.overallRetrievalRecall) : "n/a"} | ${typescript ? percentage(typescript.retrievalRecall) : "n/a"} | ${percentage(aggregate.retrievalRecall)} |`,
    `| Required-fact recall | ${java ? percentage(java.overallRequiredFactRecall) : "n/a"} | ${typescript ? percentage(typescript.requiredFactRecall) : "n/a"} | ${percentage(aggregate.requiredFactRecall)} |`,
    `| Median context reduction | ${java ? percentage(java.medianContextWindowReduction) : "n/a"} | ${typescript ? percentage(typescript.medianReduction) : "n/a"} | ${percentage(aggregate.medianContextReduction)} |`,
    `| Whole-file fallback | ${java ? percentage(java.wholeFileFallbackRate) : "n/a"} | ${typescript ? percentage(typescript.wholeFileFallbackRate) : "n/a"} | ${percentage(aggregate.wholeFileFallbackRate)} |`,
    "",
    "Each column uses different repositories and different tasks. The columns are not equivalent and must not be read as a language ranking.",
    "",
    "## Type checker decision",
    "",
    `- Required facts lost to dynamic receiver ambiguity: ${report.typeCheckerDecision.factsLostToTypeInference} of ${factsTotal}`,
    `- Tasks harmed: ${report.typeCheckerDecision.tasksHarmed}`,
    `- Unresolved imports across repositories: ${report.typeCheckerDecision.unresolvedImports}`,
    `- Decision: ${report.typeCheckerDecision.decision}`,
    "",
    report.typeCheckerDecision.rationale,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "",
    "## Next step",
    "",
    report.nextStep,
    "",
  ].join("\n");
  writeFileSync(join(outputDir, "v1.3-python-support.md"), markdown);
  console.log(markdown);
}

run();
