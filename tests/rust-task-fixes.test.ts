// Phase 3 fix loop (evidence: benchmarks/results/v1.5-phase3-rust-tasks.before-fixes.json). One fixture per
// repeated cause; fixtures are a few lines of Rust in a temp dir, never the evaluation repositories.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";

function edges(files: Record<string, string>, callee: string) {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-fix-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    const index = new ProjectIndex(dir);
    index.rebuild();
    const byId = new Map(index.symbols.map((s) => [s.id, s]));
    const line = (id?: string) => (id ? byId.get(id)?.range.startLine : undefined);
    return index.calls
      .filter((c) => c.calleeName === callee)
      .map((c) => ({
        caller: byId.get(c.callerId)?.name,
        target: line(c.resolvedTargetId),
        all: c.runtimeTargetIds?.map(line),
        conf: c.confidence,
        ev: c.evidence,
      }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Cause (a) match-arm-bound receiver: `match self { Get(cmd) => cmd.apply() }` left `cmd` untyped
// (`no-type:receiver-type-unknown`). Expected: the binding takes the variant's payload type from the enum
// declaration (scrutinee type or pattern path), `exact` only when variant and payload are unique.
const MATCH = `
pub struct Get;
pub struct Set;
impl Get { pub fn apply(&self) {} }
impl Set { pub fn apply(&self) {} }
pub enum Command { Get(Get), Set(Set), Pair(Get, Set), Other }
impl Command {
    pub fn run(&self) {
        use Command::*;
        match self {
            Get(cmd) => cmd.apply(),
            Set(cmd) => cmd.apply(),
            Pair(a, b) => { a.apply(); b.apply() }
            Other => {}
        }
    }
}
pub fn free(c: Command) {
    match c {
        Command::Set(inner) => inner.apply(),
        _ => {}
    }
}
pub fn unknown(c: Option<u8>) {
    let cmd = Get;
    match c { Some(cmd) => cmd.apply(), None => {} }
}
`;

test("(a) match-arm binding takes the enum variant's payload type", () => {
  const got = edges({ "src/lib.rs": MATCH }, "apply");
  const at = (caller: string) => got.filter((e) => e.caller === caller).map((e) => [e.target, e.conf]);
  // run(): Get(cmd) -> Get::apply (line 4), Set(cmd) -> Set::apply (line 5), Pair(a, b) -> Get / Set.
  assert.deepEqual(at("run"), [[4, "exact"], [5, "exact"], [4, "exact"], [5, "exact"]], JSON.stringify(got));
  assert.deepEqual(at("free"), [[5, "exact"]], JSON.stringify(got));
  // Scrutinee is an external Option: payload unknown, stays unresolved with no-type evidence.
  const u = got.filter((e) => e.caller === "unknown");
  assert.equal(u.length, 1);
  assert.equal(u[0].conf, "unresolved");
  assert.ok(u[0].ev.some((x) => x.startsWith("no-type:")), JSON.stringify(u));
});

// Cause (b) calls inside macro token trees: `tokio::select! { res = self.conn.read_frame() => .. }` produced
// only the `select` macro edge, so `read_frame` had no caller. Expected (spec §36: macros are not expanded):
// the invocation's argument text is re-parsed as expressions, recovered calls are resolved like any other but
// never `exact` (at most `probable`) and carry `macro:arg <macro>` evidence; format/assert/log-style macros
// are not looked into.
const MACRO = `
pub struct Conn;
impl Conn { pub fn read_frame(&self) -> u8 { 0 } pub fn flush(&self) {} }
pub struct Handler { conn: Conn }
impl Handler {
    pub async fn run(&self, other: &Conn) {
        tokio::select! {
            res = self.conn.read_frame() => { other.flush(); }
            _ = other.read_frame() => {}
        }
        println!("{}", self.conn.read_frame());
        assert_eq!(other.read_frame(), 0);
        log::debug!("{}", other.read_frame());
    }
}
`;

test("(b) calls inside non-format macros are recovered as probable with macro evidence", () => {
  const reads = edges({ "src/lib.rs": MACRO }, "read_frame");
  // Only the two select! calls: println!/assert_eq!/log::debug! are not looked into.
  assert.equal(reads.length, 2, JSON.stringify(reads));
  for (const e of reads) {
    assert.deepEqual([e.target, e.conf], [3, "probable"], JSON.stringify(e));
    assert.ok(e.ev.includes("macro:arg select"), JSON.stringify(e));
  }
  const flush = edges({ "src/lib.rs": MACRO }, "flush");
  assert.deepEqual(flush.map((e) => [e.target, e.conf]), [[3, "probable"]], JSON.stringify(flush));
  // The macro edge itself is unchanged.
  assert.deepEqual(edges({ "src/lib.rs": MACRO }, "select").map((e) => [e.conf, e.ev]), [["unresolved", ["macro:select"]]]);
});
