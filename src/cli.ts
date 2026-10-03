#!/usr/bin/env node
import { ProjectIndex } from "./indexer/index.js";
import { packageInfo } from "./package-info.js";
import { buildPreview } from "./workflow/preview.js";
import { WorkflowError } from "./workflow/errors.js";
import { resolveRepositoryRoot } from "./workflow/repository.js";

interface Arguments {
  command?: string;
  positional: string[];
  repository?: string;
  budget?: number;
  json: boolean;
  explain: boolean;
  verbose: boolean;
  version: boolean;
}

function usage() {
  return [
    "Usage: context-slice <init|index|status|doctor|preview|mcp> [options]",
    "",
    "Options:",
    "  --repo <path>     Repository root (defaults to nearest Git root)",
    "  --budget <tokens> Strict token budget for preview",
    "  --json            Emit stable JSON output",
    "  --explain         Include inclusion and omission explanations",
    "  --verbose         Include additional operational detail",
    "",
    "Commands:",
    "  init              Create or refresh the repository index",
    "  index             Refresh the repository index",
    "  status            Show cache freshness and readiness",
    "  doctor            Diagnose repository and cache setup",
    "  preview <task>    Build a strict-budget context preview",
    "  mcp               Start the stdio MCP server",
  ].join("\n");
}

function parse(argv: string[]): Arguments {
  const result: Arguments = {
    positional: [],
    json: false,
    explain: false,
    verbose: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!result.command && !value.startsWith("-")) {
      result.command = value;
      continue;
    }
    if (value === "--repo") {
      result.repository = argv[++index];
      continue;
    }
    if (value === "--budget") {
      const raw = argv[++index];
      const budget = Number(raw);
      if (!Number.isInteger(budget) || budget <= 0)
        throw new WorkflowError(
          "INVALID_ARGUMENT",
          `Invalid --budget value: ${raw ?? "missing"}`,
          "Pass a positive integer token budget.",
        );
      result.budget = budget;
      continue;
    }
    if (value === "--json") {
      result.json = true;
      continue;
    }
    if (value === "--explain") {
      result.explain = true;
      continue;
    }
    if (value === "--verbose") {
      result.verbose = true;
      continue;
    }
    if (value === "--version") {
      result.version = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      result.command = "help";
      continue;
    }
    if (value.startsWith("-"))
      throw new WorkflowError(
        "INVALID_ARGUMENT",
        `Unknown option: ${value}`,
        "Run context-slice --help to see supported options.",
      );
    result.positional.push(value);
  }
  return result;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}
function print(
  value: unknown,
  args: Arguments,
  command: string,
  human: string,
) {
  process.stdout.write(
    args.json
      ? `${JSON.stringify({ ok: true, command, result: value }, null, 2)}\n`
      : `${human}\n`,
  );
}

function renderPreview(
  preview: ReturnType<typeof buildPreview>,
  explain: boolean,
) {
  const lines = [
    `Target: ${preview.target.qualifiedName ?? preview.target.name}`,
  ];
  if (preview.baseline.wholeFileTokens > 0)
    lines.push(
      `Saved ${Math.round(preview.baseline.reduction * 100)}% context ` +
        `(${preview.estimatedTokens} vs ${preview.baseline.wholeFileTokens} tokens, ` +
        `${plural(preview.baseline.files, "file")} read in full instead of sliced)`,
    );
  lines.push(
    `Context: ${preview.estimatedTokens}/${preview.budget} tokens; ${plural(preview.included.length, "item")} included`,
  );
  if (explain) {
    lines.push(
      "",
      "Included:",
      ...preview.included.map(
        (item) => `- ${item.reason}: ${item.symbol} — ${item.explanation}`,
      ),
    );
    if (preview.omitted.length)
      lines.push(
        "Omitted:",
        ...preview.omitted.map((item) => `- ${item.symbol}: ${item.reason}`),
      );
    if (preview.unresolved.length)
      lines.push(
        "Unresolved calls:",
        ...preview.unresolved.map((call) => `- ${call.calleeName}`),
      );
  }
  return `${lines.join("\n")}\n\n${preview.rendered}`;
}

async function execute(args: Arguments) {
  const command = args.command;
  if (args.version)
    return print(packageInfo.version, args, "version", packageInfo.version);
  if (!command || command === "help")
    return print({ usage: usage() }, args, "help", usage());
  if (
    !["init", "index", "status", "doctor", "preview", "mcp"].includes(command)
  )
    throw new WorkflowError(
      "INVALID_ARGUMENT",
      `Unknown command: ${command}`,
      usage(),
    );

  const repository = resolveRepositoryRoot({
    cwd: process.cwd(),
    repository: args.repository,
  });
  if (command === "mcp") {
    const { startMcpServer } = await import("./server/mcp-server.js");
    await startMcpServer(repository);
    return;
  }

  const index = new ProjectIndex(repository);
  if (command === "init" || command === "index") {
    const refreshed = index.refresh();
    const body = { repository, ...refreshed };
    const human = [
      `Repository: ${repository}`,
      `Indexed ${plural(refreshed.summary.files, "source file")} (${plural(refreshed.summary.symbols, "symbol")}) across ${Object.entries(
        refreshed.summary.filesByLanguage,
      )
        .map(([language, count]) => `${language}: ${count}`)
        .join(", ")}.`,
      'Next: context-slice preview "explain <symbol>"',
    ].join("\n");
    return print(body, args, command, human);
  }
  if (command === "status") {
    const freshness = index.inspect();
    const body = {
      repository,
      ready: freshness.state === "CURRENT",
      freshness,
    };
    const human = [
      `Repository: ${repository}`,
      `Index: ${freshness.state}`,
      `Source files: ${freshness.indexedFiles}/${freshness.sourceFiles}`,
      ...Object.entries(freshness.filesByExtension)
        .sort()
        .map(([extension, count]) => `  ${extension}: ${count}`),
      `Schema: ${freshness.schemaVersion}`,
      `Last refresh: ${freshness.lastRefreshedAt ?? "never"}`,
    ].join("\n");
    return print(body, args, command, human);
  }
  if (command === "doctor") {
    const freshness = index.inspect();
    const checks = [
      { name: "repository", status: "ok", detail: repository },
      {
        name: "source",
        status: "ok",
        detail: `${plural(freshness.sourceFiles, "file")} found`,
      },
      {
        name: "index",
        status: freshness.state === "CURRENT" ? "ok" : "action",
        detail:
          freshness.state === "CURRENT" ? "ready" : "Run context-slice index",
      },
      {
        name: "mcp",
        status: "ok",
        detail: "Configure command: context-slice mcp",
      },
    ];
    const body = { repository, freshness, checks };
    const human = checks
      .map(
        (check) =>
          `${check.status === "ok" ? "OK" : "ACTION"} ${check.name}: ${check.detail}`,
      )
      .join("\n");
    return print(body, args, command, human);
  }

  const refreshed = index.refresh();
  const preview = buildPreview(index, args.positional.join(" "), {
    budget: args.budget,
  });
  const body = { repository, refresh: refreshed.freshness, ...preview };
  return print(body, args, command, renderPreview(preview, args.explain));
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await execute(parse(argv));
  } catch (error) {
    if (error instanceof WorkflowError) {
      process.stderr.write(
        `${error.code}: ${error.message}\n${error.remediation}\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `INTERNAL_ERROR: ${error instanceof Error ? error.message : String(error)}\nRun context-slice doctor for repository readiness.\n`,
    );
    process.exitCode = 1;
  }
}

await main();
