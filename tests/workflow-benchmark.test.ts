import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REQUIRED_WORKFLOW_PHASES, USABILITY_CHECKLIST, runWorkflowBenchmark } from "../benchmarks/v0.7-developer-workflow.js";

test("v0.7 runner reports every developer workflow phase without telemetry claims", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "context-slice-v07-report-"));
  const report = await runWorkflowBenchmark({ root: process.cwd(), outputDir, iterations: 1 });
  const json = JSON.parse(readFileSync(join(outputDir, "v0.7-developer-workflow.json"), "utf8"));
  const markdown = readFileSync(join(outputDir, "v0.7-developer-workflow.md"), "utf8");

  assert.deepEqual(report.phases.map((phase) => phase.id), REQUIRED_WORKFLOW_PHASES);
  assert.deepEqual(json.phases.map((phase: { id: string }) => phase.id), REQUIRED_WORKFLOW_PHASES);
  assert.equal(json.telemetry.status, "unavailable");
  assert.equal(json.context.wholeFileFallback, false);
  assert.ok(json.usabilityChecklist.length >= USABILITY_CHECKLIST.length);
  assert.match(markdown, /Usability checklist/);
  assert.match(markdown, /telemetry.*unavailable/i);
});
