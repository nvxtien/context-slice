import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPackageSmoke } from "../scripts/package-smoke-test.js";

test("package smoke verifies tarball installation outside the source checkout", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "context-slice-v08-report-"));
  const report = await runPackageSmoke({ root: process.cwd(), outputDir });
  const saved = JSON.parse(readFileSync(join(outputDir, "v0.8-packaging-installation.json"), "utf8"));

  assert.equal(report.status, "pass");
  assert.ok(report.tarball.requiredFiles.every((file: string) => report.tarball.files.includes(file)));
  assert.deepEqual(report.tarball.forbiddenFound, []);
  assert.equal(report.install.isolatedPrefix, true);
  assert.equal(report.cli.version, report.package.version);
  assert.equal(report.pathWithSpaces.passed, true);
  assert.equal(report.nestedCwd.passed, true);
  assert.equal(report.cli.help, true);
  assert.equal(report.mcp.protocolSafe, true);
  assert.equal(report.upgrade.cachePreserved, true);
  assert.equal(report.uninstall.repositoryPreserved, true);
  assert.equal(report.trial.externalDevelopers, "deferred");
  assert.deepEqual(saved, report);
});
