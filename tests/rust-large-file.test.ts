import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRust } from "../src/languages/rust/parse.js";
import { ProjectIndex } from "../src/indexer/index.js";

/** Source of about `size` chars made of `pub fn`s plus filler, ending with `tail`. */
function big(
  size: number,
  filler = "// padding\n",
  tail = "",
): { source: string; count: number } {
  let source = "";
  let count = 0;
  const unit = (n: number) => `pub fn f${n}() {}\n${filler}`;
  while (source.length + unit(count).length + tail.length + 8 < size) {
    source += unit(count);
    count++;
  }
  // Pad with a comment line so the total is exactly `size` chars.
  const pad = size - source.length - tail.length;
  source += "//" + "p".repeat(pad - 3) + "\n";
  return { source: source + tail, count };
}

for (const size of [32_767, 32_768, 32_769, 65_536, 200_000]) {
  test(`parseRust handles a ${size}-char file`, () => {
    const { source, count } = big(size);
    assert.equal(source.length, size);
    const parsed = parseRust("src/lib.rs", source);
    assert.equal(parsed.parseError, false);
    assert.equal(parsed.symbols.length, count);
  });
}

test("parseRust handles a large file with multi-byte characters", () => {
  const { source, count } = big(
    70_000,
    '// é 日本語 ünïcödé 🦀\nconst S: &str = "日本語é";\n',
  );
  const parsed = parseRust("src/lib.rs", source);
  assert.equal(parsed.parseError, false);
  assert.equal(
    parsed.symbols.filter((s) => s.kind === "function").length,
    count,
  );
  assert.equal(
    parsed.symbols.filter((s) => s.kind === "variable").length,
    count,
  );
});

test("imports beyond 32 KiB are found", () => {
  const { source } = big(60_000, "// padding\n", "use crate::x::Y;\n");
  const parsed = parseRust("src/lib.rs", source);
  const imp = parsed.imports.find((i) => i.importedName === "Y");
  assert.ok(imp);
  assert.equal(imp!.module, "crate::x");
});

test("ProjectIndex indexes a large file next to a small one", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-rust-big-"));
  try {
    mkdirSync(join(dir, "src"));
    const { source, count } = big(90_000, "// é\n");
    writeFileSync(join(dir, "src/lib.rs"), source + "pub mod small;\n");
    writeFileSync(join(dir, "src/small.rs"), "pub fn tiny() {}\n");
    const index = new ProjectIndex(dir);
    const summary = index.rebuild();
    assert.equal(summary.parseErrors, 0);
    const fns = index.symbols.filter(
      (s) => s.filePath === "src/lib.rs" && s.kind === "function",
    );
    assert.equal(fns.length, count);
    assert.ok(index.symbols.some((s) => s.name === "tiny"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
