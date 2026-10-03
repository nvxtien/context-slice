// Cache guard for Rust parse output (symbols, metadata, imports, exports, calls) AND resolver output (every
// fixture edge's target/confidence/kind/evidence): both are stored in the SQLite cache and reused on warm rebuilds.
// IF THIS TEST FAILS because the output legitimately changed: bump INDEX_VERSION (src/storage/sqlite.ts)
// AND regenerate the snapshot with `UPDATE_RUST_PARSE_SNAPSHOT=1 npx tsx --test tests/rust-parse-snapshot.test.ts`.
// Regeneration refuses to write a changed snapshot while INDEX_VERSION still equals the snapshot's version,
// so old SQLite caches can never be reused with a different extraction output.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { parseRust } from "../src/languages/rust/parse.js";
import { INDEX_VERSION } from "../src/storage/sqlite.js";

const DIR = join(process.cwd(), "tests/fixtures/rust");
const SNAPSHOT = join(process.cwd(), "tests/fixtures/rust-parse-snapshot.json");
const FIXTURES = [
  "functions.rs",
  "modules.rs",
  "structs_enums.rs",
  "traits_impls.rs",
  "snapshot_calls.rs",
];

/** Deterministic >32 KiB file (tree-sitter's chunked-read boundary) mixing items and calls. */
function largeSource(): string {
  let s = "use crate::m::{a, b::{c as d}};\n";
  for (let i = 0; s.length < 40_000; i++)
    s += `pub struct S${i};\nimpl S${i} { pub fn m${i}(&self, x: u8) -> u8 { d(x); self.n(); x } fn n(&self) {} }\nfn f${i}(s: &S${i}) { s.m${i}(1); a(); vec![1]; }\n`;
  return s;
}

function summary(file: string, source: string) {
  const p = parseRust(file, source);
  return {
    parseError: p.parseError,
    symbols: p.symbols.map((s) => ({
      kind: s.kind,
      name: s.name,
      qualifiedName: s.qualifiedName,
      range: s.range,
      metadata: s.metadata,
    })),
    imports: p.imports,
    exports: p.exports,
    calls: p.calls.map((c) => ({
      calleeName: c.calleeName,
      receiverText: c.receiverText,
      receiverType: c.receiverType,
      argumentCount: c.argumentCount,
      range: c.range,
      evidence: c.evidence,
    })),
  };
}

function current() {
  const files: Record<string, unknown> = {};
  for (const f of FIXTURES)
    files[f] = summary(`src/${f}`, readFileSync(join(DIR, f), "utf8"));
  const big = summary("src/large.rs", largeSource());
  files["large.rs (generated)"] = {
    counts: {
      symbols: big.symbols.length,
      imports: big.imports.length,
      calls: big.calls.length,
    },
    sha256: createHash("sha256").update(JSON.stringify(big)).digest("hex"),
  };
  files["resolved edges (fixtures indexed together)"] = resolvedSummary();
  return files;
}

/** Resolver output (cached in SQLite too, so it is guarded like parse output): every Rust edge's outcome. */
function resolvedSummary() {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-snap-"));
  try {
    mkdirSync(join(dir, "src"));
    for (const f of FIXTURES)
      writeFileSync(
        join(dir, "src", f === "snapshot_calls.rs" ? "lib.rs" : f),
        readFileSync(join(DIR, f), "utf8"),
      );
    const index = new ProjectIndex(dir);
    index.rebuild();
    const byId = new Map(index.symbols.map((s) => [s.id, s]));
    return index.calls
      .map((c) => {
        const t = c.resolvedTargetId ? byId.get(c.resolvedTargetId) : undefined;
        return [
          c.filePath,
          c.range.startLine,
          c.range.startColumn,
          c.calleeName,
          t ? `${t.filePath}:${t.range.startLine}` : null,
          c.externalPackage ?? null,
          c.confidence,
          c.resolutionKind,
          c.evidence,
        ];
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Snapshot = { indexVersion: string; files: Record<string, unknown> };
const committed = (): Snapshot | undefined =>
  existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : undefined;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** A snapshot entry present before changed or disappeared (a brand-new entry is not a change of output). */
const changed = (old: Record<string, unknown>, now: Record<string, unknown>) =>
  Object.keys(old).some((k) => !same(old[k], now[k]));

if (process.env.UPDATE_RUST_PARSE_SNAPSHOT) {
  const old = committed();
  const files = current();
  if (old && changed(old.files, files) && old.indexVersion === INDEX_VERSION)
    throw new Error(
      `Rust parse output changed but INDEX_VERSION is still ${INDEX_VERSION}: bump it before regenerating the snapshot.`,
    );
  writeFileSync(
    SNAPSHOT,
    JSON.stringify({ indexVersion: INDEX_VERSION, files }, null, 1) + "\n",
  );
}

test("Rust parse output matches the committed snapshot", () => {
  const snap = committed();
  assert.ok(
    snap,
    "missing snapshot; generate with UPDATE_RUST_PARSE_SNAPSHOT=1",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(current())),
    snap.files,
    "Rust parse output changed: bump INDEX_VERSION and regenerate the snapshot (see header comment).",
  );
});

test("snapshot was generated for the current INDEX_VERSION", () => {
  const snap = committed();
  assert.equal(
    snap?.indexVersion,
    INDEX_VERSION,
    "INDEX_VERSION changed: regenerate the snapshot (UPDATE_RUST_PARSE_SNAPSHOT=1) so the pair stays in sync.",
  );
});

test("the generated large fixture crosses 32 KiB", () => {
  assert.ok(largeSource().length > 32_768);
});
