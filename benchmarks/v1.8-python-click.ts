// Hand-curated oracle for pallets/click (pinned commit, see benchmarks/python-repositories.json).
// Every entry below was read directly from the real checkout under
// benchmarks/checkouts/click/src/click/{core,decorators,exceptions,globals}.py during this
// benchmark's own writing, mirroring the style of benchmarks/v1.7-javascript-support.ts. Call-site
// `line` values are the statement doing the call (e.g. `raise Abort()`), NOT the enclosing `def`
// line, since the resolver keys call edges strictly on range.startLine.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import type { SymbolKind, ResolutionKind, CallConfidence } from "../src/types/model.js";

type Repository = {
  id: string;
  scale: string;
  url: string;
  commit: string;
  source: string;
  scope: string;
  kind: string;
};

type OracleSymbol = {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
};

// 32 symbols: the ClickException -> UsageError -> BadParameter -> MissingParameter chain and the
// Command -> Group -> CommandCollection chain (multi-level inheritance), the ParameterSource
// enum.IntEnum, constructors, plain methods, @property getters, a @contextmanager method
// (Context.scope) and module-level function (augment_usage_errors), and module-level functions.
const symbols: OracleSymbol[] = [
  { name: "ClickException", kind: "class", file: "src/click/exceptions.py", line: 35 },
  { name: "UsageError", kind: "class", file: "src/click/exceptions.py", line: 68 },
  { name: "BadParameter", kind: "class", file: "src/click/exceptions.py", line: 114 },
  { name: "MissingParameter", kind: "class", file: "src/click/exceptions.py", line: 159 },
  { name: "NoSuchCommand", kind: "class", file: "src/click/exceptions.py", line: 268 },
  { name: "BadArgumentUsage", kind: "class", file: "src/click/exceptions.py", line: 323 },
  { name: "FileError", kind: "class", file: "src/click/exceptions.py", line: 342 },
  { name: "Abort", kind: "class", file: "src/click/exceptions.py", line: 362 },
  { name: "Exit", kind: "class", file: "src/click/exceptions.py", line: 366 },
  { name: "ParameterSource", kind: "class", file: "src/click/core.py", line: 199 },
  { name: "Context", kind: "class", file: "src/click/core.py", line: 238 },
  { name: "Command", kind: "class", file: "src/click/core.py", line: 989 },
  { name: "Group", kind: "class", file: "src/click/core.py", line: 1703 },
  { name: "CommandCollection", kind: "class", file: "src/click/core.py", line: 2173 },
  { name: "Parameter", kind: "class", file: "src/click/core.py", line: 2241 },
  { name: "Option", kind: "class", file: "src/click/core.py", line: 3057 },
  { name: "Argument", kind: "class", file: "src/click/core.py", line: 3894 },
  { name: "__init__", kind: "constructor", file: "src/click/core.py", line: 370 }, // Context.__init__
  { name: "__init__", kind: "constructor", file: "src/click/exceptions.py", line: 377 }, // Exit.__init__
  { name: "close", kind: "method", file: "src/click/core.py", line: 719 }, // Context.close
  { name: "scope", kind: "method", file: "src/click/core.py", line: 599 }, // Context.scope, @contextmanager
  { name: "protected_args", kind: "getter", file: "src/click/core.py", line: 547 }, // Context.protected_args, @property
  { name: "meta", kind: "getter", file: "src/click/core.py", line: 637 }, // Context.meta, @property
  { name: "command_path", kind: "getter", file: "src/click/core.py", line: 745 }, // Context.command_path, @property
  { name: "abort", kind: "method", file: "src/click/core.py", line: 845 }, // Context.abort
  { name: "exit", kind: "method", file: "src/click/core.py", line: 849 }, // Context.exit
  { name: "format_help", kind: "method", file: "src/click/core.py", line: 1288 }, // Command.format_help
  { name: "get_help", kind: "method", file: "src/click/core.py", line: 1263 }, // Command.get_help
  { name: "batch", kind: "function", file: "src/click/core.py", line: 149 },
  { name: "iter_params_for_processing", kind: "function", file: "src/click/core.py", line: 172 },
  { name: "augment_usage_errors", kind: "function", file: "src/click/core.py", line: 154 }, // @contextmanager
  { name: "get_current_context", kind: "function", file: "src/click/globals.py", line: 13 },
];

type OracleCall = {
  description: string;
  file: string;
  line: number; // the call-site statement's line, not the enclosing def
  calleeName: string;
  receiverText?: string;
};

// 8 real call sites: self-member calls, same-file module-function calls, and cross-file imported
// calls, each read directly from the checkout.
const calls: OracleCall[] = [
  {
    description: "Context.abort(): raise Abort()",
    file: "src/click/core.py",
    line: 847,
    calleeName: "Abort",
  },
  {
    description: "Context.exit(): raise Exit(code)",
    file: "src/click/core.py",
    line: 857,
    calleeName: "Exit",
  },
  {
    description: "Context.exit(): self.close()",
    file: "src/click/core.py",
    line: 856,
    calleeName: "close",
    receiverText: "self",
  },
  {
    description: "Command.get_help(): self.format_help(ctx, formatter)",
    file: "src/click/core.py",
    line: 1269,
    calleeName: "format_help",
    receiverText: "self",
  },
  {
    description: "Command.parse_args(): iter_params_for_processing(param_order, self.get_params(ctx))",
    file: "src/click/core.py",
    line: 1403,
    calleeName: "iter_params_for_processing",
  },
  {
    description: "Option.value_from_envvar(): batch(multi_rv, self.nargs)",
    file: "src/click/core.py",
    line: 3814,
    calleeName: "batch",
  },
  {
    description: "decorators.pass_context.new_func(): f(get_current_context(), ...)",
    file: "src/click/decorators.py",
    line: 34,
    calleeName: "get_current_context",
  },
  {
    description: "decorators.make_pass_decorator.decorator.new_func(): ctx = get_current_context()",
    file: "src/click/decorators.py",
    line: 78,
    calleeName: "get_current_context",
  },
];

type OracleResolution = {
  description: string;
  file: string;
  line: number;
  calleeName: string;
  confidence: CallConfidence;
  resolutionKind: ResolutionKind;
  target: { name: string; kind: SymbolKind; file: string; line: number };
};

// Same 8 call sites, this time asserting the resolver's actual resolutionKind/confidence and the
// specific target symbol it resolves to (verified against src/languages/python/resolve.ts's
// settle() call sites: "imported" for imports, "this-member" for self.X in-scope, "same-file" for
// a unique same-module callable).
const resolutions: OracleResolution[] = [
  {
    description: "Abort() is imported from .exceptions into core.py",
    file: "src/click/core.py",
    line: 847,
    calleeName: "Abort",
    confidence: "exact",
    resolutionKind: "imported",
    target: { name: "Abort", kind: "class", file: "src/click/exceptions.py", line: 362 },
  },
  {
    description: "Exit(code) is imported from .exceptions into core.py, resolves to its __init__",
    file: "src/click/core.py",
    line: 857,
    calleeName: "Exit",
    confidence: "exact",
    resolutionKind: "imported",
    target: { name: "__init__", kind: "constructor", file: "src/click/exceptions.py", line: 377 },
  },
  {
    description: "self.close() resolves within Context to Context.close",
    file: "src/click/core.py",
    line: 856,
    calleeName: "close",
    confidence: "exact",
    resolutionKind: "this-member",
    target: { name: "close", kind: "method", file: "src/click/core.py", line: 719 },
  },
  {
    description: "self.format_help(...) resolves within Command to Command.format_help",
    file: "src/click/core.py",
    line: 1269,
    calleeName: "format_help",
    confidence: "exact",
    resolutionKind: "this-member",
    target: { name: "format_help", kind: "method", file: "src/click/core.py", line: 1288 },
  },
  {
    description: "iter_params_for_processing(...) is a unique same-module callable",
    file: "src/click/core.py",
    line: 1403,
    calleeName: "iter_params_for_processing",
    confidence: "exact",
    resolutionKind: "same-file",
    target: {
      name: "iter_params_for_processing",
      kind: "function",
      file: "src/click/core.py",
      line: 172,
    },
  },
  {
    description: "batch(...) is a unique same-module callable",
    file: "src/click/core.py",
    line: 3814,
    calleeName: "batch",
    confidence: "exact",
    resolutionKind: "same-file",
    target: { name: "batch", kind: "function", file: "src/click/core.py", line: 149 },
  },
  {
    description: "get_current_context() in pass_context.new_func is imported from .globals",
    file: "src/click/decorators.py",
    line: 34,
    calleeName: "get_current_context",
    confidence: "exact",
    resolutionKind: "imported",
    target: { name: "get_current_context", kind: "function", file: "src/click/globals.py", line: 13 },
  },
  {
    description: "get_current_context() in make_pass_decorator.decorator.new_func is imported from .globals",
    file: "src/click/decorators.py",
    line: 78,
    calleeName: "get_current_context",
    confidence: "exact",
    resolutionKind: "imported",
    target: { name: "get_current_context", kind: "function", file: "src/click/globals.py", line: 13 },
  },
];

function run() {
  const root = process.cwd();
  const repositories: Repository[] = JSON.parse(
    readFileSync(join(root, "benchmarks/python-repositories.json"), "utf8"),
  );
  const repository = repositories.find((repo) => repo.id === "click");
  if (!repository) throw new Error("click entry missing from python-repositories.json");

  const repoRoot = resolve(root, repository.source);
  const index = new ProjectIndex(repoRoot);
  index.rebuild();

  const missing: string[] = [];

  let symbolsFound = 0;
  for (const expected of symbols) {
    const match = index.symbols.some(
      (s) =>
        s.name === expected.name &&
        s.kind === expected.kind &&
        s.filePath === expected.file &&
        s.range.startLine === expected.line,
    );
    if (match) symbolsFound++;
    else missing.push(`symbol ${expected.kind} ${expected.name} @ ${expected.file}:${expected.line}`);
  }

  let callsFound = 0;
  for (const expected of calls) {
    const match = index.calls.some(
      (c) =>
        c.calleeName === expected.calleeName &&
        c.filePath === expected.file &&
        c.range.startLine === expected.line &&
        (expected.receiverText === undefined || c.receiverText === expected.receiverText),
    );
    if (match) callsFound++;
    else missing.push(`call ${expected.description}`);
  }

  let resolutionsFound = 0;
  for (const expected of resolutions) {
    const target = index.symbols.find(
      (s) =>
        s.name === expected.target.name &&
        s.kind === expected.target.kind &&
        s.filePath === expected.target.file &&
        s.range.startLine === expected.target.line,
    );
    const call = index.calls.find(
      (c) =>
        c.calleeName === expected.calleeName &&
        c.filePath === expected.file &&
        c.range.startLine === expected.line,
    );
    const match =
      target !== undefined &&
      call !== undefined &&
      call.resolvedTargetId === target.id &&
      call.resolutionKind === expected.resolutionKind &&
      call.confidence === expected.confidence;
    if (match) resolutionsFound++;
    else missing.push(`resolution ${expected.description}`);
  }

  const result = {
    repository: repository.id,
    symbolsTotal: symbols.length,
    symbolsFound,
    callsTotal: calls.length,
    callsFound,
    resolutionsTotal: resolutions.length,
    resolutionsFound,
    missing,
  };

  console.log(
    `${repository.id}: ${symbolsFound}/${symbols.length} symbols, ${callsFound}/${calls.length} calls, ${resolutionsFound}/${resolutions.length} resolutions found`,
  );
  if (missing.length) console.log(`  missing:\n    ${missing.join("\n    ")}`);

  const outDir = resolve(root, "benchmarks/results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "v1.8-python-click.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), result }, null, 2) + "\n",
  );
}

run();
