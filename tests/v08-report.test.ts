import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("v0.8 report and release checklist expose packaging evidence honestly", () => {
  const jsonPath = join(
    root,
    "benchmarks/results/v0.8-packaging-installation.json",
  );
  const markdownPath = join(
    root,
    "benchmarks/results/v0.8-packaging-installation.md",
  );
  const frictionPath = join(root, "benchmarks/results/v0.8-friction-log.md");
  const checklistPath = join(root, "docs/release-readiness-v0.8.md");
  assert.ok(existsSync(jsonPath), "run benchmark:v08 before this assertion");
  assert.ok(existsSync(markdownPath));
  assert.ok(existsSync(frictionPath));
  assert.ok(existsSync(checklistPath));
  const report = JSON.parse(readFileSync(jsonPath, "utf8"));
  assert.equal(report.status, "pass");
  assert.equal(report.cleanCheckout.status, "deferred");
  assert.equal(report.trial.externalDevelopers, "deferred");
  assert.equal(report.install.npx, "publication-dependent");
  assert.equal(report.security.sourceCheckoutDependency, false);
  assert.match(readFileSync(markdownPath, "utf8"), /MCP packaged integration/);
  assert.match(readFileSync(frictionPath, "utf8"), /self-trial/);
  assert.match(readFileSync(checklistPath, "utf8"), /npm pack succeeds/);
  assert.match(
    readFileSync(checklistPath, "utf8"),
    /clean checkout.*deferred/i,
  );
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /npm install -g context-slice(?:@[^\s`]+)?/);
  assert.match(readme, /npm run benchmark:v08/);
});
