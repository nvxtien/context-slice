import { ProjectIndex } from "../indexer/index.js";
import { estimateTokens } from "../planner/budget.js";
import { rankSymbol } from "../planner/rank.js";
import { renderSkeleton } from "../render/compact-context.js";
import type { SymbolRecord } from "../types/model.js";
import { WorkflowError } from "./errors.js";

export type PreviewReason = "task target" | "direct caller" | "direct callee";

export interface PreviewOptions {
  budget?: number;
  depth?: number;
}

export interface PreviewItem {
  symbolId: string;
  symbol: string;
  filePath: string;
  reason: PreviewReason;
  explanation: string;
  estimatedTokens: number;
  rendered: string;
}

export interface OmittedPreviewItem {
  symbolId?: string;
  symbol: string;
  reason: "context budget";
  estimatedTokens: number;
}

export interface UnresolvedPreviewCall {
  calleeName: string;
  evidence: string[];
}

export interface PreviewResult {
  task: string;
  target: SymbolRecord;
  budget: number;
  estimatedTokens: number;
  rendered: string;
  included: PreviewItem[];
  omitted: OmittedPreviewItem[];
  unresolved: UnresolvedPreviewCall[];
  confidence: "high" | "mixed";
  freshness: ReturnType<ProjectIndex["inspect"]>;
  composition: Record<PreviewReason, number>;
}

function parameterCount(symbol: SymbolRecord) {
  const parameters = symbol.signature?.match(/\(([^)]*)\)/)?.[1].trim() ?? "";
  return parameters ? parameters.split(",").length : 0;
}

function chooseTarget(index: ProjectIndex, task: string) {
  const exact = index.resolveSymbol(task);
  if (exact.length === 1) return exact[0];
  const normalized = task.toLowerCase();
  const exactName = index.symbols
    .filter(
      (symbol) =>
        (symbol.kind === "method" || symbol.kind === "constructor") &&
        normalized.includes(symbol.name.toLowerCase()),
    )
    .sort(
      (a, b) =>
        b.name.length - a.name.length ||
        parameterCount(a) - parameterCount(b) ||
        a.id.localeCompare(b.id),
    );
  if (exactName.length) return exactName[0];

  const result = index.search(task, 1)[0];
  const target = result
    ? index.symbols.find((symbol) => symbol.id === result.id)
    : undefined;
  if (target) return target;

  throw new WorkflowError(
    "SYMBOL_NOT_FOUND",
    `No indexed Java symbol matches task: ${task}`,
    "Run context-slice index, then use a task that names a method, type, or qualified symbol.",
  );
}

function renderedSkeleton(
  index: ProjectIndex,
  symbol: SymbolRecord,
  relation: string,
) {
  const calls = index.calls
    .filter((call) => call.callerId === symbol.id)
    .map(
      (call) =>
        `${call.receiverText ? `${call.receiverText}.` : ""}${call.calleeName}(…)`,
    );
  return `// ${relation}\n${renderSkeleton(symbol, calls)}`;
}

function ranked(symbols: SymbolRecord[], task: string) {
  return [...symbols].sort(
    (a, b) =>
      rankSymbol(b, task, task) - rankSymbol(a, task, task) ||
      a.id.localeCompare(b.id),
  );
}

export function buildPreview(
  index: ProjectIndex,
  task: string,
  options: PreviewOptions = {},
): PreviewResult {
  if (!task.trim()) {
    throw new WorkflowError(
      "SYMBOL_NOT_FOUND",
      "Preview requires a non-empty developer task.",
      'Pass a task such as: context-slice preview "explain retryPayment".',
    );
  }
  if (!index.symbols.length) {
    throw new WorkflowError(
      "INDEX_STALE",
      "No loaded index is available for preview.",
      "Run context-slice index before requesting a preview.",
    );
  }

  const target = chooseTarget(index, task);
  const targetTokens = estimateTokens(target.source);
  const budget = options.budget ?? Math.max(1200, targetTokens);
  if (budget < targetTokens) {
    throw new WorkflowError(
      "BUDGET_TOO_SMALL",
      `Budget ${budget} cannot include target ${target.qualifiedName ?? target.name} (${targetTokens} tokens).`,
      `Increase --budget to at least ${targetTokens}, or select a smaller target.`,
    );
  }

  const included: PreviewItem[] = [];
  const omitted: OmittedPreviewItem[] = [];
  const composition: Record<PreviewReason, number> = {
    "task target": 0,
    "direct caller": 0,
    "direct callee": 0,
  };
  let estimatedTokens = 0;
  const add = (
    symbol: SymbolRecord,
    reason: PreviewReason,
    rendered: string,
    explanation: string,
  ) => {
    const tokens = estimateTokens(rendered);
    if (estimatedTokens + tokens > budget) {
      omitted.push({
        symbolId: symbol.id,
        symbol: symbol.qualifiedName ?? symbol.name,
        reason: "context budget",
        estimatedTokens: tokens,
      });
      return;
    }
    included.push({
      symbolId: symbol.id,
      symbol: symbol.qualifiedName ?? symbol.name,
      filePath: symbol.filePath,
      reason,
      explanation,
      estimatedTokens: tokens,
      rendered,
    });
    estimatedTokens += tokens;
    composition[reason] += tokens;
  };

  add(
    target,
    "task target",
    target.source,
    `Selected because the task names ${target.name}.`,
  );
  const related = [
    ...ranked(index.callersAtDepth(target, options.depth ?? 1), task).map(
      (symbol) => ({
        symbol,
        reason: "direct caller" as const,
        relation: "Direct caller",
      }),
    ),
    ...ranked(index.dependenciesAtDepth(target, options.depth ?? 1), task).map(
      (symbol) => ({
        symbol,
        reason: "direct callee" as const,
        relation: "Direct callee",
      }),
    ),
  ];
  const includedIds = new Set([target.id]);
  for (const item of related) {
    if (includedIds.has(item.symbol.id)) continue;
    includedIds.add(item.symbol.id);
    add(
      item.symbol,
      item.reason,
      renderedSkeleton(index, item.symbol, item.relation),
      `${item.relation} of ${target.qualifiedName ?? target.name}.`,
    );
  }

  const unresolved = index.calls
    .filter((call) => call.callerId === target.id && !call.resolvedTargetId)
    .map((call) => ({ calleeName: call.calleeName, evidence: call.evidence }))
    .sort((a, b) => a.calleeName.localeCompare(b.calleeName));
  return {
    task,
    target,
    budget,
    estimatedTokens,
    rendered: included.map((item) => item.rendered).join("\n\n"),
    included,
    omitted,
    unresolved,
    confidence: unresolved.length ? "mixed" : "high",
    freshness: index.inspect(),
    composition,
  };
}
