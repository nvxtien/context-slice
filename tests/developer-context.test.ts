import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateContextMetrics,
  contextComposition,
  duplicateContextTokens,
  duplicateContextTokensByKey,
  fitsContextWindows,
  validateManualBaselines,
  type ManualBaseline,
} from "../benchmarks/developer-context.js";

const baseline: ManualBaseline = {
  taskId: "task-1",
  files: ["src/A.java", "src/A_test.java"],
  reasoning: {
    "src/A.java": "contains the target flow",
    "src/A_test.java": "contains validation coverage",
  },
};

test("calculates developer context metrics from the same token units", () => {
  const metrics = calculateContextMetrics({
    manualTokens: 100,
    contextSliceTokens: 40,
    requiredFactsTotal: 4,
    requiredFactsPreserved: 4,
    requiredFactTokens: 20,
    manualWholeFiles: 2,
    contextSliceWholeFiles: 0,
    fallbackFiles: 0,
    contextBudget: 80,
  });

  assert.equal(metrics.contextWindowReduction, 0.6);
  assert.equal(metrics.inputTokenReduction, 0.6);
  assert.equal(metrics.wholeFileAvoidanceRate, 1);
  assert.equal(metrics.developerContextEfficiency, 0.1);
  assert.equal(metrics.contextWasteRatio, 0.5);
  assert.equal(metrics.contextBudgetPressure, 0.5);
  assert.equal(metrics.requiredFactRecall, 1);
});

test("reports context composition by category and total tokens", () => {
  const composition = contextComposition([
    { category: "target-source", text: "1234567890" },
    { category: "caller-context", text: "1234" },
    { category: "callee-context", text: "123456" },
    { category: "metadata", text: "12" },
  ]);

  assert.deepEqual(composition, {
    "target-source": 3,
    "caller-context": 1,
    "callee-context": 2,
    annotations: 0,
    types: 0,
    tests: 0,
    diff: 0,
    metadata: 1,
    total: 7,
  });
});

test("validates that every benchmark task has one auditable manual baseline", () => {
  assert.doesNotThrow(() => validateManualBaselines([baseline], ["task-1"]));
  assert.throws(() => validateManualBaselines([], ["task-1"]), /missing manual baseline/);
  assert.throws(() => validateManualBaselines([baseline, baseline], ["task-1"]), /duplicate manual baseline/);
  assert.throws(() => validateManualBaselines([{ ...baseline, reasoning: {} }], ["task-1"]), /reasoning/);
});

test("reports context-window fit and pressure without model-specific claims", () => {
  assert.deepEqual(fitsContextWindows(8_192), { "8K": true, "16K": true, "32K": true, "64K": true, "128K": true });
  assert.deepEqual(fitsContextWindows(16_385), { "8K": false, "16K": false, "32K": true, "64K": true, "128K": true });
});

test("counts duplicate context only after the first occurrence", () => {
  assert.equal(duplicateContextTokens(["1234567890", "1234567890", "1234"]), 3);
  assert.equal(duplicateContextTokensByKey([{ key: "A.java", tokens: 10 }, { key: "B.java", tokens: 5 }, { key: "A.java", tokens: 10 }]), 10);
});
