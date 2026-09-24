// Prints `<sha256>  <file>` lines for the frozen Rust ground truth (`why` fields excluded).
// Usage: npx tsx benchmarks/rust-freeze-hash.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FROZEN_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "rust-semantic-calls");
export const FROZEN_FILES = ["walkdir.json", "mini-redis.json", "ripgrep-ignore.json", "sample.json", "sample-trait.json"];

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) if (k !== "why") o[k] = canon((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

export function canonicalHash(json: unknown): string {
  return createHash("sha256").update(JSON.stringify(canon(json))).digest("hex");
}

export function frozenLines(dir = FROZEN_DIR): string[] {
  return FROZEN_FILES.map((f) => `${canonicalHash(JSON.parse(readFileSync(join(dir, f), "utf8")))}  ${f}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(frozenLines().join("\n"));
