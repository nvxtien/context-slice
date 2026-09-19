import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve as resolvePath } from "node:path";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  SymbolRecord,
} from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];
/** Imports that can never hold a call target, so they are not "unresolved source". */
const ASSET_EXTENSIONS =
  /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|json|ya?ml|woff2?|ttf|otf|eot|mp[34]|wav|webm|wasm|txt|md|html|graphql|gql)$/i;
export const isAssetSpecifier = (specifier: string) =>
  ASSET_EXTENSIONS.test(specifier.split("?")[0]);

/** `paths`/`baseUrl` from the repository tsconfig; the compiler project system is out of scope. */
export function readTsconfigAliases(root: string) {
  for (const name of ["tsconfig.json", "tsconfig.base.json"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
      const config = JSON.parse(raw);
      const options = config.compilerOptions ?? {};
      return {
        baseUrl:
          typeof options.baseUrl === "string" ? options.baseUrl : undefined,
        paths: (options.paths ?? {}) as Record<string, string[]>,
      };
    } catch {
      return { baseUrl: undefined, paths: {} };
    }
  }
  return { baseUrl: undefined, paths: {} };
}

export const externalPackageName = (specifier: string) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];

/**
 * Resolve a module specifier to a repository-relative file.
 * Deliberately smaller than the Node/TypeScript algorithm: relative paths,
 * index files, and simple tsconfig aliases only.
 */
export function resolveModule(
  specifier: string,
  fromFile: string,
  files: Set<string>,
  aliases: { baseUrl?: string; paths: Record<string, string[]> },
): { file?: string; externalPackage?: string } {
  const candidatesFor = (base: string) => {
    const withoutJs = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    const bases = base === withoutJs ? [base] : [withoutJs, base];
    return bases.flatMap((item) => [
      item,
      ...SOURCE_EXTENSIONS.map((extension) => `${item}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) => `${item}/index${extension}`),
    ]);
  };
  const pick = (candidates: string[]) =>
    candidates
      .map((candidate) => posix.normalize(candidate).replace(/^\.\//, ""))
      .find((candidate) => files.has(candidate));

  if (specifier.startsWith(".")) {
    const base = posix.join(posix.dirname(fromFile), specifier);
    const file = pick(candidatesFor(base));
    return file ? { file } : {};
  }
  for (const [pattern, targets] of Object.entries(aliases.paths ?? {})) {
    const prefix = pattern.replace(/\*$/, "");
    if (
      !pattern.endsWith("*")
        ? specifier !== pattern
        : !specifier.startsWith(prefix)
    )
      continue;
    const rest = pattern.endsWith("*") ? specifier.slice(prefix.length) : "";
    for (const target of targets) {
      const base = posix.join(
        aliases.baseUrl && aliases.baseUrl !== "." ? aliases.baseUrl : "",
        target.replace(/\*$/, "") + rest,
      );
      const file = pick(candidatesFor(base));
      if (file) return { file };
    }
    // A configured alias that does not land on repository source is not a package.
    return {};
  }
  if (aliases.baseUrl) {
    const file = pick(
      candidatesFor(
        posix.join(aliases.baseUrl === "." ? "" : aliases.baseUrl, specifier),
      ),
    );
    if (file) return { file };
  }
  return { externalPackage: externalPackageName(specifier) };
}

export interface TypeScriptGraph {
  /** file -> exported name -> symbol id, with re-export chains already followed. */
  exportsByFile: Map<string, Map<string, string>>;
  importsByFile: Map<string, ImportRecord[]>;
  symbolsById: Map<string, SymbolRecord>;
  symbolsByFile: Map<string, SymbolRecord[]>;
  cyclicExports: string[];
  unresolvedImports: ImportRecord[];
}

export function buildGraph(context: ResolveContext): TypeScriptGraph {
  const { symbols, imports, exports, root } = context;
  const aliases = readTsconfigAliases(root);
  const files = new Set(symbols.map((symbol) => symbol.filePath));
  for (const record of [...imports, ...exports]) files.add(record.filePath);

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
    if (isAssetSpecifier(record.module)) {
      record.asset = true;
      const list = importsByFile.get(record.filePath) ?? [];
      list.push(record);
      importsByFile.set(record.filePath, list);
      continue;
    }
    const resolved = resolveModule(
      record.module,
      record.filePath,
      files,
      aliases,
    );
    record.resolvedFile = resolved.file;
    record.externalPackage = resolved.externalPackage;
    if (!resolved.file && !resolved.externalPackage)
      unresolvedImports.push(record);
    const list = importsByFile.get(record.filePath) ?? [];
    list.push(record);
    importsByFile.set(record.filePath, list);
  }
  const exportsByFileRaw = new Map<string, ExportRecord[]>();
  for (const record of exports) {
    const resolved = record.fromModule
      ? resolveModule(record.fromModule, record.filePath, files, aliases)
      : undefined;
    record.resolvedFile = resolved?.file;
    const list = exportsByFileRaw.get(record.filePath) ?? [];
    list.push(record);
    exportsByFileRaw.set(record.filePath, list);
  }

  const cyclicExports: string[] = [];
  const exportsByFile = new Map<string, Map<string, string>>();
  /** Follow re-export chains; `seen` breaks barrel cycles. */
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
      (record) => record.exportedName === name && !record.fromModule,
    );
    if (direct?.symbolId) return direct.symbolId;
    if (direct?.localName) {
      const symbol = (symbolsByFile.get(file) ?? []).find(
        (candidate) =>
          candidate.name === direct.localName && !candidate.parentId,
      );
      if (symbol) return symbol.id;
    }
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
  const exportedNames = (file: string, seen = new Set<string>()): string[] => {
    if (seen.has(file)) return [];
    seen.add(file);
    const records = exportsByFileRaw.get(file) ?? [];
    return [
      ...records
        .filter((record) => !record.wildcard)
        .map((record) => record.exportedName),
      ...records
        .filter((record) => record.wildcard && record.resolvedFile)
        .flatMap((record) => exportedNames(record.resolvedFile!, seen)),
    ];
  };
  for (const file of exportsByFileRaw.keys()) {
    const map = new Map<string, string>();
    for (const name of new Set(exportedNames(file))) {
      const target = lookup(file, name, new Set());
      if (target) map.set(name, target);
    }
    exportsByFile.set(file, map);
  }
  return {
    exportsByFile,
    importsByFile,
    symbolsById,
    symbolsByFile,
    cyclicExports: [...new Set(cyclicExports)],
    unresolvedImports,
  };
}

const CALLABLE = new Set([
  "function",
  "method",
  "constructor",
  "getter",
  "setter",
]);

export function resolveTypeScriptCalls(context: ResolveContext) {
  const graph = buildGraph(context);
  const { symbolsById, symbolsByFile, importsByFile, exportsByFile } = graph;

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
    (symbolsByFile.get(container.filePath) ?? []).filter(
      (candidate) =>
        candidate.parentId === container.id && candidate.name === name,
    );
  /** Implementation wins over overload signatures (§10). */
  const primary = (candidates: SymbolRecord[]) => {
    const implementations = candidates.filter(
      (candidate) => !candidate.metadata?.overloadSignature,
    );
    return implementations.length === 1
      ? implementations[0]
      : implementations.length > 1
        ? undefined
        : candidates.length === 1
          ? candidates[0]
          : undefined;
  };
  const localCallable = (file: string, name: string) =>
    primary(
      (symbolsByFile.get(file) ?? []).filter(
        (candidate) =>
          candidate.name === name &&
          !candidate.parentId &&
          CALLABLE.has(candidate.kind),
      ),
    );
  const localType = (file: string, name: string) =>
    (symbolsByFile.get(file) ?? []).find(
      (candidate) =>
        candidate.name === name &&
        !candidate.parentId &&
        (candidate.kind === "class" || candidate.kind === "interface"),
    );
  const importFor = (file: string, localName: string) =>
    (importsByFile.get(file) ?? []).find(
      (record) => record.localName === localName && !record.typeOnly,
    );
  const importedSymbol = (record: ImportRecord, name: string) =>
    record.resolvedFile
      ? symbolsById.get(exportsByFile.get(record.resolvedFile)?.get(name) ?? "")
      : undefined;
  /** A type name that may be declared here or imported. */
  const typeSymbol = (file: string, name: string) => {
    const local = localType(file, name);
    if (local) return local;
    const record = importFor(file, name);
    if (!record) return undefined;
    const target = importedSymbol(
      record,
      record.kind === "default" ? "default" : (record.importedName ?? name),
    );
    return target && (target.kind === "class" || target.kind === "interface")
      ? target
      : undefined;
  };
  const settle = (
    call: CallEdge,
    target: SymbolRecord,
    kind: CallEdge["resolutionKind"],
    confidence: CallEdge["confidence"],
    evidence: string,
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

    if (call.resolutionKind === "constructor") {
      const type = typeSymbol(file, call.calleeName);
      if (type) {
        const constructors = memberOf(type, "constructor");
        const target = constructors.length === 1 ? constructors[0] : type;
        settle(
          call,
          target,
          "constructor",
          "exact",
          `new ${call.calleeName} resolves to ${target.qualifiedName ?? target.name}`,
        );
        continue;
      }
      const external = importFor(file, call.calleeName)?.externalPackage;
      if (external) {
        call.externalPackage = external;
        call.resolutionKind = "external-package";
        call.evidence = [`constructed from external package ${external}`];
      }
      continue;
    }

    if (call.resolutionKind === "jsx-reference") {
      const local = localCallable(file, call.calleeName);
      if (local) {
        settle(
          call,
          local,
          "jsx-reference",
          "exact",
          `JSX element references local component ${local.name}`,
        );
        continue;
      }
      const record = importFor(file, call.calleeName);
      const target =
        record &&
        importedSymbol(
          record,
          record.kind === "default"
            ? "default"
            : (record.importedName ?? call.calleeName),
        );
      if (target)
        settle(
          call,
          target,
          "jsx-reference",
          "exact",
          `JSX element references imported component ${target.name}`,
        );
      else if (record?.externalPackage) {
        call.externalPackage = record.externalPackage;
        call.resolutionKind = "external-package";
        call.evidence = [
          `JSX component from external package ${record.externalPackage}`,
        ];
      }
      continue;
    }

    // this.property.method(): use the property's declared or constructed type.
    if (call.receiverText?.startsWith("this.")) {
      const propertyName = call.receiverText.slice("this.".length);
      for (const container of ownerChain(caller)) {
        const property = memberOf(container, propertyName)[0];
        const declared = property?.metadata?.declaredType;
        const type = declared ? typeSymbol(file, declared) : undefined;
        const target = type
          ? primary(memberOf(type, call.calleeName))
          : undefined;
        if (target) {
          settle(
            call,
            target,
            "declared-type",
            type!.kind === "interface" ? "probable" : "exact",
            `this.${propertyName} is declared ${declared}`,
          );
          break;
        }
      }
      if (!call.resolvedTargetId)
        call.evidence = ["property type is not determined syntactically"];
      continue;
    }

    // this.member()
    if (call.receiverText === "this") {
      for (const container of ownerChain(caller)) {
        const target = primary(memberOf(container, call.calleeName));
        if (target) {
          settle(
            call,
            target,
            "this-member",
            "exact",
            `this.${call.calleeName} resolves within ${container.name}`,
          );
          break;
        }
      }
      if (call.resolvedTargetId) continue;
      // Inherited members stay unresolved rather than guessed.
      call.evidence = ["this receiver has no member of that name in scope"];
      continue;
    }

    if (call.receiverText) {
      // Namespace import: userService.findById()
      const namespaceImport = (importsByFile.get(file) ?? []).find(
        (record) =>
          record.kind === "namespace" && record.localName === call.receiverText,
      );
      if (namespaceImport) {
        if (namespaceImport.resolvedFile) {
          const target = importedSymbol(namespaceImport, call.calleeName);
          if (target) {
            settle(
              call,
              target,
              "namespace-import",
              "exact",
              `namespace import ${namespaceImport.localName} exposes ${call.calleeName} from ${namespaceImport.resolvedFile}`,
            );
            continue;
          }
        } else if (namespaceImport.externalPackage) {
          call.externalPackage = namespaceImport.externalPackage;
          call.resolutionKind = "external-package";
          call.evidence = [
            `namespace import from external package ${namespaceImport.externalPackage}`,
          ];
          continue;
        }
      }
      // Declared or constructed receiver type: const service: OrderService
      const receiverType = call.receiverType;
      const container = receiverType
        ? typeSymbol(file, receiverType)
        : undefined;
      if (container) {
        const target = primary(memberOf(container, call.calleeName));
        if (target) {
          settle(
            call,
            target,
            "declared-type",
            container.kind === "interface" ? "probable" : "exact",
            `receiver ${call.receiverText} is declared ${receiverType}`,
          );
          continue;
        }
      }
      // Static or namespace-like member on a known type: OrderService.create()
      const staticContainer = /^[A-Z]/.test(call.receiverText)
        ? typeSymbol(file, call.receiverText)
        : undefined;
      if (staticContainer) {
        const target = primary(memberOf(staticContainer, call.calleeName));
        if (target) {
          settle(
            call,
            target,
            "static",
            "exact",
            `static member of ${staticContainer.name}`,
          );
          continue;
        }
      }
      // A receiver that is an imported binding from a package is external.
      const record = importFor(file, call.receiverText);
      if (record?.externalPackage) {
        call.externalPackage = record.externalPackage;
        call.resolutionKind = "external-package";
        call.evidence = [
          `receiver imported from external package ${record.externalPackage}`,
        ];
        continue;
      }
      call.evidence = call.evidence.length
        ? call.evidence
        : ["receiver type is not determined syntactically"];
      continue;
    }

    // Bare call: same-file, then imported.
    const local = localCallable(file, call.calleeName);
    if (local) {
      settle(
        call,
        local,
        "same-file",
        "exact",
        `unique same-file callable ${local.name}`,
      );
      continue;
    }
    const record = importFor(file, call.calleeName);
    if (record) {
      const exportedName =
        record.kind === "default"
          ? "default"
          : (record.importedName ?? call.calleeName);
      const target = importedSymbol(record, exportedName);
      if (target) {
        const aliased =
          record.kind === "named" && record.importedName !== record.localName;
        settle(
          call,
          target,
          aliased
            ? "aliased-import"
            : record.kind === "default"
              ? "default-import"
              : "imported",
          "exact",
          aliased
            ? `${record.localName} is an alias of ${record.importedName} from ${record.resolvedFile}`
            : `imported ${exportedName} from ${record.resolvedFile}`,
        );
        continue;
      }
      if (record.externalPackage) {
        call.externalPackage = record.externalPackage;
        call.resolutionKind = "external-package";
        call.evidence = [
          `imported from external package ${record.externalPackage}`,
        ];
        continue;
      }
      call.evidence = [
        `import of ${call.calleeName} did not resolve to source`,
      ];
      continue;
    }
    call.evidence = call.evidence.length
      ? call.evidence
      : ["no same-file or imported callable of that name"];
  }
  return graph;
}

export function typeScriptDiagnostics(context: ResolveContext) {
  const graph = buildGraph(context);
  const imports = context.imports.filter((record) => !record.asset);
  const exports = context.exports;
  const resolvedImports = imports.filter(
    (record) => record.resolvedFile,
  ).length;
  const reexports = exports.filter((record) => record.fromModule);
  const resolvedReexports = reexports.filter(
    (record) => record.resolvedFile,
  ).length;
  const aliasImports = imports.filter(
    (record) =>
      record.kind === "named" && record.importedName !== record.localName,
  );
  return {
    assetImports: context.imports.filter((record) => record.asset).length,
    importsTotal: imports.length,
    importsResolved: resolvedImports,
    relativeImportResolutionRate: rate(
      imports.filter(
        (record) => record.module.startsWith(".") && record.resolvedFile,
      ).length,
      imports.filter((record) => record.module.startsWith(".")).length,
    ),
    reexportsTotal: reexports.length,
    reexportsResolved: resolvedReexports,
    reexportResolutionRate: rate(resolvedReexports, reexports.length),
    aliasImportsTotal: aliasImports.length,
    aliasResolutionRate: rate(
      aliasImports.filter((record) => record.resolvedFile).length,
      aliasImports.length,
    ),
    externalImports: imports.filter((record) => record.externalPackage).length,
    externalPackageRate: rate(
      imports.filter((record) => record.externalPackage).length,
      imports.length,
    ),
    unresolvedImports: graph.unresolvedImports.length,
    cyclicExportChains: graph.cyclicExports.length,
  };
}

const rate = (part: number, total: number) =>
  total === 0 ? 1 : Number((part / total).toFixed(4));

export const typeScriptModulePath = (root: string, file: string) =>
  resolvePath(root, file).slice(dirname(root).length);
