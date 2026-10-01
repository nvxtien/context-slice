import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

type Repository = {
  id: string;
  scale: string;
  url: string;
  commit: string;
  source: string;
  scope: string;
  kind: string;
};
type OracleSymbol = { name: string; kind: string };

const repositories: Repository[] = JSON.parse(
  readFileSync(resolve(process.cwd(), "benchmarks/go-repositories.json"), "utf8"),
);

// Hand-curated from reading each repo's actual source (Task 3 Step 3) — a representative
// sample per repo, not exhaustive. Each entry must be found among the indexed symbols for
// that repo (by name + kind); recall = found / total, precision is not separately tracked
// this phase (Phase 1 has no false-positive-prone construct the way annotation-detection
// phases did — a symbol either is or isn't a real Go declaration tree-sitter parsed).
// Every entry below was re-read directly from the real checked-out source during this
// task's own execution (errors.go, stack.go, go113.go; cobra's command.go; chi's
// chain.go, mux.go, chi.go) and confirmed to exist exactly as named/kinded.
const oracles: Record<string, OracleSymbol[]> = {
  "pkg-errors": [
    { name: "New", kind: "function" },
    { name: "Errorf", kind: "function" },
    { name: "fundamental", kind: "class" },
    { name: "Error", kind: "method" },
    { name: "WithStack", kind: "function" },
    { name: "withStack", kind: "class" },
    { name: "Wrap", kind: "function" },
    { name: "Wrapf", kind: "function" },
    { name: "WithMessage", kind: "function" },
    { name: "withMessage", kind: "class" },
    { name: "Cause", kind: "function" },
    { name: "Frame", kind: "type" },
    { name: "StackTrace", kind: "type" },
    { name: "Is", kind: "function" },
    { name: "As", kind: "function" },
    { name: "Unwrap", kind: "function" },
    // withStack embeds `error` and `*stack` (no explicit field name, falls back to the
    // embedded type's own name); withMessage has regular named fields `cause` and `msg`.
    { name: "error", kind: "field" },
    { name: "stack", kind: "field" },
    { name: "cause", kind: "field" },
    { name: "msg", kind: "field" },
  ],
  cobra: [
    { name: "Group", kind: "class" },
    { name: "Command", kind: "class" },
    { name: "Use", kind: "field" },
    { name: "Context", kind: "method" },
    { name: "SetArgs", kind: "method" },
    { name: "SetOut", kind: "method" },
    { name: "SetErr", kind: "method" },
    { name: "SetHelpFunc", kind: "method" },
    { name: "OutOrStdout", kind: "method" },
    { name: "UsageFunc", kind: "method" },
    { name: "FParseErrWhitelist", kind: "type" },
  ],
  chi: [
    { name: "Chain", kind: "function" },
    { name: "Handler", kind: "method" },
    { name: "ChainHandler", kind: "class" },
    { name: "ServeHTTP", kind: "method" },
    { name: "Mux", kind: "class" },
    { name: "NewMux", kind: "function" },
    { name: "Use", kind: "method" },
    { name: "Handle", kind: "method" },
    { name: "Get", kind: "method" },
    { name: "Post", kind: "method" },
    { name: "Router", kind: "interface" },
    { name: "Routes", kind: "interface" },
  ],
};

const results: Record<string, { total: number; found: number; missing: string[] }> = {};

for (const repo of repositories) {
  const root = resolve(process.cwd(), repo.source);
  const index = new ProjectIndex(root);
  index.rebuild();
  const oracle = oracles[repo.id] ?? [];
  const missing: string[] = [];
  let found = 0;
  for (const expected of oracle) {
    const match = index.symbols.some((s) => s.name === expected.name && s.kind === expected.kind);
    if (match) found++;
    else missing.push(`${expected.kind} ${expected.name}`);
  }
  results[repo.id] = { total: oracle.length, found, missing };
  console.log(`${repo.id}: ${found}/${oracle.length} symbols found`);
  if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
}

const outDir = resolve(process.cwd(), "benchmarks/results");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const report = { generatedAt: new Date().toISOString(), results };
writeFileSync(join(outDir, "v1.6-go-support.json"), JSON.stringify(report, null, 2) + "\n");
