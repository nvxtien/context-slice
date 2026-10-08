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
type OracleResolution = {
  calleeName: string;
  receiverText?: string;
  file: string;
  line: number;
  expectedKind: string; // ResolutionKind, or "unresolved" for a correct non-resolution
  expectedExternalPackage?: string;
  note: string;
};
type OracleSupertype = {
  structName: string;
  file: string;
  expectedSupertypes: string[];
  note: string;
};

const repositories: Repository[] = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "benchmarks/go-repositories.json"),
    "utf8",
  ),
).filter((r: Repository) => r.id === "gorilla-mux");

// Hand-curated by reading the real checked-out source at commit
// db9d1d0073d27a0a2d9a8c1bc52aa0af4374d265 (mux.go, route.go, middleware.go,
// regexp.go, example_authentication_middleware_test.go). gorilla/mux is a flat,
// single-package library (no go.mod subpackages), so this is one package directory.
const oracles: Record<string, OracleSymbol[]> = {
  "gorilla-mux": [
    { name: "NewRouter", kind: "function", exported: true },
    { name: "Router", kind: "class", exported: true },
    { name: "Route", kind: "class", exported: true },
    { name: "RouteMatch", kind: "class", exported: true },
    { name: "Match", kind: "method", exported: true },
    { name: "ServeHTTP", kind: "method", exported: true },
    { name: "Get", kind: "method", exported: true },
    { name: "StrictSlash", kind: "method", exported: true },
    { name: "SkipClean", kind: "method", exported: true },
    { name: "Walk", kind: "method", exported: true },
    { name: "WalkFunc", kind: "type", exported: true },
    // cleanPath() in mux.go:524 — real unexported helper used by ServeHTTP.
    { name: "cleanPath", kind: "function", exported: false },
    { name: "replaceURLPath", kind: "function", exported: false },
    { name: "uniqueVars", kind: "function", exported: false },
    { name: "checkPairs", kind: "function", exported: false },
    { name: "mapFromPairsToString", kind: "function", exported: false },
    { name: "matchInArray", kind: "function", exported: false },
    { name: "methodNotAllowed", kind: "function", exported: false },
    { name: "methodNotAllowedHandler", kind: "function", exported: false },
    // matcher: route.go:234, the local interface several structs satisfy directly.
    { name: "matcher", kind: "interface", exported: false },
    // middleware: middleware.go:14, the other local interface.
    { name: "middleware", kind: "interface", exported: false },
    { name: "MiddlewareFunc", kind: "type", exported: true },
    { name: "Use", kind: "method", exported: true },
    { name: "CORSMethodMiddleware", kind: "function", exported: true },
    { name: "getAllMethodsForRoute", kind: "function", exported: false },
    // routeRegexp: regexp.go:169, unexported struct backing host/path/query matching.
    { name: "routeRegexp", kind: "class", exported: false },
  ],
};

// Hand-verified against mux.go's and route.go's actual import statements. All plain
// stdlib package imports, so the Go adapter emits kind "namespace" for each.
const imports: Record<string, OracleImport[]> = {
  "gorilla-mux": [
    { module: "context", kind: "namespace" },
    { module: "errors", kind: "namespace" },
    { module: "fmt", kind: "namespace" },
    { module: "net/http", kind: "namespace" },
    { module: "regexp", kind: "namespace" },
  ],
};

// Hand-read from real call sites in mux.go, route.go, middleware.go.
const calls: Record<string, OracleCall[]> = {
  "gorilla-mux": [
    { calleeName: "cleanPath" }, // mux.go:195, direct call inside ServeHTTP
    { calleeName: "Clean", receiverText: "path" }, // mux.go:531, path.Clean(p) inside cleanPath
    { calleeName: "Errorf", receiverText: "fmt" }, // mux.go:554, fmt.Errorf(...) inside uniqueVars
    { calleeName: "NewRoute", receiverText: "r" }, // mux.go:324, r.NewRoute() inside (r *Router) Name
    { calleeName: "GetHandlerWithMiddlewares", receiverText: "r" }, // route.go:108, r.GetHandlerWithMiddlewares() inside (r *Route) Match
    { calleeName: "newRouteRegexp" }, // route.go:259, direct call inside (r *Route) addRegexpMatcher
    { calleeName: "Join", receiverText: "strings" }, // middleware.go:62, strings.Join(...) inside CORSMethodMiddleware
    { calleeName: "TrimRight", receiverText: "strings" }, // route.go:256, strings.TrimRight(...) inside addRegexpMatcher
    { calleeName: "addRegexpMatcher", receiverText: "r" }, // route.go:367, r.addRegexpMatcher(...) inside (r *Route) Host
    { calleeName: "mapFromPairsToString" }, // route.go:315, direct call inside (r *Route) Headers
  ],
};

// Phase 3b-equivalent: expected call-RESOLUTION outcome per site, hand-verified by
// reading the real source and cross-checking the declared target actually exists where
// expected. gorilla/mux has no internal subpackages (single flat package directory), so
// every package-qualified call in it is necessarily external/stdlib — same-file/same-type
// cases come from direct calls and method calls on local receivers instead.
const resolutions: Record<string, OracleResolution[]> = {
  "gorilla-mux": [
    {
      calleeName: "cleanPath",
      file: "mux.go",
      line: 195,
      expectedKind: "same-file",
      note: "direct call to cleanPath() (mux.go:524), same package directory as ServeHTTP",
    },
    {
      calleeName: "Clean",
      receiverText: "path",
      file: "mux.go",
      line: 531,
      expectedKind: "unresolved",
      expectedExternalPackage: "path",
      note: "path is stdlib",
    },
    {
      calleeName: "Errorf",
      receiverText: "fmt",
      file: "mux.go",
      line: 554,
      expectedKind: "unresolved",
      expectedExternalPackage: "fmt",
      note: "fmt is stdlib",
    },
    {
      calleeName: "NewRoute",
      receiverText: "r",
      file: "mux.go",
      line: 324,
      expectedKind: "same-type",
      note: "r.NewRoute() inside method (r *Router) Name; receiver var matches caller's own receiver, NewRoute is also a *Router method (mux.go:314)",
    },
    {
      calleeName: "GetHandlerWithMiddlewares",
      receiverText: "r",
      file: "route.go",
      line: 108,
      expectedKind: "same-type",
      note: "r.GetHandlerWithMiddlewares() inside method (r *Route) Match; both share receiver type Route",
    },
    {
      calleeName: "newRouteRegexp",
      file: "route.go",
      line: 259,
      expectedKind: "same-file",
      note: "direct call to newRouteRegexp() (regexp.go:41), same package directory as addRegexpMatcher",
    },
    {
      calleeName: "Join",
      receiverText: "strings",
      file: "middleware.go",
      line: 62,
      expectedKind: "unresolved",
      expectedExternalPackage: "strings",
      note: "strings is stdlib",
    },
    {
      calleeName: "TrimRight",
      receiverText: "strings",
      file: "route.go",
      line: 256,
      expectedKind: "unresolved",
      expectedExternalPackage: "strings",
      note: "strings is stdlib",
    },
    {
      calleeName: "addRegexpMatcher",
      receiverText: "r",
      file: "route.go",
      line: 367,
      expectedKind: "same-type",
      note: "r.addRegexpMatcher(...) inside method (r *Route) Host; both share receiver type Route",
    },
    {
      calleeName: "mapFromPairsToString",
      file: "route.go",
      line: 315,
      expectedKind: "same-file",
      note: "direct call to mapFromPairsToString() (mux.go:574), same package directory as Headers",
    },
  ],
};

// Phase 4-equivalent: real struct.supertypes found by actually running
// resolveInterfaceSatisfaction over this checkout and reading the real source to confirm
// each one by hand. gorilla/mux declares exactly two local interfaces, matcher (route.go:234,
// one method: Match(*http.Request, *RouteMatch) bool) and middleware (middleware.go:14, one
// method: Middleware(http.Handler) http.Handler) — both satisfied directly (no embedding).
const supertypes: Record<string, OracleSupertype[]> = {
  "gorilla-mux": [
    {
      structName: "Router",
      file: "mux.go",
      expectedSupertypes: ["matcher"],
      note: "Router defines Match(*http.Request, *RouteMatch) bool directly (mux.go:151), satisfying matcher",
    },
    {
      structName: "Route",
      file: "route.go",
      expectedSupertypes: ["matcher"],
      note: "Route defines Match(*http.Request, *RouteMatch) bool directly (route.go:47), satisfying matcher",
    },
    {
      structName: "authenticationMiddleware",
      file: "example_authentication_middleware_test.go",
      expectedSupertypes: ["middleware"],
      note: "authenticationMiddleware defines Middleware(http.Handler) http.Handler directly (example_authentication_middleware_test.go:24), satisfying middleware",
    },
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
    resolutionsTotal: number;
    resolutionsMatched: number;
    supertypesTotal: number;
    supertypesMatched: number;
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
    else
      missing.push(
        `${expected.kind} ${expected.name}${expected.exported === false ? " (unexported)" : ""}`,
      );
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
        (expected.receiverText === undefined ||
          c.receiverText === expected.receiverText),
    );
    if (match) callsFound++;
    else
      missing.push(
        `call ${expected.receiverText ? `${expected.receiverText}.` : ""}${expected.calleeName}`,
      );
  }

  const oracleResolutions = resolutions[repo.id] ?? [];
  let resolutionsMatched = 0;
  for (const expected of oracleResolutions) {
    const actual = index.calls.find(
      (c) =>
        c.calleeName === expected.calleeName &&
        c.receiverText === expected.receiverText &&
        c.filePath === expected.file &&
        c.range.startLine === expected.line,
    );
    const label = `resolution ${expected.receiverText ? `${expected.receiverText}.` : ""}${expected.calleeName} (${expected.file}:${expected.line})`;
    if (!actual) {
      missing.push(`${label}: call site not found in index.calls`);
      continue;
    }
    const kindMatches = actual.resolutionKind === expected.expectedKind;
    const externalMatches =
      expected.expectedExternalPackage === undefined ||
      actual.externalPackage === expected.expectedExternalPackage;
    if (kindMatches && externalMatches) {
      resolutionsMatched++;
    } else {
      missing.push(
        `${label}: expected ${expected.expectedKind}${expected.expectedExternalPackage ? ` (external ${expected.expectedExternalPackage})` : ""}, got ${actual.resolutionKind}${actual.externalPackage ? ` (external ${actual.externalPackage})` : ""}`,
      );
    }
  }

  const oracleSupertypes = supertypes[repo.id] ?? [];
  let supertypesMatched = 0;
  for (const expected of oracleSupertypes) {
    const actual = index.symbols.find(
      (s) =>
        s.kind === "class" &&
        s.name === expected.structName &&
        s.filePath === expected.file,
    );
    const label = `supertypes ${expected.structName} (${expected.file})`;
    if (!actual) {
      missing.push(`${label}: struct not found in index.symbols`);
      continue;
    }
    const actualSet = new Set(actual.supertypes ?? []);
    const expectedSet = expected.expectedSupertypes;
    if (
      expectedSet.every((n) => actualSet.has(n)) &&
      actualSet.size === expectedSet.length
    ) {
      supertypesMatched++;
    } else {
      missing.push(
        `${label}: expected [${expectedSet.join(", ")}], got [${[...actualSet].join(", ")}]`,
      );
    }
  }

  results[repo.id] = {
    symbolsTotal: oracle.length,
    symbolsFound,
    importsTotal: oracleImports.length,
    importsFound,
    callsTotal: oracleCalls.length,
    callsFound,
    resolutionsTotal: oracleResolutions.length,
    resolutionsMatched,
    supertypesTotal: oracleSupertypes.length,
    supertypesMatched,
    missing,
  };
  console.log(
    `${repo.id}: ${symbolsFound}/${oracle.length} symbols found, ${importsFound}/${oracleImports.length} imports found, ${callsFound}/${oracleCalls.length} calls found, ${resolutionsMatched}/${oracleResolutions.length} resolutions matched, ${supertypesMatched}/${oracleSupertypes.length} supertypes matched`,
  );
  if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
}

const outDir = resolve(process.cwd(), "benchmarks/results");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const report = { generatedAt: new Date().toISOString(), results };
writeFileSync(
  join(outDir, "v1.8-go-gorilla-mux.json"),
  JSON.stringify(report, null, 2) + "\n",
);
