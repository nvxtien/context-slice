import { posix } from "node:path";
import type { ImportRecord, SymbolRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";

const PACKAGE_MARKER = "__init__.py";

/**
 * Map every indexed file to the dotted module path an import would use.
 * A directory is part of a package while it holds `__init__.py`; everything
 * above that is a source root, which covers the common `src/` layout.
 */
export function moduleIndex(files: string[]) {
  const packageDirectories = new Set(
    files
      .filter(
        (file) =>
          file.endsWith(`/${PACKAGE_MARKER}`) || file === PACKAGE_MARKER,
      )
      .map((file) => posix.dirname(file)),
  );
  const byModule = new Map<string, string>();
  const byFile = new Map<string, { module: string; packagePath: string[] }>();
  for (const file of files) {
    const directory = posix.dirname(file);
    const segments = directory === "." ? [] : directory.split("/");
    // Anchor at the highest ancestor that is a package. Directories below it
    // without `__init__.py` still count, which covers namespace-style layouts
    // and keeps `src/` out of the module path.
    let anchor = -1;
    for (let at = 1; at <= segments.length; at++)
      if (packageDirectories.has(segments.slice(0, at).join("/"))) {
        anchor = at - 1;
        break;
      }
    const packageSegments = anchor < 0 ? [] : segments.slice(anchor);
    const base = posix.basename(file, ".py");
    const parts =
      base === "__init__" ? packageSegments : [...packageSegments, base];
    const module = parts.join(".");
    if (module) {
      byModule.set(module, file);
      byFile.set(file, { module, packagePath: packageSegments });
    } else byFile.set(file, { module: "", packagePath: [] });
  }
  return { byModule, byFile };
}

/** Resolve an import specifier to an indexed file, or report it external. */
export function resolveModule(
  specifier: string,
  fromFile: string,
  index: ReturnType<typeof moduleIndex>,
): { file?: string; externalPackage?: string } {
  const relativeLevel = specifier.match(/^\.+/)?.[0].length ?? 0;
  if (relativeLevel > 0) {
    const here = index.byFile.get(fromFile);
    if (!here) return {};
    const isPackageInit = posix.basename(fromFile) === PACKAGE_MARKER;
    const base = isPackageInit
      ? here.packagePath
      : here.packagePath.slice(0, here.packagePath.length);
    const up = base.slice(0, Math.max(0, base.length - (relativeLevel - 1)));
    const rest = specifier.slice(relativeLevel).split(".").filter(Boolean);
    const module = [...up, ...rest].join(".");
    const file = index.byModule.get(module);
    return file ? { file } : {};
  }
  const file = index.byModule.get(specifier);
  if (file) return { file };
  // `package.module` where only `package` is indexed is still repository source.
  const head = specifier.split(".")[0];
  if (index.byModule.has(head)) return {};
  return { externalPackage: head };
}

/** Common builtins: unresolved, but not evidence of dynamic uncertainty. */
const BUILTINS = new Set([
  "bool",
  "bytes",
  "dict",
  "enumerate",
  "float",
  "format",
  "frozenset",
  "getattr",
  "hasattr",
  "int",
  "isinstance",
  "issubclass",
  "iter",
  "len",
  "list",
  "map",
  "max",
  "min",
  "next",
  "open",
  "print",
  "range",
  "repr",
  "reversed",
  "round",
  "set",
  "setattr",
  "sorted",
  "str",
  "sum",
  "super",
  "tuple",
  "type",
  "zip",
]);

const CALLABLE = new Set([
  "function",
  "method",
  "constructor",
  "getter",
  "setter",
]);

export function pythonGraph(context: ResolveContext) {
  const { symbols, imports, exports } = context;
  const files = [...new Set(symbols.map((symbol) => symbol.filePath))];
  for (const record of [...imports, ...exports]) files.push(record.filePath);
  const modules = moduleIndex([...new Set(files)]);

  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    const list = symbolsByFile.get(symbol.filePath) ?? [];
    list.push(symbol);
    symbolsByFile.set(symbol.filePath, list);
  }
  const importsByFile = new Map<string, ImportRecord[]>();
  const unresolvedImports: ImportRecord[] = [];
  for (const record of imports) {
    const resolved = resolveModule(record.module, record.filePath, modules);
    record.resolvedFile = resolved.file;
    record.externalPackage = resolved.externalPackage;
    if (!resolved.file && !resolved.externalPackage)
      unresolvedImports.push(record);
    const list = importsByFile.get(record.filePath) ?? [];
    list.push(record);
    importsByFile.set(record.filePath, list);
  }
  for (const record of exports)
    if (record.fromModule)
      record.resolvedFile = resolveModule(
        record.fromModule,
        record.filePath,
        modules,
      ).file;

  const exportsByFileRaw = new Map<string, typeof exports>();
  for (const record of exports) {
    const list = exportsByFileRaw.get(record.filePath) ?? [];
    list.push(record);
    exportsByFileRaw.set(record.filePath, list);
  }
  const cyclicExports: string[] = [];
  /** Follow `__init__.py` re-export chains; `seen` breaks package cycles. */
  const lookup = (
    file: string,
    name: string,
    seen: Set<string>,
  ): string | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key)) {
      cyclicExports.push(key);
      return undefined;
    }
    seen.add(key);
    const records = exportsByFileRaw.get(file) ?? [];
    const direct = records.find(
      (record) => record.exportedName === name && record.symbolId,
    );
    if (direct?.symbolId) return direct.symbolId;
    const reexport = records.find(
      (record) => record.exportedName === name && record.fromModule,
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
  return {
    modules,
    symbolsById,
    symbolsByFile,
    importsByFile,
    lookup,
    cyclicExports: [...new Set(cyclicExports)],
    unresolvedImports,
  };
}

/** Resolution rules that can be measured, and removed, independently. */
export interface PythonRules {
  /** `self.repo.save()` typed by the constructor. */
  selfFieldReceiver: boolean;
  /** `service = OrderService(); service.create()`. */
  instanceReceiver: boolean;
  /** `OrderService.build()` on a known class. */
  classReceiver: boolean;
}

export const ALL_PYTHON_RULES: PythonRules = {
  selfFieldReceiver: true,
  instanceReceiver: true,
  classReceiver: true,
};

export function resolvePythonCalls(
  context: ResolveContext,
  rules: PythonRules = ALL_PYTHON_RULES,
) {
  const graph = pythonGraph(context);
  const { symbolsById, symbolsByFile, importsByFile, lookup } = graph;

  const ownerChain = (symbol: SymbolRecord) => {
    const chain: SymbolRecord[] = [];
    let current: SymbolRecord | undefined = symbol;
    while (current?.parentId) {
      current = symbolsById.get(current.parentId);
      if (current) chain.push(current);
    }
    return chain;
  };
  const memberOf = (container: SymbolRecord, name: string) =>
    (symbolsByFile.get(container.filePath) ?? []).find(
      (candidate) =>
        candidate.parentId === container.id && candidate.name === name,
    );
  const moduleLevel = (file: string, name: string) =>
    (symbolsByFile.get(file) ?? []).find(
      (candidate) => candidate.name === name && !candidate.parentId,
    );
  /** Nearest lexical scope first, then module level. */
  const localCallable = (file: string, name: string, caller?: SymbolRecord) => {
    const candidates = (symbolsByFile.get(file) ?? []).filter(
      (candidate) =>
        candidate.name === name &&
        (CALLABLE.has(candidate.kind) || candidate.kind === "class"),
    );
    return (
      candidates.find((candidate) => candidate.parentId === caller?.id) ??
      candidates.find(
        (candidate) =>
          Boolean(caller?.parentId) && candidate.parentId === caller?.parentId,
      ) ??
      candidates.find((candidate) => !candidate.parentId)
    );
  };
  const importFor = (file: string, localName: string) =>
    (importsByFile.get(file) ?? []).find(
      (record) => record.localName === localName,
    );
  const importedSymbol = (record: ImportRecord, name: string) =>
    record.resolvedFile
      ? symbolsById.get(lookup(record.resolvedFile, name, new Set()) ?? "")
      : undefined;
  /** A class named here or imported. */
  const classNamed = (file: string, name: string) => {
    const local = moduleLevel(file, name);
    if (local?.kind === "class") return local;
    const record = importFor(file, name);
    const target =
      record && importedSymbol(record, record.importedName ?? name);
    return target?.kind === "class" ? target : undefined;
  };
  /**
   * Type of a local binding, from `x = ClassName(...)` or an annotation.
   * Reassignment to anything else drops the evidence.
   */
  const bindingClass = (caller: SymbolRecord, receiver: string) => {
    const body = caller.body ?? caller.source;
    const assignments = [
      ...body.matchAll(
        new RegExp(
          `(?<![\\w.])${receiver}\\s*(?::\\s*([A-Za-z_][\\w.]*))?\\s*=\\s*([A-Za-z_][\\w.]*)?\\s*\\(?`,
          "g",
        ),
      ),
    ];
    if (assignments.length !== 1) return undefined;
    const [, annotation, constructed] = assignments[0];
    const name = (annotation ?? constructed)?.split(".").pop();
    return name ? classNamed(caller.filePath, name) : undefined;
  };
  /** `self.repo` typed by the constructor's annotation or assignment. */
  const selfFieldClass = (caller: SymbolRecord, fieldName: string) => {
    const [owner] = ownerChain(caller);
    if (!owner) return undefined;
    const constructor = memberOf(owner, "__init__");
    if (!constructor) return undefined;
    const annotation = constructor.signature?.match(
      new RegExp(`${fieldName}\\s*:\\s*([A-Za-z_][\\w.]*)`),
    )?.[1];
    const assigned = (constructor.body ?? "").match(
      new RegExp(`self\\.${fieldName}\\s*=\\s*([A-Za-z_][\\w.]*)\\s*\\(`),
    )?.[1];
    const name = (annotation ?? assigned)?.split(".").pop();
    return name ? classNamed(caller.filePath, name) : undefined;
  };
  const settle = (
    call: (typeof context.calls)[number],
    target: SymbolRecord,
    kind: (typeof context.calls)[number]["resolutionKind"],
    evidence: string,
    confidence: "exact" | "probable" = "exact",
  ) => {
    call.declaredTargetId = target.id;
    call.resolvedTargetId = target.id;
    call.resolutionKind = kind;
    call.confidence = confidence;
    call.evidence = [evidence];
  };

  for (const call of context.calls) {
    const caller = symbolsById.get(call.callerId);
    if (!caller) continue;
    const file = caller.filePath;
    const receiver = call.receiverText;

    // Dynamic constructs never produce an exact edge.
    if (["getattr", "setattr", "__import__"].includes(call.calleeName)) {
      call.evidence = ["dynamic attribute access"];
      continue;
    }
    if (receiver === "importlib") {
      call.externalPackage = "importlib";
      call.resolutionKind = "external-package";
      call.evidence = ["dynamic import"];
      continue;
    }

    if (receiver === "self" || receiver === "cls") {
      for (const container of ownerChain(caller)) {
        const target = memberOf(container, call.calleeName);
        if (target) {
          settle(
            call,
            target,
            "this-member",
            `${receiver}.${call.calleeName} resolves within ${container.name}`,
          );
          break;
        }
      }
      if (!call.resolvedTargetId)
        call.evidence = [`${receiver} has no member of that name in scope`];
      continue;
    }

    if (receiver?.startsWith("self.") && rules.selfFieldReceiver) {
      const fieldName = receiver.slice("self.".length);
      const container = selfFieldClass(caller, fieldName);
      const target = container && memberOf(container, call.calleeName);
      if (target)
        settle(
          call,
          target,
          "declared-type",
          `self.${fieldName} is ${container!.name} by constructor evidence`,
        );
      else call.evidence = ["self attribute type is not determined statically"];
      continue;
    }

    if (receiver) {
      // `import package.module as mod` then `mod.call()`
      const moduleImport = (importsByFile.get(file) ?? []).find(
        (record) =>
          record.kind === "namespace" && record.localName === receiver,
      );
      if (moduleImport) {
        if (moduleImport.resolvedFile) {
          const target = symbolsById.get(
            lookup(moduleImport.resolvedFile, call.calleeName, new Set()) ?? "",
          );
          if (target) {
            settle(
              call,
              target,
              "namespace-import",
              `module ${moduleImport.module} exposes ${call.calleeName}`,
            );
            continue;
          }
        } else if (moduleImport.externalPackage) {
          call.externalPackage = moduleImport.externalPackage;
          call.resolutionKind = "external-package";
          call.evidence = [`module from ${moduleImport.externalPackage}`];
          continue;
        }
      }
      // `service = OrderService(); service.create()`
      const container = rules.instanceReceiver
        ? bindingClass(caller, receiver)
        : undefined;
      const target = container && memberOf(container, call.calleeName);
      if (target) {
        settle(
          call,
          target,
          "declared-type",
          `${receiver} is ${container!.name} at its only binding`,
        );
        continue;
      }
      // `OrderService.create()` on a known class.
      const classReceiver =
        rules.classReceiver && /^[A-Z]/.test(receiver)
          ? classNamed(file, receiver)
          : undefined;
      const classTarget =
        classReceiver && memberOf(classReceiver, call.calleeName);
      if (classTarget) {
        settle(
          call,
          classTarget,
          "static",
          `class member of ${classReceiver!.name}`,
        );
        continue;
      }
      const record = importFor(file, receiver);
      if (record?.externalPackage) {
        call.externalPackage = record.externalPackage;
        call.resolutionKind = "external-package";
        call.evidence = [`receiver from ${record.externalPackage}`];
        continue;
      }
      call.evidence = ["receiver type is not determined statically"];
      continue;
    }

    // `cls(...)` in a classmethod constructs the enclosing class.
    if (call.calleeName === "cls") {
      const [owner] = ownerChain(caller);
      const constructor = owner && memberOf(owner, "__init__");
      if (owner) {
        settle(
          call,
          constructor ?? owner,
          "constructor",
          `cls(...) constructs ${owner.name}`,
        );
        continue;
      }
    }

    // Bare call: lexical scope, then imports.
    const local = localCallable(file, call.calleeName, caller);
    if (local) {
      const kind =
        local.kind === "class"
          ? ("constructor" as const)
          : ("same-file" as const);
      const constructorTarget =
        local.kind === "class" ? memberOf(local, "__init__") : undefined;
      settle(
        call,
        constructorTarget ?? local,
        kind,
        local.kind === "class"
          ? `constructs ${local.name}`
          : `unique same-module callable ${local.name}`,
      );
      continue;
    }
    const record = importFor(file, call.calleeName);
    if (record) {
      const target = importedSymbol(
        record,
        record.importedName ?? call.calleeName,
      );
      if (target) {
        const aliased = record.importedName !== record.localName;
        const constructorTarget =
          target.kind === "class" ? memberOf(target, "__init__") : undefined;
        settle(
          call,
          constructorTarget ?? target,
          aliased ? "aliased-import" : "imported",
          aliased
            ? `${record.localName} is an alias of ${record.importedName} from ${record.resolvedFile}`
            : `imported ${record.importedName} from ${record.resolvedFile}`,
        );
        continue;
      }
      if (record.externalPackage) {
        call.externalPackage = record.externalPackage;
        call.resolutionKind = "external-package";
        call.evidence = [`imported from ${record.externalPackage}`];
        continue;
      }
    }
    if (!receiver && BUILTINS.has(call.calleeName)) {
      call.externalPackage = "builtins";
      call.resolutionKind = "external-package";
      call.evidence = ["Python builtin"];
      continue;
    }
    call.evidence = ["no same-module or imported callable of that name"];
  }
  return graph;
}

const rate = (part: number, total: number) =>
  total === 0 ? 1 : Number((part / total).toFixed(4));

export function pythonDiagnostics(context: ResolveContext) {
  const graph = pythonGraph(context);
  const imports = context.imports;
  const relative = imports.filter((record) => record.module.startsWith("."));
  const reexports = context.exports.filter((record) => record.fromModule);
  const calls = context.calls;
  const kind = (name: string) =>
    calls.filter((call) => call.resolutionKind === name).length;
  const selfCalls = calls.filter(
    (call) => call.receiverText === "self" || call.receiverText === "cls",
  );
  return {
    importsTotal: imports.length,
    importsResolved: imports.filter((record) => record.resolvedFile).length,
    relativeImportResolutionRate: rate(
      relative.filter((record) => record.resolvedFile).length,
      relative.length,
    ),
    packageReexportResolutionRate: rate(
      reexports.filter((record) => record.resolvedFile).length,
      reexports.length,
    ),
    externalImports: imports.filter((record) => record.externalPackage).length,
    unresolvedImports: graph.unresolvedImports.length,
    cyclicExportChains: graph.cyclicExports.length,
    selfMethodResolutionRate: rate(
      selfCalls.filter((call) => call.resolvedTargetId).length,
      selfCalls.length,
    ),
    clsMethodResolutionRate: rate(
      calls.filter(
        (call) => call.receiverText === "cls" && call.resolvedTargetId,
      ).length,
      calls.filter((call) => call.receiverText === "cls").length,
    ),
    instanceReceiverResolutionRate: rate(
      kind("declared-type"),
      calls.filter(
        (call) =>
          call.receiverText &&
          call.receiverText !== "self" &&
          call.receiverText !== "cls",
      ).length,
    ),
    dynamicUnresolvedRate: rate(
      calls.filter((call) => !call.resolvedTargetId && !call.externalPackage)
        .length,
      calls.length,
    ),
    decoratedSymbols: context.symbols.filter(
      (symbol) => symbol.annotations.length > 0,
    ).length,
  };
}
