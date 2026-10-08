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
  IndexSnapshot,
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
import {
  clearDirty,
  dirtyPaths,
  dirtyMarkerExists,
  isDirty,
} from "../storage/dirty-marker.js";
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

interface LazySymbolContext {
  root: string;
}
type LazySymbol = SymbolRecord & { [lazyContextKey]?: LazySymbolContext };
const lazyContextKey = Symbol("context-slice-lazy-context");
const lazySymbolPrototype = {};

function lazySource(symbol: LazySymbol, range: SymbolRecord["range"]) {
  const context = symbol[lazyContextKey];
  if (!context) return "";
  const fullPath = resolve(context.root, symbol.filePath);
  const fromRoot = relative(context.root, fullPath);
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
  const source = readFileSync(fullPath, "utf8");
  const offset = (line: number, column: number) => {
    let current = 0;
    for (let index = 1; index < line; index++) {
      const newline = source.indexOf("\n", current);
      if (newline < 0) return source.length;
      current = newline + 1;
    }
    return Math.min(current + column, source.length);
  };
  return source.slice(
    offset(range.startLine, range.startColumn),
    offset(range.endLine, range.endColumn),
  );
}

Object.defineProperties(lazySymbolPrototype, {
  source: {
    enumerable: true,
    get(this: LazySymbol) {
      return lazySource(this, this.range);
    },
  },
  body: {
    enumerable: true,
    get(this: LazySymbol) {
      return this.bodyRange ? lazySource(this, this.bodyRange) : undefined;
    },
  },
});

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
  private snapshot?: IndexSnapshot;
  private callsLoaded = true;
  private readonly loadedCallCallers = new Set<string>();
  private readonly loadedCallTargets = new Set<string>();
  private readonly loadedCallKeys = new Set<string>();
  private readonly enterpriseRegistry: EnterpriseRegistry;
  private readonly lazySymbolContext: LazySymbolContext;
  private sourceSignatures?: Map<string, string>;
  private cachedRefresh?: ReturnType<ProjectIndex["refresh"]>;
  private readonly queryIndex = new QueryIndex();
  private readonly resolutionPipeline = new ResolutionPipeline();
  constructor(root: string) {
    this.root = resolve(root);
    this.storage = new IndexStorage(this.root);
    this.lazySymbolContext = { root: this.root };
    this.enterpriseRegistry = createEnterpriseRegistry();
  }

  close() {
    this.storage.close();
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

  private makeSymbolsLazy(symbols: SymbolRecord[]) {
    for (const symbol of symbols) {
      delete (symbol as Partial<SymbolRecord>).source;
      delete (symbol as Partial<SymbolRecord>).body;
      Object.defineProperty(symbol, lazyContextKey, {
        configurable: true,
        enumerable: false,
        value: this.lazySymbolContext,
      });
      Object.setPrototypeOf(symbol, lazySymbolPrototype);
    }
  }

  private declarationShape(symbol: SymbolRecord) {
    return JSON.stringify([
      symbol.kind,
      symbol.name,
      symbol.qualifiedName,
      symbol.signature,
      symbol.parentId,
      symbol.supertypes,
    ]);
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
  private computeFreshness(
    files: string[],
    previous = this.storage.load({ calls: false, symbols: "lean" }),
  ) {
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
    previous = this.storage.load({ calls: false, symbols: "lean" }),
    callsLoaded = true,
  ) {
    this.hashes = previous.files;
    this.symbols = previous.symbols;
    this.calls = previous.calls;
    this.imports = previous.imports;
    this.exports = previous.exports;
    this.snapshot = previous;
    this.callsLoaded = callsLoaded;
    this.makeSymbolsLazy(this.symbols);
    this.loadedCallCallers.clear();
    this.loadedCallTargets.clear();
    this.loadedCallKeys.clear();
    if (callsLoaded)
      for (const call of this.calls)
        this.loadedCallKeys.add(JSON.stringify(call));
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
      timingsMs: {},
    };
    const result = { summary, freshness };
    this.sourceSignatures = signatures;
    if (dirtyMarkerExists(this.root)) clearDirty(this.root);
    this.cachedRefresh = result;
    return result;
  }
  private dirtyChangedPaths(files: string[], paths: string[]) {
    const previous = this.storage.load({ calls: false, symbols: "lean" });
    const candidates = paths.length ? paths : [...previous.files.keys()];
    const currentFiles = new Map(
      files.map((file) => [relative(this.root, file), file]),
    );
    const changed = new Set<string>();
    for (const filePath of candidates) {
      const file = currentFiles.get(filePath);
      const previousFile = previous.files.get(filePath);
      if (!file || !previousFile) continue;
      const hash = createHash("sha256")
        .update(readFileSync(file))
        .digest("hex");
      if (hash !== previousFile.hash) changed.add(filePath);
    }
    return changed;
  }

  refresh(forcePaths = new Set<string>()) {
    const summary = this.rebuild(forcePaths);
    // Set before inspect() so its cheap signature check can recognize the index it just
    // built as current, instead of inspect() re-reading and re-hashing every file a second
    // time right after rebuild() already did exactly that.
    this.sourceSignatures = this.signatures(this.files(this.root));
    const result = { summary, freshness: this.inspect() };
    this.cachedRefresh = result;
    return result;
  }
  private ensureCallsLoaded() {
    if (this.callsLoaded) return;
    this.calls = this.storage.loadCalls();
    this.callsLoaded = true;
    this.loadedCallCallers.clear();
    this.loadedCallTargets.clear();
    this.loadedCallKeys.clear();
    for (const call of this.calls)
      this.loadedCallKeys.add(JSON.stringify(call));
    this.snapshot = { ...this.snapshot!, calls: this.calls };
    this.reindex();
  }

  private mergePartialCalls(calls: CallEdge[]) {
    const added: CallEdge[] = [];
    for (const call of calls) {
      const key = JSON.stringify(call);
      if (this.loadedCallKeys.has(key)) continue;
      this.loadedCallKeys.add(key);
      this.calls.push(call);
      added.push(call);
    }
    this.snapshot = { ...this.snapshot!, calls: this.calls };
    this.queryIndex.addCalls(added);
  }

  private ensureCallsForCaller(callerId: string) {
    if (this.callsLoaded || this.loadedCallCallers.has(callerId)) return;
    this.mergePartialCalls(this.storage.loadCallsForCaller(callerId));
    this.loadedCallCallers.add(callerId);
  }

  private ensureCallsForTarget(targetId: string) {
    if (this.callsLoaded || this.loadedCallTargets.has(targetId)) return;
    this.mergePartialCalls(this.storage.loadCallsForTarget(targetId));
    this.loadedCallTargets.add(targetId);
  }

  refreshIfStale() {
    const dirty = dirtyMarkerExists(this.root) && isDirty(this.root);
    const dirtyChanged = dirty
      ? this.dirtyChangedPaths(this.files(this.root), dirtyPaths(this.root))
      : new Set<string>();
    if (this.cachedRefresh && dirty && dirtyChanged.size === 0) {
      clearDirty(this.root);
      return this.cachedRefresh;
    }
    if (this.cachedRefresh && dirtyMarkerExists(this.root) && !dirty)
      return this.cachedRefresh;
    const files = this.files(this.root);
    const next = this.signatures(files);
    if (
      this.cachedRefresh &&
      dirtyChanged.size === 0 &&
      this.sameSignatures(next)
    ) {
      if (dirtyMarkerExists(this.root)) clearDirty(this.root);
      return this.cachedRefresh;
    }
    if (!this.cachedRefresh) {
      const previous = this.storage.load({ calls: false, symbols: "lean" });
      const freshness = this.computeFreshness(files, previous);
      if (freshness.state === "CURRENT" && dirtyChanged.size === 0)
        return this.hydrateCached(files, next, freshness, previous, false);
    }
    return this.refresh(dirtyChanged);
  }
  rebuild(forcePaths = new Set<string>()) {
    this.cachedRefresh = undefined;
    this.ensureCallsLoaded();
    const started = Date.now();
    const timingsMs: Record<string, number> = {};
    let phaseStarted = started;
    const files = this.files(this.root);
    timingsMs.fileDiscovery = Date.now() - phaseStarted;
    phaseStarted = Date.now();
    const previous = this.snapshot ?? this.storage.load({ symbols: "lean" });
    timingsMs.storageLoad = Date.now() - phaseStarted;
    phaseStarted = Date.now();
    this.symbols = [];
    this.calls = [];
    this.imports = [];
    this.exports = [];
    this.enterpriseRelations = [];
    this.hashes = new Map();
    let filesParsed = 0;
    let cacheHits = 0;
    const changedPaths = new Set<string>();
    const declarationChangedPaths = new Set<string>();
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
        !forcePaths.has(filePath) &&
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
        const previousShape = (previousSymbols.get(filePath) ?? [])
          .map((symbol) => this.declarationShape(symbol))
          .sort();
        const currentShape = fileSymbols
          .map((symbol) => this.declarationShape(symbol))
          .sort();
        if (JSON.stringify(previousShape) !== JSON.stringify(currentShape))
          declarationChangedPaths.add(filePath);
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
    timingsMs.parseAndCache = Date.now() - phaseStarted;
    phaseStarted = Date.now();
    const currentPaths = new Set(this.hashes.keys());
    const removedPaths = new Set(
      [...previous.files.keys()].filter((path) => !currentPaths.has(path)),
    );
    this.enterpriseRelations = this.enterpriseRegistry.resolveRelations(
      this.enterpriseRelations,
      this.symbols.filter((symbol) => symbol.language === "java"),
    );
    timingsMs.enterprise = Date.now() - phaseStarted;
    phaseStarted = Date.now();
    const snapshots = languageSnapshots(
      this.symbols,
      this.calls,
      this.imports,
      this.exports,
    );
    timingsMs.snapshots = Date.now() - phaseStarted;
    phaseStarted = Date.now();
    const affectedPaths = new Set(changedPaths);
    const affectedCallPaths = this.resolutionPipeline.resolve({
      root: this.root,
      symbols: this.symbols,
      declarationChangedPaths,
      affectedPaths,
      calls: this.calls,
      imports: this.imports,
      exports: this.exports,
      snapshots,
      sourceOf: (symbol) => this.sourceFor(symbol, sourceCache),
      changedPaths,
      removedPaths,
    });
    timingsMs.resolution = Date.now() - phaseStarted;
    phaseStarted = Date.now();
    this.reindex();
    timingsMs.queryIndex = Date.now() - phaseStarted;
    phaseStarted = Date.now();
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
      affectedCallPaths,
    );
    this.snapshot = {
      files: this.hashes,
      symbols: this.symbols,
      calls: this.calls,
      imports: this.imports,
      exports: this.exports,
    };
    this.makeSymbolsLazy(this.symbols);
    timingsMs.storageSave = Date.now() - phaseStarted;
    if (dirtyMarkerExists(this.root)) clearDirty(this.root);
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
      timingsMs,
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
    this.ensureCallsForTarget(target.id);
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
    this.ensureCallsForCaller(target.id);
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
    this.ensureCallsLoaded();
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
    const callStats = this.storage.callStats();
    const callEdgesExact = callStats.exact;
    const callEdgesProbable = callStats.probable;
    const callEdgesUnresolved = callStats.unresolved;
    const externalCallEdges = callStats.external;
    const callsByLanguage = callStats.byLanguage;
    Object.assign(resolutionKindCounts, callStats.byResolutionKind);
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
      callEdgesTotal: callStats.total,
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
    this.ensureCallsForCaller(caller.id);
    return this.queryIndex.callsFor(caller);
  }
}

export type LanguageSummary = Record<LanguageId, number>;
