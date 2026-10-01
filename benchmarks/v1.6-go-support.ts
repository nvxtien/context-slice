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
type OracleSymbol = { name: string; kind: string; exported?: boolean };
type OracleImport = { module: string; kind: string };
type OracleCall = { calleeName: string; receiverText?: string };

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
    { name: "New", kind: "function", exported: true },
    { name: "Errorf", kind: "function", exported: true },
    { name: "fundamental", kind: "class", exported: false },
    { name: "Error", kind: "method", exported: true },
    { name: "WithStack", kind: "function", exported: true },
    { name: "withStack", kind: "class", exported: false },
    { name: "Wrap", kind: "function", exported: true },
    { name: "Wrapf", kind: "function", exported: true },
    { name: "WithMessage", kind: "function", exported: true },
    { name: "withMessage", kind: "class", exported: false },
    { name: "Cause", kind: "function", exported: true },
    { name: "Frame", kind: "type", exported: true },
    { name: "StackTrace", kind: "type", exported: true },
    { name: "Is", kind: "function", exported: true },
    { name: "As", kind: "function", exported: true },
    { name: "Unwrap", kind: "function", exported: true },
    // withStack embeds `error` and `*stack` (no explicit field name, falls back to the
    // embedded type's own name); withMessage has regular named fields `cause` and `msg`.
    { name: "error", kind: "field", exported: false },
    { name: "stack", kind: "field", exported: false },
    { name: "cause", kind: "field", exported: false },
    { name: "msg", kind: "field", exported: false },
    // callers() in stack.go:163 — real unexported helper used by New/WithStack/Wrap.
    { name: "callers", kind: "function", exported: false },
  ],
  cobra: [
    { name: "Group", kind: "class", exported: true },
    { name: "Command", kind: "class", exported: true },
    { name: "Use", kind: "field", exported: true },
    { name: "Context", kind: "method", exported: true },
    { name: "SetArgs", kind: "method", exported: true },
    { name: "SetOut", kind: "method", exported: true },
    { name: "SetErr", kind: "method", exported: true },
    { name: "SetHelpFunc", kind: "method", exported: true },
    { name: "OutOrStdout", kind: "method", exported: true },
    { name: "UsageFunc", kind: "method", exported: true },
    { name: "FParseErrWhitelist", kind: "type", exported: true },
    // stripFlags() in command.go:674 — real unexported helper.
    { name: "stripFlags", kind: "function", exported: false },
  ],
  chi: [
    { name: "Chain", kind: "function", exported: true },
    { name: "Handler", kind: "method", exported: true },
    { name: "ChainHandler", kind: "class", exported: true },
    { name: "ServeHTTP", kind: "method", exported: true },
    { name: "Mux", kind: "class", exported: true },
    { name: "NewMux", kind: "function", exported: true },
    { name: "Use", kind: "method", exported: true },
    { name: "Handle", kind: "method", exported: true },
    { name: "Get", kind: "method", exported: true },
    { name: "Post", kind: "method", exported: true },
    { name: "Router", kind: "interface", exported: true },
    { name: "Routes", kind: "interface", exported: true },
    // chain() in chain.go:36 — real unexported helper behind the exported Chain().
    { name: "chain", kind: "function", exported: false },
  ],
};

// Hand-verified against each repo's actual import statements (Step 1 of Task 2):
// pkg-errors/errors.go imports "fmt" and "io"; cobra/command.go imports "context",
// "errors", "os"; chi/chi.go imports "net/http" and chi/mux.go imports "context", "sync".
// All are plain package imports, so the Go adapter emits kind "namespace" for each.
const imports: Record<string, OracleImport[]> = {
  "pkg-errors": [
    { module: "fmt", kind: "namespace" },
    { module: "io", kind: "namespace" },
  ],
  cobra: [
    { module: "context", kind: "namespace" },
    { module: "errors", kind: "namespace" },
    { module: "os", kind: "namespace" },
  ],
  chi: [
    { module: "net/http", kind: "namespace" },
    { module: "context", kind: "namespace" },
    { module: "sync", kind: "namespace" },
  ],
};

// Hand-read from the actual call sites in each repo's real source (Task 2 Step 1),
// chosen to exercise calleeNames the symbol/import oracles above don't already name —
// a mix of direct calls, selector/method calls on a local receiver, and package-qualified
// stdlib calls. Re-verified against pkg-errors' errors.go/stack.go, cobra's command.go,
// and chi's mux.go during this task's own execution.
const calls: Record<string, OracleCall[]> = {
  "pkg-errors": [
    { calleeName: "Sprintf", receiverText: "fmt" }, // errors.go:114, fmt.Sprintf(format, args...)
    { calleeName: "WriteString", receiverText: "io" }, // errors.go:131, io.WriteString(s, f.msg)
    { calleeName: "FuncForPC", receiverText: "runtime" }, // stack.go:24, runtime.FuncForPC(f.pc())
    { calleeName: "LastIndex", receiverText: "strings" }, // stack.go:173, strings.LastIndex(name, "/")
    { calleeName: "callers" }, // errors.go:105, direct call callers() inside New
  ],
  cobra: [
    { calleeName: "getOut", receiverText: "c" }, // command.go:394, c.getOut(os.Stdout)
    { calleeName: "mergePersistentFlags", receiverText: "c" }, // command.go:678, c.mergePersistentFlags()
    { calleeName: "HasPrefix", receiverText: "strings" }, // command.go:691, strings.HasPrefix(s, "--")
    { calleeName: "stripFlags" }, // command.go:761, direct call stripFlags(innerArgs, c)
  ],
  chi: [
    { calleeName: "NotFoundHandler", receiverText: "mx" }, // mux.go:66, mx.NotFoundHandler().ServeHTTP(w, r)
    { calleeName: "handle", receiverText: "mx" }, // mux.go:116, mx.handle(mALL, pattern, handler)
    { calleeName: "IndexAny", receiverText: "strings" }, // mux.go:110, strings.IndexAny(pattern, " \t")
    { calleeName: "TrimLeft", receiverText: "strings" }, // mux.go:111, strings.TrimLeft(pattern[i+1:], " \t")
    { calleeName: "chain" }, // mux.go:526, direct call chain(mx.middlewares, http.HandlerFunc(mx.routeHTTP))
  ],
};

const results: Record<
  string,
  {
    symbolsTotal: number;
    symbolsFound: number;
    importsTotal: number;
    importsFound: number;
    callsTotal: number;
    callsFound: number;
    missing: string[];
  }
> = {};

for (const repo of repositories) {
  const root = resolve(process.cwd(), repo.source);
  const index = new ProjectIndex(root);
  index.rebuild();
  const oracle = oracles[repo.id] ?? [];
  const oracleImports = imports[repo.id] ?? [];
  const oracleCalls = calls[repo.id] ?? [];
  const missing: string[] = [];

  let symbolsFound = 0;
  for (const expected of oracle) {
    const match = index.symbols.some(
      (s) =>
        s.name === expected.name &&
        s.kind === expected.kind &&
        (expected.exported === undefined ||
          s.modifiers?.includes("exported") === expected.exported),
    );
    if (match) symbolsFound++;
    else missing.push(`${expected.kind} ${expected.name}${expected.exported === false ? " (unexported)" : ""}`);
  }

  let importsFound = 0;
  for (const expected of oracleImports) {
    const match = index.imports.some(
      (i) => i.module === expected.module && i.kind === expected.kind,
    );
    if (match) importsFound++;
    else missing.push(`import ${expected.module} (${expected.kind})`);
  }

  let callsFound = 0;
  for (const expected of oracleCalls) {
    const match = index.calls.some(
      (c) =>
        c.calleeName === expected.calleeName &&
        (expected.receiverText === undefined || c.receiverText === expected.receiverText),
    );
    if (match) callsFound++;
    else
      missing.push(
        `call ${expected.receiverText ? `${expected.receiverText}.` : ""}${expected.calleeName}`,
      );
  }

  results[repo.id] = {
    symbolsTotal: oracle.length,
    symbolsFound,
    importsTotal: oracleImports.length,
    importsFound,
    callsTotal: oracleCalls.length,
    callsFound,
    missing,
  };
  console.log(`${repo.id}: ${symbolsFound}/${oracle.length} symbols found, ${importsFound}/${oracleImports.length} imports found, ${callsFound}/${oracleCalls.length} calls found`);
  if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
}

const outDir = resolve(process.cwd(), "benchmarks/results");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const report = { generatedAt: new Date().toISOString(), results };
writeFileSync(join(outDir, "v1.6-go-support.json"), JSON.stringify(report, null, 2) + "\n");
