import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectIndex } from "../src/indexer/index.js";
import { parseRust } from "../src/languages/rust/parse.js";
import { resolveRustCalls } from "../src/languages/rust/resolve.js";

/** A single lib.rs of about `size` chars: structs, impls, self / typed / path / bare calls. */
function big(size: number, tag = "") {
  let s =
    "use std::collections::HashMap;\nuse crate::inner::*;\nmod inner { pub fn g() {} }\n";
  for (let i = 0; s.length < size; i++)
    s +=
      `pub struct S${i} { f: HashMap<String, u8> }\n` +
      `impl S${i} {\n  pub fn new() -> Self { S${i} { f: HashMap::new() } }\n  pub fn m(&self, x: u8) -> u8 { self.n(); let a = S${i}::new(); a.n(); self.f.len(); g(); x }\n  fn n(&self) {}\n}\n` +
      `fn f${i}(s: &S${i}) -> u8 { ${tag}s.m(1); crate::inner::g(); S${i}::new().m(2) }\n`;
  return s;
}
function withDir<T>(files: Record<string, string>, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-robust-"));
  try {
    mkdirSync(join(dir, "src"));
    for (const [f, body] of Object.entries(files))
      writeFileSync(join(dir, f), body);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const outcomes = (index: ProjectIndex, file: string) => {
  const byId = new Map(index.symbols.map((s) => [s.id, s]));
  return JSON.stringify(
    index.calls
      .filter((c) => c.filePath === file)
      .map((c) => [
        c.range,
        c.calleeName,
        c.resolvedTargetId && byId.get(c.resolvedTargetId)?.range.startLine,
        c.confidence,
        c.resolutionKind,
        c.evidence,
      ]),
  );
};

test("perf guard: resolution stays roughly linear in file size (was quadratic)", () => {
  // Before the fix a 976K-char file took ~20 s cold; now ~4 s. Bound is generous for slow CI machines.
  withDir({ "src/lib.rs": big(500_000) }, (dir) => {
    const index = new ProjectIndex(dir);
    try {
      const t = performance.now();
      index.rebuild();
      const cold = performance.now() - t;
      assert.ok(index.calls.length > 15_000);
      assert.ok(
        cold < 15_000,
        `cold rebuild of a 500K-char file took ${cold.toFixed(0)} ms`,
      );
    } finally {
      index.close();
    }
  });
});

test("warm rebuild after an edit resolves the edited file exactly like a cold build (parse caches invalidate)", () => {
  const before = big(20_000);
  // The edit shadows `s` with a second binding: the single-binding rule must now refuse to type `s.m(1)`.
  const after = big(20_000, "let s = 3u8; ");
  withDir({ "src/lib.rs": before }, (dir) => {
    const warm = new ProjectIndex(dir);
    try {
      warm.rebuild();
      writeFileSync(join(dir, "src/lib.rs"), after);
      warm.rebuild();
      withDir({ "src/lib.rs": after }, (dir2) => {
        const cold = new ProjectIndex(dir2);
        try {
          cold.rebuild();
          assert.equal(outcomes(warm, "src/lib.rs"), outcomes(cold, "src/lib.rs"));
          assert.ok(
            cold.calls.some(
              (c) =>
                c.calleeName === "m" &&
                c.evidence.some((e) => e.startsWith("no-type:")),
            ),
          );
        } finally {
          cold.close();
        }
      });
    } finally {
      warm.close();
    }
  });
});

/** Resolves `files` directly, with `sourceOf` throwing for src/b.rs (a file that vanished mid-rebuild). */
function resolveWithVanishedFile(files: Record<string, string>) {
  const parsed = Object.entries(files).map(([f, src]) => parseRust(f, src));
  const context = {
    root: "/nonexistent",
    symbols: parsed.flatMap((p) => p.symbols),
    calls: parsed.flatMap((p) => p.calls),
    imports: parsed.flatMap((p) => p.imports),
    exports: parsed.flatMap((p) => p.exports),
    sourceOf: (s: { filePath: string }) => {
      if (s.filePath === "src/b.rs") throw new Error("file vanished");
      return files[s.filePath];
    },
  };
  assert.doesNotThrow(() => resolveRustCalls(context as never));
  return context.calls;
}

test("a throw while resolving one edge leaves that edge unresolved and resolves the others", () => {
  const calls = resolveWithVanishedFile({
    "src/lib.rs": "mod b;\nfn g() {}\nfn f() { g(); }\n",
    "src/b.rs": "fn h(t: u8) { t.m(); }\n",
  });
  assert.equal(calls.find((c) => c.calleeName === "g")!.confidence, "exact");
  const m = calls.find((c) => c.calleeName === "m")!;
  assert.equal(m.resolvedTargetId, undefined);
  assert.deepEqual(
    [m.confidence, m.evidence],
    ["unresolved", ["no-type:resolver-error"]],
  );
});

test("a throw before the per-edge loop leaves every Rust edge unresolved instead of aborting the rebuild", () => {
  const calls = resolveWithVanishedFile({
    "src/lib.rs": 'mod b;\nfn g() {}\nfn f() { g(); println!("x"); }\n',
    "src/b.rs":
      "struct T;\nimpl T { fn m(&self) {} }\nfn h(t: &T) { t.m(); }\n",
  });
  for (const c of calls) {
    assert.equal(c.resolvedTargetId, undefined);
    assert.equal(c.confidence, "unresolved");
  }
  assert.ok(
    calls
      .find((c) => c.calleeName === "g")!
      .evidence.includes("no-type:resolver-error"),
  );
  assert.ok(
    calls
      .find((c) => c.calleeName === "println")!
      .evidence.some((e) => e.startsWith("macro:")),
  );
});
