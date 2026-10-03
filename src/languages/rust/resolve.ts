import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";
import { leaveUnresolvedOnError, resolveCallsA } from "./calls-resolve.js";
import { modulePathFor } from "./parse.js";

/** A crate known to this project: its Cargo.toml package name, and its directory
 * relative to context.root ("" for a crate whose Cargo.toml sits at the project root). */
type CrateInfo = { name: string; dir: string };

function cargoPackageName(tomlText: string): string | undefined {
  const section = tomlText.match(/\[package\]([\s\S]*?)(?:\n\[|$)/);
  const body = section ? section[1] : tomlText;
  return body.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
}

function cargoWorkspaceMembers(tomlText: string): string[] {
  const section = tomlText.match(/\[workspace\]([\s\S]*?)(?:\n\[|$)/);
  if (!section) return [];
  const members = section[1].match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!members) return [];
  return [...members[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Only the simple "dir/*" trailing-glob form is supported — real Cargo globs (nested
 * wildcards, exclude patterns) are rare enough in practice not to special-case here. */
function expandMemberPattern(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\/$/, "");
  if (!clean.endsWith("/*")) return [clean];
  const base = clean.slice(0, -2);
  try {
    return readdirSync(join(root, base), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${base}/${entry.name}`);
  } catch {
    return [];
  }
}

/** Every crate this project can resolve `use` paths into: a root Cargo.toml's own
 * `[package]` (if any) plus every `[workspace]` member's own `[package]`. No Cargo.toml
 * means no known crates — callers fall back to treating the whole project as one crate,
 * which is the project's existing, correct single-crate behavior. */
function discoverCrates(root: string): CrateInfo[] {
  let rootToml: string;
  try {
    rootToml = readFileSync(join(root, "Cargo.toml"), "utf8");
  } catch {
    return [];
  }
  const crates: CrateInfo[] = [];
  const rootName = cargoPackageName(rootToml);
  if (rootName) crates.push({ name: rootName, dir: "" });
  for (const pattern of cargoWorkspaceMembers(rootToml)) {
    for (const memberDir of expandMemberPattern(root, pattern)) {
      let memberToml: string;
      try {
        memberToml = readFileSync(join(root, memberDir, "Cargo.toml"), "utf8");
      } catch {
        continue;
      }
      const name = cargoPackageName(memberToml);
      if (name) crates.push({ name, dir: memberDir });
    }
  }
  return crates;
}

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
  /** Names bound in `fromFile` (declared items, imports). A non-anchored path starting with one is not an external crate. */
  boundNames?: ReadonlySet<string>,
  /** Other crates in this workspace, by Cargo.toml package name — lets a non-anchored path
   * whose first segment names a sibling crate resolve into THAT crate's own module index,
   * instead of being reported as an external (non-workspace) package. */
  otherCrates?: ReadonlyMap<string, ReturnType<typeof rustModuleIndex>>,
): { file?: string; externalPackage?: string } {
  const [anchor, ...rest] = segments;
  const anchored =
    anchor === "crate" || anchor === "self" || anchor === "super";
  const here = index.byFile.get(fromFile) ?? [];
  let absolute: string[];
  let minLen = 0; // non-anchored: matches must be strictly deeper than `here`
  if (anchor === "crate") {
    absolute = rest;
  } else if (anchor === "self" || anchor === "super") {
    if (!index.byFile.has(fromFile)) return {};
    const base =
      anchor === "super" ? here.slice(0, Math.max(0, here.length - 1)) : here;
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
  if (anchor && boundNames?.has(anchor)) return {}; // bound locally: unresolved, not external
  const sibling = anchor ? otherCrates?.get(anchor) : undefined;
  if (sibling) {
    for (const path of [rest, rest.slice(0, -1)]) {
      const key = path.join("::");
      if (sibling.ambiguous.has(key)) return {};
      const file = sibling.byModule.get(key);
      if (file) return { file };
    }
  }
  return { externalPackage: anchor };
}

/**
 * Resolves every Rust ImportRecord's `resolvedFile`/`externalPackage` in
 * place, then resolves CallEdges to symbols (structural targets, see
 * calls-resolve.ts).
 */
export function resolveRustCalls(context: ResolveContext) {
  const files = [...new Set(context.symbols.map((symbol) => symbol.filePath))];
  for (const record of [...context.imports, ...context.exports])
    files.push(record.filePath);
  const allFiles = [...new Set(files)];

  // Partition files by crate (longest directory-prefix match) and build one module index per
  // crate, so two crates' own src/lib.rs (both module path []) never collide into one "ambiguous"
  // key the way a single project-wide index would. No Cargo.toml, or a Cargo.toml with no
  // crates discovered, falls back to exactly one crate covering the whole project — the
  // project's prior, unpartitioned behavior.
  const discovered = discoverCrates(context.root);
  const crateDirs = discovered.length ? discovered : [{ name: "", dir: "" }];
  if (!crateDirs.some((c) => c.dir === ""))
    crateDirs.push({ name: "", dir: "" });
  const dirsByLengthDesc = [...crateDirs].sort(
    (a, b) => b.dir.length - a.dir.length,
  );
  const crateFor = (file: string): CrateInfo =>
    dirsByLengthDesc.find(
      (c) => c.dir === "" || file === c.dir || file.startsWith(c.dir + "/"),
    ) ?? dirsByLengthDesc[dirsByLengthDesc.length - 1];

  const filesByCrateDir = new Map<string, string[]>();
  for (const file of allFiles) {
    const dir = crateFor(file).dir;
    const list = filesByCrateDir.get(dir) ?? [];
    list.push(file);
    filesByCrateDir.set(dir, list);
  }
  const indexByCrateDir = new Map<string, ReturnType<typeof rustModuleIndex>>();
  const indexByCrateName = new Map<
    string,
    ReturnType<typeof rustModuleIndex>
  >();
  for (const crate of crateDirs) {
    const crateIndex = rustModuleIndex(filesByCrateDir.get(crate.dir) ?? []);
    indexByCrateDir.set(crate.dir, crateIndex);
    if (crate.name) indexByCrateName.set(crate.name, crateIndex);
  }
  const indexFor = (file: string) => indexByCrateDir.get(crateFor(file).dir)!;

  // Per-file bound names: declared items at any nesting + names bound by imports.
  // A bare unaliased `use foo;` binds the crate name itself, so it does not count.
  const boundByFile = new Map<string, Set<string>>();
  const bind = (file: string, name: string | undefined) => {
    if (!name) return;
    let set = boundByFile.get(file);
    if (!set) boundByFile.set(file, (set = new Set()));
    set.add(name);
  };
  // Only type-namespace items (struct/enum/trait/type/mod) can start a `use` path;
  // a fn/const/static with the same name as a crate does not shadow it.
  for (const symbol of context.symbols)
    if (symbol.kind !== "function" && symbol.kind !== "variable")
      bind(symbol.filePath, symbol.name);
  for (const record of context.imports as ImportRecord[]) {
    if (record.wildcard) continue;
    const bareCrate =
      record.module === record.importedName &&
      record.localName === record.importedName;
    if (!bareCrate) bind(record.filePath, record.localName);
  }

  for (const record of context.imports as ImportRecord[]) {
    const resolved = resolveRustModule(
      record.module.split("::"),
      record.filePath,
      indexFor(record.filePath),
      boundByFile.get(record.filePath),
      indexByCrateName,
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
        indexFor(record.filePath),
        undefined,
        indexByCrateName,
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
      record.symbolId = lookup(
        record.resolvedFile,
        record.sourceName,
        new Set(),
      );
  }

  // Exact module file for a containing-module path: the dummy trailing segment makes
  // resolveRustModule's "drop last segment" fallback land on `segments` itself, never a parent.
  try {
    resolveCallsA(context, {
      moduleOf: (segments, fromFile) =>
        resolveRustModule(
          [...segments, "\u0000"],
          fromFile,
          indexFor(fromFile),
          boundByFile.get(fromFile),
          indexByCrateName,
        ),
    });
  } catch {
    // A throw outside the per-edge guard (impl pre-pass): no Rust edge is trusted, the rebuild continues.
    context.calls.forEach(leaveUnresolvedOnError);
  }
}
