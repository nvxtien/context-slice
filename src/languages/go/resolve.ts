import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallEdge, ImportRecord, SymbolRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";

/** Go's package boundary is per-directory, never by matching package-clause name strings. */
function directoryOf(filePath: string): string {
  const dir = dirname(filePath);
  return dir === "." ? "" : dir;
}

/** A single module known to this project: its declared module path, and its directory relative
 * to context.root ("" for a module whose go.mod sits at the project root). */
type ModuleInfo = { path: string; dir: string };

function readModulePath(goModDir: string): string | undefined {
  try {
    const text = readFileSync(join(goModDir, "go.mod"), "utf8");
    return text.match(/^module\s+(\S+)/m)?.[1];
  } catch {
    return undefined;
  }
}

/** The directories a go.work file lists under `use`, supporting both the block form
 * ("use (\n\t./a\n\t./b\n)") and repeated single-line directives ("use ./a\nuse ./b"). */
function parseGoWorkUseDirs(text: string): string[] {
  const dirs: string[] = [];
  const block = text.match(/use\s*\(([^)]*)\)/s);
  if (block) {
    for (const line of block[1].split("\n")) {
      const dir = line.trim().split(/\s+/)[0];
      if (dir) dirs.push(dir);
    }
  }
  for (const m of text.matchAll(/^use\s+(\.\S+)/gm)) dirs.push(m[1]);
  return dirs;
}

function normalizeWorkspaceDir(relDir: string): string {
  return relDir.replace(/^\.\//, "").replace(/\/$/, "").replace(/^\.$/, "");
}

/** Every module this project can resolve imports into: the modules a go.work file lists under
 * `use` (a multi-module workspace), or else the single module at this project's own go.mod (the
 * common case). No go.work and no go.mod means no imports resolve to project code — the correct
 * safe fallback, not a special case. */
function discoverModules(root: string): ModuleInfo[] {
  let workText: string | undefined;
  try {
    workText = readFileSync(join(root, "go.work"), "utf8");
  } catch {
    workText = undefined;
  }
  if (workText !== undefined) {
    const modules: ModuleInfo[] = [];
    for (const relDir of parseGoWorkUseDirs(workText)) {
      const dir = normalizeWorkspaceDir(relDir);
      const path = readModulePath(join(root, dir));
      if (path) modules.push({ path, dir });
    }
    return modules;
  }
  const rootPath = readModulePath(root);
  return rootPath ? [{ path: rootPath, dir: "" }] : [];
}

/** A method's own receiver variable name, e.g. "u" in "func (u *User) Name(...)" — read directly
 * off the symbol's own .source text rather than re-deriving it from parse.ts, since Phase 1
 * already formats every method's signature/source starting with its receiver clause. */
function receiverVarNameOf(method: SymbolRecord): string | undefined {
  return method.source.match(/^func\s*\(\s*(\w+)\s+/)?.[1];
}

/** A local variable's inferred type, split into an optional package qualifier (e.g. "store" in
 * "store.Store{}") and the bare type name — the qualifier tells resolveMethodCall which
 * package's directory to search instead of the caller's own. A `ctorName` instead of `type` means
 * the binding came from "x := NewFoo(...)": the real type is whatever NewFoo actually returns,
 * looked up by the caller rather than assumed from the constructor's own name. */
type BoundType = { pkg?: string; type: string } | { pkg?: string; ctorName: string };

/** Narrow, regex-based binding-type inference over a function body — mirrors
 * src/languages/python/resolve.ts's bindingClass exactly: single unambiguous assignment only,
 * any reassignment or multiple bindings drop the evidence rather than guessing. Captures an
 * optional package-qualified form ("pkg.Type") alongside the bare form ("Type"). */
function bindingTypeInBody(body: string, receiver: string): BoundType | undefined {
  const literalOrVar = new RegExp(
    `(?<![\\w.])${receiver}\\s*:?=\\s*(?:&)?(?:([A-Za-z_]\\w*)\\.)?([A-Za-z_]\\w*)\\s*\\{` +
      `|var\\s+${receiver}\\s+\\*?(?:([A-Za-z_]\\w*)\\.)?([A-Za-z_]\\w*)\\b`,
    "g",
  );
  const matches = [...body.matchAll(literalOrVar)];
  const reassignments = [...body.matchAll(new RegExp(`(?<![\\w.:])${receiver}\\s*=[^=]`, "g"))].length;
  if (matches.length === 1 && reassignments === 0) {
    const [, literalPkg, literalType, varPkg, varType] = matches[0];
    if (literalType) return { pkg: literalPkg, type: literalType };
    if (varType) return { pkg: varPkg, type: varType };
  }
  if (matches.length === 0 && reassignments === 0) {
    const ctor = body.match(
      new RegExp(`(?<![\\w.])${receiver}\\s*:=\\s*(?:([A-Za-z_]\\w*)\\.)?(New[A-Za-z_]\\w*)\\s*\\(`),
    );
    if (ctor) return { pkg: ctor[1], ctorName: ctor[2] };
  }
  return undefined;
}

/** A struct's own embedded field TYPES (not all fields) — same-directory lookup only, cycle-safe. */
function embeddedTypesOf(
  struct: SymbolRecord,
  byDirectory: Map<string, SymbolRecord[]>,
  visited: Set<string>,
): SymbolRecord[] {
  const dir = directoryOf(struct.filePath);
  const siblings = byDirectory.get(dir) ?? [];
  const types: SymbolRecord[] = [];
  for (const f of siblings) {
    if (f.kind !== "field" || f.parentId !== struct.id || !f.metadata?.embedded) continue;
    const embeddedType = siblings.find((s) => s.kind === "class" && s.name === f.name);
    if (embeddedType && !visited.has(embeddedType.id)) {
      visited.add(embeddedType.id);
      types.push(embeddedType);
    }
  }
  return types;
}

/** BFS one promotion-depth level at a time; a match at a shallower depth shadows deeper ones;
 * multiple matches at the SAME depth are ambiguous (Go itself rejects this at compile time). */
function findPromotedMethod(
  struct: SymbolRecord,
  methodName: string,
  byDirectory: Map<string, SymbolRecord[]>,
): SymbolRecord | "ambiguous" | undefined {
  const visited = new Set([struct.id]);
  let frontier = embeddedTypesOf(struct, byDirectory, visited);
  while (frontier.length) {
    const matches = frontier
      .map((t) => (byDirectory.get(directoryOf(t.filePath)) ?? []).find(
        (s) => s.kind === "method" && s.name === methodName && s.supertypes?.includes(t.name),
      ))
      .filter((m): m is SymbolRecord => Boolean(m));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return "ambiguous";
    const next: SymbolRecord[] = [];
    for (const t of frontier) next.push(...embeddedTypesOf(t, byDirectory, visited));
    frontier = next;
  }
  return undefined;
}

/** Every method reachable from a struct, name -> its own normalized signature: its direct methods,
 * plus every method reachable via embedding at any depth (a shallower method shadows a deeper
 * same-named one, mirroring findPromotedMethod's own depth-shadowing — unlike call resolution's
 * mere "is this name reachable at all", interface satisfaction needs the signature that would
 * actually be promoted, so a same-name-different-signature method at a deeper level must not win). */
function methodSetOf(struct: SymbolRecord, byDirectory: Map<string, SymbolRecord[]>): Map<string, string> {
  const methods = new Map<string, string>();
  const collectDirect = (type: SymbolRecord) => {
    for (const s of byDirectory.get(directoryOf(type.filePath)) ?? [])
      if (s.kind === "method" && s.supertypes?.includes(type.name) && !methods.has(s.name))
        methods.set(s.name, s.metadata?.methodSignature ?? "");
  };
  collectDirect(struct);
  const visited = new Set([struct.id]);
  let frontier = embeddedTypesOf(struct, byDirectory, visited);
  while (frontier.length) {
    const next: SymbolRecord[] = [];
    for (const t of frontier) {
      collectDirect(t);
      next.push(...embeddedTypesOf(t, byDirectory, visited));
    }
    frontier = next;
  }
  return methods;
}

function resolveInterfaceSatisfaction(symbols: SymbolRecord[], byDirectory: Map<string, SymbolRecord[]>) {
  // Go's interface satisfaction is structural and project-wide, not package-scoped: a struct in
  // package "impl" can satisfy an interface declared in package "contract" with no import between
  // them. Interfaces and structs are therefore collected across every directory, not grouped by one.
  const interfaces = symbols.filter((s) => s.kind === "interface" && s.metadata?.interfaceMethods);
  const structs = symbols.filter((s) => s.kind === "class");
  for (const struct of structs) {
    const methods = methodSetOf(struct, byDirectory);
    // Recomputed from scratch every pass, not appended to: struct.supertypes is owned entirely
    // by this resolver (parse.ts never sets it on struct symbols), and ProjectIndex.rebuild()
    // reuses persisted symbols across incremental rebuilds, so appending would duplicate entries
    // on every rebuild and never drop a stale one.
    const satisfied: string[] = [];
    for (const iface of interfaces) {
      const required = iface.metadata!.interfaceMethods!;
      const signatures = iface.metadata!.interfaceMethodSignatures ?? {};
      // Exact-signature match: a method of the same name but a different parameter/result
      // shape does not satisfy the interface, matching Go's own compile-time rule.
      if (required.length > 0 && required.every((name) => methods.get(name) === signatures[name])) {
        satisfied.push(iface.name);
      }
    }
    struct.supertypes = satisfied;
  }
}

function settle(
  call: CallEdge,
  target: SymbolRecord,
  kind: CallEdge["resolutionKind"],
  evidence: string,
) {
  call.resolvedTargetId = target.id;
  call.resolutionKind = kind;
  call.confidence = "exact";
  call.evidence = [...call.evidence, evidence];
}

export function resolveGoCalls(context: ResolveContext): void {
  const symbolsById = new Map(context.symbols.map((s) => [s.id, s]));
  const byDirectory = new Map<string, SymbolRecord[]>();
  for (const symbol of context.symbols) {
    const dir = directoryOf(symbol.filePath);
    const list = byDirectory.get(dir) ?? [];
    list.push(symbol);
    byDirectory.set(dir, list);
  }
  const modules = discoverModules(context.root);

  const importsByFile = new Map<string, ImportRecord[]>();
  for (const record of context.imports) {
    const list = importsByFile.get(record.filePath) ?? [];
    list.push(record);
    importsByFile.set(record.filePath, list);
  }

  const resolveDirectCall = (call: CallEdge, caller: SymbolRecord) => {
    const candidates = (byDirectory.get(directoryOf(caller.filePath)) ?? []).filter(
      (s) => s.kind === "function" && s.name === call.calleeName,
    );
    if (candidates.length === 1) settle(call, candidates[0], "same-file", "same-package direct call");
  };

  // Go modules convention: a module path at major version >=2 ends in "/vN" (go.dev/ref/mod#major-version-suffixes),
  // but the package's own declared name is unaffected, e.g. "github.com/go-chi/chi/v5" is still used as "chi.Foo(...)".
  // Strip that suffix before taking the last path segment for the unaliased case. Known limitation: a package whose
  // real (unversioned) last segment happens to look like "vN" itself is not handled — rare enough not to special-case.
  const importLocalName = (record: ImportRecord): string | undefined =>
    record.localName ?? record.module.replace(/\/v\d+$/, "").split("/").pop();

  // Shared by resolveQualifiedCall (pkg.Func()) and resolveMethodCall (x.Method() where x's type
  // is pkg.Type): maps an import alias, as used in the caller's file, to that package's directory
  // within THIS module. undefined means the alias is unresolvable or names an external package.
  const resolveImportDirectory = (alias: string, callerFilePath: string): string | undefined => {
    const record = (importsByFile.get(callerFilePath) ?? []).find((r) => importLocalName(r) === alias);
    if (!record) return undefined;
    for (const mod of modules) {
      if (record.module === mod.path || record.module.startsWith(mod.path + "/")) {
        const withinModule = record.module.slice(mod.path.length).replace(/^\//, "");
        return [mod.dir, withinModule].filter(Boolean).join("/");
      }
    }
    return undefined;
  };

  const resolveQualifiedCall = (call: CallEdge, caller: SymbolRecord): boolean => {
    if (!call.receiverText || !/^[A-Z]/.test(call.calleeName)) return false; // unexported: never a package-qualified target
    const record = (importsByFile.get(caller.filePath) ?? []).find(
      (r) => importLocalName(r) === call.receiverText,
    );
    if (!record) return false;
    const relative = resolveImportDirectory(call.receiverText, caller.filePath);
    if (relative === undefined) {
      call.externalPackage = record.module;
      return false;
    }
    const candidates = (byDirectory.get(relative) ?? []).filter(
      (s) => s.kind === "function" && s.name === call.calleeName && s.modifiers.includes("exported"),
    );
    if (candidates.length === 1) {
      settle(call, candidates[0], "imported", "package-qualified import call");
      return true;
    }
    return false;
  };

  const resolveMethodCall = (call: CallEdge, caller: SymbolRecord) => {
    if (!call.receiverText) return;
    let typeName: string | undefined;
    let pkgAlias: string | undefined;
    if (caller.kind === "method" && caller.supertypes?.[0] && receiverVarNameOf(caller) === call.receiverText) {
      typeName = caller.supertypes[0];
    } else {
      const bound = bindingTypeInBody(caller.body ?? caller.source, call.receiverText);
      pkgAlias = bound?.pkg;
      if (bound && "type" in bound) {
        typeName = bound.type;
      } else if (bound && "ctorName" in bound) {
        // The real constructed type is whatever the constructor itself declares as its return
        // type, not a name guessed from the constructor's own name (e.g. "NewFoo" returning *Bar).
        const ctorDir = pkgAlias ? resolveImportDirectory(pkgAlias, caller.filePath) : directoryOf(caller.filePath);
        const ctorFn =
          ctorDir === undefined
            ? undefined
            : (byDirectory.get(ctorDir) ?? []).find(
                (s) =>
                  s.kind === "function" &&
                  s.name === bound.ctorName &&
                  (!pkgAlias || s.modifiers.includes("exported")),
              );
        typeName = ctorFn?.metadata?.returnType;
      }
    }
    if (!typeName) return;
    let dir: string;
    if (pkgAlias) {
      if (!/^[A-Z]/.test(call.calleeName)) return; // unexported: never callable from another package
      const resolved = resolveImportDirectory(pkgAlias, caller.filePath);
      if (resolved === undefined) return; // external or unresolvable package alias
      dir = resolved;
    } else {
      dir = directoryOf(caller.filePath);
    }
    // A cross-package match must itself be exported; a same-package match needs no such check,
    // since it's reached the same way an unexported method is legitimately called in Go.
    const requireExported = Boolean(pkgAlias);
    const directMethod = (byDirectory.get(dir) ?? []).find(
      (s) =>
        s.kind === "method" &&
        s.name === call.calleeName &&
        s.supertypes?.includes(typeName!) &&
        (!requireExported || s.modifiers.includes("exported")),
    );
    if (directMethod) {
      settle(call, directMethod, "same-type", "receiver-type method call");
      return;
    }
    const struct = (byDirectory.get(dir) ?? []).find((s) => s.kind === "class" && s.name === typeName);
    if (!struct) return;
    const promoted = findPromotedMethod(struct, call.calleeName, byDirectory);
    if (promoted && promoted !== "ambiguous" && (!requireExported || promoted.modifiers.includes("exported"))) {
      settle(call, promoted, "same-type", "struct embedding method promotion");
    }
  };

  for (const call of context.calls) {
    const caller = symbolsById.get(call.callerId);
    if (!caller) continue;
    if (!call.receiverText) {
      resolveDirectCall(call, caller);
      continue;
    }
    if (resolveQualifiedCall(call, caller)) continue;
    resolveMethodCall(call, caller);
  }

  resolveInterfaceSatisfaction(context.symbols, byDirectory);
}
