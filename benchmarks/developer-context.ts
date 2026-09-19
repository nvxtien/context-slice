import { estimateTokens } from "../src/planner/budget.js";

export const CONTEXT_WINDOW_THRESHOLDS = {
  "8K": 8_192,
  "16K": 16_384,
  "32K": 32_768,
  "64K": 65_536,
  "128K": 131_072,
} as const;

export type ContextCategory =
  | "target-source"
  | "caller-context"
  | "callee-context"
  | "annotations"
  | "types"
  | "tests"
  | "diff"
  | "metadata";

export interface ContextEntry {
  category: ContextCategory;
  text: string;
  filePath?: string;
  symbolId?: string;
  wholeFile?: boolean;
}

export interface ManualBaseline {
  taskId: string;
  files: string[];
  reasoning: Record<string, string>;
}

export interface ContextMetricsInput {
  manualTokens: number;
  contextSliceTokens: number;
  requiredFactsTotal: number;
  requiredFactsPreserved: number;
  requiredFactTokens: number;
  manualWholeFiles: number;
  contextSliceWholeFiles: number;
  fallbackFiles: number;
  contextBudget: number;
}

export interface ContextMetrics {
  contextWindowReduction: number;
  inputTokenReduction: number;
  wholeFileAvoidanceRate: number;
  developerContextEfficiency: number;
  contextWasteRatio: number;
  contextBudgetPressure: number;
  requiredFactRecall: number;
}

const ratio = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : 0;

export function calculateContextMetrics(
  input: ContextMetricsInput,
): ContextMetrics {
  const reduction =
    input.manualTokens > 0
      ? 1 - input.contextSliceTokens / input.manualTokens
      : 0;
  return {
    contextWindowReduction: reduction,
    inputTokenReduction: reduction,
    wholeFileAvoidanceRate: ratio(
      Math.max(input.manualWholeFiles - input.contextSliceWholeFiles, 0),
      input.manualWholeFiles,
    ),
    developerContextEfficiency: ratio(
      input.requiredFactsPreserved,
      input.contextSliceTokens,
    ),
    contextWasteRatio: ratio(
      Math.max(input.contextSliceTokens - input.requiredFactTokens, 0),
      input.contextSliceTokens,
    ),
    contextBudgetPressure: ratio(input.contextSliceTokens, input.contextBudget),
    requiredFactRecall: ratio(
      input.requiredFactsPreserved,
      input.requiredFactsTotal,
    ),
  };
}

export function contextComposition(entries: ContextEntry[]) {
  const result: Record<ContextCategory | "total", number> = {
    "target-source": 0,
    "caller-context": 0,
    "callee-context": 0,
    annotations: 0,
    types: 0,
    tests: 0,
    diff: 0,
    metadata: 0,
    total: 0,
  };
  for (const entry of entries) {
    const tokens = estimateTokens(entry.text);
    result[entry.category] += tokens;
    result.total += tokens;
  }
  return result;
}

export function validateManualBaselines(
  baselines: ManualBaseline[],
  taskIds: string[],
) {
  const seen = new Set<string>();
  for (const baseline of baselines) {
    if (seen.has(baseline.taskId))
      throw new Error(`duplicate manual baseline: ${baseline.taskId}`);
    seen.add(baseline.taskId);
    if (!baseline.files.length)
      throw new Error(`manual baseline has no files: ${baseline.taskId}`);
    for (const file of baseline.files) {
      if (!baseline.reasoning[file]?.trim())
        throw new Error(
          `manual baseline reasoning missing for ${baseline.taskId}: ${file}`,
        );
    }
  }
  for (const taskId of taskIds)
    if (!seen.has(taskId))
      throw new Error(`missing manual baseline: ${taskId}`);
  return true;
}

export function fitsContextWindows(tokens: number) {
  return Object.fromEntries(
    Object.entries(CONTEXT_WINDOW_THRESHOLDS).map(([label, threshold]) => [
      label,
      tokens <= threshold,
    ]),
  ) as Record<keyof typeof CONTEXT_WINDOW_THRESHOLDS, boolean>;
}

export function duplicateContextTokens(texts: string[]) {
  const seen = new Set<string>();
  let duplicateTokens = 0;
  for (const text of texts) {
    if (seen.has(text)) duplicateTokens += estimateTokens(text);
    else seen.add(text);
  }
  return duplicateTokens;
}

export function duplicateContextTokensByKey(
  items: Array<{ key: string; tokens: number }>,
) {
  const seen = new Set<string>();
  let duplicateTokens = 0;
  for (const item of items) {
    if (seen.has(item.key)) duplicateTokens += item.tokens;
    else seen.add(item.key);
  }
  return duplicateTokens;
}
