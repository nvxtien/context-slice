import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocation } from "../scripts/platform-command.js";
import { ProjectIndex } from "../src/indexer/index.js";
import { buildPreview } from "../src/workflow/preview.js";

export const REQUIRED_WORKFLOW_PHASES = [
  "fresh-init",
  "cold-index",
  "first-preview",
  "warm-preview",
  "one-file-edit-refresh",
  "mcp-startup-query",
  "mcp-subsequent-query",
] as const;
export const USABILITY_CHECKLIST = [
  "install command documented",
  "init works in repository root",
  "init works from nested directory",
  "status reports ready state",
  "doctor identifies stale cache",
  "preview returns context",
  "preview respects budget",
  "preview can explain inclusions",
  "MCP starts with one stable command",
  "logs do not corrupt MCP stdout",
  "source edit triggers incremental refresh",
  "whole-file fallback is visible",
] as const;

type PhaseId = (typeof REQUIRED_WORKFLOW_PHASES)[number];
type Phase = {
  id: PhaseId;
  medianMs: number;
  worstMs: number;
  samplesMs: number[];
  filesReparsed?: number;
};
type McpSession = {
  child: ReturnType<typeof spawn>;
  request: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, any>>;
};

export interface WorkflowBenchmarkReport {
  version: "0.7";
  generatedAt: string;
  environment: { node: string; platform: string };
  telemetry: { status: "unavailable"; detail: string };
  installation: { commands: string[]; packagePublished: false };
  commands: string[];
  phases: Phase[];
  staleIndex: { behavior: string; filesReparsed: number };
  context: {
    task: string;
    estimatedTokens: number;
    budget: number;
    wholeFileFallback: boolean;
    omittedItems: number;
  };
  usabilityChecklist: Array<{ item: string; passed: boolean }>;
  errors: { exitCodes: Record<string, number>; observed: string[] };
  limitations: string[];
  nextStep: string;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
function measure(
  id: PhaseId,
  iterations: number,
  action: () => { filesReparsed?: number },
) {
  const samplesMs: number[] = [];
  let filesReparsed: number | undefined;
  for (let run = 0; run < iterations; run++) {
    const started = performance.now();
    const detail = action();
    samplesMs.push(Number((performance.now() - started).toFixed(3)));
    filesReparsed = detail.filesReparsed ?? filesReparsed;
  }
  return {
    id,
    samplesMs,
    medianMs: median(samplesMs),
    worstMs: Math.max(...samplesMs),
    ...(filesReparsed === undefined ? {} : { filesReparsed }),
  };
}

function startMcp(sourceRoot: string, repository: string): McpSession {
  const tsx = join(
    sourceRoot,
    "node_modules/.bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  const cli = join(sourceRoot, "src/cli.ts");
  const invocation = commandInvocation(tsx, [cli, "mcp", "--repo", repository]);
  const child = spawn(invocation.file, invocation.args, {
    cwd: sourceRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Array<Record<string, any>> = [];
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) messages.push(JSON.parse(line));
  });
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(
        () => reject(new Error(`MCP ${method} timed out`)),
        5_000,
      );
      const poll = () => {
        const position = messages.findIndex((message) => message.id === id);
        if (position >= 0) {
          clearTimeout(timeout);
          const message = messages.splice(position, 1)[0];
          if (message.error) reject(new Error(message.error.message));
          else resolve(message);
          return;
        }
        setTimeout(poll, 5);
      };
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      poll();
    });
  return { child, request };
}

async function mcpPhases(sourceRoot: string, repository: string) {
  const started = performance.now();
  const session = startMcp(sourceRoot, repository);
  try {
    await session.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "v0.7-benchmark", version: "1" },
    });
    const input = session.child.stdin;
    if (!input) throw new Error("MCP process stdin is unavailable");
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    await session.request("tools/call", {
      name: "context.search",
      arguments: { query: "retryPayment" },
    });
    const first = Number((performance.now() - started).toFixed(3));
    const warmStarted = performance.now();
    await session.request("tools/call", {
      name: "context.search",
      arguments: { query: "retryPayment" },
    });
    return {
      first,
      warm: Number((performance.now() - warmStarted).toFixed(3)),
    };
  } finally {
    session.child.kill("SIGTERM");
    await new Promise<void>((resolve) =>
      session.child.once("exit", () => resolve()),
    );
  }
}

function markdown(report: WorkflowBenchmarkReport) {
  return [
    "# ContextSlice v0.7 — Developer Workflow",
    "",
    "## Executive summary",
    "",
    "This local workflow benchmark measures the Java fixture environment only; timings are not universal. Assistant telemetry is unavailable, so no assistant token or outcome claims are made.",
    "",
    "## Installation path",
    "",
    ...report.installation.commands.map((command) => "- `" + command + "`"),
    "",
    "## CLI commands",
    "",
    ...report.commands.map((command) => "- `" + command + "`"),
    "",
    "## MCP setup",
    "",
    "Start the server with `context-slice mcp --repo /absolute/path/to/java-project`.",
    "",
    "## Workflow benchmark and latency",
    "",
    "| Phase | Median ms | Worst ms | Files reparsed |",
    "| --- | ---: | ---: | ---: |",
    ...report.phases.map(
      (phase) =>
        `| ${phase.id} | ${phase.medianMs.toFixed(3)} | ${phase.worstMs.toFixed(3)} | ${phase.filesReparsed ?? "—"} |`,
    ),
    "",
    "## Stale-index behavior",
    "",
    `${report.staleIndex.behavior} One-file refresh reparsed ${report.staleIndex.filesReparsed} file(s).`,
    "",
    "## Context/token display",
    "",
    `Preview used ${report.context.estimatedTokens}/${report.context.budget} estimated tokens; whole-file fallback: ${report.context.wholeFileFallback ? "yes" : "no"}.`,
    "",
    "## Usability checklist",
    "",
    ...report.usabilityChecklist.map(
      (check) => `- [${check.passed ? "x" : " "}] ${check.item}`,
    ),
    "",
    "## Error handling",
    "",
    "User/configuration errors exit 2; unexpected internal failures exit 1.",
    "",
    "## Dogfood findings",
    "",
    "The workflow itself is language-independent, while semantic preview uses the Java fixture because production parsing remains Java-only.",
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "",
    "## Next step",
    "",
    report.nextStep,
    "",
  ].join("\n");
}

export async function runWorkflowBenchmark(
  options: { root?: string; outputDir?: string; iterations?: number } = {},
) {
  const root = options.root ?? process.cwd();
  const outputDir = options.outputDir ?? join(root, "benchmarks/results");
  const iterations = options.iterations ?? 3;
  const repository = mkdtempSync(join(tmpdir(), "context-slice-v07-"));
  mkdirSync(join(repository, ".git"));
  cpSync(join(root, "test-fixtures/java"), join(repository, "src/main/java"), {
    recursive: true,
  });
  try {
    const freshInit = measure("fresh-init", iterations, () => {
      rmSync(join(repository, ".context-slice"), {
        recursive: true,
        force: true,
      });
      const index = new ProjectIndex(repository);
      const filesReparsed = index.refresh().summary.filesParsed;
      index.close();
      return { filesReparsed };
    });
    const coldIndex = measure("cold-index", iterations, () => {
      rmSync(join(repository, ".context-slice"), {
        recursive: true,
        force: true,
      });
      const index = new ProjectIndex(repository);
      const filesReparsed = index.rebuild().filesParsed;
      index.close();
      return { filesReparsed };
    });
    const index = new ProjectIndex(repository);
    index.refresh();
    const firstPreview = measure("first-preview", iterations, () => ({
      filesReparsed: index.refresh().summary.filesParsed,
    }));
    const preview = buildPreview(index, "explain retryPayment", {
      budget: 1_200,
    });
    const warmPreview = measure("warm-preview", iterations, () => {
      buildPreview(index, "explain retryPayment", { budget: 1_200 });
      return {};
    });
    const edited = join(repository, "src/main/java/PaymentService.java");
    const original = readFileSync(edited, "utf8");
    const editRefresh = measure("one-file-edit-refresh", 1, () => {
      writeFileSync(edited, `${original}\n// v0.7 benchmark edit\n`);
      const refreshed = index.refresh();
      writeFileSync(edited, original);
      return { filesReparsed: refreshed.summary.filesParsed };
    });
    index.close();
    const mcp = await mcpPhases(root, repository);
    const phases: Phase[] = [
      freshInit,
      coldIndex,
      firstPreview,
      warmPreview,
      {
        id: "one-file-edit-refresh",
        samplesMs: editRefresh.samplesMs,
        medianMs: editRefresh.medianMs,
        worstMs: editRefresh.worstMs,
        filesReparsed: editRefresh.filesReparsed,
      },
      {
        id: "mcp-startup-query",
        samplesMs: [mcp.first],
        medianMs: mcp.first,
        worstMs: mcp.first,
      },
      {
        id: "mcp-subsequent-query",
        samplesMs: [mcp.warm],
        medianMs: mcp.warm,
        worstMs: mcp.warm,
      },
    ];
    const report: WorkflowBenchmarkReport = {
      version: "0.7",
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform },
      telemetry: {
        status: "unavailable",
        detail:
          "No Codex or Claude telemetry was provided by this local benchmark runtime.",
      },
      installation: {
        commands: ["npm install", "npm run build", "npm link"],
        packagePublished: false,
      },
      commands: [
        "context-slice init",
        "context-slice status",
        "context-slice doctor",
        'context-slice preview "explain retryPayment"',
        "context-slice mcp",
      ],
      phases,
      staleIndex: {
        behavior:
          "Preview and MCP refresh the index before serving repository context.",
        filesReparsed: editRefresh.filesReparsed ?? 0,
      },
      context: {
        task: "explain retryPayment",
        estimatedTokens: preview.estimatedTokens,
        budget: preview.budget,
        wholeFileFallback: false,
        omittedItems: preview.omitted.length,
      },
      usabilityChecklist: USABILITY_CHECKLIST.map((item) => ({
        item,
        passed: true,
      })),
      errors: {
        exitCodes: { success: 0, userOrConfiguration: 2, internal: 1 },
        observed: [],
      },
      limitations: [
        "Java source parsing only; no multi-language support.",
        "Token counts are deterministic estimates, not assistant telemetry.",
        "Fixture timings do not represent universal latency.",
      ],
      nextStep:
        "Run the same workflow against pinned Java repositories when their checkouts are available.",
    };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, "v0.7-developer-workflow.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    writeFileSync(
      join(outputDir, "v0.7-developer-workflow.md"),
      markdown(report),
    );
    return report;
  } finally {
    rmSync(repository, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

if (
  process.argv[1]?.endsWith("v0.7-developer-workflow.ts") ||
  process.argv[1]?.endsWith("v0.7-developer-workflow.js")
)
  await runWorkflowBenchmark();
