import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProjectIndex } from "../indexer/index.js";
import { ProjectFileWatcher } from "../storage/file-watcher.js";
import { packageInfo } from "../package-info.js";
import { estimateTokens } from "../planner/budget.js";
import { renderSignature, renderSkeleton } from "../render/compact-context.js";
import { buildPreview } from "../workflow/preview.js";
import { resolveRepositoryRoot } from "../workflow/repository.js";

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

function assertRevision(value: string): string {
  if (value.startsWith("-")) throw new Error(`Invalid git revision: ${value}`);
  return value;
}

export function gitDiffArgs(base?: string, head?: string) {
  const revisions =
    base || head
      ? [
          assertRevision(base ?? "HEAD"),
          ...(head ? [assertRevision(head)] : []),
        ]
      : ["HEAD"];
  return [...revisions, "--"];
}

export async function startMcpServer(
  root = process.env.CONTEXT_SLICE_ROOT ?? process.cwd(),
) {
  const resolvedRoot = resolveRepositoryRoot({ repository: root });
  const index = new ProjectIndex(resolvedRoot);
  new ProjectFileWatcher(resolvedRoot);
  const server = new McpServer({
    name: packageInfo.name,
    version: packageInfo.version,
  });
  const refresh = () => index.refreshIfStale();
  let warmup: Promise<void> = Promise.resolve();
  let warmupResult: ReturnType<typeof refresh> | undefined;
  let warmupError: unknown;
  const ready = async () => {
    await warmup;
    if (warmupError) throw warmupError;
    return warmupResult ?? refresh();
  };
  const one = (symbol: string) => {
    const candidates = index.resolveSymbol(symbol);
    if (!candidates.length) throw new Error(`Symbol not found: ${symbol}`);
    if (candidates.length > 1)
      throw new Error(
        `Ambiguous symbol: ${symbol}. Candidates: ${candidates.map((candidate) => candidate.id).join(", ")}`,
      );
    return candidates[0];
  };

  server.tool(
    "context.search",
    "Find relevant Java symbols without reading every source file.",
    {
      query: z.string(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async ({ query, limit }) => {
      const refreshed = await ready();
      return result({
        refresh: refreshed,
        results: index.search(query, limit ?? 10),
      });
    },
  );
  server.tool(
    "context.symbol",
    "Read a Java symbol as a signature, skeleton, body, or full source.",
    {
      symbol: z.string(),
      detail: z.enum(["signature", "skeleton", "body", "full"]).optional(),
    },
    async ({ symbol, detail }) => {
      const refreshed = await ready();
      const target = one(symbol);
      const level = detail ?? "skeleton";
      const calls = index
        .callsFor(target)
        .map(
          (call) =>
            `${call.receiverText ? `${call.receiverText}.` : ""}${call.calleeName} [${call.confidence}]`,
        );
      let rendered = renderSignature(target);
      if (level === "skeleton") rendered = renderSkeleton(target, calls);
      if (level === "body") rendered = target.body ?? target.source;
      if (level === "full") rendered = target.source;
      return result({
        refresh: refreshed,
        symbol: target,
        detail: level,
        rendered,
      });
    },
  );
  server.tool(
    "context.callers",
    "Find callers with bounded traversal depth.",
    {
      symbol: z.string(),
      depth: z.number().int().min(1).max(5).optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async ({ symbol, depth, limit }) => {
      const refreshed = await ready();
      const target = one(symbol);
      const actualDepth = depth ?? 1;
      return result({
        refresh: refreshed,
        target: renderSignature(target),
        depth: actualDepth,
        callers: index
          .callersAtDepth(target, actualDepth)
          .slice(0, limit ?? 10)
          .map((caller) => ({
            id: caller.id,
            signature: caller.signature,
            filePath: caller.filePath,
          })),
      });
    },
  );
  server.tool(
    "context.preview",
    "Compose an explainable, budget-bounded developer context preview.",
    {
      task: z.string(),
      budget: z.number().int().positive().optional(),
      depth: z.number().int().min(1).max(5).optional(),
    },
    async ({ task, budget, depth }) => {
      const refreshed = await ready();
      return result({
        refresh: refreshed,
        ...buildPreview(index, task, { budget, depth }),
      });
    },
  );
  server.tool(
    "context.slice",
    "Compose a strict-budget context slice for a symbol.",
    {
      symbol: z.string(),
      intent: z.string().optional(),
      budget: z.number().int().positive().optional(),
      depth: z.number().int().min(1).max(5).optional(),
    },
    async ({ symbol, intent, budget, depth }) => {
      const refreshed = await ready();
      const target = one(symbol);
      return result({
        refresh: refreshed,
        ...buildPreview(index, target.id, { budget, depth, intent }),
        intent,
      });
    },
  );
  server.tool(
    "context.diff",
    "Show a Git diff with a strict token budget.",
    {
      base: z.string().optional(),
      head: z.string().optional(),
      budget: z.number().int().positive().optional(),
    },
    async ({ base, head, budget }) => {
      const refreshed = await ready();
      const args = gitDiffArgs(base, head);
      let diff = "";
      try {
        diff = execFileSync("git", ["diff", ...args], {
          cwd: resolvedRoot,
          encoding: "utf8",
          maxBuffer: 2_000_000,
        });
      } catch (error) {
        throw new Error(
          `Git unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const max = budget ?? estimateTokens(diff);
      const truncated = estimateTokens(diff) > max;
      if (truncated) diff = diff.slice(0, Math.max(1, max * 4));
      return result({
        refresh: refreshed,
        base: base ?? "HEAD",
        head: head ?? "working tree",
        budget: max,
        truncated,
        changedFiles: [
          ...diff.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm),
        ].map((match) => match[2]),
        estimatedTokens: estimateTokens(diff),
        diff,
      });
    },
  );

  const connected = server.connect(new StdioServerTransport());
  warmup = connected.then(() => {
    try {
      warmupResult = refresh();
    } catch (error) {
      warmupError = error;
    }
  });
  await connected;
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await startMcpServer();
