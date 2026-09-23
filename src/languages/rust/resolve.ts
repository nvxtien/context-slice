import type { ImportRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";
import { modulePathFor } from "./parse.js";

/** Map every indexed .rs file to its crate-relative module path, and back. */
export function rustModuleIndex(files: string[]) {
  const byModule = new Map<string, string>();
  const byFile = new Map<string, string[]>();
  for (const file of files) {
    const path = modulePathFor(file);
    byFile.set(file, path);
    if (!byModule.has(path.join("::"))) byModule.set(path.join("::"), file);
  }
  return { byModule, byFile };
}

/**
 * Resolve a `use` target's path segments to an indexed file, or report it
 * as external. Deterministic and conservative: an anchored (crate/self/
 * super) target that cannot be found locally is left fully unresolved,
 * never reported as external — those anchors can only ever mean "somewhere
 * in this crate."
 *
 * Accepts EITHER a containing-module path (e.g. ["crate","service"], with
 * no trailing item name — this is what `resolveRustCalls` below always
 * passes, since `ImportRecord.module`/`ExportRecord.fromModule` are already
 * "everything except the final segment") OR a full path including the
 * trailing item name (e.g. ["crate","service","Foo"] — this is what the
 * unit tests below exercise directly, and what a later call-resolution
 * phase may need when resolving a fully-qualified reference in one step).
 * Both work because of the two-step lookup: `asModule` matches a
 * containing-module path exactly; `asContaining` drops one more trailing
 * segment and matches again, covering the full-path case. In this phase's
 * actual call sites only `asModule` ever fires — `asContaining` exists for
 * the second calling convention, verified by its own direct unit tests
 * rather than by any code path in `resolveRustCalls`. This is intentional,
 * not dead code: do not remove it because it looks unused from
 * `resolveRustCalls` alone.
 */
export function resolveRustModule(
  segments: string[],
  fromFile: string,
  index: ReturnType<typeof rustModuleIndex>,
): { file?: string; externalPackage?: string } {
  const [anchor, ...rest] = segments;
  let absolute: string[];
  const anchored = anchor === "crate" || anchor === "self" || anchor === "super";
  if (anchor === "crate") {
    absolute = rest;
  } else if (anchor === "self" || anchor === "super") {
    const here = index.byFile.get(fromFile);
    if (!here) return {};
    const base = anchor === "super" ? here.slice(0, Math.max(0, here.length - 1)) : here;
    absolute = [...base, ...rest];
  } else {
    absolute = segments;
  }
  const asModule = index.byModule.get(absolute.join("::"));
  if (asModule) return { file: asModule };
  const containing = absolute.slice(0, -1).join("::");
  const asContaining = index.byModule.get(containing);
  if (asContaining) return { file: asContaining };
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

  for (const record of context.exports)
    if (record.resolvedFile && record.sourceName)
      record.symbolId = lookup(record.resolvedFile, record.sourceName, new Set());
}
