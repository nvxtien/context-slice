import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workspace = process.cwd();
const cli = join(workspace, "src/cli.ts");
const tsxLoader = join(workspace, "node_modules/tsx/dist/loader.mjs");

function javaRepository() {
  const root = mkdtempSync(join(tmpdir(), "context-slice-cli-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/Payment.java"),
    "package demo; public class Payment { public void retryPayment(String id) { audit(id); } private void audit(String id) {} }",
  );
  return root;
}

function run(args: string[], cwd = workspace) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("init finds the enclosing repository from a nested directory", () => {
  const root = javaRepository();
  const nested = join(root, "src/main/java");

  const result = run(["init"], nested);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Indexed 1 source file \(3 symbols\) across Java: 1\./,
  );
  assert.match(
    result.stdout,
    new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("status emits a stable JSON readiness result", () => {
  const root = javaRepository();
  assert.equal(run(["init", "--repo", root]).status, 0);

  const result = run(["status", "--repo", root, "--json"]);
  const body = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(body.ok, true);
  assert.equal(body.result.freshness.state, "CURRENT");
  assert.equal(body.result.repository, root);
});

test("doctor returns actionable configuration errors", () => {
  const result = run([
    "doctor",
    "--repo",
    join(tmpdir(), "missing-context-slice-repository"),
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /REPOSITORY_NOT_FOUND/);
  assert.match(result.stderr, /--repo/);
});

test("preview supports concise human and inspectable JSON output", () => {
  const root = javaRepository();
  assert.equal(run(["init", "--repo", root]).status, 0);

  const human = run(["preview", "explain retryPayment", "--repo", root]);
  const json = run([
    "preview",
    "explain retryPayment",
    "--repo",
    root,
    "--json",
    "--explain",
  ]);

  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Target: demo.Payment.retryPayment/);
  const body = JSON.parse(json.stdout);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(body.result.target.name, "retryPayment");
  assert.ok(body.result.included[0].explanation);
});

test("preview reports user errors with exit status 2", () => {
  const root = javaRepository();
  assert.equal(run(["init", "--repo", root]).status, 0);

  const result = run([
    "preview",
    "retryPayment",
    "--repo",
    root,
    "--budget",
    "1",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /BUDGET_TOO_SMALL/);
});
