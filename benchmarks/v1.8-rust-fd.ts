// v1.8 Rust real-repository hand-verification: sharkdp/fd (medium-scale CLI application).
// Every oracle entry below was read directly from the pinned checkout at
// benchmarks/checkouts/fd (commit 14dcd92fb76ca0ebc2e82671a275f67c790d25fc) during this task's
// own execution — not copied from another repo's benchmark and not guessed from memory.
//
// One scope note, intentional (see src/languages/rust/calls-resolve.ts):
// - filter/size.rs:61 `SizeFilter::Min(size)` is an enum tuple-variant constructor call. The
//   Rust resolver deliberately leaves bare `Enum::Variant(..)` calls unresolved
//   (`no-symbol:variant` evidence) because a variant is not a callable symbol in the index.
//   This is the documented, correct behavior, not a miss.
//
// FIXED (was a KNOWN GAP): dir_entry.rs:87 `self.metadata()` inside `DirEntry::file_type()`.
// `DirEntry` has an inherent `metadata()` (line 91) AND an unrelated `impl Colorable for
// DirEntry` method also named `metadata()` (line 166). memberOf() used to report any 2+
// same-named candidates on a type as unconditionally ambiguous, regardless of origin. Real
// Rust always picks the inherent method over a trait method of the same name (inherent
// methods are tried first in method resolution, no ambiguity exists), so memberOf() now
// settles on the sole inherent candidate when exactly one exists among the collisions.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

type Repository = { id: string; source: string };
const repositories: Repository[] = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "benchmarks/rust-repositories-extra.json"),
    "utf8",
  ),
) as Repository[];
const repo = repositories.find((r) => r.id === "fd");
if (!repo)
  throw new Error(
    "fd entry missing from benchmarks/rust-repositories-extra.json",
  );

type OracleSymbol = { name: string; kind: string; file: string; line: number };

// Structs/enums/the one trait (SanitizeErr, src/error.rs) read from the real source.
// Rust methods have kind "function" in this adapter (no separate "field"/"method" kind for
// Rust, confirmed by reading src/languages/rust/parse.ts); struct -> "class", enum -> "enum",
// trait -> "interface" (also confirmed there).
const symbols: OracleSymbol[] = [
  { name: "SanitizeErr", kind: "interface", file: "src/error.rs", line: 14 },
  { name: "SanitizedError", kind: "class", file: "src/error.rs", line: 44 },
  { name: "Config", kind: "class", file: "src/config.rs", line: 14 },
  { name: "DirEntryInner", kind: "enum", file: "src/dir_entry.rs", line: 12 },
  { name: "DirEntry", kind: "class", file: "src/dir_entry.rs", line: 20 },
  { name: "PathUrl", kind: "class", file: "src/hyperlink.rs", line: 5 },
  { name: "SanitizedStr", kind: "class", file: "src/sanitize.rs", line: 47 },
  { name: "FileTypes", kind: "class", file: "src/filetypes.rs", line: 8 },
  { name: "Outputs", kind: "class", file: "src/exec/command.rs", line: 8 },
  {
    name: "OutputBuffer",
    kind: "class",
    file: "src/exec/command.rs",
    line: 12,
  },
  { name: "ExecutionMode", kind: "enum", file: "src/exec/mod.rs", line: 22 },
  { name: "CommandSet", kind: "class", file: "src/exec/mod.rs", line: 30 },
  { name: "CommandBuilder", kind: "class", file: "src/exec/mod.rs", line: 125 },
  {
    name: "CommandTemplate",
    kind: "class",
    file: "src/exec/mod.rs",
    line: 215,
  },
  { name: "OwnerFilter", kind: "class", file: "src/filter/owner.rs", line: 6 },
  { name: "Check", kind: "enum", file: "src/filter/owner.rs", line: 12 },
  { name: "TimeFilter", kind: "enum", file: "src/filter/time.rs", line: 7 },
  { name: "SizeFilter", kind: "enum", file: "src/filter/size.rs", line: 9 },
  { name: "ExitCode", kind: "enum", file: "src/exit_codes.rs", line: 7 },
  { name: "Token", kind: "enum", file: "src/fmt/mod.rs", line: 18 },
  { name: "FormatTemplate", kind: "enum", file: "src/fmt/mod.rs", line: 46 },
  { name: "ReceiverMode", kind: "enum", file: "src/walk.rs", line: 27 },
  { name: "WorkerResult", kind: "enum", file: "src/walk.rs", line: 39 },
  { name: "Batch", kind: "class", file: "src/walk.rs", line: 48 },
  { name: "BatchSender", kind: "class", file: "src/walk.rs", line: 74 },
  { name: "ReceiverBuffer", kind: "class", file: "src/walk.rs", line: 129 },
  { name: "WorkerState", kind: "class", file: "src/walk.rs", line: 305 },
  { name: "Opts", kind: "class", file: "src/cli.rs", line: 31 },
  { name: "FileType", kind: "enum", file: "src/cli.rs", line: 806 },
  { name: "ColorWhen", kind: "enum", file: "src/cli.rs", line: 829 },
  { name: "StripCwdWhen", kind: "enum", file: "src/cli.rs", line: 839 },
  { name: "HyperlinkWhen", kind: "enum", file: "src/cli.rs", line: 849 },
  { name: "Exec", kind: "class", file: "src/cli.rs", line: 860 },
];

type OracleResolution = {
  calleeName: string;
  file: string;
  line: number;
  col: number;
  // "unresolved" means the call must have NO resolvedTargetId (and resolutionKind "unresolved").
  expectedKind: string;
  expectedTarget?: { file: string; line: number };
  evidenceContains: string;
  note: string;
};

// Call-resolution oracle, hand-read from the real source during this task (see header comment
// for the two deliberately-unresolved cases).
const resolutions: OracleResolution[] = [
  {
    calleeName: "parse_opt",
    file: "src/filter/size.rs",
    line: 29,
    col: 8,
    expectedKind: "static",
    expectedTarget: { file: "src/filter/size.rs", line: 33 },
    evidenceContains: "inherent:",
    note: "SizeFilter::from_string -> SizeFilter::parse_opt, same impl block",
  },
  {
    calleeName: "Min",
    file: "src/filter/size.rs",
    line: 61,
    col: 24,
    expectedKind: "unresolved",
    evidenceContains: "no-symbol:variant",
    note: "SizeFilter::Min(size): enum tuple-variant constructor, deliberately left unresolved",
  },
  {
    calleeName: "metadata",
    file: "src/dir_entry.rs",
    line: 87,
    col: 51,
    expectedKind: "this-member",
    evidenceContains: "inherent:unique",
    expectedTarget: { file: "src/dir_entry.rs", line: 91 },
    note: "self.metadata() inside file_type(): the inherent metadata() (line 91) now correctly wins over the unrelated impl Colorable for DirEntry's same-named method (line 166), matching Rust's own inherent-over-trait method resolution rule",
  },
  {
    calleeName: "stripped_path",
    file: "src/dir_entry.rs",
    line: 78,
    col: 12,
    expectedKind: "this-member",
    expectedTarget: { file: "src/dir_entry.rs", line: 61 },
    evidenceContains: "inherent:",
    note: "self.stripped_path(config) inside into_stripped_path(), unique inherent target",
  },
  {
    calleeName: "starts_with_dash",
    file: "src/dir_entry.rs",
    line: 65,
    col: 15,
    expectedKind: "same-file",
    expectedTarget: { file: "src/dir_entry.rs", line: 114 },
    evidenceContains: "same-file",
    note: "starts_with_dash(stripped) inside stripped_path(), free function in the same file",
  },
  {
    calleeName: "cmp",
    file: "src/dir_entry.rs",
    line: 130,
    col: 13,
    expectedKind: "this-member",
    expectedTarget: { file: "src/dir_entry.rs", line: 136 },
    evidenceContains: "trait:",
    note: "self.cmp(other) inside partial_cmp(): resolved through impl Ord for DirEntry",
  },
  {
    calleeName: "SanitizedError",
    file: "src/error.rs",
    line: 32,
    col: 8,
    expectedKind: "constructor",
    expectedTarget: { file: "src/error.rs", line: 44 },
    evidenceContains: "constructor",
    note: "SanitizedError(self) inside impl SanitizeErr for io::Error's sanitize()",
  },
  {
    calleeName: "new",
    file: "src/exec/mod.rs",
    line: 87,
    col: 35,
    expectedKind: "static",
    expectedTarget: { file: "src/exec/command.rs", line: 18 },
    evidenceContains: "inherent:",
    note: "OutputBuffer::new(null_separator) inside CommandSet::execute(), cross-file to exec/command.rs",
  },
  {
    calleeName: "new",
    file: "src/exec/mod.rs",
    line: 97,
    col: 21,
    expectedKind: "static",
    expectedTarget: { file: "src/exec/mod.rs", line: 136 },
    evidenceContains: "inherent:",
    note: "CommandBuilder::new(c, limit) inside CommandSet::execute_batch(), same file",
  },
  {
    calleeName: "handle_cmd_error",
    file: "src/exec/command.rs",
    line: 67,
    col: 29,
    expectedKind: "same-file",
    expectedTarget: { file: "src/exec/command.rs", line: 100 },
    evidenceContains: "same-file",
    note: "handle_cmd_error(None, e) inside execute_commands(), free function in the same file",
  },
  {
    calleeName: "now",
    file: "src/filter/time.rs",
    line: 31,
    col: 27,
    expectedKind: "same-file",
    expectedTarget: { file: "src/filter/time.rs", line: 13 },
    evidenceContains: "ambiguous:cfg",
    note: "now() inside TimeFilter::from_str(): two #[cfg(test)]/#[cfg(not(test))]-gated fns named now, resolved as cfg-gated alternatives (probable, picks the first in source order)",
  },
  {
    calleeName: "PathUrl",
    file: "src/hyperlink.rs",
    line: 9,
    col: 13,
    expectedKind: "constructor",
    expectedTarget: { file: "src/hyperlink.rs", line: 5 },
    evidenceContains: "constructor",
    note: "PathUrl(absolute_path(path).ok()?) inside PathUrl::new(), tuple-struct constructor",
  },
];

const root = resolve(process.cwd(), repo.source);
const index = new ProjectIndex(root);
index.rebuild();
const symbolsById = new Map(index.symbols.map((s) => [s.id, s]));

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
  else
    missing.push(
      `symbol ${expected.kind} ${expected.name} (${expected.file}:${expected.line})`,
    );
}

let resolutionsMatched = 0;
for (const expected of resolutions) {
  const actual = index.calls.find(
    (c) =>
      c.calleeName === expected.calleeName &&
      c.filePath === expected.file &&
      c.range.startLine === expected.line &&
      c.range.startColumn === expected.col,
  );
  const label = `resolution ${expected.calleeName} (${expected.file}:${expected.line}:${expected.col})`;
  if (!actual) {
    missing.push(`${label}: call site not found in index.calls`);
    continue;
  }
  const evidenceOk = actual.evidence.some((e) =>
    e.includes(expected.evidenceContains),
  );
  if (expected.expectedKind === "unresolved") {
    if (
      !actual.resolvedTargetId &&
      actual.resolutionKind === "unresolved" &&
      evidenceOk
    ) {
      resolutionsMatched++;
    } else {
      missing.push(
        `${label}: expected unresolved (${expected.evidenceContains}), got resolutionKind=${actual.resolutionKind} resolvedTargetId=${actual.resolvedTargetId ?? "none"} evidence=${JSON.stringify(actual.evidence)}`,
      );
    }
    continue;
  }
  const target = actual.resolvedTargetId
    ? symbolsById.get(actual.resolvedTargetId)
    : undefined;
  const kindOk = actual.resolutionKind === expected.expectedKind;
  const targetOk =
    !!target &&
    !!expected.expectedTarget &&
    target.filePath === expected.expectedTarget.file &&
    target.range.startLine === expected.expectedTarget.line;
  if (kindOk && targetOk && evidenceOk) {
    resolutionsMatched++;
  } else {
    missing.push(
      `${label}: expected ${expected.expectedKind} -> ${expected.expectedTarget?.file}:${expected.expectedTarget?.line} (${expected.evidenceContains}), got ${actual.resolutionKind} -> ${target?.filePath ?? "none"}:${target?.range.startLine ?? "-"} evidence=${JSON.stringify(actual.evidence)}`,
    );
  }
}

console.log(
  `fd: ${symbolsFound}/${symbols.length} symbols found, ${resolutionsMatched}/${resolutions.length} resolutions matched`,
);
if (missing.length) console.log(`  missing:\n    ${missing.join("\n    ")}`);

const outDir = resolve(process.cwd(), "benchmarks/results");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  repo: repo.id,
  symbolsTotal: symbols.length,
  symbolsFound,
  resolutionsTotal: resolutions.length,
  resolutionsMatched,
  missing,
};
writeFileSync(
  join(outDir, "v1.8-rust-fd.json"),
  JSON.stringify(report, null, 2) + "\n",
);
