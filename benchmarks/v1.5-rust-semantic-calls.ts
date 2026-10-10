// v1.5 Phase 2 Rust semantic-call EVALUATION (scores the adapter against the frozen hand-derived labels).
//
//   npx tsx benchmarks/v1.5-rust-semantic-calls.ts [--split dev|held-out|all] [--final] [--repo <id>] [--out <path>] [--json]
//
// * Default split is `dev`. `held-out` / `all` are REFUSED unless `--final` is given; `--final` prints a
//   warning, requires no --repo and no earlier `completed` entry, and logs `started` then `completed` in HELDOUT_RUNS.log. Dev runs write nothing
//   into the repo (`--out` must resolve outside the repo tree unless `--final`).
// * DISK: the project volume is nearly full. Each checkout is COPIED into os.tmpdir() (a different volume),
//   indexed there (the `.context-slice` SQLite cache lives in the copy) and the copy is deleted in `finally`.
//   Nothing is ever written under benchmarks/checkouts/. Output is small text/JSON.
// * Labels are read-only. The scorer refuses to run if the frozen files no longer match FROZEN.sha256.
// * stdout is deterministic (no timings); timings go to stderr.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectIndex } from "../src/indexer/index.js";
import { parseRust } from "../src/languages/rust/parse.js";
import type { CallEdge, SymbolRecord } from "../src/types/model.js";
import { INDEX_VERSION } from "../src/storage/sqlite.js";
import { FROZEN_DIR, frozenLines } from "./rust-freeze-hash.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(FROZEN_DIR, "HELDOUT_RUNS.log");
export const REPOS = ["walkdir", "mini-redis", "ripgrep-ignore"] as const;
export const CATEGORIES = [
  "self-method",
  "field-method",
  "param-method",
  "local-method",
  "chained-method",
  "assoc-Self",
  "assoc-Type",
  "path-module",
  "path-generic",
  "bare-fn",
  "bare-closure-or-ctor",
  "qualified-trait",
  "macro-invocation",
];

// ---------------------------------------------------------------- types
export type Expected = {
  kind: "resolved" | "external" | "unresolvable";
  target?: { file: string; qualifiedName: string; kind: string; line: number };
  confidence: "exact" | "probable";
  why: string;
};
export type Label = {
  repo: string;
  file: string;
  line: number;
  col: number;
  callerQualifiedName: string;
  callText: string;
  calleeName: string;
  category: string;
  split: "dev" | "held-out";
  supplement?: string;
  traitMethods?: string[];
  expected: Expected;
};
export type Ratio = { k: number; n: number };
export type Outcome = {
  kind: "no-edge" | "unresolved" | "external" | "resolved";
  /** resolved only: target file+startLine equals the label's target (false when the label has no target). */
  correct?: boolean;
  confidence?: CallEdge["confidence"];
  /** Stable evidence prefixes present on the matched edge (`trait:`, `inherent:`, `ambiguous:`, `no-type:`, `no-symbol:`, `macro:`). */
  evidence: string[];
  resolutionKind?: string;
  receiverText?: string;
  /** Full evidence strings and external package of the matched edge (for inspection of failures). */
  detail?: string[];
  externalPackage?: string;
};
export type Row = { l: Label; o: Outcome };
export type Split = "dev" | "held-out" | "all";

const NAME_RULE = "is defined by no project symbol";
const PREFIXES = [
  "inherent:",
  "trait:",
  "ambiguous:",
  "no-type:",
  "no-symbol:",
  "macro:",
];
const ratio = (k: number, n: number): Ratio => ({ k, n });
const fmt = (r: Ratio) =>
  r.n === 0
    ? `${r.k}/0`
    : `${r.k}/${r.n} (${(Math.round((r.k / r.n) * 1000) / 10).toFixed(1)}%)`;

// ---------------------------------------------------------------- labels
/** Refuses labels the matcher cannot handle (the oracle names paren-callee sites "", none exist in the frozen set). */
export function validateLabels(labels: Label[]): void {
  for (const l of labels)
    if (!l.calleeName)
      throw new Error(
        `label ${l.repo}:${l.file}:${l.line}:${l.col} has an empty calleeName; matcher cannot handle it`,
      );
}

/** Refuses to score if the frozen ground truth was modified without a FROZEN.sha256 update (same canonical hash as the integrity test). */
export function assertFrozen(dir = FROZEN_DIR): void {
  const p = join(dir, "FROZEN.sha256");
  const committed = existsSync(p)
    ? readFileSync(p, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith("#"))
    : [];
  const actual = frozenLines(dir);
  if (JSON.stringify(actual) !== JSON.stringify(committed))
    throw new Error(
      "Ground truth does not match FROZEN.sha256: refusing to score. Fix via CORRECTIONS.md + hash regeneration.",
    );
}

export function loadLabels(
  repos: readonly string[] = REPOS,
  dir = FROZEN_DIR,
): Label[] {
  const labels = repos.flatMap(
    (r) => JSON.parse(readFileSync(join(dir, `${r}.json`), "utf8")) as Label[],
  );
  validateLabels(labels);
  return labels;
}

// ---------------------------------------------------------------- matching / outcome
const before = (l1: number, c1: number, l2: number, c2: number) =>
  l1 < l2 || (l1 === l2 && c1 < c2);
/**
 * The adapter's edge for a label: same file, call range contains the callee-token position (label.line 1-based,
 * label.col 0-based; range end exclusive) AND calleeName equal. Several matches (nested calls) => smallest range.
 */
export function matchLabelToEdge(
  label: Label,
  edges: CallEdge[],
): CallEdge | undefined {
  let best: CallEdge | undefined;
  const size = (e: CallEdge) =>
    (e.range.endLine - e.range.startLine) * 1e6 +
    (e.range.endColumn - e.range.startColumn);
  for (const e of edges) {
    if (
      e.filePath.split("\\").join("/") !== label.file ||
      e.calleeName !== label.calleeName
    )
      continue;
    const r = e.range;
    if (before(label.line, label.col, r.startLine, r.startColumn)) continue;
    if (!before(label.line, label.col, r.endLine, r.endColumn)) continue;
    if (!best || size(e) < size(best)) best = e;
  }
  return best;
}

/** Maps a matched edge (or none) to an outcome. Correctness = same file AND symbol.range.startLine === target.line. Never qualifiedName text. */
export function classifyOutcome(
  label: Label,
  edge: CallEdge | undefined,
  symbolsById: Map<string, SymbolRecord>,
): Outcome {
  if (!edge) return { kind: "no-edge", evidence: [] };
  const evidence = PREFIXES.filter((p) =>
    edge.evidence.some((e) => e.startsWith(p)),
  );
  const base = {
    evidence,
    confidence: edge.confidence,
    resolutionKind: edge.resolutionKind,
    receiverText: edge.receiverText,
    detail: edge.evidence,
    externalPackage: edge.externalPackage,
  };
  if (edge.resolvedTargetId) {
    const s = symbolsById.get(edge.resolvedTargetId);
    const t = label.expected.target;
    const correct =
      !!s &&
      !!t &&
      s.filePath.split("\\").join("/") === t.file &&
      s.range.startLine === t.line;
    return { kind: "resolved", correct, ...base };
  }
  if (edge.resolutionKind === "external-package" || edge.externalPackage)
    return { kind: "external", ...base };
  return { kind: "unresolved", ...base };
}

// ---------------------------------------------------------------- metrics
export type Metrics = {
  n: number;
  recallExact: Ratio;
  recallInclProbable: Ratio;
  precision: Ratio;
  externalAgreement: Ratio;
  falsePositiveEdgeRate: Ratio;
  wrongExact: number;
  wrongProbable: number;
  /** nameRule: agreements that come only from the "method name defined by no project symbol" rule (receiver type unknown). */
  externalBreakdown: {
    agree: number;
    nameRule: number;
    claimedResolved: number;
    unresolved: number;
    noEdge: number;
  };
  coverage: Ratio;
};

/** Metrics for a set of (non-macro) rows. */
export function scoreEntries(rows: Row[]): Metrics {
  const resolved = rows.filter((r) => r.l.expected.kind === "resolved");
  const external = rows.filter((r) => r.l.expected.kind === "external");
  const claims = rows.filter((r) => r.o.kind === "resolved");
  const correct = claims.filter(
    (r) => r.l.expected.kind === "resolved" && r.o.correct,
  );
  const wrong = claims.filter(
    (r) => !(r.l.expected.kind === "resolved" && r.o.correct),
  );
  const isCorrectResolved = (r: Row) =>
    r.l.expected.kind === "resolved" && r.o.kind === "resolved" && r.o.correct;
  return {
    n: rows.length,
    recallExact: ratio(
      resolved.filter((r) => isCorrectResolved(r) && r.o.confidence === "exact")
        .length,
      resolved.length,
    ),
    recallInclProbable: ratio(
      resolved.filter(isCorrectResolved).length,
      resolved.length,
    ),
    precision: ratio(correct.length, claims.length),
    externalAgreement: ratio(
      external.filter((r) => r.o.kind === "external").length,
      external.length,
    ),
    falsePositiveEdgeRate: ratio(wrong.length, rows.length),
    wrongExact: wrong.filter((r) => r.o.confidence === "exact").length,
    wrongProbable: wrong.filter((r) => r.o.confidence === "probable").length,
    externalBreakdown: {
      agree: external.filter((r) => r.o.kind === "external").length,
      nameRule: external.filter(
        (r) =>
          r.o.kind === "external" &&
          (r.o.detail ?? []).some((e) => e.includes(NAME_RULE)),
      ).length,
      claimedResolved: external.filter((r) => r.o.kind === "resolved").length,
      unresolved: external.filter((r) => r.o.kind === "unresolved").length,
      noEdge: external.filter((r) => r.o.kind === "no-edge").length,
    },
    coverage: ratio(
      rows.filter((r) => r.o.kind !== "no-edge").length,
      rows.length,
    ),
  };
}

// ---------------------------------------------------------------- failure attribution
export const FAILURE_CATEGORIES = [
  "CALL_RESOLUTION",
  "TRAIT_RESOLUTION",
  "IMPL_RESOLUTION",
  "USE_RESOLUTION",
  "MACRO_EXPANSION_LIMIT",
  "SYMBOL_INDEX",
  "PARSER",
  "GROUND_TRUTH",
  "UNKNOWN",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
/** Keyed by repo: symbolExists(repo,file,line); parseErrorFiles holds `repo:file`. */
export type AttributionContext = {
  symbolExists(repo: string, file: string, line: number): boolean;
  parseErrorFiles: Set<string>;
};
const METHOD_CATEGORIES = new Set([
  "self-method",
  "field-method",
  "param-method",
  "local-method",
  "chained-method",
  "assoc-Self",
  "assoc-Type",
]);
const PATH_CATEGORIES = new Set([
  "path-module",
  "path-generic",
  "bare-fn",
  "bare-closure-or-ctor",
]);

/**
 * null when the row is not a failure. Failure = label `resolved` and adapter not (resolved && correct);
 * adapter `resolved` on a label `external`/`unresolvable`; `no-edge` on anything. (label external + adapter
 * `unresolved` is a NEUTRAL miss, reported as a count, not attributed.)
 * Otherwise the FIRST matching rule wins (see the report for the table):
 *  1 no-edge -> PARSER if the file had a parse error, else UNKNOWN
 *  2 label target has no symbol at (file,line) in the index -> SYMBOL_INDEX
 *  3 adapter RESOLVED a macro-invocation or `unresolvable` label (false positive) -> CALL_RESOLUTION;
 *    macro-invocation label otherwise -> MACRO_EXPANSION_LIMIT
 *  4 label target kind trait-method-decl, category qualified-trait, or `trait:` evidence -> TRAIT_RESOLUTION
 *  5 `inherent:` evidence -> IMPL_RESOLUTION
 *  6 category: method-like -> IMPL_RESOLUTION (incl. chained-method on call receivers: a declared return type is learnable);
 *    path-like -> USE_RESOLUTION when label target is in another file than the call, else CALL_RESOLUTION
 *  7 anything else -> UNKNOWN
 * GROUND_TRUTH is never assigned automatically (needs reviewed evidence in CORRECTIONS.md).
 */
export function attributeFailure(
  l: Label,
  o: Outcome,
  ctx: AttributionContext,
): FailureCategory | null {
  const k = l.expected.kind;
  const failure =
    o.kind === "no-edge" ||
    (k === "resolved" && !(o.kind === "resolved" && o.correct)) ||
    (k !== "resolved" && o.kind === "resolved");
  if (!failure) return null;
  if (o.kind === "no-edge")
    return ctx.parseErrorFiles.has(`${l.repo}:${l.file}`)
      ? "PARSER"
      : "UNKNOWN";
  const t = l.expected.target;
  if (k === "resolved" && t && !ctx.symbolExists(l.repo, t.file, t.line))
    return "SYMBOL_INDEX";
  const macroish = l.category === "macro-invocation" || k === "unresolvable";
  if (macroish && o.kind === "resolved") return "CALL_RESOLUTION";
  if (l.category === "macro-invocation") return "MACRO_EXPANSION_LIMIT";
  if (
    t?.kind === "trait-method-decl" ||
    l.category === "qualified-trait" ||
    o.evidence.includes("trait:")
  )
    return "TRAIT_RESOLUTION";
  if (o.evidence.includes("inherent:")) return "IMPL_RESOLUTION";
  if (METHOD_CATEGORIES.has(l.category)) return "IMPL_RESOLUTION";
  if (PATH_CATEGORIES.has(l.category))
    return k === "resolved" && t && t.file !== l.file
      ? "USE_RESOLUTION"
      : "CALL_RESOLUTION";
  return "UNKNOWN";
}

// ---------------------------------------------------------------- report
export type Report = {
  split: Split;
  repos: string[];
  pooled: Metrics;
  byRepo: Record<string, Metrics>;
  byCategory: Record<string, Metrics>;
  bySplit: Record<string, Metrics & { n: number }>;
  macro: {
    n: number;
    unresolvedWithMacroEvidence: number;
    macroUnresolvedRate: Ratio;
    claimedResolved: number;
  };
  supplement: { n: number; metrics: Metrics };
  extraction: {
    labelled: Ratio;
    perRepo: Record<
      string,
      {
        labelled: Ratio;
        edges?: number;
        oracleTotal?: number;
        macroEdges?: number;
        oracleMacro?: number;
      }
    >;
  };
  trait: Record<string, number>;
  failures: {
    byCategory: Record<string, number>;
    rows: Array<{
      id: string;
      category: string;
      repo: string;
      split: string;
      label: string;
      outcome: string;
      attribution: FailureCategory;
      callText: string;
      why: string;
      evidence: string[];
    }>;
  };
  targetSymbolsPresent: Ratio;
  coldWarm?: Record<string, boolean>;
};
export type RepoCounts = Record<
  string,
  { total: number; "macro-invocation": number }
>;
export type BuildOpts = {
  split: Split;
  counts?:
    | Record<
        string,
        {
          total: number;
          edges: number;
          macroEdges: number;
          oracleTotal: number;
          oracleMacro: number;
        }
      >
    | undefined;
  ctx?: AttributionContext;
  coldWarm?: Record<string, boolean>;
};

const isMacro = (r: Row) => r.l.category === "macro-invocation";
const isSupp = (r: Row) => !!r.l.supplement;

/** All rows passed in are already restricted to the requested split(s) by the caller of buildReport OR filtered here. */
export function buildReport(allRows: Row[], opts: BuildOpts): Report {
  const rows = allRows.filter(
    (r) => opts.split === "all" || r.l.split === opts.split,
  );
  const ctx: AttributionContext = opts.ctx ?? {
    symbolExists: () => true,
    parseErrorFiles: new Set(),
  };
  const head = rows.filter((r) => !isMacro(r) && !isSupp(r));
  const group = (rs: Row[], key: (r: Row) => string) => {
    const out: Record<string, Metrics> = {};
    for (const k of [...new Set(rs.map(key))].sort())
      out[k] = scoreEntries(rs.filter((r) => key(r) === k));
    return out;
  };
  const macroRows = rows.filter((r) => isMacro(r) && !isSupp(r));
  const unresolvedMacro = macroRows.filter(
    (r) => r.o.kind === "unresolved" && r.o.evidence.includes("macro:"),
  ).length;
  const suppRows = rows.filter(isSupp);
  const traitRows = rows.filter((r) => !isMacro(r) && r.o.kind !== "no-edge");
  const trait: Record<string, number> = {
    "inherent-resolved": 0,
    "trait-declaration-resolved": 0,
    "trait-impl-resolved": 0,
    "other-resolved": 0,
    ambiguous: 0,
    unresolved: 0,
    "unresolved-no-type": 0,
    external: 0,
  };
  for (const r of traitRows) {
    const ev = r.o.evidence;
    if (r.o.kind === "resolved") {
      const key = ev.includes("inherent:")
        ? "inherent-resolved"
        : ev.includes("trait:")
          ? r.o.resolutionKind === "interface"
            ? "trait-declaration-resolved"
            : "trait-impl-resolved"
          : "other-resolved";
      trait[key]++;
    } else if (r.o.kind === "external") trait.external++;
    else if (ev.includes("ambiguous:")) trait.ambiguous++;
    else {
      trait.unresolved++;
      if (ev.includes("no-type:")) trait["unresolved-no-type"]++;
    }
  }
  const failRows: Report["failures"]["rows"] = [];
  const byCat: Record<string, number> = Object.fromEntries(
    FAILURE_CATEGORIES.map((c) => [c, 0]),
  );
  for (const r of rows) {
    const a = attributeFailure(r.l, r.o, ctx);
    if (!a) continue;
    byCat[a]++;
    failRows.push({
      id: `${r.l.repo}:${r.l.file}:${r.l.line}:${r.l.col}`,
      category: r.l.category,
      repo: r.l.repo,
      split: r.l.split,
      label:
        r.l.expected.kind === "resolved"
          ? `resolved ${r.l.expected.target?.file}:${r.l.expected.target?.line}`
          : r.l.expected.kind,
      outcome:
        r.o.kind === "resolved"
          ? `resolved(${r.o.correct ? "correct" : "wrong"},${r.o.confidence})`
          : r.o.kind,
      attribution: a,
      callText: r.l.callText,
      why: r.l.expected.why,
      evidence: r.o.detail ?? [],
    });
  }
  const resolvedLabels = rows.filter(
    (r) => r.l.expected.kind === "resolved" && r.l.expected.target,
  );
  const perRepo: Report["extraction"]["perRepo"] = {};
  for (const repo of [...new Set(rows.map((r) => r.l.repo))].sort()) {
    const rr = rows.filter((r) => r.l.repo === repo);
    const c = opts.counts?.[repo];
    perRepo[repo] = {
      labelled: ratio(
        rr.filter((r) => r.o.kind !== "no-edge").length,
        rr.length,
      ),
      ...(c
        ? {
            edges: c.edges,
            oracleTotal: c.oracleTotal,
            macroEdges: c.macroEdges,
            oracleMacro: c.oracleMacro,
          }
        : {}),
    };
  }
  return {
    split: opts.split,
    repos: [...new Set(rows.map((r) => r.l.repo))].sort(),
    pooled: scoreEntries(head),
    byRepo: group(head, (r) => r.l.repo),
    byCategory: group(head, (r) => r.l.category),
    bySplit: group(head, (r) => r.l.split) as Report["bySplit"],
    macro: {
      n: macroRows.length,
      unresolvedWithMacroEvidence: unresolvedMacro,
      macroUnresolvedRate: ratio(unresolvedMacro, macroRows.length),
      claimedResolved: macroRows.filter((r) => r.o.kind === "resolved").length,
    },
    supplement: { n: suppRows.length, metrics: scoreEntries(suppRows) },
    extraction: {
      labelled: ratio(
        rows.filter((r) => r.o.kind !== "no-edge").length,
        rows.length,
      ),
      perRepo,
    },
    trait,
    failures: { byCategory: byCat, rows: failRows },
    targetSymbolsPresent: ratio(
      resolvedLabels.filter((r) =>
        ctx.symbolExists(
          r.l.repo,
          r.l.expected.target!.file,
          r.l.expected.target!.line,
        ),
      ).length,
      resolvedLabels.length,
    ),
    ...(opts.coldWarm ? { coldWarm: opts.coldWarm } : {}),
  };
}

const CAVEAT =
  "CAVEAT: samples are tiny (tens of entries per repo, single digits per category); read every rate with its k/n. Rates are raw counts only, with no interval estimates.";

function metricsLines(m: Metrics, indent = "  "): string[] {
  return [
    `${indent}n (labelled, non-macro)      ${m.n}`,
    `${indent}recall_exact                ${fmt(m.recallExact)}`,
    `${indent}recall_incl_probable        ${fmt(m.recallInclProbable)}`,
    `${indent}precision                   ${fmt(m.precision)}`,
    `${indent}external_agreement          ${fmt(m.externalAgreement)}   [by name rule only ${m.externalBreakdown.nameRule}, claimed-resolved ${m.externalBreakdown.claimedResolved}, unresolved(neutral) ${m.externalBreakdown.unresolved}, no-edge ${m.externalBreakdown.noEdge}]`,
    `${indent}false_positive_edge_rate    ${fmt(m.falsePositiveEdgeRate)}   [wrong exact ${m.wrongExact}, wrong probable ${m.wrongProbable}]`,
    `${indent}extraction (edge found)     ${fmt(m.coverage)}`,
  ];
}
const row = (name: string, m: Metrics) =>
  `  ${name.padEnd(22)} n=${String(m.n).padStart(3)}  recall_exact ${fmt(m.recallExact).padEnd(14)} recall+probable ${fmt(m.recallInclProbable).padEnd(14)} precision ${fmt(m.precision).padEnd(12)} ext ${fmt(m.externalAgreement).padEnd(14)} FP ${fmt(m.falsePositiveEdgeRate)}`;

/** Deterministic text report (no timings). */
export function formatReport(r: Report): string {
  const o: string[] = [];
  o.push(
    `Rust semantic-call evaluation | split=${r.split} | repos=${r.repos.join(",")}`,
    CAVEAT,
    "",
  );
  o.push(
    "== POOLED HEADLINE (non-macro, non-supplement) ==",
    ...metricsLines(r.pooled),
    "",
  );
  o.push(
    "== PER SPLIT ==",
    ...Object.entries(r.bySplit).map(([k, m]) => row(k, m)),
    "",
  );
  o.push(
    "== PER REPO ==",
    ...Object.entries(r.byRepo).map(([k, m]) => row(k, m)),
    "",
  );
  o.push(
    "== PER CATEGORY (pooled) ==",
    ...CATEGORIES.filter((c) => r.byCategory[c]).map((c) =>
      row(c, r.byCategory[c]),
    ),
    "",
  );
  o.push(
    "== MACRO BLOCK (excluded from headline) ==",
    `  macro-labelled entries        ${r.macro.n}`,
    `  macro_unresolved_rate         ${fmt(r.macro.macroUnresolvedRate)}   (edge exists, unresolved, macro: evidence)`,
    `  adapter claimed a target      ${r.macro.claimedResolved}`,
    "",
  );
  o.push(
    `== SUPPLEMENT: trait-candidate (n=${r.supplement.n}; never mixed into the headline) ==`,
    ...metricsLines(r.supplement.metrics),
    "",
  );
  o.push(
    "== EXTRACTION COVERAGE ==",
    `  labelled entries with a matching edge (all incl. macro, supplement): ${fmt(r.extraction.labelled)}`,
  );
  for (const [repo, c] of Object.entries(r.extraction.perRepo)) {
    o.push(
      `  ${repo.padEnd(15)} labelled ${fmt(c.labelled)}` +
        (c.edges !== undefined
          ? `   edges ${c.edges} vs oracle total ${c.oracleTotal} (${fmt(ratio(c.edges, c.oracleTotal!))}); macro edges ${c.macroEdges} vs oracle ${c.oracleMacro}`
          : ""),
    );
  }
  o.push(
    `  label targets that exist as an indexed symbol (file,startLine): ${fmt(r.targetSymbolsPresent)}`,
    "",
  );
  o.push(
    "== TRAIT BREAKDOWN (matched non-macro edges, by evidence prefix) ==",
    ...Object.entries(r.trait).map(([k, v]) => `  ${k.padEnd(28)} ${v}`),
    "",
  );
  o.push(
    "== FAILURE ATTRIBUTION ==",
    ...Object.entries(r.failures.byCategory).map(
      ([k, v]) => `  ${k.padEnd(24)} ${v}`,
    ),
    `  (UNKNOWN is never hidden; GROUND_TRUTH is never auto-assigned; label external + adapter unresolved is a neutral miss, not a failure)`,
  );
  const unknown = r.failures.rows.filter((f) => f.attribution === "UNKNOWN");
  if (unknown.length)
    o.push(
      "  UNKNOWN rows:",
      ...unknown.map(
        (f) =>
          `    ${f.id} [${f.category}] label=${f.label} outcome=${f.outcome} | ${f.callText}`,
      ),
    );
  o.push("");
  if (r.coldWarm)
    o.push(
      "== COLD == WARM ==",
      ...Object.entries(r.coldWarm).map(
        ([k, v]) => `  ${k.padEnd(15)} ${v ? "identical" : "DIFFERENT"}`,
      ),
    );
  return o.join("\n");
}

// ---------------------------------------------------------------- split gate
export type Gate = { ok: true } | { ok: false; message: string };
/** Held-out / all need --final; --final needs all repos and no completed held-out run. Pure: never writes. */
export function gateSplit(
  split: string,
  final: boolean,
  logPath = LOG_PATH,
  repo?: string,
): Gate {
  if (split !== "dev" && split !== "held-out" && split !== "all")
    return {
      ok: false,
      message: `unknown --split '${split}' (dev|held-out|all)`,
    };
  if (split !== "dev" && !final)
    return {
      ok: false,
      message: `Refusing --split ${split}: the held-out split is measured exactly once at the end. Pass --final only for that run.`,
    };
  if (final && repo)
    return {
      ok: false,
      message:
        "Refusing --final with --repo: a final run must cover all repos.",
    };
  if (
    final &&
    split !== "dev" &&
    existsSync(logPath) &&
    readFileSync(logPath, "utf8")
      .split("\n")
      .some((l) => {
        const f = l.split(" ");
        return !l.startsWith("#") && f[2] !== "dev" && f[3] === "completed";
      })
  )
    return {
      ok: false,
      message: `Refusing --final: the single held-out run was already performed (see ${logPath}). Changing this requires a human editing the log and a note in CORRECTIONS.md.`,
    };
  return { ok: true };
}

export const LOG_HEADER =
  "# Held-out split runs. Exactly one COMPLETED entry allowed by the end of the evaluation.\n" +
  "# Each line: ISO date, git HEAD short sha, split, `started` (+ invoked by) or `completed`.\n" +
  "# A `started` line without `completed` is a crashed run (visible, does not block a rerun); a `completed` line blocks further --final runs.\n";
const appendLog = (
  logPath: string,
  sha: string,
  split: string,
  what: string,
) => {
  if (!existsSync(logPath)) writeFileSync(logPath, LOG_HEADER);
  appendFileSync(
    logPath,
    `${new Date().toISOString()} ${sha} ${split} ${what}\n`,
  );
};
/**
 * Runs `work`. For a --final held-out/all run: gate, append `started`, run, append `completed` only on success
 * (a throw leaves just `started`). Otherwise (dev) nothing is logged.
 */
export function runGuarded<T>(
  o: {
    split: string;
    final: boolean;
    repo?: string;
    logPath: string;
    sha: string;
    invokedBy: string;
  },
  work: () => T,
): { ok: true; value: T } | { ok: false; message: string } {
  const g = gateSplit(o.split, o.final, o.logPath, o.repo);
  if (!g.ok) return g;
  if (o.split === "dev") return { ok: true, value: work() };
  appendLog(o.logPath, o.sha, o.split, `started ${o.invokedBy}`);
  const value = work();
  appendLog(o.logPath, o.sha, o.split, "completed");
  return { ok: true, value };
}

// ---------------------------------------------------------------- indexing (copies in os.tmpdir())
const SKIP = new Set([".git", "target", ".context-slice", "node_modules"]);
function rsFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    SKIP.has(e.name)
      ? []
      : e.isDirectory()
        ? rsFiles(join(dir, e.name), base)
        : e.name.endsWith(".rs")
          ? [relative(base, join(dir, e.name)).split("\\").join("/")]
          : [],
  );
}
const norm = (p: string) => p.split("\\").join("/");

/** Indexes `dir` (must be a scratch copy: the SQLite cache is written into it) cold then warm and checks identity. */
export function indexRepo(dir: string) {
  const index = new ProjectIndex(dir);
  const snap = () =>
    JSON.stringify({
      calls: index.calls.map((c) => [
        c.filePath,
        c.range,
        c.calleeName,
        c.receiverText,
        c.receiverType,
        c.resolvedTargetId,
        c.externalPackage,
        c.confidence,
        c.resolutionKind,
        c.evidence,
      ]),
      symbols: index.symbols.map((s) => [s.id, s.filePath, s.range.startLine]),
    });
  let t = performance.now();
  index.rebuild();
  const coldMs = performance.now() - t;
  const cold = snap();
  t = performance.now();
  index.rebuild();
  const warmMs = performance.now() - t;
  const coldWarmIdentical = cold === snap();
  const calls = index.calls.filter(
    (c) =>
      (c.language ?? "rust") === "rust" && norm(c.filePath).endsWith(".rs"),
  );
  const symbols = index.symbols.filter((s) => norm(s.filePath).endsWith(".rs"));
  const symbolsById = new Map(index.symbols.map((s) => [s.id, s]));
  const at = new Set(
    symbols.map((s) => `${norm(s.filePath)}:${s.range.startLine}`),
  );
  const parseErrorFiles = new Set<string>();
  for (const f of rsFiles(dir))
    if (parseRust(f, readFileSync(join(dir, f), "utf8")).parseError)
      parseErrorFiles.add(f);
  index.close();
  return {
    calls,
    symbols,
    symbolsById,
    parseErrorFiles,
    coldMs,
    warmMs,
    coldWarmIdentical,
    symbolExists: (file: string, line: number) => at.has(`${file}:${line}`),
  };
}

// ---------------------------------------------------------------- final run metadata + markdown report
export type FinalRun = {
  meta: { date: string; head: string; indexVersion: string; argv: string };
  reports: { dev: Report; "held-out": Report; all: Report };
  timingsMs: Record<string, { cold: number; warm: number }>;
  counts: Record<string, Record<string, number>>;
  independence: Array<{ what: string; command: string; output: string }>;
};
// `git grep` exits 1 when nothing matches: that is the clean case, reported as empty output.
const git = (...a: string[]) => {
  try {
    return execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
/** Leakage / independence checks, recorded verbatim (empty output = clean). */
export function independenceChecks(): FinalRun["independence"] {
  const freeze = git(
    "log",
    "--format=%h",
    "--grep",
    "freeze Rust semantic-call ground truth",
    "-1",
  );
  const checks: Array<[string, string[]]> = [
    [
      "src/ mentions no benchmark repo or semantic-calls name",
      [
        "grep",
        "-nIE",
        "semantic-calls|walkdir|mini-redis|mini_redis|ripgrep",
        "--",
        "src",
      ],
    ],
    [
      "oracle, freeze hash and label files import nothing from src/ or the indexer",
      [
        "grep",
        "-nE",
        String.raw`\.\./src/|ProjectIndex|parseRust|resolveRust|modulePathFor`,
        "--",
        "benchmarks/rust-call-oracle.ts",
        "benchmarks/rust-freeze-hash.ts",
        "benchmarks/rust-semantic-calls",
      ],
    ],
    [
      `label/sample files changed after the freeze commit ${freeze}`,
      [
        "log",
        "--oneline",
        `${freeze}..HEAD`,
        "--",
        "benchmarks/rust-semantic-calls/*.json",
      ],
    ],
  ];
  return checks.map(([what, a]) => ({
    what,
    command: `git ${a.join(" ")}`,
    output: git(...a),
  }));
}

const pct = (r: Ratio) =>
  r.n === 0 ? `${r.k}/0` : `${r.k}/${r.n} (${((r.k / r.n) * 100).toFixed(1)}%)`;
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (head: string[], rows: string[][]) =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

/** Markdown results report from a final run's JSON. Numbers come only from `f`; the prose sections are fixed disclosures. */
export function renderMarkdown(f: FinalRun, notes = ""): string {
  const S = ["dev", "held-out", "all"] as const;
  const R = f.reports;
  const metricRows = (pick: (r: Report) => Metrics): string[][] => [
    ["n (labelled, non-macro)", ...S.map((k) => String(pick(R[k]).n))],
    ["recall_exact", ...S.map((k) => pct(pick(R[k]).recallExact))],
    [
      "recall_incl_probable",
      ...S.map((k) => pct(pick(R[k]).recallInclProbable)),
    ],
    ["precision", ...S.map((k) => pct(pick(R[k]).precision))],
    ["external_agreement", ...S.map((k) => pct(pick(R[k]).externalAgreement))],
    [
      "  of which by the name rule only",
      ...S.map((k) => String(pick(R[k]).externalBreakdown.nameRule)),
    ],
    [
      "  external left unresolved (neutral)",
      ...S.map((k) => String(pick(R[k]).externalBreakdown.unresolved)),
    ],
    [
      "false_positive_edge_rate",
      ...S.map((k) => pct(pick(R[k]).falsePositiveEdgeRate)),
    ],
    [
      "  wrong exact / wrong probable",
      ...S.map((k) => `${pick(R[k]).wrongExact} / ${pick(R[k]).wrongProbable}`),
    ],
    ["extraction (edge found)", ...S.map((k) => pct(pick(R[k]).coverage))],
  ];
  const mRow = (name: string, m: Metrics) => [
    name,
    String(m.n),
    pct(m.recallExact),
    pct(m.precision),
    pct(m.externalAgreement),
    pct(m.falsePositiveEdgeRate),
  ];
  const mHead = ["", "n", "recall_exact", "precision", "external", "FP rate"];
  const catRows = (k: (typeof S)[number]) =>
    CATEGORIES.filter((c) => R[k].byCategory[c]).map((c) =>
      mRow(c, R[k].byCategory[c]),
    );
  const repoRows = (k: (typeof S)[number]) =>
    Object.entries(R[k].byRepo).map(([repo, m]) => mRow(repo, m));
  const indep = f.independence
    .map(
      (c) =>
        `- ${c.what}\n\n  \`${c.command}\`\n\n  \`\`\`\n  ${c.output || "(no output)"}\n  \`\`\``,
    )
    .join("\n");
  const failures = R.all.failures.rows.map((x) => [
    x.id,
    x.split,
    x.category,
    x.label,
    x.outcome,
    x.attribution,
    `\`${esc(x.callText)}\``,
    esc(x.evidence.join("; ")),
  ]);
  const ext = (k: (typeof S)[number]) =>
    `${R[k].pooled.externalBreakdown.nameRule} of ${R[k].pooled.externalAgreement.k}`;
  const o: string[] = [
    "# v1.5 Phase 2: Rust semantic-call resolution, measured on real repositories",
    "",
    `Generated by \`npx tsx benchmarks/v1.5-rust-semantic-calls.ts --report <json>\` from the single final run (\`${f.meta.argv}\`) at commit \`${f.meta.head}\`, ${f.meta.date}, INDEX_VERSION ${f.meta.indexVersion}. Numbers are copied from that run's JSON; nothing is hand-edited.`,
    "",
    "## Scope",
    "- Three pinned repositories: walkdir, mini-redis, ripgrep `crates/ignore` (sparse checkout: only `crates/ignore` is indexed; other ripgrep crates are external).",
    `- Ground truth: ${R.all.pooled.n} non-macro headline entries and ${R.all.macro.n} macro entries from a stratified sample, plus ${R.all.supplement.n} trait-candidate supplement entries. Hand-derived from source, blind re-verified (Task 5: 99/99 kind, 43/43 resolved targets, 0 disagreements; labeller and verifier were both LLMs, so this is consistency evidence, not proof), frozen before any resolver code.`,
    `- Split by a fixed hash rule: dev n=${R.dev.pooled.n}, held-out n=${R["held-out"].pooled.n} headline entries. The resolver was iterated on dev only; held-out was measured once, in this run.`,
    "- The main sample is stratified by syntactic category (fixed quotas per category), so every pooled rate is a rate over this sample, not an estimate of the whole-repo rate.",
    "- Not measured: whole-repo recall and whole-repo precision (only sampled sites), calls inside macro arguments (not extracted by design), resolution into ripgrep crates outside the sparse scope, `Self::f()` (0 real sites), qualified-trait calls (0 real sites).",
    "",
    "## Headline (non-macro, non-supplement)",
    "Samples are tiny (tens of entries per split, single digits per category): read every rate with its k/n. No interval estimates are given.",
    "",
    table(
      ["metric", "dev", "held-out", "pooled"],
      metricRows((r) => r.pooled),
    ),
    "",
    `Dev/held-out gap: recall_exact dev ${pct(R.dev.pooled.recallExact)} vs held-out ${pct(R["held-out"].pooled.recallExact)}; precision dev ${pct(R.dev.pooled.precision)} vs held-out ${pct(R["held-out"].pooled.precision)}; external agreement dev ${pct(R.dev.pooled.externalAgreement)} vs held-out ${pct(R["held-out"].pooled.externalAgreement)}. Dev was tuned on; held-out is the honest estimate.`,
    "",
    "### Per repo",
    ...S.flatMap((k) => [
      `**${k}**`,
      "",
      table(["repo", ...mHead.slice(1)], repoRows(k)),
      "",
    ]),
    "### Per category",
    "Categories are syntactic (oracle). `local-method` detection is flow-insensitive; `bare-closure-or-ctor` mixes constructors and closure calls.",
    "",
    ...S.flatMap((k) => [
      `**${k}**`,
      "",
      table(["category", ...mHead.slice(1)], catRows(k)),
      "",
    ]),
    "## Macro block (excluded from the headline)",
    table(
      ["", ...S],
      [
        ["macro-labelled entries", ...S.map((k) => String(R[k].macro.n))],
        [
          "macro_unresolved_rate",
          ...S.map((k) => pct(R[k].macro.macroUnresolvedRate)),
        ],
        [
          "adapter claimed a target",
          ...S.map((k) => String(R[k].macro.claimedResolved)),
        ],
      ],
    ),
    "",
    "## Trait-candidate supplement (never mixed into the headline)",
    "Sites whose callee name equals a method of an in-repo trait. Most are same-named methods on unrelated types, so this block mainly measures false-positive resistance. Only 2 entries are real in-repo trait dispatch (ripgrep-ignore `walk.rs:1821` and `walk.rs:1837`, through `Box<dyn ParallelVisitor>`, labelled `probable` trait declaration).",
    "",
    table(
      ["metric", "dev", "held-out", "pooled"],
      metricRows((r) => r.supplement.metrics),
    ),
    "",
    "## Trait-resolution breakdown (spec §73)",
    "Matched non-macro edges including the supplement, bucketed by evidence prefix.",
    "",
    table(
      ["bucket", ...S],
      Object.keys(R.all.trait).map((b) => [
        b,
        ...S.map((k) => String(R[k].trait[b])),
      ]),
    ),
    "",
    "## Extraction coverage",
    table(
      [
        "repo",
        "labelled entries with an edge",
        "edges",
        "oracle total",
        "macro edges",
        "oracle macro",
        "oracle hiddenInMacro (not extracted)",
      ],
      Object.entries(R.all.extraction.perRepo).map(([repo, c]) => [
        repo,
        pct(c.labelled),
        String(c.edges),
        String(c.oracleTotal),
        String(c.macroEdges),
        String(c.oracleMacro),
        String(f.counts[repo]?.hiddenInMacro ?? ""),
      ]),
    ),
    "",
    `Label targets that exist as an indexed symbol at (file, startLine): ${pct(R.all.targetSymbolsPresent)}.`,
    "",
    "## Failure attribution (spec §74)",
    "Rules, first match wins: no edge -> PARSER if the file has a parse error, else UNKNOWN; label target not indexed -> SYMBOL_INDEX; adapter resolved a macro/unresolvable label -> CALL_RESOLUTION, other macro label -> MACRO_EXPANSION_LIMIT; trait-method-decl target, qualified-trait or `trait:` evidence -> TRAIT_RESOLUTION; `inherent:` evidence or a method-like category -> IMPL_RESOLUTION; path-like category -> USE_RESOLUTION if the target is in another file, else CALL_RESOLUTION; else UNKNOWN. GROUND_TRUTH is never auto-assigned. Label external + adapter unresolved is a neutral miss, not a failure.",
    "",
    table(
      ["category", ...S],
      FAILURE_CATEGORIES.map((c) => [
        c,
        ...S.map((k) => String(R[k].failures.byCategory[c])),
      ]),
    ),
    "",
    "Every failure row (all splits, including supplement and macro):",
    "",
    failures.length
      ? table(
          [
            "entry",
            "split",
            "category",
            "label",
            "adapter",
            "attribution",
            "call",
            "adapter evidence",
          ],
          failures,
        )
      : "(none)",
    "",
    "## Cold vs warm",
    table(
      ["repo", "cold == warm", "cold ms", "warm ms"],
      Object.keys(f.timingsMs)
        .sort()
        .map((r) => [
          r,
          R.all.coldWarm?.[r] ? "identical" : "DIFFERENT",
          String(f.timingsMs[r].cold),
          String(f.timingsMs[r].warm),
        ]),
    ),
    "",
    `Timings are one run on one machine (indexing a temp copy, SQLite cache included) at commit \`${f.meta.head}\`, not a benchmark. Later rebuild-cost measurements are in the Performance section.`,
    "",
    "## Performance of call extraction",
    "Measured in the Task 6 review, not by this script: `parseRust` with call extraction is +65-69% slower than the Phase 1 parser on real files (ripgrep-ignore `dir.rs` 26.5 -> 44.7 ms, `walk.rs` 43.5 -> 73.1 ms, `incremental.rs` 23.1 -> 38.2 ms; synthetic 1 MiB file 1117 -> 1792 ms), linear in file size. Cause: a second tree traversal; merging the traversals is deferred.",
    "",
    "Rebuild cost vs `main` (no Rust call resolution), measured after the final run with a scratch script (full rebuild of a temp copy, same machine; warm = second rebuild of an unchanged tree). The indexer re-resolves every unresolved or external Rust edge on every rebuild (`src/indexer/index.ts`, shared rebuild path), so warm rebuilds pay the resolver again:",
    "",
    table(
      [
        "repo",
        "main cold / warm ms",
        "final-run commit cold / warm ms",
        "after the perf fix cold / warm ms",
      ],
      [
        ["walkdir", "87-93 / 7-12", "207-213 / 60-66", "204-218 / 29-38"],
        ["mini-redis", "115-119 / 12-14", "218-226 / 75-82", "215-219 / 34-45"],
        [
          "ripgrep-ignore",
          "197-202 / 19-22",
          "558-569 / 242-255",
          "490-497 / 96-123",
        ],
      ],
    ),
    "",
    "So cold rebuilds are about 2.2-2.5x and warm rebuilds about 3-5x slower than `main` after the fix (before it: cold 2.5-2.9x, warm 6-12x). The fix (a per-file cache for a whole-file text scan that ran on every glob lookup, an index of top-level symbols by name, and parse trees reused across rebuilds while the text is unchanged) made resolution roughly linear in file size: a generated single `lib.rs` of 122K/244K/488K/976K chars went from 0.8/2.1/6.1/20.4 s cold to 0.55/1.0/1.9/4.1 s cold (warm 0.3/0.8/2.6/8.8 s -> 0.1/0.16/0.32/0.77 s). Every Rust edge of the three checkouts is byte-identical before and after the fix (cold and warm), so the measured tables above are unaffected.",
    "",
    "## Independence and leakage checks (run by this script)",
    indep,
    "",
    "Ground-truth corrections: `benchmarks/rust-semantic-calls/CORRECTIONS.md` holds six `why`-text-only edits made at the freeze; no kind, target or confidence changed. The last check above lists any later label-file commit.",
    "",
    "## Honesty notes and known limits",
    `- Thin samples: pooled headline n=${R.all.pooled.n} (dev ${R.dev.pooled.n}, held-out ${R["held-out"].pooled.n}). Per-repo and per-category held-out rates rest on a few entries each and are not interpretable alone.`,
    "- `assoc-Self` has 0 real sites in all three repos (`Self::f()` never appears in code) and qualified-trait has 0: spec §25/§27 are covered only by synthetic tests.",
    "- Only 2 real in-repo trait-dispatch entries exist (supplement, above): trait dispatch on real code is barely measured.",
    `- External agreement partly comes from a name rule: a method whose receiver type is unknown and whose name no project symbol defines is classed external (\`std-or-dependency\`, probable). Agreements from that rule alone: dev ${ext("dev")}, held-out ${ext("held-out")}.`,
    "- Dev tuning: resolver rules were developed while looking at dev failures (each with a synthetic test), so dev numbers are optimistic. The held-out column is the honest number.",
    "- Cached RESOLVED edges are not re-resolved on warm rebuilds (shared indexer behaviour): an edit in another file can leave a stale or dangling edge until a cold rebuild. INDEX_VERSION only protects against old cache formats.",
    "- In-repo blanket impls only make competing candidates ambiguous; their bounds are not checked.",
    "- Macros are structural only: no expansion, and calls inside macro arguments are not extracted.",
    "- No inference for closures, iterator adapters, `for`/`match`/`if let` patterns, `.await`, or external return types.",
    "- A library imported by its own crate name (`use <crate>::...` from `tests/` or `src/bin/`) is not mapped to the local library (the import is marked external; crate identity needs Cargo.toml), so calls through it stay unresolved.",
    "- Dev history, quoted from the task reports (earlier commits, same script, dev split): no resolver 0/21 recall_exact, 0/24 external; structural resolution (Task 7) 10/21, precision 10/10, external 11/24; typed receivers (Task 8) 20/21, 20/20, 24/24, FP 0/45.",
    "- Parse slowdown of +65-69% from call extraction (see Performance).",
  ];
  if (notes.trim())
    o.push(
      "",
      "## Analysis (written after the run, from the rows above)",
      "",
      notes.trim(),
    );
  return o.join("\n") + "\n";
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv: string[]) {
  const a = {
    split: "dev",
    final: false,
    repo: undefined as string | undefined,
    out: undefined as string | undefined,
    json: false,
    report: undefined as string | undefined,
    notes: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--split") a.split = argv[++i] ?? "";
    else if (v === "--final") a.final = true;
    else if (v === "--repo") a.repo = argv[++i];
    else if (v === "--out") a.out = argv[++i];
    else if (v === "--json") a.json = true;
    else if (v === "--report") a.report = argv[++i];
    else if (v === "--notes") a.notes = argv[++i];
    else throw new Error(`unknown argument ${v}`);
  }
  return a;
}
const insideRepo = (p: string) => {
  const rel = relative(REPO_ROOT, resolve(p));
  return !rel.startsWith("..") && !isAbsolute(rel);
};
const die = (msg: string): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
};

function main() {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    return die(String((e as Error).message));
  }
  if (args.report) {
    // Report mode: renders the .md next to a final run's JSON. Reads JSON only: no indexing, no gate, no log.
    const f = JSON.parse(readFileSync(args.report, "utf8")) as FinalRun;
    if (!f.reports?.["held-out"])
      return die(`${args.report} is not a final --split all run`);
    const md = args.report.replace(/\.json$/, ".md");
    writeFileSync(
      md,
      renderMarkdown(f, args.notes ? readFileSync(args.notes, "utf8") : ""),
    );
    process.stdout.write(`wrote ${md}\n`);
    return;
  }
  const gate = gateSplit(
    args.split,
    args.final,
    LOG_PATH,
    args.final ? args.repo : undefined,
  );
  if (!gate.ok) return die(gate.message);
  if (args.out && insideRepo(args.out) && !args.final)
    return die(
      `Refusing --out ${args.out}: must resolve outside the repo tree (dev runs write nothing into the repo).`,
    );
  if (args.repo && !(REPOS as readonly string[]).includes(args.repo))
    return die(`unknown --repo ${args.repo}`);
  try {
    assertFrozen();
  } catch (e) {
    return die(String((e as Error).message));
  }
  const split = args.split as Split;
  const repos = args.repo ? [args.repo] : [...REPOS];
  if (args.split !== "dev")
    process.stderr.write(
      "\x1b[1m*** HELD-OUT SPLIT: this is the ONE final measurement. It is logged in HELDOUT_RUNS.log. Do not iterate on it. ***\x1b[0m\n",
    );
  const sha =
    args.split === "dev"
      ? ""
      : execFileSync("git", ["rev-parse", "--short", "HEAD"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        }).trim();
  const by = `${userInfo().username} via ${process.argv.slice(1).join(" ").replace(REPO_ROOT, ".")}`;
  const res = runGuarded(
    {
      split: args.split,
      final: args.final,
      repo: args.final ? args.repo : undefined,
      logPath: LOG_PATH,
      sha,
      invokedBy: by,
    },
    () => evaluate(repos, split, args),
  );
  if (!res.ok) return die(res.message);
  if (res.value) process.exit(1);
}

/** Indexes copies, scores, prints. Returns true if cold != warm for any repo. */
function evaluate(
  repos: string[],
  split: Split,
  args: ReturnType<typeof parseArgs>,
): boolean {
  const labels = loadLabels(repos);
  const counts = JSON.parse(
    readFileSync(join(FROZEN_DIR, "counts.json"), "utf8"),
  );
  const rows: Row[] = [];
  const cw: Record<string, boolean> = {};
  const repoStats: NonNullable<BuildOpts["counts"]> = {};
  const symKeys = new Set<string>();
  const parseErrs = new Set<string>();
  const timings: string[] = [];
  const timingsMs: Record<string, { cold: number; warm: number }> = {};
  const tmpRoot = mkdtempSync(join(tmpdir(), "rust-semantic-calls-"));
  try {
    for (const repo of repos) {
      // Label `file` is relative to the checkout root (ripgrep-ignore: crates/ignore/src/...), same base as ProjectIndex paths.
      const copy = join(tmpRoot, repo);
      cpSync(join(REPO_ROOT, "benchmarks/checkouts", repo), copy, {
        recursive: true,
        filter: (s) => !SKIP.has(s.split("/").pop()!),
      });
      const idx = indexRepo(copy);
      cw[repo] = idx.coldWarmIdentical;
      timings.push(
        `${repo}: cold ${idx.coldMs.toFixed(0)} ms, warm ${idx.warmMs.toFixed(0)} ms`,
      );
      timingsMs[repo] = {
        cold: Math.round(idx.coldMs),
        warm: Math.round(idx.warmMs),
      };
      for (const l of labels.filter((x) => x.repo === repo)) {
        if (!existsSync(join(copy, l.file)))
          throw new Error(
            `label file ${l.file} not found in ${repo} checkout: path mapping is wrong`,
          );
        rows.push({
          l,
          o: classifyOutcome(
            l,
            matchLabelToEdge(l, idx.calls),
            idx.symbolsById,
          ),
        });
      }
      const c = counts[repo];
      repoStats[repo] = {
        total: c.total,
        edges: idx.calls.length,
        oracleTotal: c.total,
        macroEdges: idx.calls.filter((e) =>
          e.evidence.some((x) => x.startsWith("macro:")),
        ).length,
        oracleMacro: c["macro-invocation"],
      };
      idx.symbols.forEach((sy) =>
        symKeys.add(
          `${repo}:${sy.filePath.split("\\").join("/")}:${sy.range.startLine}`,
        ),
      );
      idx.parseErrorFiles.forEach((f) => parseErrs.add(`${repo}:${f}`));
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  const attrib: AttributionContext = {
    symbolExists: (r, f, l) => symKeys.has(`${r}:${f}:${l}`),
    parseErrorFiles: parseErrs,
  };
  const build = (sp: Split) =>
    buildReport(rows, {
      split: sp,
      counts: repoStats,
      ctx: attrib,
      coldWarm: cw,
    });
  const report = build(split);
  // A final `all` run carries dev, held-out and pooled reports from ONE indexing pass, plus run metadata for the results file.
  const final: FinalRun | undefined =
    split === "all"
      ? {
          meta: {
            date: new Date().toISOString(),
            head: git("rev-parse", "--short", "HEAD"),
            indexVersion: INDEX_VERSION,
            argv: process.argv.slice(2).join(" "),
          },
          reports: {
            dev: build("dev"),
            "held-out": build("held-out"),
            all: report,
          },
          timingsMs,
          counts,
          independence: independenceChecks(),
        }
      : undefined;
  const out = final ?? report;
  const text = args.json
    ? JSON.stringify(out, null, 2)
    : final
      ? (["dev", "held-out", "all"] as const)
          .map((k) => formatReport(final.reports[k]))
          .join("\n\n")
      : formatReport(report);
  process.stdout.write(`${text}\n`);
  process.stderr.write(
    `timings (non-deterministic):\n${timings.map((t) => `  ${t}`).join("\n")}\n`,
  );
  if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n");
  return Object.values(cw).some((v) => !v);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
