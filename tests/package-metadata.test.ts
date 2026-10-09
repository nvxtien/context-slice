import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const tsx = join(root, "node_modules/.bin/tsx");
const cli = join(root, "src/cli.ts");

test("package metadata describes an intentional publish-ready runtime", () => {
  assert.equal(packageJson.name, "context-slice");
  assert.equal(packageJson.version, "1.9.4");
  assert.equal(packageJson.license, "MIT");
  assert.ok(packageJson.repository);
  assert.match(packageJson.engines.node, />=20/);
  assert.deepEqual(packageJson.files, [
    "dist/src",
    "queries",
    "skills",
    "hooks",
    "plugin.json",
    "mcp.json",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(packageJson.bin["context-slice"], "dist/src/cli.js");
  assert.ok(packageJson.scripts["package-smoke"]);
});

test("version and help work from the source entry point", () => {
  const version = spawnSync(tsx, [cli, "--version"], {
    cwd: root,
    encoding: "utf8",
  });
  const help = spawnSync(tsx, [cli, "--help"], { cwd: root, encoding: "utf8" });

  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageJson.version);
  assert.equal(help.status, 0, help.stderr);
  for (const command of ["init", "index", "status", "doctor", "preview", "mcp"])
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
});
