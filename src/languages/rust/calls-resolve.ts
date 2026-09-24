import type { CallEdge, ExportRecord, ImportRecord, SymbolRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";
import { field, rustParser, type Node } from "./parse.js";

/**
 * Rust call resolution, part A (structural targets): `self.m()`, `Self::f()`/`Type::f()`,
 * module paths and bare calls. Typed receivers (`x.m()`) are left unresolved for part B.
 *
 * Conservative by construction: `exact` only for a single deterministic target; any ambiguity is
 * `unresolved` with `ambiguous:N`; a target reached only through a trait declaration is
 * `probable` / `interface` with `trait:` evidence. File granularity: an inline `mod` is a scope,
 * but items are looked up by name per file.
 */
export interface CallDeps {
  /** Exact file of a module path (`[...segments]`, no trailing item) as seen from `fromFile`. */
  moduleOf(segments: string[], fromFile: string): { file?: string; externalPackage?: string };
}

const TYPE_KINDS = new Set(["class", "enum", "interface", "type"]);
const IDENT = /^[A-Za-z_]\w*$/;
// Rust prelude items a call can name without a `use`: documented, deliberately small.
const PRELUDE_FNS = new Set(["Some", "Ok", "Err", "drop"]);
const STD_TYPES = new Set([
  "Option", "Result", "Vec", "String", "Box", "Default", "Clone", "Iterator", "IntoIterator", "From", "Into",
  "TryFrom", "TryInto", "AsRef", "AsMut", "ToString", "ToOwned", "PartialEq", "Eq", "PartialOrd", "Ord", "Drop",
  "Fn", "FnMut", "FnOnce", "Send", "Sync", "Copy", "Sized", "Extend", "FromIterator", "DoubleEndedIterator",
  "ExactSizeIterator", "Some", "None", "Ok", "Err",
  "bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64",
]);
const STD_ROOTS = new Set(["std", "core", "alloc"]);
// A glob import can shadow these prelude names (e.g. `use io::*` brings its own `Result`).
const SHADOWABLE = new Set(["Result"]);

const isImpl = (s: SymbolRecord) => s.kind === "type" && s.name.startsWith("impl ");
const isTupleStruct = (s: SymbolRecord) => s.kind === "class" && s.metadata?.declaredTypes?.["0"] !== undefined;
const contains = (outer: SymbolRecord["range"], inner: SymbolRecord["range"]) =>
  (outer.startLine < inner.startLine || (outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn)) &&
  (outer.endLine > inner.endLine || (outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn));

type TypeRes =
  | { t: "decl"; sym: SymbolRecord }
  | { t: "ambiguous"; n: number }
  | { t: "external"; pkg: string; exact: boolean }
  | undefined;
type Target = { t: "ext"; pkg: string } | { t: "path"; fromFile: string; segs: string[] } | { t: "unknown" };

export function resolveCallsA(context: ResolveContext, deps: CallDeps) {
  const byId = new Map<string, SymbolRecord>();
  const childrenOf = new Map<string, SymbolRecord[]>();
  const topByFile = new Map<string, SymbolRecord[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => (m.get(k)?.push(v) ?? m.set(k, [v]));
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  const methodCount = new Map<string, number>();
  for (const s of context.symbols) {
    byId.set(s.id, s);
    push(symbolsByFile, s.filePath, s);
    if (s.parentId) push(childrenOf, s.parentId, s);
    else push(topByFile, s.filePath, s);
  }
  for (const s of context.symbols) {
    const p = s.parentId ? byId.get(s.parentId) : undefined;
    if (s.kind === "function" && p && (isImpl(p) || p.kind === "interface"))
      methodCount.set(s.name, (methodCount.get(s.name) ?? 0) + 1);
  }
  const importsByFile = new Map<string, ImportRecord[]>();
  for (const r of context.imports) push(importsByFile, r.filePath, r);
  const exportsByFile = new Map<string, ExportRecord[]>();
  for (const r of context.exports) push(exportsByFile, r.filePath, r);

  const ancestors = (s: SymbolRecord) => {
    const ids = new Set<string>();
    for (let c: SymbolRecord | undefined = s; c; c = c.parentId ? byId.get(c.parentId) : undefined) ids.add(c.id);
    return ids;
  };

  const enclosing = (caller: SymbolRecord) => (caller.parentId ? byId.get(caller.parentId) : undefined);
  const modContainer = (s: SymbolRecord) => {
    for (let c = s.parentId ? byId.get(s.parentId) : undefined; c; c = c.parentId ? byId.get(c.parentId) : undefined)
      if (c.kind === "namespace") return c;
    return undefined;
  };
  /** Module scope a symbol lives in: its nearest inline `mod`, else the file's top level. */
  const ownScope = (s: SymbolRecord) => modContainer(s)?.id ?? `file:${s.filePath}`;

  // ---- scopes of `use` / `pub use` records (by range containment in the file's fn/mod symbols)
  const scopeCache = new WeakMap<object, { vis?: SymbolRecord; mod?: SymbolRecord }>();
  const scopeOf = (rec: { filePath: string; range: SymbolRecord["range"] }) => {
    let c = scopeCache.get(rec);
    if (c) return c;
    let vis: SymbolRecord | undefined;
    let mod: SymbolRecord | undefined;
    for (const s of symbolsByFile.get(rec.filePath) ?? []) {
      if ((s.kind !== "function" && s.kind !== "namespace") || !contains(s.range, rec.range)) continue;
      if (!vis || contains(vis.range, s.range)) vis = s;
      if (s.kind === "namespace" && (!mod || contains(mod.range, s.range))) mod = s;
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
  // The call being resolved (set by the main loop; undefined while resolving impl headers). A fn-local
  // `use` counts only if the block it sits in encloses this call.
  let currentCall: CallEdge | undefined;
  const importsFor = (file: string, from: SymbolRecord) =>
    (importsByFile.get(file) ?? []).filter(
      (r) => visible(r, from) && (scopeOf(r).vis?.kind !== "function" || declEnclosesCall(from, r.range)),
    );
  /** Imports declared in a fn body (enclosing the call) that bind `name`: they shadow module-level items. */
  const localImportsNamed = (file: string, from: SymbolRecord, name: string) =>
    importsFor(file, from).filter((r) => !r.wildcard && r.localName === name && scopeOf(r).vis?.kind === "function");

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
    if (!rec.wildcard && (!rec.importedName || (mod.length === 1 && mod[0] === rec.importedName))) return { t: "unknown" };
    let segs = rec.wildcard ? mod : [...mod, rec.importedName!];
    let fromFile = rec.filePath;
    const container = scopeOf(rec).mod;
    if (container) {
      // `use` inside an inline mod: anchors are relative to that mod, not the file's module.
      if (segs[0] === "super" && !container.parentId) segs = ["self", ...segs.slice(1)];
      else if (segs[0] !== "crate") return { t: "unknown" };
    }
    return { t: "path", fromFile, segs };
  };
  const moduleFile = (segs: string[], fromFile: string) => (segs.length ? deps.moduleOf(segs, fromFile).file : undefined);

  // ---- item lookup in a module file, following `pub use` chains
  const lookupItems = (file: string, name: string, seen = new Set<string>()): SymbolRecord[] => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const direct = (topByFile.get(file) ?? []).filter((s) => s.name === name && !isImpl(s));
    if (direct.length) return direct;
    const out = new Map<string, SymbolRecord>();
    const add = (list: SymbolRecord[]) => list.forEach((s) => out.set(s.id, s));
    for (const rec of exportsByFile.get(file) ?? []) {
      if (scopeOf(rec).vis || !rec.fromModule) continue;
      const mod = rec.fromModule.split("::");
      if (rec.wildcard) {
        const f = moduleFile(mod, file);
        if (f) add(lookupItems(f, name, seen));
      } else if (rec.exportedName === name && rec.sourceName) {
        const f = moduleFile(mod, file);
        if (f) add(lookupItems(f, rec.sourceName, seen));
      }
    }
    return [...out.values()];
  };
  const itemsVia = (t: Target & { t: "path" }, name?: string): SymbolRecord[] => {
    const segs = name === undefined ? t.segs.slice(0, -1) : t.segs;
    const last = name ?? t.segs.at(-1)!;
    const f = moduleFile(segs, t.fromFile);
    return f ? lookupItems(f, last) : [];
  };

  // ---- glob imports visible from a scope
  // `unknown`: a glob we cannot see into may provide `name`. A glob of a CamelCase path (`use Enum::*`)
  // only brings that enum's variants, which are CamelCase too, so it cannot provide a lowercase name.
  const globs = (file: string, from: SymbolRecord, name: string) => {
    const files: { file: string; via: ImportRecord }[] = [];
    let unknown = false;
    for (const rec of importsFor(file, from).filter((r) => r.wildcard)) {
      const t = importTarget(rec);
      const f = t.t === "path" ? moduleFile(t.segs, t.fromFile) : undefined;
      if (f) files.push({ file: f, via: rec });
      else if (!(/^[a-z_]/.test(name) && /^[A-Z]/.test(rec.module.split("::").at(-1) ?? ""))) unknown = true;
    }
    return { files, unknown };
  };

  // ---- types
  // Type declarations by module scope (never merged across inline mods) and, loosely, by file.
  const typeDeclsByScope = new Map<string, Map<string, SymbolRecord[]>>();
  const typeNamesInFile = new Map<string, Set<string>>();
  for (const s of context.symbols) {
    const p = s.parentId ? byId.get(s.parentId) : undefined;
    if (!TYPE_KINDS.has(s.kind) || isImpl(s) || (p && p.kind !== "namespace")) continue;
    const key = ownScope(s);
    let m = typeDeclsByScope.get(key);
    if (!m) typeDeclsByScope.set(key, (m = new Map()));
    push(m, s.name, s);
    let names = typeNamesInFile.get(s.filePath);
    if (!names) typeNamesInFile.set(s.filePath, (names = new Set()));
    names.add(s.name);
  }
  const declsHere = (from: SymbolRecord, name: string) => typeDeclsByScope.get(ownScope(from))?.get(name) ?? [];
  const fromDecls = (list: SymbolRecord[]): TypeRes => {
    const uniq = [...new Map(list.map((s) => [s.id, s])).values()];
    return uniq.length === 1 ? { t: "decl", sym: uniq[0] } : uniq.length > 1 ? { t: "ambiguous", n: uniq.length } : undefined;
  };
  const typeName = (name: string, file: string, from: SymbolRecord): TypeRes => {
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
      if (unknown || (ext.size && decls.length) || ext.size > 1) return undefined;
      if (ext.size) return { t: "external", pkg: [...ext][0], exact: true };
      return fromDecls(decls);
    };
    const local = localImportsNamed(file, from, name);
    if (local.length) return viaImports(local); // a fn-local `use` shadows module-level items
    const same = declsHere(from, name);
    if (same.length) return fromDecls(same);
    const recs = importsFor(file, from).filter((r) => !r.wildcard && r.localName === name);
    if (recs.length) return viaImports(recs);
    const g = globs(file, from, name);
    const cands = g.files.flatMap((x) => lookupItems(x.file, name).filter((s) => TYPE_KINDS.has(s.kind)));
    const found = fromDecls(cands);
    if (found) return g.unknown ? undefined : found;
    if (STD_TYPES.has(name) && !(g.unknown && SHADOWABLE.has(name))) return { t: "external", pkg: "std", exact: false };
    return undefined;
  };
  /** Type named by `segs` (`Foo` or `a::b::Foo`), seen from `from` in `file`. */
  const typePath = (segs: string[], file: string, from: SymbolRecord): TypeRes => {
    if (segs.length === 1) return typeName(segs[0], file, from);
    const full = expand(segs, file, from);
    if (!full) return undefined;
    if (full.t === "ext") return { t: "external", pkg: full.pkg, exact: full.exact };
    return fromDecls(itemsVia({ t: "path", fromFile: full.fromFile, segs: full.segs }).filter((s) => TYPE_KINDS.has(s.kind)));
  };
  /** Replaces a first segment that is a visible `use` alias by the aliased path. */
  const expand = (
    segs: string[],
    file: string,
    from: SymbolRecord,
  ): ({ t: "ext"; pkg: string; exact: boolean } | { t: "path"; fromFile: string; segs: string[]; via?: ImportRecord }) | undefined => {
    const [first, ...rest] = segs;
    if (first === "crate" || first === "self" || first === "super") return { t: "path", fromFile: file, segs };
    const recs = importsFor(file, from).filter((r) => !r.wildcard && r.localName === first);
    if (recs.length > 1) return undefined;
    if (recs.length === 1) {
      const t = importTarget(recs[0]);
      if (t.t === "ext") return { t: "ext", pkg: t.pkg, exact: true };
      if (t.t === "unknown") return undefined;
      return { t: "path", fromFile: t.fromFile, segs: [...t.segs, ...rest], via: recs[0] };
    }
    if (STD_ROOTS.has(first) && !boundNames(file, first)) return { t: "ext", pkg: "std", exact: true };
    return { t: "path", fromFile: file, segs };
  };
  const boundNames = (file: string, name: string) =>
    (typeNamesInFile.get(file)?.has(name) ?? false) ||
    (symbolsByFile.get(file) ?? []).some((s) => s.kind === "namespace" && s.name === name) ||
    (importsByFile.get(file) ?? []).some((r) => r.localName === name);

  // ---- impls
  const implTexts = (impl: SymbolRecord): { self?: string[]; trait?: string[] } => {
    const label = impl.name.slice("impl ".length);
    const at = label.lastIndexOf(" for ");
    const parts = at >= 0 ? [label.slice(0, at), label.slice(at + 5)] : [undefined, label];
    const segsOf = (t: string | undefined, base: string | undefined) => {
      if (!t || !base) return undefined;
      let s = "";
      for (let depth = 0, i = 0; i < t.length; i++) {
        if (t[i] === "<") depth++;
        else if (t[i] === ">") depth--;
        else if (depth === 0) s += t[i];
      }
      const segs = s.trim().split("::").map((x) => x.trim());
      return segs.every((x) => IDENT.test(x)) && segs.at(-1) === base ? segs : undefined;
    };
    return {
      self: segsOf(parts[1], impl.metadata?.implSelfType),
      trait: parts[0] === undefined ? undefined : segsOf(parts[0], impl.metadata?.implTrait),
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
  for (const impl of context.symbols.filter((s) => isImpl(s) && s.metadata?.implSelfType)) {
    const self = implSelf(impl);
    if (self?.t !== "decl") continue;
    for (const m of childrenOf.get(impl.id) ?? []) if (m.kind === "function") push(methodsByType, self.sym.id, { sym: m, impl });
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
    (childrenOf.get(trait.id) ?? []).filter((s) => s.kind === "function" && s.name === name);

  // ---- caller facts
  type Tree = ReturnType<ReturnType<typeof rustParser>["parse"]>;
  const sourceCache = new Map<string, { text: string; lines: number[]; tree?: Tree }>();
  const fileText = (sample: SymbolRecord) => {
    let c = sourceCache.get(sample.filePath);
    if (!c) {
      const text = context.sourceOf(sample);
      const lines = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines.push(i + 1);
      sourceCache.set(sample.filePath, (c = { text, lines }));
    }
    return c;
  };
  const offsetIn = (sample: SymbolRecord, line: number, col: number) => fileText(sample).lines[line - 1] + col;
  /** [start, end) of the innermost `{ }` block enclosing `offset`, or undefined at module level. */
  const blockAt = (sample: SymbolRecord, offset: number): [number, number] | undefined => {
    const c = fileText(sample);
    try {
      c.tree ??= rustParser().parse((i: number) => c.text.slice(i, i + 4_096));
      for (let n: Node | null = c.tree.rootNode.descendantForIndex(offset); n; n = n.parent)
        if (n.type === "block") return [n.startIndex, n.endIndex];
    } catch {
      /* unparsable: no block info */
    }
    return undefined;
  };
  /** True when the block declaring the item at `at` also encloses the call being resolved. */
  const declEnclosesCall = (sample: SymbolRecord, at: SymbolRecord["range"]) => {
    if (!currentCall) return true;
    const blk = blockAt(sample, offsetIn(sample, at.startLine, at.startColumn));
    if (!blk) return true;
    const c = offsetIn(sample, currentCall.range.startLine, currentCall.range.startColumn);
    return c >= blk[0] && c < blk[1];
  };
  /** `path` (`recv::f()`), `method` (`recv.f()`) or undefined, from the text right after the receiver. */
  const shapeOf = (call: CallEdge, caller: SymbolRecord): "path" | "method" | undefined => {
    const rt = call.receiverText!;
    const off = offsetIn(caller, call.range.startLine, call.range.startColumn);
    const tail = fileText(caller).text.slice(off, off + rt.length + 200);
    if (!tail.startsWith(rt)) return "method"; // `<call>`-style marker: the receiver text is not in the source
    const after = tail.slice(rt.length).trimStart();
    return after.startsWith("::") ? "path" : after.startsWith(".") ? "method" : undefined;
  };
  const bindingCache = new Map<string, Set<string>>();
  /** Names bound by parameters, `let`, closures, `for`, `if let`/`match` patterns anywhere in the caller. */
  const bindingsOf = (caller: SymbolRecord) => {
    let set = bindingCache.get(caller.id);
    if (set) return set;
    set = new Set();
    const collect = (n: Node | null, ownerType?: string) => {
      if (!n) return;
      if (n.type === "identifier" || n.type === "shorthand_field_identifier") set!.add(n.text);
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i)!;
        const parentField = ["tuple_struct_pattern", "struct_pattern"].includes(n.type) && n.childForFieldName("type")?.id === c.id;
        if (c.type === "scoped_identifier" || parentField) continue;
        collect(c, ownerType);
      }
    };
    const visit = (n: Node) => {
      switch (n.type) {
        case "let_declaration":
        case "for_expression":
        case "let_condition":
        case "parameter":
        case "match_arm":
          collect(n.childForFieldName("pattern"));
          break;
        case "closure_parameters":
          collect(n);
          break;
        case "self_parameter":
          set!.add("self");
          break;
      }
      for (const c of n.namedChildren) if (c.type !== "token_tree") visit(c);
    };
    try {
      visit(rustParser().parse(caller.source).rootNode);
    } catch {
      set.add("*"); // unparsable: treat every name as possibly shadowed
    }
    bindingCache.set(caller.id, set);
    return set;
  };
  const genericsCache = new Map<string, Set<string>>();
  /** Type/const parameter names declared by a fn / impl / trait, read from its syntax tree (any qualifiers). */
  const declaredGenerics = (s: SymbolRecord) => {
    let names = genericsCache.get(s.id);
    if (names) return names;
    names = new Set();
    try {
      // Only the head matters: parsing the whole impl/trait body is wasted work.
      const head = s.kind === "function" ? s.source : `${s.source.slice(0, Math.max(0, s.source.indexOf("{")))}{}`;
      const item = rustParser().parse((i: number) => head.slice(i, i + 4_096)).rootNode.namedChild(0);
      for (const p of (item ? field(item, "type_parameters") : null)?.namedChildren ?? []) {
        const n = p.type === "type_identifier" ? p : (field(p, "left") ?? field(p, "name"));
        if (n && (n.type === "type_identifier" || n.type === "identifier")) names.add(n.text);
      }
    } catch {
      names.add("*"); // unparsable head: any name may be a type parameter
    }
    genericsCache.set(s.id, names);
    return names;
  };
  /** Type parameters in scope for a caller: its own, its impl's or trait's. */
  const isGenericParam = (caller: SymbolRecord, name: string) => {
    const owner = enclosing(caller);
    const has = (x: SymbolRecord) => declaredGenerics(x).has(name) || declaredGenerics(x).has("*");
    return has(caller) || (!!owner && (isImpl(owner) || owner.kind === "interface") && has(owner));
  };

  // ---- edge writers
  const BASE = (e: string) => e.startsWith("macro:") || e.startsWith("qualified:") || e === "no-type:callee-expression";
  type Outcome = () => void;
  // Keeps parse-time evidence (idempotent across warm re-resolution), drops earlier resolver evidence.
  const withBase = (call: CallEdge, ev: string) => [...new Set([...call.evidence.filter(BASE), ev])];
  const unresolved = (call: CallEdge, ev: string): Outcome => () => {
    call.evidence = withBase(call, ev);
  };
  const ambiguous = (call: CallEdge, n: number, what: string) => unresolved(call, `ambiguous:${n} ${what}`);
  const settle = (
    call: CallEdge,
    target: SymbolRecord,
    kind: CallEdge["resolutionKind"],
    evidence: string,
    confidence: "exact" | "probable" = "exact",
  ): Outcome => () => {
    call.declaredTargetId = target.id;
    call.resolvedTargetId = target.id;
    call.resolutionKind = kind;
    call.confidence = confidence;
    call.evidence = withBase(call, evidence);
  };
  const external = (call: CallEdge, pkg: string, exact: boolean, ev: string): Outcome => () => {
    call.externalPackage = pkg;
    call.resolutionKind = "external-package";
    call.confidence = exact ? "exact" : "probable";
    call.evidence = withBase(call, ev);
  };

  /** Methods/assoc fns named `name` on a resolved type: impls first, then traits the type implements. */
  const memberOf = (call: CallEdge, decl: SymbolRecord, name: string, kind: CallEdge["resolutionKind"], extraTrait?: SymbolRecord): Outcome => {
    if (decl.kind === "interface") return traitDecl(call, [decl], name);
    const cands = (methodsByType.get(decl.id) ?? []).filter((m) => m.sym.name === name);
    if (cands.length === 1) {
      const { sym, impl } = cands[0];
      return settle(
        call,
        sym,
        kind,
        impl.metadata?.implTrait
          ? `trait:unique impl target ${impl.metadata.implTrait} for ${decl.name}::${name}`
          : `inherent:unique target ${decl.name}::${name}`,
      );
    }
    if (cands.length > 1) return ambiguous(call, cands.length, `candidates for ${decl.name}::${name}`);
    const traits = new Set(traitsByType.get(decl.id) ?? []);
    if (extraTrait) traits.add(extraTrait);
    const viaTrait = [...traits].filter((t) => traitMethods(t, name).length);
    if (viaTrait.length) return traitDecl(call, viaTrait, name);
    if (decl.kind === "enum" && /^[A-Z]/.test(name)) return unresolved(call, "no-symbol:variant");
    return unresolved(call, `no-symbol:member ${decl.name}::${name}`);
  };
  const traitDecl = (call: CallEdge, traits: SymbolRecord[], name: string): Outcome => {
    const decls = traits.flatMap((t) => traitMethods(t, name));
    if (decls.length === 1)
      return settle(call, decls[0], "interface", `trait:declaration ${traits.find((t) => t.id === decls[0].parentId)?.name}::${name}`, "probable");
    if (decls.length > 1) return ambiguous(call, decls.length, `trait declarations of ${name}`);
    return unresolved(call, `no-symbol:member trait::${name}`);
  };
  const typeOutcome = (call: CallEdge, res: TypeRes, name: string, kind: CallEdge["resolutionKind"], extraTrait?: SymbolRecord): Outcome => {
    if (!res) return unresolved(call, "no-type:unknown-type");
    if (res.t === "ambiguous") return ambiguous(call, res.n, "types with that name");
    if (res.t === "external") return external(call, res.pkg, res.exact, `external type from ${res.pkg}`);
    return memberOf(call, res.sym, name, kind, extraTrait);
  };
  const enclosingTypeRes = (caller: SymbolRecord): { res: TypeRes; trait?: SymbolRecord; owner?: SymbolRecord } => {
    const owner = enclosing(caller);
    if (!owner) return { res: undefined };
    if (owner.kind === "interface") return { res: { t: "decl", sym: owner }, owner };
    if (!isImpl(owner)) return { res: undefined };
    const tr = implTrait(owner);
    return { res: implSelf(owner), owner, trait: tr?.t === "decl" && tr.sym.kind === "interface" ? tr.sym : undefined };
  };

  // ---- rules
  const selfMethod = (call: CallEdge, caller: SymbolRecord): Outcome => {
    const { res, trait, owner } = enclosingTypeRes(caller);
    if (!owner) return unresolved(call, "no-type:self-outside-impl");
    if (!res) return unresolved(call, `no-type:self-type-unknown candidates=${methodCount.get(call.calleeName) ?? 0}`);
    if (res.t === "decl") return memberOf(call, res.sym, call.calleeName, "this-member", trait);
    if (res.t === "ambiguous") return ambiguous(call, res.n, "types with that name");
    return unresolved(call, `no-type:self-type-external candidates=${methodCount.get(call.calleeName) ?? 0}`);
  };

  const scopeFns = (caller: SymbolRecord, name: string) => {
    // Only local fns declared in a block that encloses the call are in scope.
    const fns = (list: SymbolRecord[]) =>
      list.filter((s) => s.kind === "function" && s.name === name && (s.parentId === undefined || byId.get(s.parentId)?.kind !== "function" || declEnclosesCall(caller, s.range)));
    const own = fns(childrenOf.get(caller.id) ?? []);
    if (own.length) return own;
    for (let p = caller.parentId ? byId.get(caller.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
      if (p.kind !== "function" && p.kind !== "namespace") continue; // impl/trait bodies are not name scopes
      const f = fns(childrenOf.get(p.id) ?? []);
      if (f.length || p.kind === "namespace") return f;
    }
    return fns(topByFile.get(caller.filePath) ?? []);
  };

  const bareViaImports = (call: CallEdge, name: string, recs: ImportRecord[]): Outcome => {
    const cands = new Map<string, SymbolRecord>();
    const ext = new Set<string>();
    let unknown = false;
    for (const r of recs) {
      const t = importTarget(r);
      if (t.t === "ext") ext.add(t.pkg);
      else if (t.t === "unknown") unknown = true;
      else for (const s of itemsVia(t)) if (s.kind === "function" || isTupleStruct(s)) cands.set(s.id, s);
    }
    if (unknown) return unresolved(call, "no-symbol:import-target");
    if (ext.size === 1 && !cands.size) return external(call, [...ext][0], true, `imported from ${[...ext][0]}`);
    if (cands.size === 1 && !ext.size) {
      const s = [...cands.values()][0];
      const aliased = recs[0].localName !== recs[0].importedName;
      return settle(call, s, isTupleStruct(s) ? "constructor" : aliased ? "aliased-import" : "imported", `import ${recs[0].module}::${recs[0].importedName}`);
    }
    if (cands.size + ext.size > 1) return ambiguous(call, cands.size + ext.size, `imports named ${name}`);
    return unresolved(call, `no-symbol:imported ${name}`);
  };

  const bareCall = (call: CallEdge, caller: SymbolRecord): Outcome => {
    const name = call.calleeName;
    const file = caller.filePath;
    if (bindingsOf(caller).has(name) || bindingsOf(caller).has("*")) return unresolved(call, "no-type:local-binding");
    const local = localImportsNamed(file, caller, name);
    if (local.length) return bareViaImports(call, name, local); // fn-local `use` shadows module items
    const fns = scopeFns(caller, name);
    if (fns.length === 1) return settle(call, fns[0], "same-file", `same-file fn ${fns[0].qualifiedName}`);
    if (fns.length > 1) return ambiguous(call, fns.length, `same-scope fns named ${name}`);
    const ctors = declsHere(caller, name).filter(isTupleStruct);
    if (ctors.length === 1) return settle(call, ctors[0], "constructor", `constructor ${ctors[0].qualifiedName}`);
    if (ctors.length > 1) return ambiguous(call, ctors.length, `constructors named ${name}`);
    const recs = importsFor(file, caller).filter((r) => !r.wildcard && r.localName === name);
    if (recs.length) return bareViaImports(call, name, recs);
    const g = globs(file, caller, name);
    const gc = new Map<string, SymbolRecord>();
    for (const x of g.files) for (const s of lookupItems(x.file, name)) if (s.kind === "function" || isTupleStruct(s)) gc.set(s.id, s);
    if (gc.size > 1) return ambiguous(call, gc.size, `glob imports providing ${name}`);
    if (gc.size === 1) {
      if (g.unknown) return unresolved(call, "no-type:glob-unknown");
      const s = [...gc.values()][0];
      return settle(call, s, isTupleStruct(s) ? "constructor" : "imported", `glob import provides ${s.qualifiedName}`);
    }
    if (PRELUDE_FNS.has(name) && !g.unknown) return external(call, "std", false, `prelude ${name}`);
    return unresolved(call, g.unknown ? "no-type:glob-unknown" : "no-type:unknown-function");
  };

  /** Fn (or tuple-struct constructor) named `name` reached by `full` module path. */
  const moduleFn = (call: CallEdge, name: string, full: { fromFile: string; segs: string[]; via?: ImportRecord }, kind: CallEdge["resolutionKind"]): Outcome | undefined => {
    const f = moduleFile(full.segs, full.fromFile);
    if (!f) return undefined;
    const cands = lookupItems(f, name).filter((s) => s.kind === "function" || isTupleStruct(s));
    if (cands.length === 1) {
      const s = cands[0];
      return settle(call, s, isTupleStruct(s) ? "constructor" : kind, `module path ${full.segs.join("::")}::${name}`);
    }
    if (cands.length > 1) return ambiguous(call, cands.length, `fns named ${name} in ${full.segs.join("::")}`);
    return unresolved(call, `no-symbol:member ${full.segs.join("::")}::${name}`);
  };

  /** Same-file inline `mod` descent: returns undefined when the path does not start in an inline mod scope. */
  const inlineFn = (call: CallEdge, caller: SymbolRecord, segs: string[]): Outcome | undefined => {
    let container: SymbolRecord | undefined = modContainer(caller);
    const rest = [...segs];
    let anchored = false;
    while (rest[0] === "self" || rest[0] === "super") {
      anchored = true;
      if (rest[0] === "super") {
        if (!container) return undefined; // file-level: module files handle it
        container = modContainer(container);
      }
      rest.shift();
    }
    const scopeChildren = (c: SymbolRecord | undefined) => (c ? childrenOf.get(c.id) ?? [] : topByFile.get(caller.filePath) ?? []);
    for (const seg of rest) {
      const next = scopeChildren(container).filter((s) => s.kind === "namespace" && s.name === seg);
      if (next.length !== 1) return undefined;
      container = next[0];
    }
    const fns = scopeChildren(container).filter((s) => s.kind === "function" && s.name === call.calleeName);
    if (fns.length === 1) return settle(call, fns[0], "same-file", `same-file module fn ${fns[0].qualifiedName}`);
    if (fns.length > 1) return ambiguous(call, fns.length, `fns named ${call.calleeName} in module`);
    return undefined;
  };

  const pathCall = (call: CallEdge, caller: SymbolRecord, segs: string[]): Outcome => {
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
    // `T::f()` with a generic `T` in scope is a bound-based call (part B), never a same-named type.
    if (!anchored && isGenericParam(caller, first)) return unresolved(call, "no-type:generic-param");
    if (!anchored) {
      const inline = inlineFn(call, caller, segs);
      if (inline) return inline;
    } else if (modContainer(caller)) {
      return inlineFn(call, caller, segs) ?? unresolved(call, "no-symbol:module");
    }
    // A first segment that names a local type.
    if (!anchored && segs.length === 1 && declsHere(caller, first).length > 0) return typeOutcome(call, typeName(first, file, caller), name, "static");
    const full = expand(segs, file, caller);
    if (!full) return unresolved(call, "no-type:unknown-type");
    if (full.t === "ext") return external(call, full.pkg, full.exact, `external path ${segs.join("::")}`);
    if (anchored || full.via || full.segs !== segs) {
      const kind = full.via ? (full.via.localName !== full.via.importedName ? "aliased-import" : "namespace-import") : "namespace-import";
      const viaModule = moduleFn(call, name, full, kind);
      if (viaModule && moduleFile(full.segs, full.fromFile)) {
        // A module file exists for the whole prefix: it wins over a type of the same name.
        return viaModule;
      }
      const tres = fromDecls(itemsVia({ t: "path", fromFile: full.fromFile, segs: full.segs }).filter((s) => TYPE_KINDS.has(s.kind)));
      if (tres) return typeOutcome(call, tres, name, "static");
      return unresolved(call, anchored ? "no-symbol:module" : "no-type:unknown-type");
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
    if (STD_TYPES.has(first)) return external(call, "std", false, `std type ${first}`);
    if (/^[a-z_]/.test(first)) return external(call, first, false, `extern crate ${first}`);
    return unresolved(call, "no-type:unknown-type");
  };

  for (const call of context.calls) {
    const caller = byId.get(call.callerId);
    if (!caller) continue;
    // Recomputed from scratch each rebuild: clear a previous resolution.
    call.declaredTargetId = call.resolvedTargetId = call.externalPackage = undefined;
    call.resolutionKind = "unresolved";
    call.confidence = "unresolved";
    if (call.evidence.some((e) => e.startsWith("macro:"))) continue;
    let outcome: Outcome;
    currentCall = call;
    const rt = call.receiverText;
    if (call.evidence.includes("no-type:callee-expression")) outcome = unresolved(call, "no-type:callee-expression");
    else if (rt === undefined) outcome = bareCall(call, caller);
    else if (rt === "self" && shapeOf(call, caller) === "method") outcome = selfMethod(call, caller);
    else {
      const shape = shapeOf(call, caller);
      if (shape === "path") {
        const segs = rt.split("::");
        outcome = rt.startsWith("<") || !segs.every((s) => IDENT.test(s))
          ? unresolved(call, "no-type:qualified-path")
          : pathCall(call, caller, segs);
      } else if (shape === "method")
        outcome = unresolved(call, `no-type:receiver-type-unknown candidates=${methodCount.get(call.calleeName) ?? 0}`);
      else outcome = unresolved(call, "no-type:call-shape");
    }
    outcome();
  }
}
