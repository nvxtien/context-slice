import type {
  CallEdge,
  ImportRecord,
  SymbolRecord,
} from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";
import {
  callEdge,
  field,
  macroArgs,
  macroIndex,
  modulePathFor,
  rustParser,
  typeParamNames,
  type Node,
} from "./parse.js";

/**
 * Rust call resolution. Part A (structural targets): `self.m()`, `Self::f()`/`Type::f()`, module paths and
 * bare calls. Part B (`x.m()`): the receiver's type is read syntactically from parameter / field / `let`
 * annotations, constructor and exact-target return types (`?`, `unwrap` on std Result/Option); generic
 * bounds, `impl Trait` and `dyn Trait` give only the trait declaration (probable).
 *
 * Conservative by construction: `exact` only for a single deterministic target; any ambiguity is
 * `unresolved` with `ambiguous:N`; a target reached only through a trait declaration is
 * `probable` / `interface` with `trait:` evidence. File granularity: an inline `mod` is a scope,
 * but items are looked up by name per file.
 */
export interface CallDeps {
  /** Exact file of a module path (`[...segments]`, no trailing item) as seen from `fromFile`. */
  moduleOf(segments: string[], fromFile: string): { file?: string };
}

const TYPE_KINDS = new Set(["class", "enum", "interface", "type"]);
const IDENT = /^[A-Za-z_]\w*$/;
// Rust prelude items a call can name without a `use`: documented, deliberately small.
const PRELUDE_FNS = new Set(["Some", "Ok", "Err", "drop"]);
const STD_TYPES = new Set([
  "Option",
  "Result",
  "Vec",
  "String",
  "Box",
  "Default",
  "Clone",
  "Iterator",
  "IntoIterator",
  "From",
  "Into",
  "TryFrom",
  "TryInto",
  "AsRef",
  "AsMut",
  "ToString",
  "ToOwned",
  "PartialEq",
  "Eq",
  "PartialOrd",
  "Ord",
  "Drop",
  "Fn",
  "FnMut",
  "FnOnce",
  "Send",
  "Sync",
  "Copy",
  "Sized",
  "Extend",
  "FromIterator",
  "DoubleEndedIterator",
  "ExactSizeIterator",
  "bool",
  "char",
  "str",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "f32",
  "f64",
]);
// Methods a `#[derive(..)]` also provides, keyed to the derived trait.
const DERIVE_TRAIT: Record<string, string> = {
  clone: "Clone",
  default: "Default",
  fmt: "Debug",
  eq: "PartialEq",
  ne: "PartialEq",
  cmp: "Ord",
  partial_cmp: "PartialOrd",
  hash: "Hash",
};
const STD_ROOTS = new Set(["std", "core", "alloc"]);
// A glob import can shadow these prelude names (e.g. `use io::*` brings its own `Result`).
const SHADOWABLE = new Set(["Result"]);

const isImpl = (s: SymbolRecord) =>
  s.kind === "type" && s.name.startsWith("impl ");
const isTupleStruct = (s: SymbolRecord) =>
  s.kind === "class" && s.metadata?.declaredTypes?.["0"] !== undefined;
const contains = (outer: SymbolRecord["range"], inner: SymbolRecord["range"]) =>
  (outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine &&
      outer.startColumn <= inner.startColumn)) &&
  (outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn));

type TypeRes =
  | { t: "decl"; sym: SymbolRecord }
  | { t: "ambiguous"; n: number }
  | { t: "external"; pkg: string; exact: boolean }
  | undefined;
type Target =
  | { t: "ext"; pkg: string }
  | { t: "path"; fromFile: string; segs: string[] }
  | { t: "unknown" };

const BASE = (e: string) =>
  e.startsWith("macro:") ||
  e.startsWith("qualified:") ||
  e === "no-type:callee-expression";
// Keeps parse-time evidence (idempotent across warm re-resolution), drops earlier resolver evidence.
const withBase = (call: CallEdge, ev: string) => [
  ...new Set([...call.evidence.filter(BASE), ev]),
];
/** The conservative outcome when resolution throws: no target, `no-type:resolver-error` (macro edges keep theirs). */
export function leaveUnresolvedOnError(call: CallEdge) {
  call.declaredTargetId =
    call.resolvedTargetId =
    call.externalPackage =
    call.runtimeTargetIds =
      undefined;
  call.resolutionKind = "unresolved";
  call.confidence = "unresolved";
  if (isMacroArg(call) || !call.evidence.some((e) => e.startsWith("macro:")))
    call.evidence = withBase(call, "no-type:resolver-error");
}

type Tree = ReturnType<ReturnType<typeof rustParser>["parse"]>;
type FileFacts = {
  text: string;
  lines: number[];
  tree?: Tree;
  conventional?: boolean;
};
type Bindings = {
  source: string;
  sites: Map<string, Node[]>;
  calls: Map<string, Node>;
  root?: Node;
};
/**
 * Parse results that depend ONLY on the exact text they were parsed from, kept across resolve runs so warm
 * rebuilds do not re-parse unchanged files / fns. Every hit is checked against the current text (a changed
 * file or fn is re-parsed); entries for files / symbols no longer indexed are dropped at the start of each run.
 */
/** Trees re-parsed from a macro's arguments -> maps their indices to caller-source indices. */
const MACRO_SHIFT = new WeakMap<object, (i: number) => number>();
const callerIndex = (n: Node) =>
  MACRO_SHIFT.get(n.tree)?.(n.startIndex) ?? n.startIndex;
/** A call recovered from a macro's arguments (never `exact`); a bare `macro:<name>` edge is the invocation itself. */
const MACRO_ARG = "macro:arg ";
const isMacroArg = (call: CallEdge) =>
  call.evidence.some((e) => e.startsWith(MACRO_ARG));
const PERSIST = {
  files: new Map<string, FileFacts>(),
  bindings: new Map<string, Bindings>(),
  generics: new Map<string, { source: string; names: Set<string> }>(),
};

export function resolveCallsA(context: ResolveContext, deps: CallDeps) {
  const byId = new Map<string, SymbolRecord>();
  const childrenOf = new Map<string, SymbolRecord[]>();
  const topByFile = new Map<string, SymbolRecord[]>();
  /** Top-level symbols by `file\0name`, in symbol order (same order a filter over topByFile gives). */
  const topNamed = new Map<string, SymbolRecord[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) =>
    m.get(k)?.push(v) ?? m.set(k, [v]);
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  const methodCount = new Map<string, number>();
  for (const s of context.symbols) {
    byId.set(s.id, s);
    push(symbolsByFile, s.filePath, s);
    if (s.parentId) push(childrenOf, s.parentId, s);
    else {
      push(topByFile, s.filePath, s);
      push(topNamed, `${s.filePath}\0${s.name}`, s);
    }
  }
  for (const s of context.symbols) {
    const p = s.parentId ? byId.get(s.parentId) : undefined;
    if (s.kind === "function" && p && (isImpl(p) || p.kind === "interface"))
      methodCount.set(s.name, (methodCount.get(s.name) ?? 0) + 1);
  }
  for (const k of PERSIST.files.keys())
    if (!symbolsByFile.has(k)) PERSIST.files.delete(k);
  for (const m of [PERSIST.bindings, PERSIST.generics])
    for (const k of m.keys()) if (!byId.has(k)) m.delete(k);
  const importsByFile = new Map<string, ImportRecord[]>();
  for (const r of context.imports) push(importsByFile, r.filePath, r);

  // Files that are the root of a crate other than the library: `src/bin/*`, `tests/*`, `examples/*`,
  // `benches/*`, `build.rs`, and `src/main.rs` next to a `src/lib.rs`. The shared module index maps every file
  // into one tree, so anchored paths (`crate::`/`self::`/`super::`) there would land in the library: never trusted.
  const allFiles = new Set([
    ...symbolsByFile.keys(),
    ...context.imports.map((r) => r.filePath),
    ...context.exports.map((r) => r.filePath),
  ]);
  const foreignRoot = (file: string) => {
    const p = file.replace(/\\/g, "/");
    return (
      /(^|\/)src\/bin\//.test(p) ||
      (/(^|\/)(tests|examples|benches)\//.test(p) && !/(^|\/)src\//.test(p)) ||
      /(^|\/)build\.rs$/.test(p) ||
      (/(^|\/)src\/main\.rs$/.test(p) &&
        allFiles.has(p.replace(/main\.rs$/, "lib.rs")))
    );
  };
  const isAnchor = (seg: string | undefined) =>
    seg === "crate" || seg === "self" || seg === "super";

  const ancestors = (s: SymbolRecord) => {
    const ids = new Set<string>();
    for (
      let c: SymbolRecord | undefined = s;
      c;
      c = c.parentId ? byId.get(c.parentId) : undefined
    )
      ids.add(c.id);
    return ids;
  };

  const enclosing = (caller: SymbolRecord) =>
    caller.parentId ? byId.get(caller.parentId) : undefined;
  const modContainer = (s: SymbolRecord) => {
    for (
      let c = s.parentId ? byId.get(s.parentId) : undefined;
      c;
      c = c.parentId ? byId.get(c.parentId) : undefined
    )
      if (c.kind === "namespace") return c;
    return undefined;
  };
  /** Module scope a symbol lives in: its nearest inline `mod`, else the file's top level. */
  const ownScope = (s: SymbolRecord) =>
    modContainer(s)?.id ?? `file:${s.filePath}`;

  // ---- scopes of `use` / `pub use` records (by range containment in the file's fn/mod symbols)
  const scopeCache = new WeakMap<
    object,
    { vis?: SymbolRecord; mod?: SymbolRecord }
  >();
  const scopeOf = (rec: { filePath: string; range: SymbolRecord["range"] }) => {
    let c = scopeCache.get(rec);
    if (c) return c;
    let vis: SymbolRecord | undefined;
    let mod: SymbolRecord | undefined;
    for (const s of symbolsByFile.get(rec.filePath) ?? []) {
      if (s.kind === "namespace" && s.metadata?.moduleScope === true) continue; // synthetic per-file import symbol, not a real scope
      if (
        (s.kind !== "function" && s.kind !== "namespace") ||
        !contains(s.range, rec.range)
      )
        continue;
      if (!vis || contains(vis.range, s.range)) vis = s;
      if (s.kind === "namespace" && (!mod || contains(mod.range, s.range)))
        mod = s;
    }
    scopeCache.set(rec, (c = { vis, mod }));
    return c;
  };
  // A `use` is visible only inside the module scope that declares it (an inline mod does not
  // inherit its parent's imports) and, when declared in a fn body, only inside that fn.
  const visible = (rec: ImportRecord, from: SymbolRecord) => {
    const { vis, mod } = scopeOf(rec);
    if ((mod?.id ?? "") !== (modContainer(from)?.id ?? "")) return false;
    return !vis || ancestors(from).has(vis.id);
  };
  const sourceCache = new Map<string, FileFacts>();
  const fileText = (sample: SymbolRecord) => {
    let c = sourceCache.get(sample.filePath);
    if (!c) {
      const text = context.sourceOf(sample);
      c = PERSIST.files.get(sample.filePath);
      if (c?.text !== text) {
        const lines = [0];
        for (let i = 0; i < text.length; i++)
          if (text.charCodeAt(i) === 10) lines.push(i + 1);
        PERSIST.files.set(sample.filePath, (c = { text, lines }));
      }
      sourceCache.set(sample.filePath, c);
    }
    return c;
  };
  const offsetIn = (sample: SymbolRecord, line: number, col: number) =>
    fileText(sample).lines[line - 1] + col;
  /** Innermost node at `offset` of the sample's whole-file syntax tree, or undefined when unparsable. */
  const nodeAt = (sample: SymbolRecord, offset: number): Node | undefined => {
    const c = fileText(sample);
    try {
      c.tree ??= rustParser().parse((i: number) => c.text.slice(i, i + 4_096));
      return c.tree.rootNode.descendantForIndex(offset);
    } catch {
      return undefined;
    }
  };
  /** [start, end) of the innermost `{ }` block enclosing `offset`, or undefined at module level. */
  const blockAt = (
    sample: SymbolRecord,
    offset: number,
  ): [number, number] | undefined => {
    for (
      let n: Node | null | undefined = nodeAt(sample, offset);
      n;
      n = n.parent
    )
      if (n.type === "block") return [n.startIndex, n.endIndex];
    return undefined;
  };
  /**
   * True when the block declaring the item at `at` also encloses the call being resolved.
   * Converts `currentCall`'s position with `sample`'s own file line table (`offsetIn(sample, ...)`),
   * so `sample.filePath` MUST equal the file `currentCall` lives in, or the comparison is garbage.
   * This holds today only because every caller reaching here through a cross-file lookup
   * (fieldTy / aliasTy / armTy, whose `from` can be a decl in another file) first checks
   * `inFn(from)` and bails when it's true -- which is also what `visible()` relies on to exclude
   * a fn-local `use`/item unrelated to that cross-file `from`. Adding a new caller that passes a
   * cross-file `sample` without that same `inFn` guard would silently reintroduce file-mismatched
   * offsets here.
   */
  const declEnclosesCall = (
    sample: SymbolRecord,
    at: SymbolRecord["range"],
  ) => {
    if (!currentCall) return true;
    const blk = blockAt(sample, offsetIn(sample, at.startLine, at.startColumn));
    if (!blk) return true;
    const c = offsetIn(
      sample,
      currentCall.range.startLine,
      currentCall.range.startColumn,
    );
    return c >= blk[0] && c < blk[1];
  };
  // The call being resolved (set by the main loop; undefined while resolving impl headers). A fn-local
  // `use` counts only if the block it sits in encloses this call.
  let currentCall: CallEdge | undefined;
  const importsFor = (file: string, from: SymbolRecord) =>
    (importsByFile.get(file) ?? []).filter(
      (r) =>
        visible(r, from) &&
        (scopeOf(r).vis?.kind !== "function" ||
          declEnclosesCall(from, r.range)),
    );
  /** Imports declared in a fn body (enclosing the call) that bind `name`: they shadow module-level items. */
  const localImportsNamed = (file: string, from: SymbolRecord, name: string) =>
    importsFor(file, from).filter(
      (r) =>
        !r.wildcard &&
        r.localName === name &&
        scopeOf(r).vis?.kind === "function",
    );

  // ---- where a `use` points
  const targetCache = new WeakMap<ImportRecord, Target>();
  const importTarget = (rec: ImportRecord): Target => {
    let t = targetCache.get(rec);
    if (t) return t;
    t = computeTarget(rec);
    targetCache.set(rec, t);
    return t;
  };
  const computeTarget = (rec: ImportRecord): Target => {
    if (rec.externalPackage) return { t: "ext", pkg: rec.externalPackage };
    const mod = rec.module.split("::");
    if (
      !rec.wildcard &&
      (!rec.importedName || (mod.length === 1 && mod[0] === rec.importedName))
    )
      return { t: "unknown" };
    let segs = rec.wildcard ? mod : [...mod, rec.importedName!];
    if (isAnchor(segs[0]) && foreignRoot(rec.filePath)) return { t: "unknown" };
    const fromFile = rec.filePath;
    const container = scopeOf(rec).mod;
    if (container) {
      // `use` inside an inline mod: anchors are relative to that mod, not the file's module.
      if (segs[0] === "super" && !container.parentId)
        segs = ["self", ...segs.slice(1)];
      else if (segs[0] !== "crate") return { t: "unknown" };
    }
    return { t: "path", fromFile, segs };
  };
  // Exact module file of `segs`, unless a prefix's file declares an INLINE mod on the way: that mod has no
  // file, and a same-named orphan/cfg-alternative file must never stand in for it.
  const moduleFile = (segs: string[], fromFile: string) => {
    if (!segs.length) return undefined;
    for (let i = isAnchor(segs[0]) ? 1 : 0; i < segs.length; i++) {
      const pf =
        i === 0 ? fromFile : deps.moduleOf(segs.slice(0, i), fromFile).file;
      const inline = (topNamed.get(`${pf ?? ""}\0${segs[i]}`) ?? []).some(
        (s) => s.kind === "namespace" && s.bodyRange !== undefined,
      );
      if (inline) return undefined;
    }
    return deps.moduleOf(segs, fromFile).file;
  };

  // ---- item lookup in a module file, following `pub use` chains
  // `use` declarations with a visibility modifier (they also produce export records).
  const pubUses = new Set(
    context.exports.map(
      (e) => `${e.filePath}:${e.range.startLine}:${e.range.startColumn}`,
    ),
  );
  /** True when module file `asker` is `file`'s module or one of its descendants. */
  const within = (asker: string, file: string) => {
    const a = modulePathFor(asker);
    return modulePathFor(file).every((seg, i) => a[i] === seg);
  };
  /** Items named `name` in module `file` as seen from module file `asker` (private `use` only from within). */
  const lookupItems = (
    file: string,
    name: string,
    asker: string,
    seen = new Set<string>(),
  ): SymbolRecord[] => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const direct = (topNamed.get(`${file}\0${name}`) ?? []).filter(
      (s) => !isImpl(s),
    );
    if (direct.length) return direct;
    const out = new Map<string, SymbolRecord>();
    const add = (list: SymbolRecord[]) => list.forEach((s) => out.set(s.id, s));
    // Module-level `use` records: `pub` ones always, private ones only for the module itself and its descendants.
    const inside = within(asker, file);
    for (const rec of importsByFile.get(file) ?? []) {
      const sc = scopeOf(rec);
      if (sc.vis || sc.mod || rec.externalPackage) continue;
      if (
        !inside &&
        !pubUses.has(
          `${rec.filePath}:${rec.range.startLine}:${rec.range.startColumn}`,
        )
      )
        continue;
      const mod = rec.module.split("::");
      if (isAnchor(mod[0]) && foreignRoot(file)) continue;
      if (rec.wildcard) {
        const f = moduleFile(mod, file);
        if (f) add(lookupItems(f, name, file, seen));
      } else if (
        rec.localName === name &&
        rec.importedName &&
        !(mod.length === 1 && mod[0] === rec.importedName)
      ) {
        const f = moduleFile(mod, file);
        if (f) add(lookupItems(f, rec.importedName, file, seen));
      }
    }
    return [...out.values()];
  };
  const itemsVia = (
    t: Target & { t: "path" },
    name?: string,
  ): SymbolRecord[] => {
    const segs = name === undefined ? t.segs.slice(0, -1) : t.segs;
    const last = name ?? t.segs.at(-1)!;
    const f = moduleFile(segs, t.fromFile);
    return f ? lookupItems(f, last, t.fromFile) : [];
  };

  // ---- glob imports visible from a scope
  // `unknown`: a glob we cannot see into may provide `name`. A glob of a CamelCase path (`use Enum::*`)
  // only brings that enum's variants, which are CamelCase too, so it cannot provide a lowercase name.
  // This rests on the naming CONVENTION only (`#[allow(non_camel_case_types)]` variants can break it), so a
  // file mentioning that attribute gets the conservative answer: every unseeable glob may provide the name.
  /** Start offset of the innermost `{ }` block holding a fn-local import (-1 when not fn-local). */
  const blockStartOf = (from: SymbolRecord, rec: ImportRecord) =>
    scopeOf(rec).vis?.kind === "function"
      ? (blockAt(
          from,
          offsetIn(from, rec.range.startLine, rec.range.startColumn),
        )?.[0] ?? -1)
      : -1;
  const globs = (
    file: string,
    from: SymbolRecord,
    name: string,
    onlyLocal = false,
    minBlock = -1,
  ) => {
    const ft = fileText(from);
    const conventional = (ft.conventional ??= !ft.text.includes(
      "non_camel_case_types",
    ));
    const files: { file: string }[] = [];
    // Items an ancestor scope imports by name, which `use super::*` / `use crate::*` also brings in.
    const extra: SymbolRecord[] = [];
    let unknown = false;
    const wild = importsFor(file, from).filter(
      (r) =>
        r.wildcard &&
        (!onlyLocal ||
          (scopeOf(r).vis?.kind === "function" &&
            blockStartOf(from, r) > minBlock)),
    );
    for (const rec of wild) {
      const t = importTarget(rec);
      const f = t.t === "path" ? moduleFile(t.segs, t.fromFile) : undefined;
      if (f) {
        files.push({ file: f });
        if (t.t === "path" && t.segs.every(isAnchor))
          for (const r of importsByFile.get(f) ?? []) {
            if (
              r === rec ||
              r.wildcard ||
              r.localName !== name ||
              scopeOf(r).vis
            )
              continue;
            const rt = importTarget(r);
            if (rt.t === "path") extra.push(...itemsVia(rt));
            else unknown = true; // an external / unknown import of that name: cannot see into it
          }
      } else if (!(
        conventional &&
        /^[a-z_]/.test(name) &&
        /^[A-Z]/.test(rec.module.split("::").at(-1) ?? "")
      ))
        unknown = true;
    }
    return { files, extra, unknown, hit: files.length > 0 || unknown };
  };

  // ---- types
  // Type declarations by module scope (never merged across inline mods) and, loosely, by file.
  const typeDeclsByScope = new Map<string, Map<string, SymbolRecord[]>>();
  const typeNamesInFile = new Map<string, Set<string>>();
  for (const s of context.symbols) {
    const p = s.parentId ? byId.get(s.parentId) : undefined;
    if (!TYPE_KINDS.has(s.kind) || isImpl(s) || (p && p.kind !== "namespace"))
      continue;
    const key = ownScope(s);
    let m = typeDeclsByScope.get(key);
    if (!m) typeDeclsByScope.set(key, (m = new Map()));
    push(m, s.name, s);
    let names = typeNamesInFile.get(s.filePath);
    if (!names) typeNamesInFile.set(s.filePath, (names = new Set()));
    names.add(s.name);
  }
  /** Items declared in a fn body (in a block enclosing the call) that shadow module-level names. */
  const localItems = (from: SymbolRecord, name: string) => {
    const out: SymbolRecord[] = [];
    for (
      let a: SymbolRecord | undefined = from;
      a;
      a = a.parentId ? byId.get(a.parentId) : undefined
    )
      if (a.kind === "function")
        for (const c of childrenOf.get(a.id) ?? [])
          if (
            c.name === name &&
            c.kind !== "function" &&
            !isImpl(c) &&
            declEnclosesCall(from, c.range)
          )
            out.push(c);
    return out;
  };
  const declsHere = (from: SymbolRecord, name: string) =>
    typeDeclsByScope.get(ownScope(from))?.get(name) ?? [];
  const fromDecls = (list: SymbolRecord[]): TypeRes => {
    const uniq = [...new Map(list.map((s) => [s.id, s])).values()];
    return uniq.length === 1
      ? { t: "decl", sym: uniq[0] }
      : uniq.length > 1
        ? { t: "ambiguous", n: uniq.length }
        : undefined;
  };
  const typeName = (
    name: string,
    file: string,
    from: SymbolRecord,
  ): TypeRes => {
    const viaImports = (recs: ImportRecord[]): TypeRes => {
      const decls: SymbolRecord[] = [];
      const ext = new Set<string>();
      let unknown = false;
      for (const r of recs) {
        const t = importTarget(r);
        if (t.t === "ext") ext.add(t.pkg);
        else if (t.t === "unknown") unknown = true;
        else decls.push(...itemsVia(t).filter((s) => TYPE_KINDS.has(s.kind)));
      }
      if (unknown || (ext.size && decls.length) || ext.size > 1)
        return undefined;
      if (ext.size) return { t: "external", pkg: [...ext][0], exact: true };
      return fromDecls(decls);
    };
    const localTypes = localItems(from, name).filter((s) =>
      TYPE_KINDS.has(s.kind),
    );
    if (localTypes.length) return fromDecls(localTypes);
    const local = localImportsNamed(file, from, name);
    const named = local.length
      ? Math.max(...local.map((r) => blockStartOf(from, r)))
      : -1;
    const lg = globs(file, from, name, true, named);
    if (lg.hit) {
      const lc = fromDecls(
        [
          ...lg.files.flatMap((x) => lookupItems(x.file, name, file)),
          ...lg.extra,
        ].filter((s) => TYPE_KINDS.has(s.kind)),
      );
      if (lc) return lg.unknown ? undefined : lc;
      if (lg.unknown) return undefined;
    }
    if (local.length) return viaImports(local); // a fn-local `use` shadows module-level items
    const same = declsHere(from, name);
    if (same.length) return fromDecls(same);
    const recs = importsFor(file, from).filter(
      (r) => !r.wildcard && r.localName === name,
    );
    if (recs.length) return viaImports(recs);
    const g = globs(file, from, name);
    const cands = [
      ...g.files.flatMap((x) => lookupItems(x.file, name, file)),
      ...g.extra,
    ].filter((s) => TYPE_KINDS.has(s.kind));
    const found = fromDecls(cands);
    if (found) return g.unknown ? undefined : found;
    if (STD_TYPES.has(name) && !(g.unknown && SHADOWABLE.has(name)))
      return { t: "external", pkg: "std", exact: false };
    return undefined;
  };
  /** Type named by `segs` (`Foo` or `a::b::Foo`), seen from `from` in `file`. */
  const typePath = (
    segs: string[],
    file: string,
    from: SymbolRecord,
  ): TypeRes => {
    if (segs.length === 1) return typeName(segs[0], file, from);
    const full = expand(segs, file, from);
    if (!full) return undefined;
    if (full.t === "ext")
      return { t: "external", pkg: full.pkg, exact: full.exact };
    return fromDecls(
      itemsVia({ t: "path", fromFile: full.fromFile, segs: full.segs }).filter(
        (s) => TYPE_KINDS.has(s.kind),
      ),
    );
  };
  /** Replaces a first segment that is a visible `use` alias by the aliased path. */
  const expand = (
    segs: string[],
    file: string,
    from: SymbolRecord,
  ):
    | (
        | { t: "ext"; pkg: string; exact: boolean }
        | { t: "path"; fromFile: string; segs: string[]; via?: ImportRecord }
      )
    | undefined => {
    const [first, ...rest] = segs;
    if (first === "crate" || first === "self" || first === "super")
      return { t: "path", fromFile: file, segs };
    const recs = importsFor(file, from).filter(
      (r) => !r.wildcard && r.localName === first,
    );
    if (recs.length > 1) return undefined;
    if (recs.length === 1) {
      const t = importTarget(recs[0]);
      if (t.t === "ext") return { t: "ext", pkg: t.pkg, exact: true };
      if (t.t === "unknown") return undefined;
      return {
        t: "path",
        fromFile: t.fromFile,
        segs: [...t.segs, ...rest],
        via: recs[0],
      };
    }
    if (STD_ROOTS.has(first) && !boundNames(file, first))
      return { t: "ext", pkg: first, exact: true }; // `std`, `core` or `alloc`
    return { t: "path", fromFile: file, segs };
  };
  const boundNames = (file: string, name: string) =>
    (typeNamesInFile.get(file)?.has(name) ?? false) ||
    (symbolsByFile.get(file) ?? []).some(
      (s) => s.kind === "namespace" && s.name === name,
    ) ||
    (importsByFile.get(file) ?? []).some((r) => r.localName === name);

  // ---- impls
  const implTexts = (
    impl: SymbolRecord,
  ): { self?: string[]; trait?: string[] } => {
    const label = impl.name.slice("impl ".length);
    const at = label.lastIndexOf(" for ");
    const parts =
      at >= 0 ? [label.slice(0, at), label.slice(at + 5)] : [undefined, label];
    const segsOf = (t: string | undefined, base: string | undefined) => {
      if (!t || !base) return undefined;
      let s = "";
      for (let depth = 0, i = 0; i < t.length; i++) {
        if (t[i] === "<") depth++;
        else if (t[i] === ">") depth--;
        else if (depth === 0) s += t[i];
      }
      const segs = s
        .trim()
        .split("::")
        .map((x) => x.trim());
      return segs.every((x) => IDENT.test(x)) && segs.at(-1) === base
        ? segs
        : undefined;
    };
    return {
      self: segsOf(parts[1], impl.metadata?.implSelfType),
      trait:
        parts[0] === undefined
          ? undefined
          : segsOf(parts[0], impl.metadata?.implTrait),
    };
  };
  const implSelf = (impl: SymbolRecord): TypeRes => {
    const segs = implTexts(impl).self;
    return segs ? typePath(segs, impl.filePath, impl) : undefined;
  };
  const implTrait = (impl: SymbolRecord): TypeRes => {
    const segs = implTexts(impl).trait;
    return segs ? typePath(segs, impl.filePath, impl) : undefined;
  };
  type Method = { sym: SymbolRecord; impl: SymbolRecord };
  const methodsByType = new Map<string, Method[]>();
  const traitsByType = new Map<string, Set<SymbolRecord>>();
  for (const impl of context.symbols.filter(
    (s) => isImpl(s) && s.metadata?.implSelfType,
  )) {
    const self = implSelf(impl);
    if (self?.t !== "decl") continue;
    for (const m of childrenOf.get(impl.id) ?? [])
      if (m.kind === "function")
        push(methodsByType, self.sym.id, { sym: m, impl });
    if (impl.metadata?.implTrait) {
      const tr = implTrait(impl);
      if (tr?.t === "decl" && tr.sym.kind === "interface") {
        let set = traitsByType.get(self.sym.id);
        if (!set) traitsByType.set(self.sym.id, (set = new Set()));
        set.add(tr.sym);
      }
    }
  }
  const traitMethods = (trait: SymbolRecord, name: string) =>
    (childrenOf.get(trait.id) ?? []).filter(
      (s) => s.kind === "function" && s.name === name,
    );
  // Method names an in-repo impl gives to something that is not an in-repo type (blanket `impl<T> Tr for T`,
  // `impl Tr for String`): a receiver of an external type may reach them.
  const foreignNames = new Set<string>();
  // In-repo traits with a blanket impl (`impl<T: ..> Tr for T` / `for &T`): any type may have their methods.
  // Filtered lazily: the generics reader is declared further down.
  const blanketCands: {
    impl: SymbolRecord;
    trait: SymbolRecord;
    self: string;
  }[] = [];
  let blanketCache: SymbolRecord[] | undefined;
  const blanketTraits = () =>
    (blanketCache ??= [
      ...new Set(
        blanketCands
          .filter((b) => declaredGenerics(b.impl).has(b.self))
          .map((b) => b.trait),
      ),
    ]);
  for (const impl of context.symbols.filter(isImpl)) {
    if (impl.metadata?.implSelfType && implSelf(impl)?.t === "decl") continue;
    const tr = impl.metadata?.implTrait ? implTrait(impl) : undefined;
    if (
      tr?.t === "decl" &&
      tr.sym.kind === "interface" &&
      impl.name.includes(" for ")
    )
      blanketCands.push({
        impl,
        trait: tr.sym,
        self: impl.name
          .slice(impl.name.lastIndexOf(" for ") + 5)
          .replace(/^&\s*('\w+\s+)?(mut\s+)?/, "")
          .trim(),
      });
    for (const owner of [impl, ...(tr?.t === "decl" ? [tr.sym] : [])])
      for (const m of childrenOf.get(owner.id) ?? [])
        if (m.kind === "function") foreignNames.add(m.name);
  }

  // ---- caller facts
  /** `path` (`recv::f()`), `method` (`recv.f()`) or undefined, from the text right after the receiver. */
  const shapeOf = (
    call: CallEdge,
    caller: SymbolRecord,
  ): "path" | "method" | undefined => {
    const rt = call.receiverText!;
    const off = offsetIn(caller, call.range.startLine, call.range.startColumn);
    const tail = fileText(caller).text.slice(off, off + rt.length + 200);
    if (!tail.startsWith(rt)) return "method"; // `<call>`-style marker: the receiver text is not in the source
    const after = tail.slice(rt.length).trimStart();
    return after.startsWith("::")
      ? "path"
      : after.startsWith(".")
        ? "method"
        : undefined;
  };
  /**
   * Binding sites (the let / parameter / for / closure / arm / const node) of every name bound by parameters,
   * `let`, closures, `for`, `if let`/`match` patterns anywhere in the caller, parsed from the caller's own source
   * (offsets relative to its start). `*` = unparsable: every name may be shadowed.
   */
  const bindingSites = (caller: SymbolRecord): Bindings => {
    let c = PERSIST.bindings.get(caller.id);
    if (c?.source === caller.source) return c;
    const sites = new Map<string, Node[]>();
    const calls = new Map<string, Node>();
    const add = (name: string, owner: Node) => push(sites, name, owner);
    const collect = (n: Node | null, owner: Node) => {
      if (!n) return;
      if (n.type === "identifier" || n.type === "shorthand_field_identifier")
        add(n.text, owner);
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i)!;
        const parentField =
          ["tuple_struct_pattern", "struct_pattern"].includes(n.type) &&
          n.childForFieldName("type")?.id === c.id;
        if (c.type === "scoped_identifier" || parentField) continue;
        collect(c, owner);
      }
    };
    const visit = (n: Node) => {
      switch (n.type) {
        case "macro_invocation": {
          const args = macroArgs(n);
          if (args) {
            const outer = MACRO_SHIFT.get(n.tree) ?? ((i: number) => i);
            MACRO_SHIFT.set(args.root.tree, (i) => outer(macroIndex(args, i)));
            visit(args.root);
          }
          break;
        }
        case "call_expression":
          calls.set(
            `${callerIndex(n)}:${callerIndex(n) + n.endIndex - n.startIndex}`,
            n,
          );
          break;
        case "let_declaration":
        case "for_expression":
        case "let_condition":
        case "parameter":
        case "match_arm":
          collect(n.childForFieldName("pattern"), n);
          break;
        case "closure_parameters":
          collect(n, n);
          break;
        case "const_item":
        case "static_item":
          if (n.childForFieldName("name"))
            add(n.childForFieldName("name")!.text, n);
          break;
        case "self_parameter":
          add("self", n);
          break;
      }
      for (const c of n.namedChildren) if (c.type !== "token_tree") visit(c);
    };
    let root: Node | undefined;
    try {
      root = rustParser().parse((i: number) =>
        caller.source.slice(i, i + 4_096),
      ).rootNode;
      visit(root);
    } catch {
      sites.set("*", []);
    }
    PERSIST.bindings.set(
      caller.id,
      (c = { source: caller.source, sites, calls, root }),
    );
    return c;
  };
  const bindingsOf = (caller: SymbolRecord) => bindingSites(caller).sites;
  /** Type/const parameter names declared by a fn / impl / trait, read from its syntax tree (any qualifiers). */
  const declaredGenerics = (s: SymbolRecord) => {
    const hit = PERSIST.generics.get(s.id);
    if (hit?.source === s.source) return hit.names;
    const names = new Set<string>();
    try {
      // Only the head matters: parsing the whole impl/trait body is wasted work.
      const head =
        s.kind === "function"
          ? s.source
          : `${s.source.slice(0, Math.max(0, s.source.indexOf("{")))}{}`;
      const item = rustParser()
        .parse((i: number) => head.slice(i, i + 4_096))
        .rootNode.namedChild(0);
      for (const p of (item ? field(item, "type_parameters") : null)
        ?.namedChildren ?? []) {
        const n =
          p.type === "type_identifier"
            ? p
            : (field(p, "left") ?? field(p, "name"));
        if (n && (n.type === "type_identifier" || n.type === "identifier"))
          names.add(n.text);
      }
    } catch {
      names.add("*"); // unparsable head: any name may be a type parameter
    }
    PERSIST.generics.set(s.id, { source: s.source, names });
    return names;
  };
  /** Type parameters in scope for a caller: its own, its impl's or trait's. */
  const isGenericParam = (caller: SymbolRecord, name: string) => {
    const owner = enclosing(caller);
    const has = (x: SymbolRecord) =>
      declaredGenerics(x).has(name) || declaredGenerics(x).has("*");
    return (
      has(caller) ||
      (!!owner && (isImpl(owner) || owner.kind === "interface") && has(owner))
    );
  };

  // ---- edge writers
  type Outcome = () => void;
  const unresolved =
    (call: CallEdge, ev: string): Outcome =>
    () => {
      call.evidence = withBase(call, ev);
    };
  const ambiguous = (call: CallEdge, n: number, what: string) =>
    unresolved(call, `ambiguous:${n} ${what}`);
  /**
   * Same-name fns in one scope of one file that differ only by `#[cfg(..)]` (spec §40: which one is active is
   * not known): every alternative is attached (`runtimeTargetIds`), the first in source order as the target,
   * `probable`. Any other same-name ambiguity stays `ambiguous:N`.
   */
  const fnChoice = (
    call: CallEdge,
    fns: SymbolRecord[],
    what: string,
    kind: CallEdge["resolutionKind"] = "same-file",
  ): Outcome => {
    const isCfg = (a: string) => /^#\[\s*cfg\s*\(/.test(a);
    const rest = (s: SymbolRecord) =>
      JSON.stringify((s.annotations ?? []).filter((a) => !isCfg(a)));
    const gated = fns.every(
      (f) =>
        f.kind === "function" &&
        f.filePath === fns[0].filePath &&
        f.parentId === fns[0].parentId &&
        (f.annotations ?? []).some(isCfg) &&
        rest(f) === rest(fns[0]),
    );
    if (!gated) return ambiguous(call, fns.length, what);
    const sorted = [...fns].sort(
      (a, b) => a.range.startLine - b.range.startLine,
    );
    const pick = settle(
      call,
      sorted[0],
      kind,
      `ambiguous:cfg ${fns.length} cfg-gated alternatives of ${sorted[0].qualifiedName}`,
      "probable",
    );
    return () => {
      pick();
      call.runtimeTargetIds = sorted.map((f) => f.id);
    };
  };
  const settle =
    (
      call: CallEdge,
      target: SymbolRecord,
      kind: CallEdge["resolutionKind"],
      evidence: string,
      confidence: "exact" | "probable" = "exact",
    ): Outcome =>
    () => {
      call.declaredTargetId = target.id;
      call.resolvedTargetId = target.id;
      call.resolutionKind = kind;
      call.confidence = confidence;
      call.evidence = withBase(call, evidence);
    };
  const external =
    (call: CallEdge, pkg: string, exact: boolean, ev: string): Outcome =>
    () => {
      call.externalPackage = pkg;
      call.resolutionKind = "external-package";
      call.confidence = exact ? "exact" : "probable";
      call.evidence = withBase(call, ev);
    };

  /** Methods/assoc fns named `name` on a resolved type: impls first, then traits the type implements. */
  const memberOf = (
    call: CallEdge,
    decl: SymbolRecord,
    name: string,
    kind: CallEdge["resolutionKind"],
    extraTrait?: SymbolRecord,
  ): Outcome => {
    if (decl.kind === "interface") return traitDecl(call, [decl], name);
    const cands = (methodsByType.get(decl.id) ?? []).filter(
      (m) => m.sym.name === name,
    );
    // A blanket impl of an in-scope trait declaring `name` competes with the type's own methods.
    const asker = byId.get(call.callerId);
    const blanket = asker
      ? blanketTraits().filter((t) => {
          if (!traitMethods(t, name).length) return false;
          const seen = typeName(t.name, asker.filePath, asker);
          return seen?.t === "decl" && seen.sym.id === t.id;
        })
      : [];
    const own = [
      ...(traitsByType.get(decl.id) ?? []),
      ...(extraTrait ? [extraTrait] : []),
    ].filter((t) => !blanket.includes(t));
    if (
      blanket.length &&
      (cands.length || own.some((t) => traitMethods(t, name).length))
    )
      return ambiguous(
        call,
        cands.length + blanket.length,
        `${decl.name}::${name} or blanket impl of ${blanket.map((t) => t.name).join(", ")}`,
      );
    if (cands.length === 1) {
      const { sym, impl } = cands[0];
      const traitName = impl.metadata?.implTrait;
      if (traitName) {
        // Derived / std impls are not indexed, so a unique in-repo trait impl is not unique in Rust when the
        // type derives the same method; and a trait method is only a candidate when its trait is in scope.
        const derived = DERIVE_TRAIT[name];
        if (
          derived &&
          (decl.annotations ?? []).some((a) =>
            new RegExp(`derive\\s*\\([^)]*\\b${derived}\\b`).test(a),
          )
        )
          return ambiguous(
            call,
            2,
            `derive(${derived}) and ${traitName} for ${decl.name}::${name}`,
          );
        const caller = byId.get(call.callerId);
        const trait = [...(traitsByType.get(decl.id) ?? [])].find(
          (t) => t.name === traitName && traitMethods(t, name).length > 0,
        );
        const seen = caller
          ? typeName(traitName, caller.filePath, caller)
          : undefined;
        const owner = caller ? enclosing(caller) : undefined;
        const ot = owner && isImpl(owner) ? implTrait(owner) : undefined;
        const viaOwnImpl =
          !!ot &&
          owner!.metadata?.implTrait === traitName &&
          (trait
            ? ot.t === "decl" && ot.sym.id === trait.id
            : ot.t === "external");
        const visibleHere =
          viaOwnImpl ||
          (trait
            ? seen?.t === "decl" && seen.sym.id === trait.id
            : seen?.t === "external");
        if (!visibleHere)
          return unresolved(call, `no-type:trait-not-in-scope ${traitName}`);
      }
      return settle(
        call,
        sym,
        kind,
        impl.metadata?.implTrait
          ? `trait:unique impl target ${impl.metadata.implTrait} for ${decl.name}::${name}`
          : `inherent:unique target ${decl.name}::${name}`,
      );
    }
    if (cands.length > 1)
      return ambiguous(
        call,
        cands.length,
        `candidates for ${decl.name}::${name}`,
      );
    const traits = new Set(traitsByType.get(decl.id) ?? []);
    if (extraTrait) traits.add(extraTrait);
    const viaTrait = [...traits].filter((t) => traitMethods(t, name).length);
    if (viaTrait.length) return traitDecl(call, viaTrait, name);
    if (decl.kind === "enum" && /^[A-Z]/.test(name))
      return unresolved(call, "no-symbol:variant");
    return unresolved(call, `no-symbol:member ${decl.name}::${name}`);
  };
  const traitDecl = (
    call: CallEdge,
    traits: SymbolRecord[],
    name: string,
  ): Outcome => {
    const decls = traits.flatMap((t) => traitMethods(t, name));
    if (decls.length === 1)
      return settle(
        call,
        decls[0],
        "interface",
        `trait:declaration ${traits.find((t) => t.id === decls[0].parentId)?.name}::${name}`,
        "probable",
      );
    if (decls.length > 1)
      return ambiguous(call, decls.length, `trait declarations of ${name}`);
    return unresolved(call, `no-symbol:member trait::${name}`);
  };
  const typeOutcome = (
    call: CallEdge,
    res: TypeRes,
    name: string,
    kind: CallEdge["resolutionKind"],
    extraTrait?: SymbolRecord,
  ): Outcome => {
    if (!res) return unresolved(call, "no-type:unknown-type");
    if (res.t === "ambiguous")
      return ambiguous(call, res.n, "types with that name");
    if (res.t === "external")
      return external(
        call,
        res.pkg,
        res.exact,
        `external type from ${res.pkg}`,
      );
    return memberOf(call, res.sym, name, kind, extraTrait);
  };
  const enclosingTypeRes = (
    caller: SymbolRecord,
  ): { res: TypeRes; trait?: SymbolRecord; owner?: SymbolRecord } => {
    const owner = enclosing(caller);
    if (!owner) return { res: undefined };
    if (owner.kind === "interface")
      return { res: { t: "decl", sym: owner }, owner };
    if (!isImpl(owner)) return { res: undefined };
    const tr = implTrait(owner);
    return {
      res: implSelf(owner),
      owner,
      trait:
        tr?.t === "decl" && tr.sym.kind === "interface" ? tr.sym : undefined,
    };
  };

  // ---- part B: syntactic receiver types (no inference engine)
  // `bound` = a generic param / `impl Trait` / `dyn Trait`: only its traits are known (in-repo decls, external pkgs).
  type Ty =
    | { t: "decl"; sym: SymbolRecord; args: Ty[] }
    | { t: "ext"; pkg: string; exact: boolean; name: string; args: Ty[] }
    | { t: "bound"; traits: SymbolRecord[]; ext: string[]; unknown: boolean }
    | { t: "ambiguous"; n: number }
    | undefined;
  /** Where a type is written: `from` resolves names; generics of `owners` are bounds only when `bounded`
   * (the caller's own signature/body), else unknown (another fn's return type, a field). */
  type Scope = {
    from: SymbolRecord;
    owners: SymbolRecord[];
    bounded: boolean;
    subst?: Map<string, Ty>;
    self?: () => Ty;
  };
  const WRAPPERS = new Set(["Box", "Arc", "Rc"]);
  // Methods the wrapper itself has (or gets from std traits): never pushed through to the inner type.
  const WRAPPER_METHODS = new Set([
    "clone",
    "as_ref",
    "as_mut",
    "borrow",
    "borrow_mut",
    "deref",
    "deref_mut",
    "eq",
    "ne",
    "cmp",
    "partial_cmp",
    "fmt",
    "hash",
    "to_string",
    "to_owned",
    "into",
    "try_into",
    "downcast",
    "downcast_ref",
    "downcast_mut",
  ]);
  const UNWRAP = new Set([
    "unwrap",
    "expect",
    "unwrap_or_default",
    "unwrap_or",
    "unwrap_or_else",
  ]);
  const ITEM_NODES: Record<string, string[]> = {
    function: ["function_item", "function_signature_item"],
    class: ["struct_item"],
    enum: ["enum_item"],
    type: ["impl_item", "type_item"],
    interface: ["trait_item"],
  };
  /** Syntax node of a declaration in its whole-file tree. */
  const declNode = (s: SymbolRecord): Node | undefined => {
    const off = offsetIn(s, s.range.startLine, s.range.startColumn);
    for (let n: Node | null | undefined = nodeAt(s, off); n; n = n.parent)
      if (n.startIndex === off && ITEM_NODES[s.kind]?.includes(n.type))
        return n;
    return undefined;
  };
  // Items declared inside a fn body see block-local names we only model relative to the call: not typed.
  const inFn = (s: SymbolRecord) =>
    [...ancestors(s)].some(
      (id) => id !== s.id && byId.get(id)?.kind === "function",
    );
  const ownerOf = (fn: SymbolRecord) => {
    const o = enclosing(fn);
    return o && (isImpl(o) || o.kind === "interface") ? o : undefined;
  };
  // A fn's signature scope: module-level names, never its own body's `use`/items (a distinct id hides them).
  const sigFromCache = new Map<string, SymbolRecord>();
  const sigFrom = (fn: SymbolRecord) =>
    sigFromCache.get(fn.id) ??
    sigFromCache.set(fn.id, { ...fn, id: `${fn.id}#sig` }).get(fn.id)!;
  const selfTy = (owner: SymbolRecord | undefined, bounded: boolean): Ty => {
    if (!owner || inFn(owner)) return undefined;
    if (owner.kind === "interface")
      return bounded
        ? { t: "bound", traits: [owner], ext: [], unknown: false }
        : undefined;
    if (!isImpl(owner) || !owner.metadata?.implSelfType) return undefined;
    return tyOf(declNode(owner)?.childForFieldName("type"), {
      from: owner,
      owners: [owner],
      bounded,
    });
  };
  const sigScope = (fn: SymbolRecord, bounded: boolean): Scope => {
    const owner = ownerOf(fn);
    return {
      from: sigFrom(fn),
      owners: owner ? [fn, owner] : [fn],
      bounded,
      self: () => selfTy(owner, bounded),
    };
  };
  const bodyScope = (caller: SymbolRecord): Scope => ({
    ...sigScope(caller, true),
    from: caller,
  });

  /** Trait bounds written on generic `name` by an owner (inline and `where`), or undefined if it declares no such param. */
  const boundNodes = (owner: Node, name: string): Node[] | undefined => {
    let found = false;
    const out: Node[] = [];
    for (const p of field(owner, "type_parameters")?.namedChildren ?? []) {
      const left =
        p.type === "type_identifier"
          ? p
          : (field(p, "left") ?? field(p, "name"));
      if (left?.text !== name) continue;
      found = true;
      out.push(...(field(p, "bounds")?.namedChildren ?? []));
    }
    for (const w of owner.namedChildren.find((c) => c.type === "where_clause")
      ?.namedChildren ?? [])
      if (w.type === "where_predicate" && field(w, "left")?.text === name)
        out.push(...(field(w, "bounds")?.namedChildren ?? []));
    return found ? out : undefined;
  };
  const boundTy = (nodes: Node[], sc: Scope): Ty => {
    const b = {
      t: "bound" as const,
      traits: [] as SymbolRecord[],
      ext: [] as string[],
      unknown: false,
    };
    for (let n of nodes) {
      if (n.type === "lifetime" || n.type === "removed_trait_bound") continue;
      if (n.type === "higher_ranked_trait_bound") n = field(n, "type") ?? n;
      if (n.type === "dynamic_type") n = field(n, "trait") ?? n;
      if (n.type === "function_type") {
        // `Fn(..)` sugar: a std trait
        b.ext.push("std");
        continue;
      }
      const t = tyOf(n, { ...sc, bounded: false });
      if (t?.t === "decl" && t.sym.kind === "interface") b.traits.push(t.sym);
      else if (t?.t === "ext") b.ext.push(t.pkg);
      else b.unknown = true;
    }
    return b;
  };
  /** A type alias `type X<P> = T;` expanded with its use-site arguments. */
  const aliasTy = (alias: SymbolRecord, args: Ty[], depth: number): Ty => {
    const node = inFn(alias) ? undefined : declNode(alias);
    if (node?.type !== "type_item") return undefined;
    const params = [...typeParamNames(node)];
    if (args.length && args.length !== params.length) return undefined;
    const subst = new Map<string, Ty>(params.map((p, i) => [p, args[i]]));
    return tyOf(
      field(node, "type"),
      { from: alias, owners: [], bounded: false, subst },
      depth + 1,
    );
  };
  const named = (res: TypeRes, name: string, args: Ty[], depth: number): Ty => {
    if (!res) return undefined;
    if (res.t === "ambiguous") return res;
    if (res.t === "external")
      return { t: "ext", pkg: res.pkg, exact: res.exact, name, args };
    if (res.sym.kind === "type") return aliasTy(res.sym, args, depth);
    return { t: "decl", sym: res.sym, args };
  };
  /** Type written as syntax `node` in scope `sc`. */
  const tyOf = (
    node: Node | null | undefined,
    sc: Scope,
    depth = 0,
    args: Ty[] = [],
  ): Ty => {
    if (!node || depth > 8) return undefined;
    switch (node.type) {
      case "reference_type":
      case "pointer_type":
        return tyOf(field(node, "type"), sc, depth + 1);
      case "abstract_type":
      case "dynamic_type": {
        const tr = field(node, "trait");
        return tr
          ? boundTy(tr.type === "bounded_type" ? tr.namedChildren : [tr], sc)
          : undefined;
      }
      case "bounded_type":
        return boundTy(node.namedChildren, sc);
      case "primitive_type":
        return { t: "ext", pkg: "std", exact: true, name: node.text, args: [] };
      case "generic_type": {
        const list = (
          field(node, "type_arguments")?.namedChildren ?? []
        ).filter((c) => c.type !== "lifetime" && !c.type.endsWith("comment"));
        return tyOf(
          field(node, "type"),
          sc,
          depth + 1,
          list.map((a) => tyOf(a, sc, depth + 1)),
        );
      }
      case "type_identifier": {
        const name = node.text;
        if (name === "Self") return sc.self?.();
        if (sc.subst?.has(name)) return sc.subst.get(name);
        for (const o of sc.owners) {
          const g = declaredGenerics(o);
          if (g.has("*")) return undefined;
          if (!g.has(name)) continue;
          const on = sc.bounded ? declNode(o) : undefined;
          const bn = on && boundNodes(on, name);
          return bn ? boundTy(bn, sc) : undefined;
        }
        return named(
          typeName(name, sc.from.filePath, sc.from),
          name,
          args,
          depth,
        );
      }
      case "scoped_type_identifier": {
        const segs = node.text.split("::").map((s) => s.trim());
        // `T::Assoc` / `Self::Assoc` are associated types: unknown.
        if (
          !segs.every((s) => IDENT.test(s)) ||
          segs[0] === "Self" ||
          sc.owners.some((o) => declaredGenerics(o).has(segs[0]))
        )
          return undefined;
        return named(
          typePath(segs, sc.from.filePath, sc.from),
          segs.at(-1)!,
          args,
          depth,
        );
      }
    }
    return undefined;
  };

  /** `Result<T, _>` / `Option<T>` (std, or an alias of them) => T. */
  const unwrapTy = (ty: Ty): Ty =>
    ty?.t === "ext" &&
    STD_ROOTS.has(ty.pkg) &&
    (ty.name === "Result" || ty.name === "Option")
      ? ty.args[0]
      : undefined;
  const derefTy = (ty: Ty): Ty =>
    ty?.t === "ext" && WRAPPERS.has(ty.name) && ty.args.length === 1
      ? derefTy(ty.args[0])
      : ty;

  /** Type of field `name` of a struct-typed value (generic args substituted). */
  const fieldTy = (base: Ty, name: string): Ty => {
    if (base?.t !== "decl" || base.sym.kind !== "class" || inFn(base.sym))
      return undefined;
    const node = declNode(base.sym);
    const body = node && field(node, "body");
    let tn: Node | null | undefined;
    if (body?.type === "field_declaration_list")
      tn = body.namedChildren
        .find(
          (f) =>
            f.type === "field_declaration" && field(f, "name")?.text === name,
        )
        ?.childForFieldName("type");
    else if (body && /^\d+$/.test(name))
      tn = body.childrenForFieldName("type")[Number(name)];
    if (!tn || !node) return undefined;
    const params = [...typeParamNames(node)];
    const subst = new Map<string, Ty>(
      params.map((p, i) => [
        p,
        base.args.length === params.length ? base.args[i] : undefined,
      ]),
    );
    return tyOf(tn, {
      from: base.sym,
      owners: [],
      bounded: false,
      subst,
      self: () => base,
    });
  };

  /** Type of the local `name` used at `use` (caller-source offset): one binding site only, a plain `let`/parameter. */
  const localTy = (caller: SymbolRecord, name: string, use: number): Ty => {
    const { sites } = bindingSites(caller);
    // A match arm's binding is visible only inside that arm: arms not containing the use are not rivals.
    // A binding written inside a macro's arguments: its scope is not modelled, never guessed.
    if ((sites.get(name) ?? []).some((s) => MACRO_SHIFT.has(s.tree)))
      return undefined;
    const list = (sites.get(name) ?? []).filter(
      (s) =>
        s.type !== "match_arm" || (use >= s.startIndex && use < s.endIndex),
    );
    if (sites.has("*") || list.length !== 1) return undefined; // shadowed / re-bound: never guessed
    const site = list[0];
    if (site.type === "match_arm") return armTy(caller, site, name);
    let pat = field(site, "pattern");
    if (pat?.type === "mut_pattern") pat = pat.namedChild(0);
    if (pat?.type !== "identifier") return undefined;
    if (site.type === "parameter")
      return tyOf(field(site, "type"), sigScope(caller, true));
    if (
      site.type !== "let_declaration" ||
      use < site.endIndex ||
      !site.parent ||
      use >= site.parent.endIndex
    )
      return undefined;
    const tn = field(site, "type");
    return tn
      ? tyOf(tn, bodyScope(caller))
      : exprTy(caller, field(site, "value"));
  };

  /**
   * Type of `name` bound as a direct field of a tuple-variant arm pattern (`Get(cmd)` / `E::Get(a, b)`): the
   * variant's declared payload type. The enum comes from the scrutinee's type, else from the pattern path;
   * undefined unless the enum, the variant and the field position are each unique.
   */
  const armTy = (caller: SymbolRecord, arm: Node, name: string): Ty => {
    let pat = field(arm, "pattern");
    if (pat?.type === "match_pattern") pat = pat.namedChild(0);
    if (pat?.type !== "tuple_struct_pattern") return undefined;
    const path = field(pat, "type");
    const fields = pat.namedChildren.filter(
      (c) => c.id !== path?.id && !c.type.endsWith("comment"),
    );
    const pos = fields.findIndex(
      (c) => c.type === "identifier" && c.text === name,
    );
    if (
      !path ||
      pos < 0 ||
      fields.some((c) => c.type === "remaining_field_pattern")
    )
      return undefined;
    const segs = path.text.split("::").map((s) => s.trim());
    const scrutinee =
      arm.parent?.parent?.type === "match_expression"
        ? field(arm.parent.parent, "value")
        : null;
    let en = derefTy(exprTy(caller, scrutinee));
    if (
      en?.t !== "decl" &&
      segs.length > 1 &&
      segs.slice(0, -1).every((s) => IDENT.test(s))
    )
      en = named(
        typePath(segs.slice(0, -1), caller.filePath, caller),
        segs.at(-2)!,
        [],
        0,
      );
    if (en?.t !== "decl" || en.sym.kind !== "enum" || inFn(en.sym))
      return undefined;
    const node = declNode(en.sym);
    const variants =
      (node &&
        field(node, "body")?.namedChildren.filter(
          (v) =>
            v.type === "enum_variant" && field(v, "name")?.text === segs.at(-1),
        )) ??
      [];
    const body = variants.length === 1 ? field(variants[0], "body") : null;
    if (body?.type !== "ordered_field_declaration_list") return undefined;
    const types = body.childrenForFieldName("type");
    if (types.length !== fields.length || !node || typeParamNames(node).size)
      return undefined;
    return tyOf(types[pos], {
      from: en.sym,
      owners: [],
      bounded: false,
      self: () => en,
    });
  };

  // Recursion only moves to strictly earlier / smaller nodes (receivers, a `let` value before its use), so it
  // terminates; the guard only bounds the stack. A result computed under a cut is never memoized.
  let exprDepth = 0;
  let cuts = 0;
  /** Type of expression `n` (a node of the caller's own source tree). */
  const exprTy = (caller: SymbolRecord, n: Node | null | undefined): Ty => {
    if (!n) return undefined;
    if (exprDepth > 200) {
      cuts++;
      return undefined;
    }
    exprDepth++;
    try {
      return exprTyOf(caller, n);
    } finally {
      exprDepth--;
    }
  };
  const exprTyOf = (caller: SymbolRecord, n: Node): Ty => {
    switch (n.type) {
      case "self":
        return selfTy(ownerOf(caller), true);
      case "identifier":
        return localTy(caller, n.text, callerIndex(n));
      case "parenthesized_expression":
      case "reference_expression":
        return exprTy(caller, n.namedChildren.at(-1));
      case "field_expression":
        return fieldTy(
          derefTy(exprTy(caller, field(n, "value"))),
          field(n, "field")?.text ?? "",
        );
      case "struct_expression":
        return tyOf(field(n, "name"), bodyScope(caller));
      case "try_expression":
        return unwrapTy(exprTy(caller, n.namedChild(0)));
      case "call_expression": {
        // Memoized per caller and node: each call of a chain is typed once, not once per outer call.
        const key = `${caller.id}:${n.startIndex}:${n.endIndex}`;
        if (callTyMemo.has(key)) return callTyMemo.get(key);
        const before = cuts;
        const ty = callTy(caller, n);
        if (cuts === before) callTyMemo.set(key, ty);
        return ty;
      }
    }
    return undefined;
  };

  const callTyMemo = new Map<string, Ty>();
  /** Resolves a call found inside another call's receiver as if it were an edge (not recorded). */
  const probe = (caller: SymbolRecord, n: Node): CallEdge => {
    const edge = callEdge(n, caller.filePath, caller.id);
    // Positions of the caller-source tree are relative to the caller's start: shift them to the file.
    const at = (p: { row: number; column: number }) => ({
      line: caller.range.startLine + p.row,
      col: p.row === 0 ? caller.range.startColumn + p.column : p.column,
    });
    const s = at(n.startPosition);
    const e = at(n.endPosition);
    edge.range = {
      startLine: s.line,
      startColumn: s.col,
      endLine: e.line,
      endColumn: e.col,
    };
    if (edge.evidence.some((x) => x.startsWith("macro:"))) return edge;
    const saved = currentCall;
    currentCall = edge;
    try {
      resolveEdge(edge, caller, n)();
    } finally {
      currentCall = saved;
    }
    return edge;
  };

  /** Return type of a call: the exact in-repo target's declared return type, or std `unwrap`-style / `Default` rules. */
  const callTy = (caller: SymbolRecord, n: Node): Ty => {
    let fn = field(n, "function");
    if (fn?.type === "generic_function") fn = field(fn, "function");
    if (
      fn?.type === "field_expression" &&
      UNWRAP.has(field(fn, "field")?.text ?? "")
    ) {
      const inner = unwrapTy(exprTy(caller, field(fn, "value")));
      if (inner) return inner;
    }
    const edge = probe(caller, n);
    const target =
      edge.resolvedTargetId && edge.confidence === "exact"
        ? byId.get(edge.resolvedTargetId)
        : undefined;
    if (target?.kind === "class") return { t: "decl", sym: target, args: [] }; // tuple-struct constructor
    if (target?.kind === "function") {
      const rt = inFn(target)
        ? undefined
        : declNode(target)?.childForFieldName("return_type");
      return rt ? tyOf(rt, sigScope(target, false)) : undefined;
    }
    // `T::default()` is `Self` by the `Default` signature; `Enum::Variant(..)` is the enum.
    if (
      fn?.type !== "scoped_identifier" ||
      !edge.evidence.some((e) => e.startsWith("no-symbol:"))
    )
      return undefined;
    const path = field(fn, "path");
    const segs =
      (path?.type === "generic_type" ? field(path, "type") : path)?.text
        .split("::")
        .map((s) => s.trim()) ?? [];
    if (
      !segs.length ||
      !segs.every((s) => IDENT.test(s)) ||
      isGenericParam(caller, segs[0])
    )
      return undefined;
    const t =
      segs.length === 1 && segs[0] === "Self"
        ? selfTy(ownerOf(caller), false)
        : named(typePath(segs, caller.filePath, caller), segs.at(-1)!, [], 0);
    if (t?.t !== "decl" || t.sym.kind === "interface") return undefined;
    const name = edge.calleeName;
    return (name === "default" && edge.argumentCount === 0) ||
      (t.sym.kind === "enum" && /^[A-Z]/.test(name))
      ? t
      : undefined;
  };

  /** `recv.m()` on a typed receiver. */
  const methodOn = (call: CallEdge, ty: Ty): Outcome => {
    const name = call.calleeName;
    const cands = methodCount.get(name) ?? 0;
    const nowhere = `method ${name} is defined by no project symbol`;
    if (!ty)
      return cands
        ? unresolved(call, `no-type:receiver-type-unknown candidates=${cands}`)
        : external(call, "std-or-dependency", false, nowhere);
    if (ty.t === "ambiguous")
      return ambiguous(call, ty.n, "types with that name");
    if (ty.t === "decl") return memberOf(call, ty.sym, name, "declared-type");
    if (ty.t === "bound") {
      const traits = ty.traits.filter((t) => traitMethods(t, name).length);
      if (traits.length) return traitDecl(call, traits, name);
      // Only external bounds (e.g. `I: Iterator`): the method is theirs unless an in-repo blanket/foreign impl adds one.
      if (
        !ty.unknown &&
        !ty.traits.length &&
        ty.ext.length &&
        !foreignNames.has(name)
      )
        return external(
          call,
          new Set(ty.ext).size === 1 ? ty.ext[0] : "std-or-dependency",
          false,
          `trait bound method ${name}`,
        );
      return cands
        ? unresolved(call, `no-type:generic-param candidates=${cands}`)
        : external(call, "std-or-dependency", false, nowhere);
    }
    if (WRAPPERS.has(ty.name) && ty.args.length === 1) {
      // Nested wrappers (`Arc<Box<A>>`) recurse here, so the wrapper-method guard applies at every level.
      if (!cands) return external(call, ty.pkg, ty.exact, nowhere);
      if (WRAPPER_METHODS.has(name))
        return ambiguous(call, 2, `${ty.name}::${name} or the inner type's`);
      return methodOn(call, ty.args[0]);
    }
    if (!cands)
      return external(
        call,
        ty.pkg,
        ty.exact,
        `method on external type ${ty.name}`,
      );
    // A project method name: an in-repo trait impl for this type, or a Deref to an in-repo generic argument, may win.
    if (foreignNames.has(name))
      return ambiguous(
        call,
        2,
        `external ${ty.name}::${name} or an in-repo trait impl`,
      );
    const local = (t: Ty): boolean => !t || t.t !== "ext" || t.args.some(local);
    if (ty.args.some(local))
      return unresolved(
        call,
        `no-type:external-generic ${ty.name} candidates=${cands}`,
      );
    return external(
      call,
      ty.pkg,
      ty.exact,
      `method on external type ${ty.name}`,
    );
  };
  const methodCall = (
    call: CallEdge,
    caller: SymbolRecord,
    node?: Node,
  ): Outcome => {
    let n = node;
    if (!n) {
      const base = offsetIn(
        caller,
        caller.range.startLine,
        caller.range.startColumn,
      );
      const rel =
        offsetIn(caller, call.range.startLine, call.range.startColumn) - base;
      n = bindingSites(caller).calls.get(
        `${rel}:${offsetIn(caller, call.range.endLine, call.range.endColumn) - base}`,
      );
    }
    let fn = n && field(n, "function");
    if (fn?.type === "generic_function") fn = field(fn, "function");
    return methodOn(
      call,
      fn?.type === "field_expression"
        ? exprTy(caller, field(fn, "value"))
        : undefined,
    );
  };

  // ---- rules
  const selfMethod = (call: CallEdge, caller: SymbolRecord): Outcome => {
    const { res, trait, owner } = enclosingTypeRes(caller);
    if (!owner) return unresolved(call, "no-type:self-outside-impl");
    if (!res)
      return unresolved(
        call,
        `no-type:self-type-unknown candidates=${methodCount.get(call.calleeName) ?? 0}`,
      );
    if (res.t === "decl")
      return memberOf(call, res.sym, call.calleeName, "this-member", trait);
    if (res.t === "ambiguous")
      return ambiguous(call, res.n, "types with that name");
    return unresolved(
      call,
      `no-type:self-type-external candidates=${methodCount.get(call.calleeName) ?? 0}`,
    );
  };

  const scopeFns = (caller: SymbolRecord, name: string) => {
    // Only local fns declared in a block that encloses the call are in scope.
    const fns = (list: SymbolRecord[]) =>
      list.filter(
        (s) =>
          s.kind === "function" &&
          s.name === name &&
          (s.parentId === undefined ||
            byId.get(s.parentId)?.kind !== "function" ||
            declEnclosesCall(caller, s.range)),
      );
    const own = fns(childrenOf.get(caller.id) ?? []);
    if (own.length) return own;
    for (
      let p = caller.parentId ? byId.get(caller.parentId) : undefined;
      p;
      p = p.parentId ? byId.get(p.parentId) : undefined
    ) {
      if (p.kind !== "function" && p.kind !== "namespace") continue; // impl/trait bodies are not name scopes
      const f = fns(childrenOf.get(p.id) ?? []);
      if (f.length || p.kind === "namespace") return f;
    }
    return fns(topNamed.get(`${caller.filePath}\0${name}`) ?? []);
  };

  const bareViaImports = (
    call: CallEdge,
    name: string,
    recs: ImportRecord[],
  ): Outcome => {
    const cands = new Map<string, SymbolRecord>();
    const ext = new Set<string>();
    let unknown = false;
    for (const r of recs) {
      const t = importTarget(r);
      if (t.t === "ext") ext.add(t.pkg);
      else if (t.t === "unknown") unknown = true;
      else
        for (const s of itemsVia(t))
          if (s.kind === "function" || isTupleStruct(s)) cands.set(s.id, s);
    }
    if (unknown) return unresolved(call, "no-symbol:import-target");
    if (ext.size === 1 && !cands.size)
      return external(call, [...ext][0], true, `imported from ${[...ext][0]}`);
    if (cands.size === 1 && !ext.size) {
      const s = [...cands.values()][0];
      const aliased = recs[0].localName !== recs[0].importedName;
      return settle(
        call,
        s,
        isTupleStruct(s)
          ? "constructor"
          : aliased
            ? "aliased-import"
            : "imported",
        `import ${recs[0].module}::${recs[0].importedName}`,
      );
    }
    if (cands.size + ext.size > 1)
      return ambiguous(call, cands.size + ext.size, `imports named ${name}`);
    return unresolved(call, `no-symbol:imported ${name}`);
  };

  const bareCall = (call: CallEdge, caller: SymbolRecord): Outcome => {
    const name = call.calleeName;
    const file = caller.filePath;
    if (bindingsOf(caller).has(name) || bindingsOf(caller).has("*"))
      return unresolved(call, "no-type:local-binding");
    const li = localItems(caller, name);
    const localCtors = li.filter(isTupleStruct);
    if (localCtors.length === 1 && li.length === 1)
      return settle(
        call,
        localCtors[0],
        "constructor",
        `constructor ${localCtors[0].qualifiedName}`,
      );
    if (li.some((x) => x.kind === "variable" || TYPE_KINDS.has(x.kind)))
      return unresolved(call, "no-type:local-item");
    const local = localImportsNamed(file, caller, name);
    // A local fn (declared in a fn body, enclosing the call) is as local as a `use`; the innermost block wins.
    const localFns = scopeFns(caller, name).filter(
      (f) =>
        f.parentId !== undefined && byId.get(f.parentId)?.kind === "function",
    );
    const fnStart = localFns.length
      ? Math.max(
          ...localFns.map(
            (f) =>
              blockAt(
                caller,
                offsetIn(caller, f.range.startLine, f.range.startColumn),
              )?.[0] ?? -1,
          ),
        )
      : -1;
    const named = local.length
      ? Math.max(...local.map((r) => blockStartOf(caller, r)))
      : -1;
    const lg = globs(file, caller, name, true, Math.max(named, fnStart));
    if (lg.hit) {
      const lc = new Map<string, SymbolRecord>();
      for (const s of [
        ...lg.files.flatMap((x) => lookupItems(x.file, name, file)),
        ...lg.extra,
      ])
        if (s.kind === "function" || isTupleStruct(s)) lc.set(s.id, s);
      if (lc.size > 1)
        return ambiguous(call, lc.size, `local glob imports providing ${name}`);
      if (lc.size === 1) {
        if (lg.unknown) return unresolved(call, "no-type:glob-unknown");
        const s = [...lc.values()][0];
        return settle(
          call,
          s,
          isTupleStruct(s) ? "constructor" : "imported",
          `glob import provides ${s.qualifiedName}`,
        );
      }
      if (lg.unknown) return unresolved(call, "no-type:glob-unknown");
    }
    if (local.length) return bareViaImports(call, name, local); // fn-local `use` shadows module items
    const fns = scopeFns(caller, name);
    if (fns.length === 1)
      return settle(
        call,
        fns[0],
        "same-file",
        `same-file fn ${fns[0].qualifiedName}`,
      );
    if (fns.length > 1)
      return fnChoice(call, fns, `same-scope fns named ${name}`);
    const ctors = declsHere(caller, name).filter(isTupleStruct);
    if (ctors.length === 1)
      return settle(
        call,
        ctors[0],
        "constructor",
        `constructor ${ctors[0].qualifiedName}`,
      );
    if (ctors.length > 1)
      return ambiguous(call, ctors.length, `constructors named ${name}`);
    const recs = importsFor(file, caller).filter(
      (r) => !r.wildcard && r.localName === name,
    );
    if (recs.length) return bareViaImports(call, name, recs);
    const g = globs(file, caller, name);
    const gc = new Map<string, SymbolRecord>();
    for (const s of [
      ...g.files.flatMap((x) => lookupItems(x.file, name, file)),
      ...g.extra,
    ])
      if (s.kind === "function" || isTupleStruct(s)) gc.set(s.id, s);
    if (gc.size > 1)
      return ambiguous(call, gc.size, `glob imports providing ${name}`);
    if (gc.size === 1) {
      if (g.unknown) return unresolved(call, "no-type:glob-unknown");
      const s = [...gc.values()][0];
      return settle(
        call,
        s,
        isTupleStruct(s) ? "constructor" : "imported",
        `glob import provides ${s.qualifiedName}`,
      );
    }
    if (PRELUDE_FNS.has(name) && !g.unknown)
      return external(call, "std", false, `prelude ${name}`);
    return unresolved(
      call,
      g.unknown ? "no-type:glob-unknown" : "no-type:unknown-function",
    );
  };

  /** Fn (or tuple-struct constructor) named `name` reached by `full` module path. */
  const moduleFn = (
    call: CallEdge,
    name: string,
    full: { fromFile: string; segs: string[]; via?: ImportRecord },
    kind: CallEdge["resolutionKind"],
  ): Outcome | undefined => {
    const f = moduleFile(full.segs, full.fromFile);
    if (!f) return undefined;
    const cands = lookupItems(f, name, full.fromFile).filter(
      (s) => s.kind === "function" || isTupleStruct(s),
    );
    if (cands.length === 1) {
      const s = cands[0];
      return settle(
        call,
        s,
        isTupleStruct(s) ? "constructor" : kind,
        `module path ${full.segs.join("::")}::${name}`,
      );
    }
    if (cands.length > 1)
      return fnChoice(
        call,
        cands,
        `fns named ${name} in ${full.segs.join("::")}`,
        kind,
      );
    return unresolved(
      call,
      `no-symbol:member ${full.segs.join("::")}::${name}`,
    );
  };

  /** Same-file inline `mod` descent: returns undefined when the path does not start in an inline mod scope. */
  const inlineFn = (
    call: CallEdge,
    caller: SymbolRecord,
    segs: string[],
  ): Outcome | undefined => {
    let container: SymbolRecord | undefined = modContainer(caller);
    const rest = [...segs];
    while (rest[0] === "self" || rest[0] === "super") {
      if (rest[0] === "super") {
        if (!container) return undefined; // file-level: module files handle it
        container = modContainer(container);
      }
      rest.shift();
    }
    const scopeChildren = (c: SymbolRecord | undefined) =>
      c ? (childrenOf.get(c.id) ?? []) : (topByFile.get(caller.filePath) ?? []);
    for (const seg of rest) {
      const next = scopeChildren(container).filter(
        (s) => s.kind === "namespace" && s.name === seg,
      );
      if (next.length !== 1) return undefined;
      container = next[0];
    }
    const fns = scopeChildren(container).filter(
      (s) => s.kind === "function" && s.name === call.calleeName,
    );
    if (fns.length === 1)
      return settle(
        call,
        fns[0],
        "same-file",
        `same-file module fn ${fns[0].qualifiedName}`,
      );
    if (fns.length > 1)
      return fnChoice(call, fns, `fns named ${call.calleeName} in module`);
    return undefined;
  };

  const pathCall = (
    call: CallEdge,
    caller: SymbolRecord,
    segs: string[],
  ): Outcome => {
    const name = call.calleeName;
    const file = caller.filePath;
    const first = segs[0];
    if (first === "Self") {
      if (segs.length > 1) return unresolved(call, "no-type:unknown-type");
      const { res, trait } = enclosingTypeRes(caller);
      if (!res) return unresolved(call, "no-type:unknown-type");
      return typeOutcome(call, res, name, "static", trait);
    }
    const anchored = first === "crate" || first === "self" || first === "super";
    if (anchored && foreignRoot(file))
      return unresolved(call, "no-type:crate-root");
    // `T::f()` with a generic `T` in scope is a bound-based call (part B), never a same-named type.
    if (!anchored && isGenericParam(caller, first))
      return unresolved(call, "no-type:generic-param");
    const li = anchored ? [] : localItems(caller, first);
    if (li.some((x) => x.kind === "namespace"))
      return unresolved(call, "no-type:local-item");
    if (!anchored) {
      const inline = inlineFn(call, caller, segs);
      if (inline) return inline;
    } else if (modContainer(caller)) {
      return (
        inlineFn(call, caller, segs) ?? unresolved(call, "no-symbol:module")
      );
    }
    // A fn-local glob (innermost block) shadows file-level named imports: single segments go through the
    // type lookup, longer paths are left alone.
    if (!anchored) {
      const localNamed = localImportsNamed(file, caller, first);
      const lg = globs(
        file,
        caller,
        first,
        true,
        localNamed.length
          ? Math.max(...localNamed.map((r) => blockStartOf(caller, r)))
          : -1,
      );
      if (lg.hit)
        return segs.length === 1
          ? typeOutcome(call, typeName(first, file, caller), name, "static")
          : unresolved(call, "no-type:local-glob");
    }
    // A first segment that names a local type.
    if (
      !anchored &&
      segs.length === 1 &&
      (declsHere(caller, first).length > 0 || li.length > 0)
    )
      return typeOutcome(call, typeName(first, file, caller), name, "static");
    const full = expand(segs, file, caller);
    if (!full) return unresolved(call, "no-type:unknown-type");
    if (full.t === "ext")
      return external(
        call,
        full.pkg,
        full.exact,
        `external path ${segs.join("::")}`,
      );
    if (anchored || full.via || full.segs !== segs) {
      const kind = full.via
        ? full.via.localName !== full.via.importedName
          ? "aliased-import"
          : "namespace-import"
        : "namespace-import";
      const viaModule = moduleFn(call, name, full, kind);
      if (viaModule && moduleFile(full.segs, full.fromFile)) {
        // A module file exists for the whole prefix: it wins over a type of the same name.
        return viaModule;
      }
      const tres = fromDecls(
        itemsVia({
          t: "path",
          fromFile: full.fromFile,
          segs: full.segs,
        }).filter((s) => TYPE_KINDS.has(s.kind)),
      );
      if (tres) return typeOutcome(call, tres, name, "static");
      return unresolved(
        call,
        anchored ? "no-symbol:module" : "no-type:unknown-type",
      );
    }
    // Non-anchored, no alias: local module file, else a type, else std/extern crate.
    const viaModule = moduleFn(call, name, full, "namespace-import");
    if (viaModule) return viaModule;
    if (segs.length === 1) {
      const t = typeName(first, file, caller);
      if (t) return typeOutcome(call, t, name, "static");
    } else {
      const t = typePath(segs, file, caller);
      if (t) return typeOutcome(call, t, name, "static");
    }
    const g = globs(file, caller, first);
    if (boundNames(file, first) || g.files.length || g.unknown)
      return unresolved(call, "no-type:unknown-type");
    if (STD_TYPES.has(first))
      return external(call, "std", false, `std type ${first}`);
    if (/^[a-z_]/.test(first))
      return external(call, first, false, `extern crate ${first}`);
    return unresolved(call, "no-type:unknown-type");
  };

  function resolveEdge(
    call: CallEdge,
    caller: SymbolRecord,
    node?: Node,
  ): Outcome {
    const rt = call.receiverText;
    if (call.evidence.includes("no-type:callee-expression"))
      return unresolved(call, "no-type:callee-expression");
    if (rt === undefined) return bareCall(call, caller);
    const shape = shapeOf(call, caller);
    if (rt === "self" && shape === "method") return selfMethod(call, caller);
    if (shape === "path") {
      const segs = rt.split("::");
      return rt.startsWith("<") || !segs.every((s) => IDENT.test(s))
        ? unresolved(call, "no-type:qualified-path")
        : pathCall(call, caller, segs);
    }
    if (shape === "method") return methodCall(call, caller, node);
    return unresolved(call, "no-type:call-shape");
  }

  for (const call of context.calls) {
    const caller = byId.get(call.callerId);
    if (!caller) continue;
    // Recomputed from scratch each rebuild: clear a previous resolution.
    call.declaredTargetId =
      call.resolvedTargetId =
      call.externalPackage =
      call.runtimeTargetIds =
        undefined;
    call.resolutionKind = "unresolved";
    call.confidence = "unresolved";
    if (call.evidence.some((e) => e.startsWith("macro:")) && !isMacroArg(call))
      continue;
    currentCall = call;
    try {
      resolveEdge(call, caller)();
      if (isMacroArg(call) && (call.confidence as string) === "exact")
        call.confidence = "probable";
    } catch {
      // One bad edge (e.g. a file that vanished mid-rebuild) must not abort the rebuild for every language.
      leaveUnresolvedOnError(call);
    }
  }
}
