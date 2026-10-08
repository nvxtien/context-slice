import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  LanguageId,
  SymbolRecord,
} from "../types/model.js";
import { rankSymbol } from "../planner/rank.js";
import { INDEX_VERSION, IndexStorage } from "../storage/sqlite.js";
import type {
  IndexedFileRecord,
  IndexStore,
} from "../storage/index-snapshot.js";
import { WorkflowError } from "../workflow/errors.js";
import {
  adapterFor,
  ignoredDirectories,
  languages,
  type ResolveContext,
} from "../languages/adapter.js";
import { ensureLanguageBootstrap } from "../languages/bootstrap.js";
import { QueryIndex } from "./query-index.js";
import { ResolutionPipeline } from "./resolution-pipeline.js";
import { languageSnapshots } from "./language-snapshot.js";
import type { EnterpriseRelation } from "../types/enterprise.js";
import {
  createEnterpriseRegistry,
  type EnterpriseRegistry,
} from "../languages/java/enterprise/registry.js";

ensureLanguageBootstrap();

const coreIgnored = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  "out",
  ".idea",
  ".vscode",
  ".context-slice",
]);
const ignored = new Set([...coreIgnored, ...ignoredDirectories()]);

/** Display suffix: `.d.ts` and `.tsx` are counted separately from `.ts`. */
function fileSuffix(filePath: string) {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".d.ts") ? ".d.ts" : extname(lower);
}

export class ProjectIndex {
  readonly root: string;
  symbols: SymbolRecord[] = [];
  calls: CallEdge[] = [];
  imports: ImportRecord[] = [];
  exports: ExportRecord[] = [];
  enterpriseRelations: EnterpriseRelation[] = [];
  private hashes = new Map<string, IndexedFileRecord>();
  private readonly storage: IndexStore;
  private readonly enterpriseRegistry: EnterpriseRegistry;
  private sourceSignatures?: Map<string, string>;
  private cachedRefresh?: ReturnType<ProjectIndex["refresh"]>;
  private readonly queryIndex = new QueryIndex();
  private readonly resolutionPipeline = new ResolutionPipeline();
  constructor(root: string) {
    this.root = resolve(root);
    this.storage = new IndexStorage(this.root);
    this.enterpriseRegistry = createEnterpriseRegistry();
  }
  private files(dir: string, visited = new Set<string>()): string[] {
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      return [];
    }
    if (visited.has(realDir)) return [];
    visited.add(realDir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      if (ignored.has(entry.name)) return [];
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? this.files(path, visited)
        : entry.isFile() && adapterFor(entry.name)
          ? [path]
          : [];
    });
  }
  private counts(files: string[]) {
    const byExtension: Record<string, number> = {};
    const byLanguage: Record<string, number> = {};
    for (const file of files) {
      const suffix = fileSuffix(file);
      byExtension[suffix] = (byExtension[suffix] ?? 0) + 1;
      const language = adapterFor(file)?.label ?? "unknown";
      byLanguage[language] = (byLanguage[language] ?? 0) + 1;
    }
    return { byExtension, byLanguage };
  }
  private signatures(files: string[]) {
    return new Map(
      files.map((file) => {
        const stats = statSync(file);
        return [
          relative(this.root, file),
          `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
        ];
      }),
    );
  }
  private sameSignatures(next: Map<string, string>) {
    if (!this.sourceSignatures || this.sourceSignatures.size !== next.size)
      return false;
    return [...next].every(
      ([path, signature]) => this.sourceSignatures?.get(path) === signature,
    );
  }
  private reindex() {
    this.queryIndex.rebuild(this.symbols, this.calls);
  }

  symbolById(id: string): SymbolRecord | undefined {
    return this.queryIndex.symbolById(id);
  }

  childrenOf(parentId: string): SymbolRecord[] {
    return this.queryIndex.childrenOf(parentId);
  }

  moduleScopeSymbol(filePath: string): SymbolRecord | undefined {
    return this.queryIndex.moduleScopeSymbol(filePath);
  }
  inspect() {
    const files = this.files(this.root);
    const signatures = this.signatures(files);
    // Nothing on disk has changed since the last refresh()/rebuild() in this process: the
    // in-memory index is already authoritative, so report CURRENT without re-reading and
    // re-hashing every source file's full contents again (computeFreshness below). This is
    // what makes repeated calls — e.g. the freshness check buildPreview() runs on every
    // preview request — cheap instead of redoing the full-repo hash scan each time.
    if (this.hashes.size > 0 && this.sameSignatures(signatures)) {
      const metadata = this.storage.metadata();
      const counts = this.counts(files);
      return {
        state: "CURRENT" as const,
        sourceFiles: files.length,
        filesByExtension: counts.byExtension,
        filesByLanguage: counts.byLanguage,
        languages: Object.keys(counts.byLanguage),
        indexedFiles: this.hashes.size,
        schemaVersion: metadata.schema_version ?? INDEX_VERSION,
        lastRefreshedAt: metadata.last_refreshed_at,
      };
    }
    return this.computeFreshness(files);
  }
  /** Compare filesystem metadata with the persisted index without reading source contents. */
  private computeFreshness(files: string[], previous = this.storage.load()) {
    const signatures = this.signatures(files);
    const hasIndex = previous.files.size > 0;
    const stale =
      hasIndex &&
      (signatures.size !== previous.files.size ||
        [...signatures].some(([path, signature]) => {
          const file = previous.files.get(path);
          return (
            !file ||
            `${file.size}:${file.mtimeMs}:${file.ctimeMs}` !== signature
          );
        }));
    const metadata = this.storage.metadata();
    const counts = this.counts(files);
    return {
      state: hasIndex
        ? stale
          ? ("STALE" as const)
          : ("CURRENT" as const)
        : ("UNINITIALIZED" as const),
      sourceFiles: files.length,
      filesByExtension: counts.byExtension,
      filesByLanguage: counts.byLanguage,
      languages: Object.keys(counts.byLanguage),
      indexedFiles: previous.files.size,
      schemaVersion: metadata.schema_version ?? INDEX_VERSION,
      lastRefreshedAt: metadata.last_refreshed_at,
    };
  }
  private hydrateCached(
    files: string[],
    signatures: Map<string, string>,
    freshness: ReturnType<ProjectIndex["computeFreshness"]>,
    previous = this.storage.load(),
  ) {
    this.hashes = previous.files;
    this.symbols = previous.symbols;
    this.calls = previous.calls;
    this.imports = previous.imports;
    this.exports = previous.exports;
    this.enterpriseRelations = [];
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    for (const symbol of this.symbols) {
      const symbols = symbolsByFile.get(symbol.filePath) ?? [];
      symbols.push(symbol);
      symbolsByFile.set(symbol.filePath, symbols);
    }
    for (const [filePath, symbols] of symbolsByFile)
      if (symbols.some((symbol) => symbol.language === "java"))
        this.enterpriseRelations.push(
          ...this.enterpriseRegistry.extractRelations(symbols, filePath, ""),
        );
    this.enterpriseRelations = this.enterpriseRegistry.resolveRelations(
      this.enterpriseRelations,
      this.symbols.filter((symbol) => symbol.language === "java"),
    );
    this.reindex();
    const counts = this.counts(files);
    const summary = {
      files: files.length,
      filesScanned: files.length,
      filesParsed: 0,
      parseErrors: [...this.hashes.values()].filter((file) => file.parseError)
        .length,
      cacheHits: files.length,
      filesByExtension: counts.byExtension,
      filesByLanguage: counts.byLanguage,
      symbols: this.symbols.length,
      symbolsUpdated: 0,
      calls: this.calls.length,
      imports: this.imports.length,
      exports: this.exports.length,
      elapsedMs: 0,
    };
    const result = { summary, freshness };
    this.sourceSignatures = signatures;
    this.cachedRefresh = result;
    return result;
  }
  refresh() {
    const summary = this.rebuild();
    // Set before inspect() so its cheap signature check can recognize the index it just
    // built as current, instead of inspect() re-reading and re-hashing every file a second
    // time right after rebuild() already did exactly that.
    this.sourceSignatures = this.signatures(this.files(this.root));
    const result = { summary, freshness: this.inspect() };
    this.cachedRefresh = result;
    return result;
  }
  refreshIfStale() {
    const files = this.files(this.root);
    const next = this.signatures(files);
    if (this.cachedRefresh && this.sameSignatures(next))
      return this.cachedRefresh;
    if (!this.cachedRefresh) {
      const previous = this.storage.load();
      const freshness = this.computeFreshness(files, previous);
      if (freshness.state === "CURRENT")
        return this.hydrateCached(files, next, freshness, previous);
    }
    return this.refresh();
  }
  rebuild() {
    this.cachedRefresh = undefined;
    const started = Date.now();
    const files = this.files(this.root);
    const previous = this.storage.load();
    this.symbols = [];
    this.calls = [];
    this.imports = [];
    this.exports = [];
    this.enterpriseRelations = [];
    this.hashes = new Map();
    let filesParsed = 0;
    let cacheHits = 0;
    const changedPaths = new Set<string>();
    const previousByFile = <T extends { filePath: string }>(records: T[]) => {
      const grouped = new Map<string, T[]>();
      for (const record of records) {
        const items = grouped.get(record.filePath) ?? [];
        items.push(record);
        grouped.set(record.filePath, items);
      }
      return grouped;
    };
    const previousSymbols = previousByFile(previous.symbols);
    const previousCalls = previousByFile(previous.calls);
    const previousImports = previousByFile(previous.imports);
    const previousExports = previousByFile(previous.exports);
    let parseErrors = 0;
    let symbolsUpdated = 0;
    const sourceCache = new Map<string, string>();
    for (const file of files) {
      const filePath = relative(this.root, file);
      const adapter = adapterFor(filePath);
      if (!adapter) continue;
      const stats = statSync(file);
      let fileSymbols: SymbolRecord[];
      const previousFile = previous.files.get(filePath);
      if (
        previousFile?.size === stats.size &&
        previousFile.mtimeMs === stats.mtimeMs &&
        previousFile.ctimeMs === stats.ctimeMs
      ) {
        this.hashes.set(filePath, previousFile);
        if (previousFile.parseError) parseErrors++;
        fileSymbols = previousSymbols.get(filePath) ?? [];
        this.symbols.push(...fileSymbols);
        this.calls.push(...(previousCalls.get(filePath) ?? []));
        this.imports.push(...(previousImports.get(filePath) ?? []));
        this.exports.push(...(previousExports.get(filePath) ?? []));
        cacheHits++;
      } else {
        const source = readFileSync(file, "utf8");
        sourceCache.set(filePath, source);
        const hash = createHash("sha256").update(source).digest("hex");
        changedPaths.add(filePath);
        const parsed = adapter.parse(filePath, source);
        fileSymbols = parsed.symbols;
        this.symbols.push(...parsed.symbols);
        this.calls.push(...parsed.calls);
        this.imports.push(...parsed.imports);
        this.exports.push(...parsed.exports);
        if (parsed.parseError) parseErrors++;
        symbolsUpdated += parsed.symbols.length;
        this.hashes.set(filePath, {
          hash,
          language: adapter.id,
          parseError: parsed.parseError,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
        });
        filesParsed++;
      }
      if (adapter.id === "java") {
        this.enterpriseRelations.push(
          ...this.enterpriseRegistry.extractRelations(
            fileSymbols,
            filePath,
            sourceCache.get(filePath) ?? "",
          ),
        );
      }
    }
    const currentPaths = new Set(this.hashes.keys());
    const removedPaths = new Set(
      [...previous.files.keys()].filter((path) => !currentPaths.has(path)),
    );
    this.enterpriseRelations = this.enterpriseRegistry.resolveRelations(
      this.enterpriseRelations,
      this.symbols.filter((symbol) => symbol.language === "java"),
    );
    const snapshots = languageSnapshots(
      this.symbols,
      this.calls,
      this.imports,
      this.exports,
    );
    this.resolutionPipeline.resolve({
      root: this.root,
      symbols: this.symbols,
      previousSymbols: previous.symbols,
      calls: this.calls,
      imports: this.imports,
      exports: this.exports,
      snapshots,
      sourceOf: (symbol) => this.sourceFor(symbol, sourceCache),
      changedPaths,
      removedPaths,
    });
    this.reindex();
    this.storage.save(
      {
        files: this.hashes,
        symbols: this.symbols,
        calls: this.calls,
        imports: this.imports,
        exports: this.exports,
      },
      changedPaths,
      removedPaths,
    );
    const counts = this.counts(files);
    return {
      files: files.length,
      filesScanned: files.length,
      filesParsed,
      parseErrors,
      cacheHits,
      filesByExtension: counts.byExtension,
      filesByLanguage: counts.byLanguage,
      symbols: this.symbols.length,
      symbolsUpdated,
      calls: this.calls.length,
      imports: this.imports.length,
      exports: this.exports.length,
      elapsedMs: Date.now() - started,
    };
  }
  search(query: string, limit = 10) {
    return this.symbols
      .map((symbol) => ({
        id: symbol.id,
        kind: symbol.kind,
        language: symbol.language,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        signature: symbol.signature,
        filePath: symbol.filePath,
        score: rankSymbol(symbol, query),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
  resolveSymbol(input: string): SymbolRecord[] {
    return this.queryIndex.resolveSymbol(input);
  }
  callers(target: SymbolRecord) {
    // A cfg-gated call (spec §40) carries every alternative in runtimeTargetIds, not just the
    // resolvedTargetId it settled on — a non-first alternative must still be reachable as a
    // caller/dependency edge, or context composition can never include it (see docs/rust-support.md).
    return this.queryIndex.callers(target);
  }
  callersAtDepth(target: SymbolRecord, depth: number) {
    let frontier = [target];
    const found = new Map<string, SymbolRecord>();
    for (let level = 0; level < depth; level++) {
      const next = frontier
        .flatMap((symbol) => this.callers(symbol))
        .filter((symbol) => !found.has(symbol.id));
      for (const symbol of next) found.set(symbol.id, symbol);
      frontier = next;
    }
    return [...found.values()];
  }
  dependencies(target: SymbolRecord) {
    return this.queryIndex.dependencies(target);
  }
  dependenciesAtDepth(target: SymbolRecord, depth: number) {
    let frontier = [target];
    const found = new Map<string, SymbolRecord>();
    for (let level = 0; level < depth; level++) {
      const next = frontier
        .flatMap((symbol) => this.dependencies(symbol))
        .filter((symbol) => !found.has(symbol.id));
      for (const symbol of next) found.set(symbol.id, symbol);
      frontier = next;
    }
    return [...found.values()];
  }
  ambiguousCalls() {
    return this.calls.filter(
      (call) =>
        !call.resolvedTargetId &&
        this.queryIndex.methodCount(call.calleeName) > 1,
    );
  }
  diagnostics() {
    const simpleNames = new Map<string, number>();
    const filePaths = new Set<string>();
    const ids = new Set<string>();
    let collisions = 0;
    const kindCounts: Record<string, number> = {};
    let componentsIndexed = 0;
    const symbolsByLanguage: Record<string, number> = {};
    for (const symbol of this.symbols) {
      simpleNames.set(symbol.name, (simpleNames.get(symbol.name) ?? 0) + 1);
      filePaths.add(symbol.filePath);
      if (ids.has(symbol.id)) collisions++;
      ids.add(symbol.id);
      kindCounts[symbol.kind] = (kindCounts[symbol.kind] ?? 0) + 1;
      if (symbol.metadata?.reactComponent) componentsIndexed++;
      symbolsByLanguage[symbol.language] =
        (symbolsByLanguage[symbol.language] ?? 0) + 1;
    }
    const resolutionKindCounts: Record<string, number> = {};
    let callEdgesExact = 0;
    let callEdgesProbable = 0;
    let callEdgesUnresolved = 0;
    let externalCallEdges = 0;
    const callsByLanguage: Record<string, number> = {};
    for (const call of this.calls) {
      resolutionKindCounts[call.resolutionKind] =
        (resolutionKindCounts[call.resolutionKind] ?? 0) + 1;
      if (call.confidence === "exact") callEdgesExact++;
      else if (call.confidence === "probable") callEdgesProbable++;
      else if (call.confidence === "unresolved") callEdgesUnresolved++;
      if (call.externalPackage) externalCallEdges++;
      const language = call.language ?? "java";
      callsByLanguage[language] = (callsByLanguage[language] ?? 0) + 1;
    }
    let importsResolved = 0;
    let externalImports = 0;
    const importsByLanguage: Record<string, number> = {};
    for (const record of this.imports) {
      if (record.resolvedFile) importsResolved++;
      if (record.externalPackage) externalImports++;
      importsByLanguage[record.language] =
        (importsByLanguage[record.language] ?? 0) + 1;
    }
    let reexportsTotal = 0;
    let reexportsResolved = 0;
    const exportsByLanguage: Record<string, number> = {};
    for (const record of this.exports) {
      if (record.fromModule) {
        reexportsTotal++;
        if (record.resolvedFile) reexportsResolved++;
      }
      exportsByLanguage[record.language] =
        (exportsByLanguage[record.language] ?? 0) + 1;
    }
    const byLanguage = Object.fromEntries(
      languages().map((adapter) => [
        adapter.id,
        {
          symbols: symbolsByLanguage[adapter.id] ?? 0,
          calls: callsByLanguage[adapter.id] ?? 0,
          imports: importsByLanguage[adapter.id] ?? 0,
          exports: exportsByLanguage[adapter.id] ?? 0,
        },
      ]),
    );
    const kindCount = (kind: string) => kindCounts[kind] ?? 0;
    return {
      filesIndexed: filePaths.size,
      symbolsIndexed: this.symbols.length,
      methodsIndexed: kindCount("method"),
      constructorsIndexed: kindCount("constructor"),
      classesIndexed: kindCount("class"),
      interfacesIndexed: kindCount("interface"),
      recordsIndexed: kindCount("record"),
      enumsIndexed: kindCount("enum"),
      functionsIndexed: kindCount("function"),
      typesIndexed: kindCount("type"),
      componentsIndexed,
      duplicateSimpleNames: [...simpleNames.values()].filter(
        (count) => count > 1,
      ).length,
      ambiguousLookups: 0,
      symbolIdCollisions: collisions,
      callEdgesTotal: this.calls.length,
      callEdgesExact,
      callEdgesProbable,
      callEdgesUnresolved,
      externalCallEdges,
      importsTotal: this.imports.length,
      importsResolved,
      externalImports,
      reexportsTotal,
      reexportsResolved,
      byLanguage,
      resolutionKindCounts,
    };
  }
  sourceFor(symbol: SymbolRecord, sourceCache?: Map<string, string>) {
    const full = resolve(this.root, symbol.filePath);
    const fromRoot = relative(this.root, full);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    )
      throw new WorkflowError(
        "INVALID_ARGUMENT",
        `Path escapes repository root: ${symbol.filePath}`,
        "Pass a symbol whose filePath resolves inside the indexed repository root.",
      );
    const cached = sourceCache?.get(symbol.filePath);
    if (cached !== undefined) return cached;
    const source = readFileSync(full, "utf8");
    sourceCache?.set(symbol.filePath, source);
    return source;
  }

  callsFor(caller: SymbolRecord) {
    return this.queryIndex.callsFor(caller);
  }
}

export type LanguageSummary = Record<LanguageId, number>;
