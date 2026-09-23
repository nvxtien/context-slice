import type { ImportRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";
import { modulePathFor } from "./parse.js";

/**
 * Map every indexed .rs file to its crate-relative module path, and back.
 * A module-path key claimed by two different files (e.g. two crates' lib.rs
 * in a workspace) is ambiguous: it is dropped from `byModule` and recorded in
 * `ambiguous`, so it resolves to nothing rather than to whichever came first.
 */
export function rustModuleIndex(files: string[]) {
  const byModule = new Map<string, string>();
  const ambiguous = new Set<string>();
  const byFile = new Map<string, string[]>();
  for (const file of files) {
    const path = modulePathFor(file);
    byFile.set(file, path);
    const key = path.join("::");
    if (ambiguous.has(key)) continue;
    const existing = byModule.get(key);
    if (existing !== undefined && existing !== file) {
      byModule.delete(key);
      ambiguous.add(key);
    } else byModule.set(key, file);
  }
  return { byModule, byFile, ambiguous };
}

/**
 * Resolve a `use` target's path segments to an indexed file, or report it
 * as external. Deterministic and conservative.
 *
 * Anchored (crate/self/super) targets can only mean "somewhere in this
 * crate", so a miss is `{}`, never external. At file granularity a
 * module-only anchored path whose module has no file of its own (e.g.
 * ["crate","nope"], where `nope` may be an inline `mod` or an item in the
 * crate root) falls back to the containing module's file via `asContaining`
 * (here the crate root); that is the documented file-granularity fallback.
 *
 * Non-anchored targets follow Rust 2018: first a descendant module of the
 * CURRENT module (`[...here, ...segments]`), else an extern crate. Only a
 * match strictly deeper than the current module counts, so a path can never
 * fall back to the current file or an ancestor (e.g. lib.rs).
 *
 * A module-path key claimed by several files is ambiguous and never guessed:
 * the result is `{}`.
 *
 * Accepts EITHER a containing-module path (what `resolveRustCalls` passes,
 * since `ImportRecord.module` is everything but the final segment) OR a full
 * path with the trailing item name (used by the unit tests). Both work via
 * the two-step lookup `asModule` (exact) / `asContaining` (drop last segment).
 */
export function resolveRustModule(
  segments: string[],
  fromFile: string,
  index: ReturnType<typeof rustModuleIndex>,
): { file?: string; externalPackage?: string } {
  const [anchor, ...rest] = segments;
  const anchored = anchor === "crate" || anchor === "self" || anchor === "super";
  const here = index.byFile.get(fromFile) ?? [];
  let absolute: string[];
  let minLen = 0; // non-anchored: matches must be strictly deeper than `here`
  if (anchor === "crate") {
    absolute = rest;
  } else if (anchor === "self" || anchor === "super") {
    if (!index.byFile.has(fromFile)) return {};
    const base = anchor === "super" ? here.slice(0, Math.max(0, here.length - 1)) : here;
    absolute = [...base, ...rest];
  } else {
    absolute = [...here, ...segments];
    minLen = here.length + 1;
  }
  for (const path of [absolute, absolute.slice(0, -1)]) {
    if (path.length < minLen) continue;
    const key = path.join("::");
    if (index.ambiguous.has(key)) return {};
    const file = index.byModule.get(key);
    if (file) return { file };
  }
  if (anchored) return {};
  return { externalPackage: anchor };
}

/**
 * Resolves every Rust ImportRecord's `resolvedFile`/`externalPackage` in
 * place. Call resolution itself (matching CallEdges to symbols) remains
 * unimplemented in this phase — CallEdge arrays stay empty until a later
 * phase builds on this module graph.
 */
export function resolveRustCalls(context: ResolveContext) {
  const files = [...new Set(context.symbols.map((symbol) => symbol.filePath))];
  for (const record of [...context.imports, ...context.exports])
    files.push(record.filePath);
  const index = rustModuleIndex([...new Set(files)]);

  for (const record of context.imports as ImportRecord[]) {
    const resolved = resolveRustModule(
      record.module.split("::"),
      record.filePath,
      index,
    );
    record.resolvedFile = resolved.file;
    record.externalPackage = resolved.externalPackage;
  }

  const exportsByFile = new Map<string, typeof context.exports>();
  for (const record of context.exports) {
    if (record.fromModule) {
      record.resolvedFile = resolveRustModule(
        record.fromModule.split("::"),
        record.filePath,
        index,
      ).file;
    }
    const list = exportsByFile.get(record.filePath) ?? [];
    list.push(record);
    exportsByFile.set(record.filePath, list);
  }

  const symbolsByFileAndName = new Map<string, string>(); // `${file}#${name}` -> symbolId
  for (const symbol of context.symbols)
    symbolsByFileAndName.set(`${symbol.filePath}#${symbol.name}`, symbol.id);

  /** Follows `pub use` re-export chains; `seen` breaks cycles (mirrors python resolve.ts's `lookup`). */
  const lookup = (
    file: string,
    name: string,
    seen: Set<string>,
  ): string | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const direct = symbolsByFileAndName.get(key);
    if (direct) return direct;
    const records = exportsByFile.get(file) ?? [];
    const reexport = records.find(
      (record) => record.exportedName === name && record.resolvedFile,
    );
    if (reexport?.resolvedFile)
      return lookup(reexport.resolvedFile, reexport.sourceName ?? name, seen);
    for (const wildcard of records.filter((record) => record.wildcard))
      if (wildcard.resolvedFile) {
        const found = lookup(wildcard.resolvedFile, name, seen);
        if (found) return found;
      }
    return undefined;
  };

  for (const record of context.exports) {
    record.symbolId = undefined; // drop any stale id loaded from the cache
    if (record.resolvedFile && record.sourceName)
      record.symbolId = lookup(record.resolvedFile, record.sourceName, new Set());
  }
}
