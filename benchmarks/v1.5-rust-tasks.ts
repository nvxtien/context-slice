import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectIndex } from "../src/indexer/index.js";
import {
  composeSiblings,
  composeImportContext,
} from "../src/planner/composition.js";
import { estimateTokens } from "../src/planner/budget.js";
import {
  buildPreview,
  COMPOSITION_BUDGET_SHARE,
} from "../src/workflow/preview.js";
import type { SymbolRecord } from "../src/types/model.js";
import {
  calculateContextMetrics,
  validateManualBaselines,
  type ContextEntry,
  type ManualBaseline,
} from "./developer-context.js";

type Repository = {
  id: string;
  scale: string;
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
export type Attribution =
  | "PRESERVED"
  | "TARGET_NOT_FOUND"
  | "ADAPTER_EMPTY_FILE"
  | "NOT_SELECTED"
  | "BUDGET"
  | "NOT_IN_SOURCE"
  | "TARGET_AMBIGUOUS";

const budgets = [256, 512, 1_024, 2_048, 4_096, 8_192];
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const readIfPresent = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8") : "";

// Adapter names look like `a::impl A::new`; tasks say `A.new`. Normalise and match on a
// whole-segment suffix so `new` stays ambiguous and never picks the first of many.
const normalise = (name: string) =>
  name.replace(/impl /g, "").replace(/::/g, ".");
export function contextEntries_(index: ProjectIndex, target: SymbolRecord) {
  return contextEntries(index, target);
}
export function resolveTarget(
  index: ProjectIndex,
  qualifiedName: string,
  file?: string,
) {
  const matches = index.symbols.filter((symbol) => {
    if (symbol.kind !== "function" && symbol.kind !== "method") return false;
    if (file && symbol.filePath !== file) return false;
    const name = normalise(symbol.qualifiedName ?? symbol.name);
    return name === qualifiedName || name.endsWith(`.${qualifiedName}`);
  });
  if (matches.length === 1)
    return { symbol: matches[0], candidates: 1 } as {
      symbol?: SymbolRecord;
      error?: "not-found" | "ambiguous";
      candidates: number;
    };
  return {
    error: matches.length ? "ambiguous" : "not-found",
    candidates: matches.length,
  } as {
    symbol?: SymbolRecord;
    error?: "not-found" | "ambiguous";
    candidates: number;
  };
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
  const add = (
    category: "caller-context" | "callee-context",
    symbols: SymbolRecord[],
  ) => {
    for (const symbol of symbols) {
      if (seen.has(symbol.id)) continue;
      seen.add(symbol.id);
      entries.push({
        category,
        symbolId: symbol.id,
        filePath: symbol.filePath,
        text: `${symbol.qualifiedName}\n${symbol.source}`,
      });
    }
  };
  add("caller-context", index.callers(target));
  add("callee-context", index.dependencies(target));
  for (const candidate of composeSiblings(index, target, seen))
    entries.push({
      category: "types",
      symbolId: candidate.symbol?.id,
      filePath: candidate.filePath,
      text: candidate.rendered,
    });
  const relatedFiles = new Set(
    [...seen]
      .map((id) => index.symbols.find((s) => s.id === id)?.filePath)
      .filter(
        (file): file is string => Boolean(file) && file !== target.filePath,
      ),
  );
  for (const candidate of composeImportContext(
    index,
    target,
    relatedFiles,
    seen,
  ))
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

const patternsOf = (fact: Fact) => fact.verification.patterns ?? [];
const has = (fact: Fact, text: string) =>
  patternsOf(fact).length > 0 &&
  patternsOf(fact).every((pattern) => text.includes(pattern));

/** Why a fact is (not) present. fullText is the unlimited-budget selection. */
export function attributeFact(
  fact: Fact,
  ctx: {
    target?: SymbolRecord;
    ambiguous?: boolean;
    fileParsed: boolean;
    selectedText: string;
    fullText: string;
    groundTruthText: string;
    budget: number;
  },
): Attribution {
  if (!ctx.target && ctx.ambiguous) return "TARGET_AMBIGUOUS";
  if (!ctx.target)
    return ctx.fileParsed ? "TARGET_NOT_FOUND" : "ADAPTER_EMPTY_FILE";
  if (!has(fact, ctx.groundTruthText)) return "NOT_IN_SOURCE";
  if (has(fact, ctx.selectedText)) return "PRESERVED";
  return has(fact, ctx.fullText) ? "BUDGET" : "NOT_SELECTED";
}

function evaluateTask(
  task: Task,
  index: ProjectIndex,
  repositoryRoot: string,
  baselines: ManualBaseline[],
) {
  let resolved = resolveTarget(index, task.targetSymbol);
  if (resolved.error === "ambiguous") {
    // The ground-truth file is task input: retry scoped to each file, accept only a unique hit.
    const hits = task.groundTruthFiles
      .map((file) => resolveTarget(index, task.targetSymbol, file))
      .filter((hit) => hit.symbol);
    if (hits.length === 1) resolved = hits[0];
  }
  const target = resolved.symbol;
  const baseline = baselines.find((item) => item.taskId === task.id)!;
  const manualTokens = baseline.files.reduce(
    (sum, file) =>
      sum + estimateTokens(readIfPresent(join(repositoryRoot, file))),
    0,
  );
  const groundTruthText = task.groundTruthFiles
    .map((file) => readIfPresent(join(repositoryRoot, file)))
    .join("\n");
  const fileParsed = index.symbols.some((symbol) =>
    task.groundTruthFiles.includes(symbol.filePath),
  );
  const entries = target ? contextEntries(index, target) : [];
  const full = select(entries, Number.MAX_SAFE_INTEGER);
  const sweep = budgets.map((budget) => {
    const selected = select(entries, budget);
    const facts = task.requiredFacts.map((fact) => ({
      id: fact.id,
      attribution: attributeFact(fact, {
        target,
        ambiguous: resolved.error === "ambiguous",
        fileParsed,
        selectedText: selected.text,
        fullText: full.text,
        groundTruthText,
        budget,
      }),
    }));
    return {
      budget,
      selected,
      facts,
      preserved: facts.filter((fact) => fact.attribution === "PRESERVED")
        .length,
    };
  });
  const sufficient = sweep.find(
    (row) => row.preserved === task.requiredFacts.length,
  );
  const representative = sufficient ?? sweep.at(-1)!;
  const fallback = !sufficient;
  const selectedFiles = new Set(
    representative.selected.entries.map((entry) => entry.filePath),
  );
  const retrievalRecall =
    target &&
    task.groundTruthFiles.every(
      (file) => selectedFiles.has(file) || file === target.filePath,
    )
      ? 1
      : 0;
  const wholeModuleFallback =
    fallback &&
    representative.selected.entries.some(
      (entry) =>
        index.symbols.find((s) => s.id === entry.symbolId)?.kind ===
        "namespace",
    );
  return {
    task: task.id,
    repository: task.repository,
    category: task.category,
    targetSymbol: task.targetSymbol,
    targetFound: Boolean(target),
    targetResolution: resolved.error ?? "resolved",
    targetCandidates: resolved.candidates,
    targetFileParsed: fileParsed,
    retrievalRecall,
    requiredFactsTotal: task.requiredFacts.length,
    requiredFactsPreserved: representative.preserved,
    requiredFactRecall: representative.preserved / task.requiredFacts.length,
    manualTokens,
    manualFiles: baseline.files.length,
    suppliedContextTokens: representative.selected.tokens,
    contextItems: representative.selected.entries.length,
    minimumSufficientBudget: sufficient?.budget ?? null,
    wholeFileFallback: fallback,
    wholeModuleFallback,
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

function evaluateRepository(
  repository: Repository,
  tasks: Task[],
  root: string,
) {
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
    symbol.filePath.endsWith(".rs"),
  )?.filePath;
  let singleFileRefreshMs: number | null = null;
  if (changed) {
    const file = join(repositoryRoot, changed);
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, `${original}\n// context-slice refresh probe\n`);
      singleFileRefreshMs = new ProjectIndex(repositoryRoot).rebuild()
        .elapsedMs;
    } finally {
      writeFileSync(file, original);
    }
  }
  const index = new ProjectIndex(repositoryRoot);
  index.rebuild();
  const timings: number[] = [];
  let previewError: string | undefined;
  for (const previewTask of tasks
    .filter((task) => task.repository === repository.id)
    .slice(0, 3)) {
    const started = performance.now();
    try {
      buildPreview(index, previewTask.task, {});
      timings.push(Math.round(performance.now() - started));
    } catch (error) {
      previewError = `${previewTask.id}: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  const previewMs = timings.length ? median(timings) : null;
  const diagnostics = index.diagnostics();
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
      callEdges: diagnostics.callEdgesTotal,
      callEdgesExact: diagnostics.callEdgesExact,
      callEdgesUnresolved: diagnostics.callEdgesUnresolved,
      performance: {
        coldIndexMs: cold.elapsedMs,
        warmIndexMs: warm.elapsedMs,
        singleFileRefreshMs,
        previewMs,
        previewError,
        filesIndexed: cold.files,
      },
    },
  };
}

/** Per non-PRESERVED cause: tasks, repos, and fix/report-only (fix iff loses a fact/target and repeats in >=2 tasks or >=2 repos). */
export function buildFindings(
  rows: {
    task: string;
    repository: string;
    facts: { attribution: string }[];
  }[],
) {
  const causes = new Map<string, { tasks: Set<string>; repos: Set<string> }>();
  for (const row of rows)
    for (const fact of row.facts) {
      if (fact.attribution === "PRESERVED") continue;
      const entry = causes.get(fact.attribution) ?? {
        tasks: new Set<string>(),
        repos: new Set<string>(),
      };
      entry.tasks.add(row.task);
      entry.repos.add(row.repository);
      causes.set(fact.attribution, entry);
    }
  return [...causes].map(([cause, { tasks, repos }]) => ({
    cause,
    tasks: [...tasks],
    repositories: [...repos],
    taskCount: tasks.size,
    repositoryCount: repos.size,
    marker:
      cause !== "NOT_IN_SOURCE" &&
      cause !== "BUDGET" &&
      (tasks.size >= 2 || repos.size >= 2)
        ? "fix"
        : "report-only",
  }));
}

// What each attribution means for the fix loop (the evidence behind a row, not a claim about one repo).
export const ROOT_CAUSE_NOTES: Record<string, string> = {
  NOT_SELECTED:
    "fact lies outside every selected symbol: a missing/unresolved call edge, or text that is not in any symbol (e.g. a `use` line)",
  BUDGET: "fact is in the unlimited selection but not at 8192 tokens",
  NOT_IN_SOURCE: "pattern absent from the ground-truth files: task defect",
  TARGET_NOT_FOUND:
    "target symbol not indexed although its file parsed: adapter defect",
  ADAPTER_EMPTY_FILE:
    "ground-truth file produced no symbols (empty/parse error): adapter defect",
  TARGET_AMBIGUOUS: "target name matched several symbols, even scoped by file",
};

type FactRow = {
  task: string;
  category: string;
  facts: { id: string; attribution: string }[];
};
type Summary = {
  requiredFactRecall: number;
  retrievalRecall: number;
  wholeFileFallbackRate: number;
};
type RunJson = {
  summary: { overall: Summary; byCategory: Record<string, Summary> };
  tasks: FactRow[];
};

/** Before/after comparison of two runs (overall + per category) and every fact whose attribution changed. */
export function buildBeforeAfter(before: RunJson, after: RunJson) {
  const groups = [
    ["all", before.summary.overall, after.summary.overall] as const,
    ...Object.keys(after.summary.byCategory).map(
      (c) =>
        [c, before.summary.byCategory[c], after.summary.byCategory[c]] as const,
    ),
  ];
  const rows = groups.map(([group, b, a]) => ({
    group,
    factRecall: [b?.requiredFactRecall ?? null, a.requiredFactRecall],
    retrievalRecall: [b?.retrievalRecall ?? null, a.retrievalRecall],
    wholeFileFallback: [
      b?.wholeFileFallbackRate ?? null,
      a.wholeFileFallbackRate,
    ],
  }));
  const changes = after.tasks.flatMap((t) =>
    t.facts.flatMap((f) => {
      const old =
        before.tasks
          .find((x) => x.task === t.task)
          ?.facts.find((x) => x.id === f.id)?.attribution ?? "absent";
      return old === f.attribution
        ? []
        : [{ task: t.task, fact: f.id, before: old, after: f.attribution }];
    }),
  );
  return {
    rows,
    changes,
    regressions: changes.filter((c) => c.before === "PRESERVED"),
  };
}

/** Categories with the lowest fact recall (ties all named). */
export function weakestCategories(
  byCategory: Record<string, { requiredFactRecall: number }>,
) {
  const min = Math.min(
    ...Object.values(byCategory).map((s) => s.requiredFactRecall),
  );
  return Object.entries(byCategory)
    .filter(([, s]) => s.requiredFactRecall === min)
    .map(([c]) => c);
}

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
function summarize(rows: any[]) {
  const total = rows.reduce((sum, row) => sum + row.requiredFactsTotal, 0);
  const kept = rows.reduce((sum, row) => sum + row.requiredFactsPreserved, 0);
  const n = Math.max(rows.length, 1);
  return {
    tasks: rows.length,
    requiredFactRecall: kept / Math.max(total, 1),
    retrievalRecall:
      rows.reduce((sum, row) => sum + row.retrievalRecall, 0) / n,
    medianContextReduction: median(rows.map((row) => row.reduction)),
    medianManualTokens: median(rows.map((row) => row.manualTokens)),
    medianContextTokens: median(rows.map((row) => row.suppliedContextTokens)),
    medianMinimumSufficientBudget: median(
      rows
        .map((row) => row.minimumSufficientBudget)
        .filter((v): v is number => typeof v === "number"),
    ),
    wholeFileFallbackRate:
      rows.filter((row) => row.wholeFileFallback).length / n,
    wholeModuleFallbackRate:
      rows.filter((row) => row.wholeModuleFallback).length / n,
  };
}

function main() {
  const root = process.cwd();
  const outputDir = join(root, "benchmarks/results");
  const read = <T>(file: string) =>
    JSON.parse(readFileSync(join(root, file), "utf8")) as T;
  const repositories = read<Repository[]>("benchmarks/rust-repositories.json");
  const tasks = read<Task[]>("benchmarks/rust-tasks.json");
  const baselines = read<ManualBaseline[]>(
    "benchmarks/rust-manual-context.json",
  );
  validateManualBaselines(
    baselines,
    tasks.map((task) => task.id),
  );
  mkdirSync(outputDir, { recursive: true });
  const repositoryReports: any[] = [];
  const taskResults: any[] = [];
  for (const repository of repositories) {
    const measured = evaluateRepository(repository, tasks, root);
    if (!measured) {
      repositoryReports.push({ repository: repository.id, status: "N/A" });
      continue;
    }
    repositoryReports.push(measured.report);
    for (const task of tasks.filter(
      (item) => item.repository === repository.id,
    ))
      taskResults.push(
        evaluateTask(task, measured.index, measured.repositoryRoot, baselines),
      );
  }
  const summary = {
    overall: summarize(taskResults),
    byRepository: Object.fromEntries(
      repositories.map((r) => [
        r.id,
        summarize(taskResults.filter((row) => row.repository === r.id)),
      ]),
    ),
    byCategory: Object.fromEntries(
      [...new Set(tasks.map((t) => t.category))].map((c) => [
        c,
        summarize(taskResults.filter((row) => row.category === c)),
      ]),
    ),
  };
  const attribution: Record<string, number> = {};
  for (const row of taskResults)
    for (const fact of row.facts)
      if (fact.attribution !== "PRESERVED")
        attribution[fact.attribution] =
          (attribution[fact.attribution] ?? 0) + 1;
  const findings = buildFindings(taskResults);
  const performance = repositoryReports
    .filter((r) => r.performance)
    .map((r) => ({ repository: r.repository, ...r.performance }));
  const report = {
    version: "1.5-phase3",
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    tokenAccounting:
      "estimated deterministic context size; not assistant telemetry",
    note: "Small sample (n=15 tasks); not comparable to Java/TypeScript/Python numbers.",
    repositories: repositoryReports,
    tasks: taskResults,
    summary,
    failureAttribution: attribution,
    findings,
    performance,
  };
  writeFileSync(
    join(outputDir, "v1.5-phase3-rust-tasks.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const beforeFile = join(
    outputDir,
    "v1.5-phase3-rust-tasks.before-fixes.json",
  );
  const beforeAfter = existsSync(beforeFile)
    ? buildBeforeAfter(JSON.parse(readFileSync(beforeFile, "utf8")), report)
    : undefined;
  const pp = (v: number | null) => (v === null ? "n/a" : pct(v));
  const incomplete = taskResults.filter(
    (r) => r.minimumSufficientBudget === null,
  );
  const weakest = weakestCategories(summary.byCategory);
  const factTasks = (cause: string) =>
    new Set(
      taskResults
        .filter((r) => r.facts.some((f: any) => f.attribution === cause))
        .map((r) => r.task),
    ).size;
  const row = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${s.tasks} | ${pct(s.requiredFactRecall)} | ${pct(s.retrievalRecall)} | ${pct(s.medianContextReduction)} | ${pct(s.wholeFileFallbackRate)} | ${pct(s.wholeModuleFallbackRate)} | ${s.medianMinimumSufficientBudget} |`;
  const head = [
    "| Group | Tasks | Fact recall | Retrieval recall | Median reduction | Whole-file fallback | Whole-module fallback | Median min budget |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const markdown = [
    "# ContextSlice v1.5 Phase 3 — Rust Task Evaluation",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `${report.note}`,
    "",
    `Decision gate (every required fact preserved at <= 8192 tokens on all ${taskResults.length} tasks): ${incomplete.length ? `NOT MET — ${incomplete.length} task(s) incomplete: ${incomplete.map((r) => r.task).join(", ")}.` : "MET."}`,
    "",
    `Weakest categories (lowest fact recall, ${pct(summary.byCategory[weakest[0]]?.requiredFactRecall ?? 0)}): ${weakest.join(", ")}.`,
    "",
    "## Overall",
    "",
    ...head,
    row("all", summary.overall),
    "",
    "## Per repository",
    "",
    ...head,
    ...Object.entries(summary.byRepository).map(([k, v]) => row(k, v)),
    "",
    "## Per category",
    "",
    ...head,
    ...Object.entries(summary.byCategory).map(([k, v]) => row(k, v)),
    "",
    "## Tasks",
    "",
    "| Task | Category | Target | Manual tokens | Context tokens | Reduction | Fact recall | Retrieval | Min budget |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...taskResults.map(
      (r) =>
        `| ${r.task} | ${r.category} | ${r.targetFound ? "found" : r.targetResolution} | ${r.manualTokens} | ${r.suppliedContextTokens} | ${pct(r.reduction)} | ${pct(r.requiredFactRecall)} | ${r.retrievalRecall} | ${r.minimumSufficientBudget ?? "n/a"} |`,
    ),
    "",
    "Note: retrieval recall 1 with min budget n/a is possible: every ground-truth file is selected but some fact text in it is not (e.g. a line outside every symbol).",
    "",
    "## Failure attribution",
    "",
    "TARGET_NOT_FOUND/ADAPTER_EMPTY_FILE = adapter defect; NOT_SELECTED = missing edge/selection rule; BUDGET = budget too small; NOT_IN_SOURCE = task defect.",
    "",
    "| Cause | Facts | Distinct tasks |",
    "| --- | --- | --- |",
    ...(Object.keys(attribution).length
      ? Object.entries(attribution).map(
          ([k, v]) => `| ${k} | ${v} | ${factTasks(k)} |`,
        )
      : ["| none | 0 | 0 |"]),
    "",
    "## Findings",
    "",
    "Counts are distinct tasks / repositories, not facts.",
    "",
    "| Cause | Tasks | Repositories | Task count | Repo count | Marker | Root-cause note |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...(findings.length
      ? findings.map(
          (f) =>
            `| ${f.cause} | ${f.tasks.join(", ")} | ${f.repositories.join(", ")} | ${f.taskCount} | ${f.repositoryCount} | ${f.marker} | ${ROOT_CAUSE_NOTES[f.cause] ?? "-"} |`,
        )
      : ["| none | - | - | 0 | 0 | - | - |"]),
    "",
    "## Before / After",
    "",
    ...(beforeAfter
      ? [
          "Before = `v1.5-phase3-rust-tasks.before-fixes.json` (frozen baseline); After = this run.",
          "",
          "| Group | Fact recall | Retrieval recall | Whole-file fallback |",
          "| --- | --- | --- | --- |",
          ...beforeAfter.rows.map(
            (r) =>
              `| ${r.group} | ${pp(r.factRecall[0])} → ${pp(r.factRecall[1])} | ${pp(r.retrievalRecall[0])} → ${pp(r.retrievalRecall[1])} | ${pp(r.wholeFileFallback[0])} → ${pp(r.wholeFileFallback[1])} |`,
          ),
          "",
          "Fact status changes:",
          "",
          ...(beforeAfter.changes.length
            ? beforeAfter.changes.map(
                (c) => `- ${c.task} / ${c.fact}: ${c.before} → ${c.after}`,
              )
            : ["- none"]),
          "",
          `Regressions (a fact PRESERVED before and not after): ${beforeAfter.regressions.length ? beforeAfter.regressions.map((c) => `${c.task} / ${c.fact}`).join(", ") : "none"}.`,
        ]
      : ["No before-fixes baseline present."]),
    "",
    "## Missing facts",
    "",
    ...taskResults.flatMap((r) =>
      r.facts
        .filter((f: any) => f.attribution !== "PRESERVED")
        .map((f: any) => `- ${r.task} / ${f.id}: ${f.attribution}`),
    ),
    "",
    "## Performance",
    "",
    "| Repository | Files | Cold | Warm | Single-file refresh | Preview |",
    "| --- | --- | --- | --- | --- | --- |",
    ...performance.map(
      (p) =>
        `| ${p.repository} | ${p.filesIndexed} | ${p.coldIndexMs} ms | ${p.warmIndexMs} ms | ${p.singleFileRefreshMs === null ? "n/a" : `${p.singleFileRefreshMs} ms`} | ${p.previewMs === null ? "n/a" : `${p.previewMs} ms (median of up to 3)`} |`,
    ),
    "",
    ...performance
      .filter((p) => p.previewError)
      .map((p) => `Preview error (${p.repository}): ${p.previewError}`),
    "",
    "Limitation: wholeModuleFallback is a proxy (true only when a selected entry is a module/namespace symbol) and is expected to read 0% here.",
    "",
    "Limitation: cfg-gated alternatives are all attached as probable targets, but caller/callee graph traversal only follows the first-listed target in source order, so non-first cfg alternatives are not reachable via context composition yet.",
    "",
    "Timings are from one local machine and one pinned checkout each.",
    "",
  ].join("\n");
  writeFileSync(join(outputDir, "v1.5-phase3-rust-tasks.md"), markdown);
  console.log(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
