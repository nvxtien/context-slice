import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workspace = process.cwd();
const tsx = join(workspace, "node_modules/.bin/tsx");
const cli = join(workspace, "src/cli.ts");

function javaRepository() {
  const root = mkdtempSync(join(tmpdir(), "context-slice-mcp-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/java/Payment.java"),
    "package demo; public class Payment { public void retryPayment(String id) {} public void retryPayment(String id, boolean force) {} }",
  );
  return root;
}

function startMcp(root: string) {
  const child = spawn(tsx, [cli, "mcp", "--repo", root], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  return { child, request, invalidStdout, messages };
}

test(
  "mcp is protocol-safe and refreshes before each request",
  { timeout: 15_000 },
  async () => {
    const root = javaRepository();
    const mcp = startMcp(root);
    try {
      const initialized = await mcp.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      assert.equal(initialized.jsonrpc, "2.0");
      mcp.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );

      const first = await mcp.request("tools/call", {
        name: "context.search",
        arguments: { query: "retryPayment" },
      });
      const firstBody = JSON.parse(first.result.content[0].text);
      assert.equal(firstBody.refresh.freshness.state, "CURRENT");
      assert.equal(
        mcp.invalidStdout.length,
        0,
        `non-protocol stdout: ${mcp.invalidStdout.join("\n")}`,
      );

      const ambiguous = await mcp.request("tools/call", {
        name: "context.slice",
        arguments: { symbol: "Payment.retryPayment" },
      });
      assert.equal(ambiguous.result.isError, true);
      assert.match(ambiguous.result.content[0].text, /Ambiguous symbol/);

      writeFileSync(
        join(root, "src/main/java/Payment.java"),
        "package demo; public class Payment { public void retryPayment(String id) {} public void settle(String id) {} }",
      );
      const second = await mcp.request("tools/call", {
        name: "context.search",
        arguments: { query: "settle" },
      });
      const secondBody = JSON.parse(second.result.content[0].text);
      assert.equal(secondBody.refresh.summary.filesParsed, 1);
      assert.equal(secondBody.results[0].name, "settle");
    } finally {
      mcp.child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        mcp.child.once("exit", () => resolve()),
      );
    }
  },
);
