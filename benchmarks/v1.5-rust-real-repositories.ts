// v1.5 Phase 1 real-repository evaluation of Rust module/use/re-export resolution.
// Measurement only: nothing under src/ is changed and no expectation is tuned.
// modulePathFor is imported ONLY as the subject under test (compared against an
// independently built oracle); resolveRustModule/rustModuleIndex are never used.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { modulePathFor } from "../src/languages/rust/parse.js";
import {
  classifyUse,
  expectedModuleFile,
  hasSyntaxError,
  inlineModSpans,
  modDeclarations,
  targetContainsName,
} from "./rust-oracles.js";
import { findingsProse } from "./v1.5-rust-findings.js";

type Repository = {
  id: string;
  scale: string;
  url: string;
  commit: string;
  sparse?: string[];
  source: string;
  scope: string;
  kind: string;
};
const CATEGORIES = [
  "MODULE_RESOLUTION",
  "USE_RESOLUTION",
  "CARGO_WORKSPACE_RESOLUTION",
  "MACRO_EXPANSION_LIMIT",
  "RUST_STATIC_LIMIT",
  "PARSER",
  "UNKNOWN",
] as const;
type Category = (typeof CATEGORIES)[number];
type Failure = {
  kind: string;
  category: Category;
  file: string;
  line: number;
  detail: string;
};

const root = process.cwd();
const outputDir = join(root, "benchmarks/results");
const repositories = JSON.parse(
  readFileSync(join(root, "benchmarks/rust-repositories.json"), "utf8"),
) as Repository[];
const SKIP_DIRS = new Set([
  ".git", "node_modules", "build", "dist", "out", ".idea", ".vscode", ".context-slice", "target",
]);
const EXAMPLES_LIMIT = 10;
const STD = new Set(["std", "core", "alloc", "proc_macro", "test"]);

function walk(dir: string, base: string, ext: (n: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, base, ext);
    return entry.isFile() && ext(entry.name)
      ? [path.slice(base.length + 1).split("\\").join("/")]
      : [];
  });
}
const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10_000) / 100);
const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

/** Dependency names + package name from a Cargo.toml (line based; enough for names). */
function cargoInfo(text: string) {
  const deps = new Set<string>();
  let name: string | undefined;
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
      const dotted = /dependencies\.([\w-]+)$/.exec(section);
      if (dotted) deps.add(dotted[1].replace(/-/g, "_"));
      continue;
    }
    const kv = /^([\w-]+)\s*=/.exec(line);
    if (!kv) continue;
    if (section === "package" && kv[1] === "name")
      name = /"([^"]+)"/.exec(line)?.[1];
    else if (/(^|\.)(dev-|build-)?dependencies$/.test(section))
      deps.add(kv[1].replace(/-/g, "_"));
  }
  return { name: name?.replace(/-/g, "_"), deps };
}

function evaluate(repo: Repository) {
  const dir = resolve(root, repo.source);
  rmSync(join(dir, ".context-slice"), { recursive: true, force: true });
  const rsFiles = walk(dir, dir, (n) => n.endsWith(".rs")).sort();
  const fileSet = new Set(rsFiles);
  const exists = (p: string) => fileSet.has(p);
  const sources = new Map(rsFiles.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const cargoFiles = walk(dir, dir, (n) => n === "Cargo.toml");
  const packages = new Map(
    cargoFiles.map((f) => [dirname(f) === "." ? "" : dirname(f), cargoInfo(readFileSync(join(dir, f), "utf8"))]),
  );
  const packageOf = (file: string) => {
    for (let d = dirname(file); ; d = dirname(d)) {
      const key = d === "." ? "" : d;
      if (packages.has(key)) return packages.get(key)!;
      if (d === "." || d === "/") return undefined;
    }
  };
  const isPackageDir = (d: string) => packages.has(d === "." ? "" : d);

  // ---- cold / warm indexing ------------------------------------------------
  const index = new ProjectIndex(dir);
  const coldStart = performance.now();
  const cold = index.rebuild();
  const coldWall = performance.now() - coldStart;
  const snapshot = () =>
    JSON.stringify({
      imports: index.imports.map((r) => [r.filePath, r.range.startLine, r.module, r.importedName, r.localName, r.wildcard ?? false, r.resolvedFile ?? null, r.externalPackage ?? null]),
      exports: index.exports.map((r) => [r.filePath, r.range.startLine, r.exportedName, r.fromModule, r.sourceName, r.wildcard ?? false, r.resolvedFile ?? null, r.symbolId ?? null]),
      symbols: index.symbols.map((s) => s.id),
    });
  const coldSnapshot = snapshot();
  const warmStart = performance.now();
  const warm = index.rebuild();
  const warmWall = performance.now() - warmStart;
  const warmSnapshot = snapshot();

  // Repos may hold non-Rust files (e.g. walkdir/compare/walk.py); measure Rust records only.
  const view = {
    symbols: index.symbols.filter((s) => s.language === "rust"),
    imports: index.imports.filter((r) => r.language === "rust"),
    exports: index.exports.filter((r) => r.language === "rust"),
  };
  const syntaxErrorFiles = rsFiles.filter((f) => hasSyntaxError(sources.get(f)!));
  // Independent detection of files the adapter silently emptied: no Rust records at all,
  // yet the raw text plainly contains items. (Cross-checked against the indexer's own
  // cold parseError count in the output.)
  const filesWithRecords = new Set([...view.symbols, ...view.imports, ...view.exports].map((r) => r.filePath));
  const droppedFiles = rsFiles.filter(
    (f) => !filesWithRecords.has(f) && /^\s*(pub(\([^)]*\))?\s+)?(fn|struct|enum|trait|impl|mod|use|const|static|type)\b/m.test(sources.get(f)!),
  );
  const errorSet = new Set([...syntaxErrorFiles, ...droppedFiles]);

  // ---- oracle module tree ----------------------------------------------------
  const rootKindOf = (file: string): string | undefined => {
    const d = dirname(file);
    const b = basename(file);
    if (basename(d) === "src" && (b === "lib.rs" || b === "main.rs")) return b === "lib.rs" ? "lib" : "main";
    if (basename(d) === "bin" && basename(dirname(d)) === "src") return "bin";
    if (b === "main.rs" && basename(dirname(d)) === "bin" && basename(dirname(dirname(d))) === "src") return "bin";
    if (basename(d) === "tests" && isPackageDir(dirname(d))) return "test";
    if (basename(d) === "examples" && isPackageDir(dirname(d))) return "example";
    if (b === "build.rs" && isPackageDir(d)) return "build";
    return undefined;
  };
  const oracleMP = new Map<string, string[]>();
  const crateRoot = new Map<string, string>();
  const declarations: Array<{ file: string; name: string; line: number; status: string; target?: string; category?: Category; detail: string }> = [];
  const multiClaimed: string[] = [];
  const queue: string[] = [];
  for (const file of rsFiles)
    if (rootKindOf(file)) {
      oracleMP.set(file, []);
      crateRoot.set(file, file);
      queue.push(file);
    }
  const rootFiles = [...queue];
  while (queue.length) {
    const file = queue.shift()!;
    for (const decl of modDeclarations(sources.get(file)!)) {
      const entry = { file, name: decl.name, line: decl.line };
      if (decl.pathAttribute !== undefined) {
        declarations.push({ ...entry, status: "skipped-path-attribute", detail: `#[path = "${decl.pathAttribute}"]` });
        continue;
      }
      const target = expectedModuleFile(file, decl.name, exists, decl.inlineChain);
      if (!target) {
        declarations.push({
          ...entry,
          status: "file-missing",
          category: decl.cfg ? "RUST_STATIC_LIMIT" : "UNKNOWN",
          detail: decl.cfg ? "cfg-gated declaration whose file is absent" : "no file on disk (generated or feature-specific?)",
        });
        continue;
      }
      declarations.push({ ...entry, status: "file-found", target, detail: "" });
      const path = [...oracleMP.get(file)!, ...decl.inlineChain, decl.name];
      if (oracleMP.has(target)) {
        if (oracleMP.get(target)!.join("::") !== path.join("::")) multiClaimed.push(target);
        continue;
      }
      oracleMP.set(target, path);
      crateRoot.set(target, crateRoot.get(file)!);
      queue.push(target);
    }
  }
  const fileByModule = new Map<string, string>();
  for (const [file, path] of oracleMP) fileByModule.set(`${crateRoot.get(file)}|${path.join("::")}`, file);
  const orphans = rsFiles.filter((f) => !oracleMP.has(f));

  // ---- module_resolution_rate ----------------------------------------------
  const moduleDisagree: Array<{ file: string; oracle: string[]; modulePathFor: string[]; category: Category; reason: string }> = [];
  let agree = 0;
  for (const [file, path] of oracleMP) {
    const actual = modulePathFor(file);
    if (actual.join("::") === path.join("::")) {
      agree++;
      continue;
    }
    const rk = rootKindOf(crateRoot.get(file)!);
    const nonLib = rk !== "lib" && rk !== "main";
    moduleDisagree.push({
      file,
      oracle: path,
      modulePathFor: actual,
      category: nonLib ? "CARGO_WORKSPACE_RESOLUTION" : "MODULE_RESOLUTION",
      reason: nonLib
        ? `belongs to a ${rk} crate root (${crateRoot.get(file)}), which is its own crate but modulePathFor uses the src/-relative path`
        : "file in the lib/main crate tree: real disagreement",
    });
  }
  const moduleFailuresByCategory: Record<string, number> = {};
  for (const d of moduleDisagree) bump(moduleFailuresByCategory, d.category);

  const failures: Failure[] = [];
  for (const d of declarations)
    if (d.status === "file-missing")
      failures.push({ kind: "mod-file-missing", category: d.category!, file: d.file, line: d.line, detail: `mod ${d.name}; ${d.detail}` });

  // ---- helpers for use analysis ----------------------------------------------
  const inlineSpansCache = new Map<string, ReturnType<typeof inlineModSpans>>();
  const spansOf = (file: string) => {
    if (!inlineSpansCache.has(file)) inlineSpansCache.set(file, inlineModSpans(sources.get(file)!));
    return inlineSpansCache.get(file)!;
  };
  const insideInline = (file: string, line: number) =>
    spansOf(file).some((s) => line >= s.startLine && line <= s.endLine);
  /** Independent oracle for a `use` module path: the longest file-backed module prefix. */
  function oracleTarget(file: string, moduleText: string) {
    const mp = oracleMP.get(file);
    if (!mp) return { status: "orphan" as const };
    const segs = moduleText.split("::");
    let cur = mp;
    let i = 0;
    if (segs[0] === "crate") { cur = []; i = 1; }
    else if (segs[0] === "self") { i = 1; }
    else if (segs[0] === "super") while (segs[i] === "super") { cur = cur.slice(0, -1); i++; }
    const full = [...cur, ...segs.slice(i)];
    const r = crateRoot.get(file)!;
    for (let n = full.length; n >= 0; n--) {
      const hit = fileByModule.get(`${r}|${full.slice(0, n).join("::")}`);
      if (hit) return n === full.length ? { status: "exact" as const, file: hit } : { status: "prefix" as const, file: hit, rest: full.slice(n) };
    }
    return { status: "none" as const };
  }
  const nonLibRoot = (file: string) => {
    const r = crateRoot.get(file);
    if (!r) return true; // orphan: not part of any crate the oracle can place
    const rk = rootKindOf(r);
    return rk !== "lib" && rk !== "main";
  };
  const wordIn = (name: string, text: string) =>
    new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\b`).test(text);

  function attributeAnchored(record: (typeof index.imports)[number], kind: string): Category {
    const file = record.filePath;
    if (errorSet.has(file)) return "PARSER";
    const t = oracleTarget(file, record.module);
    if ((t.status === "exact" || t.status === "prefix") && errorSet.has(t.file)) return "PARSER";
    if (nonLibRoot(file)) return "CARGO_WORKSPACE_RESOLUTION";
    if (insideInline(file, record.range.startLine)) return "RUST_STATIC_LIMIT";
    if (t.status === "exact" || (t.status === "prefix" && kind === "unresolved" && t.rest.length <= 1)) {
      if (kind === "wrong-file" || kind === "unresolved") {
        const oracleFile = t.file!;
        return modulePathFor(oracleFile).join("::") !== oracleMP.get(oracleFile)!.join("::") ? "MODULE_RESOLUTION" : "USE_RESOLUTION";
      }
    }
    if (t.status === "prefix") {
      const inlineNames = new Set(spansOf(t.file).map((s) => s.name));
      if (inlineNames.has(t.rest[0])) return "RUST_STATIC_LIMIT";
      return kind === "unresolved" ? "USE_RESOLUTION" : "UNKNOWN";
    }
    return "UNKNOWN";
  }

  // ---- use_resolution_rate --------------------------------------------------
  const anchored = { total: 0, resolved: 0, unresolved: 0, wildcard: 0, wildcardResolved: 0 };
  const nonAnchored = { total: 0, external: 0, localResolved: 0, neither: 0, wildcard: 0, wildcardResolved: 0 };
  const oracleCheck = { anchoredResolvedChecked: 0, agree: 0, disagree: 0, nonAnchoredLocalChecked: 0, nonAnchoredLocalAgree: 0 };
  const precision = { checked: 0, contains: 0, unverifiable: 0, missing: 0 };
  const externalBreakdown: Record<string, number> = {};
  const nameMissingSamples: Failure[] = [];
  let nameMissingTotal = 0;
  const wrongFileExamples: Array<Record<string, unknown>> = [];
  for (const record of view.imports) {
    const cls = classifyUse(record);
    const wild = Boolean(record.wildcard);
    const bucket = cls === "anchored" ? anchored : nonAnchored;
    bucket.total++;
    if (wild) {
      bucket.wildcard++;
      if (record.resolvedFile) bucket.wildcardResolved++;
    }
    const at = { file: record.filePath, line: record.range.startLine };
    if (cls === "anchored") {
      if (record.resolvedFile) {
        anchored.resolved++;
        const t = oracleTarget(record.filePath, record.module);
        if (t.status === "exact" || t.status === "prefix") {
          oracleCheck.anchoredResolvedChecked++;
          if (t.file === record.resolvedFile) oracleCheck.agree++;
          else {
            oracleCheck.disagree++;
            const category = attributeAnchored(record, "wrong-file");
            failures.push({ kind: "resolved-to-wrong-file", category, ...at, detail: `use ${record.module}::${record.importedName ?? "*"} resolved to ${record.resolvedFile}, oracle says ${t.file}` });
            if (wrongFileExamples.length < EXAMPLES_LIMIT) wrongFileExamples.push({ ...at, module: record.module, resolvedFile: record.resolvedFile, oracleFile: t.file, category });
          }
        }
      } else {
        anchored.unresolved++;
        failures.push({ kind: "anchored-unresolved", category: attributeAnchored(record, "unresolved"), ...at, detail: `use ${record.module}::${record.importedName ?? "*"}` });
      }
    } else if (record.externalPackage) {
      nonAnchored.external++;
      const first = record.module.split("::")[0];
      if (!sources.has(record.filePath)) throw new Error(`indexed file missing from disk walk: ${record.filePath}`);
      const pkg = packageOf(record.filePath);
      const local = new Set([
        ...modDeclarations(sources.get(record.filePath)!).map((d) => d.name),
        ...spansOf(record.filePath).map((s) => s.name),
        ...view.symbols.filter((s) => s.filePath === record.filePath && !s.parentId).map((s) => s.name),
        ...view.imports.filter((r) => r.filePath === record.filePath).map((r) => r.localName ?? ""),
      ]);
      let why: string;
      if (record.module.includes("{")) why = "malformed-top-level-use-group";
      else if (STD.has(first)) why = "std-family";
      else if (pkg?.deps.has(first)) why = "declared-dependency";
      else if (pkg?.name === first) why = "own-package-crate";
      else if (local.has(first)) why = "in-scope-local-item";
      else why = "unverified";
      bump(externalBreakdown, why);
      if (why === "own-package-crate")
        failures.push({ kind: "external-but-repo-source", category: "CARGO_WORKSPACE_RESOLUTION", ...at, detail: `use ${record.module}::${record.importedName ?? "*"} names the package's own lib crate` });
      else if (why === "malformed-top-level-use-group")
        failures.push({ kind: "external-malformed-use-group", category: "USE_RESOLUTION", ...at, detail: `top-level braced use group parsed as one import with module text ${JSON.stringify(record.module.slice(0, 40))}...; its real imports are lost` });
      else if (why === "in-scope-local-item")
        failures.push({ kind: "external-but-in-scope-item", category: "USE_RESOLUTION", ...at, detail: `use ${record.module}::${record.importedName ?? "*"}: '${first}' is a mod/item in scope in this file` });
      else if (why === "unverified")
        failures.push({ kind: "external-unverified", category: "UNKNOWN", ...at, detail: `use ${record.module}::${record.importedName ?? "*"}: '${first}' not std, not a declared dependency` });
    } else if (record.resolvedFile) {
      nonAnchored.localResolved++;
      const t = oracleTarget(record.filePath, record.module);
      oracleCheck.nonAnchoredLocalChecked++;
      if ((t.status === "exact" || t.status === "prefix") && t.file === record.resolvedFile) oracleCheck.nonAnchoredLocalAgree++;
    } else nonAnchored.neither++;

    if (record.resolvedFile && record.importedName && !wild) {
      precision.checked++;
      const r = targetContainsName(view, record.resolvedFile, record.importedName);
      if (r === true) precision.contains++;
      else if (r === "unverifiable") precision.unverifiable++;
      else {
        precision.missing++;
        nameMissingTotal++;
        const category = ((): Category => {
          const file = record.filePath;
          const target = sources.get(record.resolvedFile!) ?? "";
          if (errorSet.has(file) || errorSet.has(record.resolvedFile!)) return "PARSER";
          if (cls === "anchored") {
            const t = oracleTarget(file, record.module);
            if ((t.status === "exact" || t.status === "prefix") && errorSet.has(t.file)) return "PARSER";
            if (nonLibRoot(file)) return "CARGO_WORKSPACE_RESOLUTION";
            if ((t.status === "exact" || t.status === "prefix") && t.file !== record.resolvedFile) return "USE_RESOLUTION";
          }
          if (insideInline(file, record.range.startLine)) return "RUST_STATIC_LIMIT";
          if (new RegExp(`macro_rules!|\\b${record.importedName!.replace(/[^\w]/g, "")}!`).test(target) && wordIn(record.importedName!, target)) return "MACRO_EXPANSION_LIMIT";
          if (new RegExp(`use\\s[^;]*[{,\\s:]${record.importedName!.replace(/[^\w]/g, "")}\\b`).test(target)) return "USE_RESOLUTION";
          return "UNKNOWN"; // includes: imported name absent from the resolved file's text (see detail)
        })();
        const f: Failure = { kind: "resolved-name-missing", category, file: record.filePath, line: record.range.startLine, detail: `use ${record.module}::${record.importedName} -> ${record.resolvedFile}${category === "UNKNOWN" && !wordIn(record.importedName, (sources.get(record.resolvedFile!) ?? "")) ? " [fallback: imported name does not appear in the resolved file's text]" : ""}` };
        failures.push(f);
        if (nameMissingSamples.length < EXAMPLES_LIMIT) nameMissingSamples.push(f);
      }
    }
  }

  // ---- reexport_resolution_rate -----------------------------------------------
  const rex = view.exports.filter((e) => e.fromModule);
  const rexLocal = rex.filter((e) => classifyUse({ module: e.fromModule! }) === "anchored");
  const reexport = {
    exportsTotal: view.exports.length,
    withFromModule: rex.length,
    withResolvedFile: rex.filter((e) => e.resolvedFile).length,
    anchoredReexports: rexLocal.length,
    anchoredWithResolvedFile: rexLocal.filter((e) => e.resolvedFile).length,
    nonWildcard: rex.filter((e) => !e.wildcard).length,
    nonWildcardWithSymbolId: rex.filter((e) => !e.wildcard && e.symbolId).length,
    nonWildcardWithoutSymbolIdExamples: rex
      .filter((e) => !e.wildcard && !e.symbolId)
      .slice(0, EXAMPLES_LIMIT)
      .map((e) => ({ file: e.filePath, line: e.range.startLine, fromModule: e.fromModule, sourceName: e.sourceName, resolvedFile: e.resolvedFile ?? null, external: !e.resolvedFile && classifyUse({ module: e.fromModule! }) === "non-anchored" })),
    wildcard: rex.filter((e) => e.wildcard).length,
    wildcardWithResolvedFile: rex.filter((e) => e.wildcard && e.resolvedFile).length,
  };

  // ---- attribution tallies + UNKNOWN examples --------------------------------
  const byCategory: Record<string, number> = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const f of failures) byCategory[f.category]++;
  const byKindCategory: Record<string, Record<string, number>> = {};
  for (const f of failures) {
    byKindCategory[f.kind] ??= {};
    bump(byKindCategory[f.kind], f.category);
  }
  const lineOf = (file: string, line: number) => (sources.get(file)?.split("\n")[line - 1] ?? "").trim();
  const unknownExamples = failures
    .filter((f) => f.category === "UNKNOWN")
    .slice(0, EXAMPLES_LIMIT)
    .map((f) => ({ ...f, sourceLine: lineOf(f.file, f.line) }));
  const failureExamples = failures.slice(0, 40).map((f) => ({ ...f, sourceLine: lineOf(f.file, f.line) }));

  const declCounts = {
    total: declarations.length,
    fileFound: declarations.filter((d) => d.status === "file-found").length,
    fileMissing: declarations.filter((d) => d.status === "file-missing").length,
    skippedPathAttribute: declarations.filter((d) => d.status === "skipped-path-attribute").length,
  };

  return {
    id: repo.id,
    scale: repo.scale,
    commit: repo.commit,
    scope: repo.scope,
    sparse: repo.sparse ?? null,
    coverage: {
      rsFilesOnDisk: rsFiles.length,
      rsFilesIndexed: cold.filesByLanguage.Rust ?? 0,
      symbols: view.symbols.length,
      imports: view.imports.length,
      exports: view.exports.length,
      filesWithParseError: syntaxErrorFiles.length,
      parseErrorFiles: syntaxErrorFiles,
      filesSilentlyDropped: droppedFiles.map((f) => ({ file: f, chars: sources.get(f)!.length })),
      indexerReportedParseErrorsCold: cold.parseErrors,
    },
    performance: {
      coldMs: cold.elapsedMs, warmMs: warm.elapsedMs,
      coldWallMs: Math.round(coldWall), warmWallMs: Math.round(warmWall),
      coldFilesParsed: cold.filesParsed, warmFilesParsed: warm.filesParsed, warmCacheHits: warm.cacheHits,
    },
    coldWarmIdentical: coldSnapshot === warmSnapshot,
    moduleResolution: {
      crateRoots: rootFiles.map((f) => ({ file: f, kind: rootKindOf(f) })),
      filesReached: oracleMP.size,
      agree,
      disagree: moduleDisagree.length,
      agreeRate: pct(agree, oracleMP.size),
      disagreeByCategory: moduleFailuresByCategory,
      disagreements: moduleDisagree.slice(0, 40),
      orphans: orphans.map((f) => ({ file: f, modulePathFor: modulePathFor(f) })),
      multiClaimedFiles: [...new Set(multiClaimed)],
      declarations: declCounts,
      declarationsFileMissing: declarations.filter((d) => d.status === "file-missing"),
      skippedPathAttribute: declarations.filter((d) => d.status === "skipped-path-attribute"),
    },
    useResolution: {
      anchored: { ...anchored, resolvedRate: pct(anchored.resolved, anchored.total) },
      nonAnchored: { ...nonAnchored, externalOrLocalRate: pct(nonAnchored.external + nonAnchored.localResolved, nonAnchored.total) },
      externalBreakdown,
      oracleCheck,
      precisionProxy: { ...precision, containsRate: pct(precision.contains, precision.checked), containsOrUnverifiableRate: pct(precision.contains + precision.unverifiable, precision.checked) },
      nameMissingTotal,
      nameMissingSamples,
      wrongFileExamples,
    },
    reexportResolution: reexport,
    attribution: { totalFailures: failures.length, byCategory, byKindCategory, unknownExamples, failureExamples },
  };
}

// ---- run + emit ----------------------------------------------------------------
const results = repositories.map((repo) => {
  console.log(`Evaluating ${repo.id}`);
  return evaluate(repo);
});

const ATTRIBUTION_RULES = [
  ["PARSER", "The importing file, or the file the oracle says is the target, has a tree-sitter syntax error (genuine grammar error) OR the adapter failed to parse / emptied the file (an adapter defect, e.g. tree-sitter input-size limit: no symbols/imports/exports although the text contains items; the indexer reports these as parseErrors). Both sub-kinds are in this bucket; file counts per sub-kind are in the coverage table."],
  ["CARGO_WORKSPACE_RESOLUTION", "The file belongs to a crate root that is not src/lib.rs or src/main.rs (src/bin/*, tests/*, examples/*, build.rs, or an orphan such as a second crate outside src/), or a non-anchored import names the package's own lib crate but was classified external."],
  ["RUST_STATIC_LIMIT", "The use sits inside an inline `mod x { }` body; or its path continues into an inline mod / item that has no file of its own; or the mod declaration is cfg-gated with no file."],
  ["MACRO_EXPANSION_LIMIT", "The resolved file contains macro_rules!/an invocation mentioning the imported name and no symbol of that name exists."],
  ["MODULE_RESOLUTION", "The independent oracle finds a file-backed module for the path, but the adapter's modulePathFor disagrees with the oracle module path of that file."],
  ["USE_RESOLUTION", "The oracle finds the target module file and modulePathFor agrees with it, yet the adapter left the import unresolved / resolved it to a different file; or the name appears only inside a `use` group the parser skips (nested use groups); or a non-anchored path names a mod/item/imported name in scope in the same file but was marked external; or a top-level braced `use {a::b, c::d};` was parsed as one import whose module text is the whole group; or the path continues two or more segments past the last file-backed module."],
  ["UNKNOWN", "FALLBACK: none of the rules above matched, including a resolved-name-missing case where the imported name does not appear anywhere in the resolved file's text (marked in the example detail). Reported unminimized; see UNKNOWN examples."],
] as const;

const generatedAt = new Date().toISOString();
const json = { generatedAt, spec: "docs/prompt/CONTEXTSLICE_V1.5_RUST_SUPPORT.md §67-74, §80", attributionRules: Object.fromEntries(ATTRIBUTION_RULES), repositories: results };
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "v1.5-phase1-rust-real-repositories.json"), `${JSON.stringify(json, null, 2)}\n`);

const table = (headers: string[], rows: Array<Array<string | number | null>>) =>
  [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c) => c ?? "n/a").join(" | ")} |`)].join("\n");
const col = <T>(f: (r: (typeof results)[number]) => T) => results.map(f);
const rate = (n: number, d: number) => `${n}/${d} (${pct(n, d) ?? "n/a"}%)`;
const md: string[] = [];
md.push("# v1.5 Phase 1: Rust module/use/re-export resolution on real repositories", "");
md.push(`Generated ${generatedAt} by \`npm run benchmark:v15-phase1\`. Every number below comes from that run.`, "");
md.push("## Benchmark scope", "");
md.push(table(["repo", "scale", "commit", "sparse scope"], results.map((r) => [r.id, r.scale, `\`${r.commit.slice(0, 12)}\``, r.sparse ? r.sparse.join(", ") : "whole repository"])), "");
md.push("Measured: module-path assignment (spec §72 `module_resolution_rate`), `use` resolution (`use_resolution_rate`), `pub use` re-export resolution (`reexport_resolution_rate`), failure attribution (§74) and cold/warm index time (§80, partial).", "");
md.push("NOT measured: semantic call recall/precision (Rust call resolution is Phase 2), retrieval / required-fact recall, context-reduction, and hand-written tasks. Oracles are independent of the adapter: filesystem layout, raw tree-sitter syntax, Cargo.toml text. `modulePathFor` is the subject under test, never the oracle.", "");
md.push("## Coverage and performance", "");
md.push(table(["metric", ...col((r) => r.id)], [
  [".rs files indexed / on disk", ...col((r) => `${r.coverage.rsFilesIndexed} / ${r.coverage.rsFilesOnDisk}`)],
  ["symbols", ...col((r) => r.coverage.symbols)],
  ["imports", ...col((r) => r.coverage.imports)],
  ["exports", ...col((r) => r.coverage.exports)],
  ["files with tree-sitter syntax error (oracle)", ...col((r) => r.coverage.filesWithParseError)],
  ["files emptied by adapter, i.e. no records (indexer cold parseErrors)", ...col((r) => `${r.coverage.filesSilentlyDropped.length} (${r.coverage.indexerReportedParseErrorsCold})`)],
  ["cold rebuild ms (indexer)", ...col((r) => r.performance.coldMs)],
  ["warm rebuild ms (indexer)", ...col((r) => r.performance.warmMs)],
  ["warm files parsed / cache hits", ...col((r) => `${r.performance.warmFilesParsed} / ${r.performance.warmCacheHits}`)],
  ["cold == warm resolved values", ...col((r) => (r.coldWarmIdentical ? "identical" : "DIFFERENT"))],
]), "");
md.push("## module_resolution_rate", "");
md.push("Oracle: crate roots are `src/lib.rs`, `src/main.rs`, `src/bin/*.rs` (and `src/bin/*/main.rs`), package-level `tests/*.rs`, `examples/*.rs` and `build.rs`, each with module path `[]`; every file-backed `mod foo;` is followed with the Rust filesystem rule (including declarations nested in inline `mod` bodies). `examples/*.rs` is added to the plan's root list because Cargo treats each as its own crate. Compared against `modulePathFor`.", "");
md.push(table(["metric", ...col((r) => r.id)], [
  ["files reached from a crate root", ...col((r) => r.moduleResolution.filesReached)],
  ["agree with modulePathFor", ...col((r) => rate(r.moduleResolution.agree, r.moduleResolution.filesReached))],
  ["disagree", ...col((r) => r.moduleResolution.disagree)],
  ["  of which CARGO_WORKSPACE_RESOLUTION", ...col((r) => r.moduleResolution.disagreeByCategory.CARGO_WORKSPACE_RESOLUTION ?? 0)],
  ["  of which MODULE_RESOLUTION", ...col((r) => r.moduleResolution.disagreeByCategory.MODULE_RESOLUTION ?? 0)],
  ["orphans (no parent declaration, not a root)", ...col((r) => r.moduleResolution.orphans.length)],
  ["mod declarations (file-backed)", ...col((r) => r.moduleResolution.declarations.total)],
  ["  file found", ...col((r) => r.moduleResolution.declarations.fileFound)],
  ["  file missing", ...col((r) => r.moduleResolution.declarations.fileMissing)],
  ["  skipped-path-attribute", ...col((r) => r.moduleResolution.declarations.skippedPathAttribute)],
]), "");
for (const r of results) {
  if (r.moduleResolution.disagreements.length) {
    md.push(`Disagreements in ${r.id}:`, "");
    md.push(table(["file", "oracle", "modulePathFor", "category"], r.moduleResolution.disagreements.map((d) => [`\`${d.file}\``, `[${d.oracle.join(", ")}]`, `[${d.modulePathFor.join(", ")}]`, d.category])), "");
  }
  if (r.moduleResolution.orphans.length)
    md.push(`Orphans in ${r.id}: ${r.moduleResolution.orphans.map((o) => `\`${o.file}\` (modulePathFor [${o.modulePathFor.join(", ")}])`).join(", ")}.`, "");
  if (r.moduleResolution.declarationsFileMissing.length)
    md.push(`Missing-file declarations in ${r.id}: ${r.moduleResolution.declarationsFileMissing.map((d) => `\`${d.file}:${d.line}\` mod ${d.name} (${d.detail})`).join("; ")}.`, "");
}
md.push("## use_resolution_rate", "");
md.push(table(["metric", ...col((r) => r.id)], [
  ["imports total", ...col((r) => r.coverage.imports)],
  ["anchored (crate/self/super)", ...col((r) => r.useResolution.anchored.total)],
  ["  resolved", ...col((r) => rate(r.useResolution.anchored.resolved, r.useResolution.anchored.total))],
  ["  unresolved", ...col((r) => r.useResolution.anchored.unresolved)],
  ["  resolved file agrees with oracle", ...col((r) => rate(r.useResolution.oracleCheck.agree, r.useResolution.oracleCheck.anchoredResolvedChecked))],
  ["  wildcard (resolved)", ...col((r) => `${r.useResolution.anchored.wildcard} (${r.useResolution.anchored.wildcardResolved})`)],
  ["non-anchored", ...col((r) => r.useResolution.nonAnchored.total)],
  ["  external", ...col((r) => r.useResolution.nonAnchored.external)],
  ["  local-resolved", ...col((r) => r.useResolution.nonAnchored.localResolved)],
  ["  local-resolved agrees with oracle", ...col((r) => rate(r.useResolution.oracleCheck.nonAnchoredLocalAgree, r.useResolution.oracleCheck.nonAnchoredLocalChecked))],
  ["  neither", ...col((r) => r.useResolution.nonAnchored.neither)],
  ["  wildcard (resolved)", ...col((r) => `${r.useResolution.nonAnchored.wildcard} (${r.useResolution.nonAnchored.wildcardResolved})`)],
  ["precision PROXY: resolved named imports where target has the name", ...col((r) => rate(r.useResolution.precisionProxy.contains, r.useResolution.precisionProxy.checked))],
  ["  unverifiable (enum-variant name)", ...col((r) => r.useResolution.precisionProxy.unverifiable)],
  ["  name missing", ...col((r) => r.useResolution.precisionProxy.missing)],
]), "");
md.push("External (non-anchored, `externalPackage` set) classified by Cargo.toml text:", "");
const extKeys = ["malformed-top-level-use-group", "std-family", "declared-dependency", "own-package-crate", "in-scope-local-item", "unverified"];
md.push(table(["class", ...col((r) => r.id)], extKeys.map((k) => [k, ...col((r) => r.useResolution.externalBreakdown[k] ?? 0)])), "");
for (const r of results) {
  if (r.useResolution.wrongFileExamples.length)
    md.push(`Anchored imports resolved to a different file than the oracle in ${r.id} (first ${r.useResolution.wrongFileExamples.length}):`, "", table(["at", "module", "resolved", "oracle", "category"], r.useResolution.wrongFileExamples.map((e: any) => [`\`${e.file}:${e.line}\``, e.module, e.resolvedFile, e.oracleFile, e.category])), "");
  if (r.useResolution.nameMissingSamples.length)
    md.push(`Resolved-but-name-missing samples in ${r.id} (${r.useResolution.nameMissingTotal} total, first ${r.useResolution.nameMissingSamples.length}):`, "", table(["at", "detail", "category"], r.useResolution.nameMissingSamples.map((e) => [`\`${e.file}:${e.line}\``, e.detail, e.category])), "");
}
md.push("## reexport_resolution_rate", "");
md.push(table(["metric", ...col((r) => r.id)], [
  ["export records", ...col((r) => r.reexportResolution.exportsTotal)],
  ["re-exports (`pub use`, have fromModule)", ...col((r) => r.reexportResolution.withFromModule)],
  ["  with resolvedFile", ...col((r) => rate(r.reexportResolution.withResolvedFile, r.reexportResolution.withFromModule))],
  ["  anchored (crate/self/super) with resolvedFile", ...col((r) => rate(r.reexportResolution.anchoredWithResolvedFile, r.reexportResolution.anchoredReexports))],
  ["non-wildcard with symbolId", ...col((r) => rate(r.reexportResolution.nonWildcardWithSymbolId, r.reexportResolution.nonWildcard))],
  ["wildcard with resolvedFile", ...col((r) => rate(r.reexportResolution.wildcardWithResolvedFile, r.reexportResolution.wildcard))],
]), "");
for (const r of results)
  if (r.reexportResolution.nonWildcardWithoutSymbolIdExamples.length)
    md.push(`Non-wildcard re-exports without symbolId in ${r.id}:`, "", table(["at", "from", "name", "resolvedFile", "external crate?"], r.reexportResolution.nonWildcardWithoutSymbolIdExamples.map((e) => [`\`${e.file}:${e.line}\``, e.fromModule ?? null, e.sourceName ?? null, e.resolvedFile, e.external ? "yes" : "no"])), "");
md.push("## Failure attribution (spec §74)", "");
md.push("Failures counted: anchored-unresolved imports, anchored imports resolved to a file the oracle disagrees with, `mod foo;` with no file, resolved-but-name-missing imports, and non-anchored imports marked external that name in-repo code. Rules are deterministic and applied in the order listed in the code:", "");
md.push(table(["category", "rule"], ATTRIBUTION_RULES.map(([c, rule]) => [c, rule])), "");
md.push(table(["category", ...col((r) => r.id)], [...CATEGORIES.map((c) => [c, ...col((r) => r.attribution.byCategory[c])]), ["total", ...col((r) => r.attribution.totalFailures)]]), "");
md.push("By failure kind:", "");
for (const r of results)
  md.push(`- ${r.id}: ${Object.entries(r.attribution.byKindCategory).map(([k, v]) => `${k} ${Object.entries(v).map(([c, n]) => `${c}=${n}`).join(",")}`).join("; ") || "no failures"}`);
md.push("");
for (const r of results)
  if (r.attribution.unknownExamples.length)
    md.push(`UNKNOWN examples in ${r.id}:`, "", table(["at", "kind", "detail", "source line"], r.attribution.unknownExamples.map((e) => [`\`${e.file}:${e.line}\``, e.kind, e.detail, `\`${e.sourceLine.replace(/\|/g, "\\|")}\``])), "");
md.push(findingsProse(results));
writeFileSync(join(outputDir, "v1.5-phase1-rust-real-repositories.md"), `${md.join("\n")}\n`);
console.log(`Wrote ${join(outputDir, "v1.5-phase1-rust-real-repositories.md")}`);
if (results.some((r) => !r.coldWarmIdentical)) {
  console.error("cold vs warm resolved values DIFFER");
  process.exitCode = 1;
}
