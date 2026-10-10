import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

const workspace = process.cwd();
const cli = join(workspace, "src/cli.ts");
const tsxLoader = pathToFileURL(
  join(workspace, "node_modules/tsx/dist/loader.mjs"),
).href;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function rustRepository() {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-product-"));
  cpSync(join(workspace, "tests/fixtures/rust"), root, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], {
    cwd: root,
    env: { ...process.env, ...gitEnv },
  });
  return root;
}

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("Rust and Python sources coexist without id collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-mixed-"));
  const skip = (s: string) => !s.includes(".context-slice");
  cpSync(join(workspace, "tests/fixtures/rust"), join(root, "rs"), {
    recursive: true,
    filter: skip,
  });
  cpSync(join(workspace, "tests/fixtures/python"), join(root, "py"), {
    recursive: true,
    filter: skip,
  });
  const index = new ProjectIndex(root);
  index.rebuild();
  const ids = index.symbols.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(index.symbols.some((s) => s.filePath.endsWith(".rs")));
  assert.ok(index.symbols.some((s) => s.filePath.endsWith(".py")));
  index.close();
});

test("init, index, status succeed on a Rust repository", () => {
  const root = rustRepository();

  const init = run(["init"], root);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /across Rust: 5\./);

  const reindex = run(["index"], root);
  assert.equal(reindex.status, 0, reindex.stderr);

  const status = run(["status", "--json"], root);
  assert.equal(status.status, 0, status.stderr);
  const body = JSON.parse(status.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.result.freshness.state, "CURRENT");
  assert.deepEqual(body.result.freshness.languages, ["Rust"]);
});

test("preview returns Rust context and leaves git status clean apart from the cache", () => {
  const root = rustRepository();
  assert.equal(run(["init"], root).status, 0);

  const preview = run(
    ["preview", "explain create_order behavior", "--explain"],
    root,
  );

  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Target: functions::create_order/);
  assert.match(preview.stdout, /pub fn create_order/);

  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(status.stdout.trim(), "");
});

function startMcp(root: string) {
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, cli, "mcp", "--repo", root],
    {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const messages: Array<Record<string, unknown>> = [];
  const invalidStdout: string[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        invalidStdout.push(line);
      }
    }
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for MCP ${method}`)),
        5_000,
      );
      const poll = () => {
        const index = messages.findIndex((message) => message.id === id);
        if (index >= 0) {
          clearTimeout(timer);
          const message = messages.splice(index, 1)[0] as Record<string, any>;
          if (message.error) reject(new Error(message.error.message));
          else resolve(message);
          return;
        }
        setTimeout(poll, 10);
      };
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      poll();
    });
  return { child, request, invalidStdout };
}

async function stopMcp(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

test(
  "MCP search, symbol and callers each return a Rust symbol/edge",
  { timeout: 15_000 },
  async () => {
    const root = rustRepository();
    const mcp = startMcp(root);
    try {
      await mcp.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      mcp.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );

      const search = await mcp.request("tools/call", {
        name: "context.search",
        arguments: { query: "create_order" },
      });
      const searchBody = JSON.parse(search.result.content[0].text);
      assert.ok(
        searchBody.results.some(
          (r: any) => r.language === "rust" && r.filePath.endsWith(".rs"),
        ),
      );

      const symbol = await mcp.request("tools/call", {
        name: "context.symbol",
        arguments: { symbol: "functions::create_order", detail: "full" },
      });
      const symbolBody = JSON.parse(symbol.result.content[0].text);
      assert.equal(symbolBody.symbol.language, "rust");
      assert.match(symbolBody.rendered, /create_order/);

      const callers = await mcp.request("tools/call", {
        name: "context.callers",
        arguments: { symbol: "snapshot_calls::helper" },
      });
      const callersBody = JSON.parse(callers.result.content[0].text);
      assert.ok(callersBody.callers.length >= 1);
      assert.ok(
        callersBody.callers.every(
          (c: any) => c.filePath === "snapshot_calls.rs",
        ),
      );

      assert.equal(mcp.invalidStdout.length, 0, mcp.invalidStdout.join("\n"));
    } finally {
      await stopMcp(mcp.child);
    }
  },
);

test("a >40KB Rust file with a syntax error gets parseError without aborting sibling indexing", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-rust-big-"));
  cpSync(join(workspace, "tests/fixtures/rust"), root, { recursive: true });

  let big = "";
  for (let i = 0; i < 2000; i++)
    big += `pub fn f${i}(x: u32) -> u32 { x + ${i} }\n`;
  big += "pub fn broken(x: u32) -> u32 { x +\n"; // deliberately unclosed
  assert.ok(Buffer.byteLength(big) > 40_000);
  writeFileSync(join(root, "big.rs"), big);

  const index = new ProjectIndex(root);
  const summary = index.rebuild();

  assert.equal(summary.parseErrors, 1);
  assert.ok(index.symbols.some((s) => s.filePath === "functions.rs"));
  assert.ok(
    index.symbols.some((s) => s.filePath === "big.rs" && s.name === "f0"),
  );
  index.close();
});
