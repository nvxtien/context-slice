import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectIndex } from "../src/indexer/index.js";
import { composeSiblings } from "../src/planner/composition.js";
import { estimateTokens } from "../src/planner/budget.js";
import { buildPreview, COMPOSITION_BUDGET_SHARE } from "../src/workflow/preview.js";
import type { SymbolRecord } from "../src/types/model.js";
import {
  calculateContextMetrics,
  validateManualBaselines,
  type ContextEntry,
  type ManualBaseline,
} from "./developer-context.js";

type Repository = { id: string; scale: string; commit: string; source: string; scope: string; kind: string };
type Fact = { id: string; description: string; verification: { type: string; patterns?: string[] } };
type Task = {
  id: string; repository: string; category: string; task: string; targetSymbol: string;
  groundTruthFiles: string[]; requiredFacts: Fact[]; baselineFiles: string[];
};
export type Attribution = "PRESERVED" | "TARGET_NOT_FOUND" | "ADAPTER_EMPTY_FILE" | "NOT_SELECTED" | "BUDGET" | "NOT_IN_SOURCE";

const budgets = [256, 512, 1_024, 2_048, 4_096, 8_192];
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const readIfPresent = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

// Adapter names look like `a::impl A::new`; tasks say `A.new`. Normalise and match on a
// whole-segment suffix so `new` stays ambiguous and never picks the first of many.
const normalise = (name: string) => name.replace(/impl /g, "").replace(/::/g, ".");
export function resolveTarget(index: ProjectIndex, qualifiedName: string, file?: string) {
  const matches = index.symbols.filter((symbol) => {
    if (symbol.kind !== "function" && symbol.kind !== "method") return false;
    if (file && symbol.filePath !== file) return false;
    const name = normalise(symbol.qualifiedName ?? symbol.name);
    return name === qualifiedName || name.endsWith(`.${qualifiedName}`);
  });
  if (matches.length === 1) return { symbol: matches[0], candidates: 1 } as { symbol?: SymbolRecord; error?: "not-found" | "ambiguous"; candidates: number };
  return { error: matches.length ? "ambiguous" : "not-found", candidates: matches.length } as { symbol?: SymbolRecord; error?: "not-found" | "ambiguous"; candidates: number };
}

function contextEntries(index: ProjectIndex, target: SymbolRecord): ContextEntry[] {
  const entries: ContextEntry[] = [
    { category: "target-source", symbolId: target.id, filePath: target.filePath, text: target.source },
  ];
  const seen = new Set([target.id]);
  const add = (category: "caller-context" | "callee-context", symbols: SymbolRecord[]) => {
    for (const symbol of symbols) {
      if (seen.has(symbol.id)) continue;
      seen.add(symbol.id);
      entries.push({ category, symbolId: symbol.id, filePath: symbol.filePath, text: `${symbol.qualifiedName}\n${symbol.source}` });
    }
  };
  add("caller-context", index.callers(target));
  add("callee-context", index.dependencies(target));
  for (const candidate of composeSiblings(index, target, seen))
    entries.push({ category: "types", symbolId: candidate.symbol?.id, filePath: candidate.filePath, text: candidate.rendered });
  return entries;
}

function select(entries: ContextEntry[], budget: number) {
  const selected: ContextEntry[] = [];
  let used = 0;
  let composition = 0;
  const allowance = Math.floor(budget * COMPOSITION_BUDGET_SHARE);
  for (const entry of entries) {
    const tokens = estimateTokens(entry.text);
    if (entry.category === "types" && composition + tokens > allowance) continue;
    if (selected.length === 0 || used + tokens <= budget) {
      selected.push(entry);
      used += tokens;
      if (entry.category === "types") composition += tokens;
    }
  }
  return { entries: selected, text: selected.map((entry) => entry.text).join("\n\n"), tokens: used };
}

const patternsOf = (fact: Fact) => fact.verification.patterns ?? [];
const has = (fact: Fact, text: string) => patternsOf(fact).length > 0 && patternsOf(fact).every((pattern) => text.includes(pattern));

/** Why a fact is (not) present. fullText is the unlimited-budget selection. */
export function attributeFact(
  fact: Fact,
  ctx: { target?: SymbolRecord; fileParsed: boolean; selectedText: string; fullText: string; groundTruthText: string; budget: number },
): Attribution {
  if (!ctx.target) return ctx.fileParsed ? "TARGET_NOT_FOUND" : "ADAPTER_EMPTY_FILE";
  if (!has(fact, ctx.groundTruthText)) return "NOT_IN_SOURCE";
  if (has(fact, ctx.selectedText)) return "PRESERVED";
  return has(fact, ctx.fullText) ? "BUDGET" : "NOT_SELECTED";
}

function evaluateTask(task: Task, index: ProjectIndex, repositoryRoot: string, baselines: ManualBaseline[]) {
  const resolved = resolveTarget(index, task.targetSymbol);
  const target = resolved.symbol;
  const baseline = baselines.find((item) => item.taskId === task.id)!;
  const manualTokens = baseline.files.reduce((sum, file) => sum + estimateTokens(readIfPresent(join(repositoryRoot, file))), 0);
  const groundTruthText = task.groundTruthFiles.map((file) => readIfPresent(join(repositoryRoot, file))).join("\n");
  const fileParsed = index.symbols.some((symbol) => task.groundTruthFiles.includes(symbol.filePath));
  const entries = target ? contextEntries(index, target) : [];
  const full = select(entries, Number.MAX_SAFE_INTEGER);
  const sweep = budgets.map((budget) => {
    const selected = select(entries, budget);
    const facts = task.requiredFacts.map((fact) => ({
      id: fact.id,
      attribution: attributeFact(fact, { target, fileParsed, selectedText: selected.text, fullText: full.text, groundTruthText, budget }),
    }));
    return { budget, selected, facts, preserved: facts.filter((fact) => fact.attribution === "PRESERVED").length };
  });
  const sufficient = sweep.find((row) => row.preserved === task.requiredFacts.length);
  const representative = sufficient ?? sweep.at(-1)!;
  const fallback = !sufficient;
  const selectedFiles = new Set(representative.selected.entries.map((entry) => entry.filePath));
  const retrievalRecall = target && task.groundTruthFiles.every((file) => selectedFiles.has(file) || file === target.filePath) ? 1 : 0;
  const wholeModuleFallback =
    fallback && representative.selected.entries.some((entry) => index.symbols.find((s) => s.id === entry.symbolId)?.kind === "namespace");
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
    reduction: manualTokens > 0 ? 1 - representative.selected.tokens / manualTokens : 0,
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

function evaluateRepository(repository: Repository, tasks: Task[], root: string) {
  const repositoryRoot = resolve(root, repository.source);
  if (!existsSync(repositoryRoot)) return undefined;
  rmSync(join(repositoryRoot, ".context-slice"), { recursive: true, force: true });
  const coldIndex = new ProjectIndex(repositoryRoot);
  const cold = coldIndex.rebuild();
  const warm = new ProjectIndex(repositoryRoot).rebuild();
  const changed = coldIndex.symbols.find((symbol) => symbol.filePath.endsWith(".rs"))?.filePath;
  let singleFileRefreshMs = 0;
  if (changed) {
    const file = join(repositoryRoot, changed);
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, `${original}\n// context-slice refresh probe\n`);
      singleFileRefreshMs = new ProjectIndex(repositoryRoot).rebuild().elapsedMs;
    } finally {
      writeFileSync(file, original);
    }
  }
  const index = new ProjectIndex(repositoryRoot);
  index.rebuild();
  const previewTask = tasks.find((task) => task.repository === repository.id);
  const started = performance.now();
  if (previewTask) buildPreview(index, previewTask.task, {});
  const previewMs = Math.round(performance.now() - started);
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
      performance: { coldIndexMs: cold.elapsedMs, warmIndexMs: warm.elapsedMs, singleFileRefreshMs, previewMs, filesIndexed: cold.files },
    },
  };
}

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
function summarize(rows: any[]) {
  const total = rows.reduce((sum, row) => sum + row.requiredFactsTotal, 0);
  const kept = rows.reduce((sum, row) => sum + row.requiredFactsPreserved, 0);
  const n = Math.max(rows.length, 1);
  return {
    tasks: rows.length,
    requiredFactRecall: kept / Math.max(total, 1),
    retrievalRecall: rows.reduce((sum, row) => sum + row.retrievalRecall, 0) / n,
    medianContextReduction: median(rows.map((row) => row.reduction)),
    medianManualTokens: median(rows.map((row) => row.manualTokens)),
    medianContextTokens: median(rows.map((row) => row.suppliedContextTokens)),
    medianMinimumSufficientBudget: median(rows.map((row) => row.minimumSufficientBudget).filter((v): v is number => typeof v === "number")),
    wholeFileFallbackRate: rows.filter((row) => row.wholeFileFallback).length / n,
    wholeModuleFallbackRate: rows.filter((row) => row.wholeModuleFallback).length / n,
  };
}

function main() {
  const root = process.cwd();
  const outputDir = join(root, "benchmarks/results");
  const read = <T>(file: string) => JSON.parse(readFileSync(join(root, file), "utf8")) as T;
  const repositories = read<Repository[]>("benchmarks/rust-repositories.json");
  const tasks = read<Task[]>("benchmarks/rust-tasks.json");
  const baselines = read<ManualBaseline[]>("benchmarks/rust-manual-context.json");
  validateManualBaselines(baselines, tasks.map((task) => task.id));
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
    for (const task of tasks.filter((item) => item.repository === repository.id))
      taskResults.push(evaluateTask(task, measured.index, measured.repositoryRoot, baselines));
  }
  const summary = {
    overall: summarize(taskResults),
    byRepository: Object.fromEntries(repositories.map((r) => [r.id, summarize(taskResults.filter((row) => row.repository === r.id))])),
    byCategory: Object.fromEntries([...new Set(tasks.map((t) => t.category))].map((c) => [c, summarize(taskResults.filter((row) => row.category === c))])),
  };
  const attribution: Record<string, number> = {};
  for (const row of taskResults)
    for (const fact of row.facts) if (fact.attribution !== "PRESERVED") attribution[fact.attribution] = (attribution[fact.attribution] ?? 0) + 1;
  const performance = repositoryReports.filter((r) => r.performance).map((r) => ({ repository: r.repository, ...r.performance }));
  const report = {
    version: "1.5-phase3",
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    tokenAccounting: "estimated deterministic context size; not assistant telemetry",
    note: "15 tasks; not comparable to Java/TypeScript/Python numbers.",
    repositories: repositoryReports,
    tasks: taskResults,
    summary,
    failureAttribution: attribution,
    performance,
  };
  writeFileSync(join(outputDir, "v1.5-phase3-rust-tasks.json"), `${JSON.stringify(report, null, 2)}\n`);
  const row = (name: string, s: ReturnType<typeof summarize>) =>
    `| ${name} | ${s.tasks} | ${pct(s.requiredFactRecall)} | ${pct(s.retrievalRecall)} | ${pct(s.medianContextReduction)} | ${pct(s.wholeFileFallbackRate)} | ${pct(s.wholeModuleFallbackRate)} | ${s.medianMinimumSufficientBudget} |`;
  const head = ["| Group | Tasks | Fact recall | Retrieval recall | Median reduction | Whole-file fallback | Whole-module fallback | Median min budget |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  const markdown = [
    "# ContextSlice v1.5 Phase 3 — Rust Task Evaluation",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "15 tasks; not comparable to Java/TypeScript/Python numbers.",
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
    ...taskResults.map((r) => `| ${r.task} | ${r.category} | ${r.targetFound ? "found" : r.targetResolution} | ${r.manualTokens} | ${r.suppliedContextTokens} | ${pct(r.reduction)} | ${pct(r.requiredFactRecall)} | ${r.retrievalRecall} | ${r.minimumSufficientBudget ?? "n/a"} |`),
    "",
    "## Failure attribution",
    "",
    "TARGET_NOT_FOUND/ADAPTER_EMPTY_FILE = adapter defect; NOT_SELECTED = missing edge/selection rule; BUDGET = budget too small; NOT_IN_SOURCE = task defect.",
    "",
    "| Cause | Facts |",
    "| --- | --- |",
    ...(Object.keys(attribution).length ? Object.entries(attribution).map(([k, v]) => `| ${k} | ${v} |`) : ["| none | 0 |"]),
    "",
    "## Missing facts",
    "",
    ...taskResults.flatMap((r) => r.facts.filter((f: any) => f.attribution !== "PRESERVED").map((f: any) => `- ${r.task} / ${f.id}: ${f.attribution}`)),
    "",
    "## Performance",
    "",
    "| Repository | Files | Cold | Warm | Single-file refresh | Preview |",
    "| --- | --- | --- | --- | --- | --- |",
    ...performance.map((p) => `| ${p.repository} | ${p.filesIndexed} | ${p.coldIndexMs} ms | ${p.warmIndexMs} ms | ${p.singleFileRefreshMs} ms | ${p.previewMs} ms |`),
    "",
    "Timings are from one local machine and one pinned checkout each.",
    "",
  ].join("\n");
  writeFileSync(join(outputDir, "v1.5-phase3-rust-tasks.md"), markdown);
  console.log(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
