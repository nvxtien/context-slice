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
import {
  INDEX_VERSION,
  IndexStorage,
  type IndexedFileRecord,
} from "../storage/sqlite.js";
import { WorkflowError } from "../workflow/errors.js";
import {
  adapterFor,
  ignoredDirectories,
  languages,
  type ResolveContext,
} from "../languages/adapter.js";
import { ensureLanguageBootstrap } from "../languages/bootstrap.js";
import { resetCallResolution } from "./resolution-state.js";
import type { EnterpriseRelation } from "../types/enterprise.js";
import {
  extractEnterpriseRelations,
  resolveEnterpriseRelations,
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
  private readonly storage: IndexStorage;
  private sourceSignatures?: Map<string, string>;
  private cachedRefresh?: ReturnType<ProjectIndex["refresh"]>;
  constructor(root: string) {
    this.root = resolve(root);
    this.storage = new IndexStorage(this.root);
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
  inspect() {
    const files = this.files(this.root);
    const previous = this.storage.load();
    const hashes = new Map<string, string>();
    for (const file of files) {
      const filePath = relative(this.root, file);
      hashes.set(
        filePath,
        createHash("sha256").update(readFileSync(file, "utf8")).digest("hex"),
      );
    }
    const hasIndex = previous.files.size > 0;
    const stale =
      hasIndex &&
      (hashes.size !== previous.files.size ||
        [...hashes].some(
          ([path, hash]) => previous.files.get(path)?.hash !== hash,
        ));
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
  refresh() {
    const summary = this.rebuild();
    const result = { summary, freshness: this.inspect() };
    this.sourceSignatures = this.signatures(this.files(this.root));
    this.cachedRefresh = result;
    return result;
  }
  refreshIfStale() {
    const next = this.signatures(this.files(this.root));
    if (this.cachedRefresh && this.sameSignatures(next))
      return this.cachedRefresh;
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
    for (const file of files) {
      const filePath = relative(this.root, file);
      const adapter = adapterFor(filePath);
      if (!adapter) continue;
      const source = readFileSync(file, "utf8");
      const hash = createHash("sha256").update(source).digest("hex");
      this.hashes.set(filePath, { hash, language: adapter.id });
      let fileSymbols: SymbolRecord[];
      if (previous.files.get(filePath)?.hash === hash) {
        fileSymbols = previousSymbols.get(filePath) ?? [];
        this.symbols.push(...fileSymbols);
        this.calls.push(...(previousCalls.get(filePath) ?? []));
        this.imports.push(...(previousImports.get(filePath) ?? []));
        this.exports.push(...(previousExports.get(filePath) ?? []));
        cacheHits++;
      } else {
        changedPaths.add(filePath);
        const parsed = adapter.parse(filePath, source);
        fileSymbols = parsed.symbols;
        this.symbols.push(...parsed.symbols);
        this.calls.push(...parsed.calls);
        this.imports.push(...parsed.imports);
        this.exports.push(...parsed.exports);
        if (parsed.parseError) parseErrors++;
        filesParsed++;
      }
      if (adapter.id === "java") {
        this.enterpriseRelations.push(
          ...extractEnterpriseRelations(fileSymbols, filePath, source),
        );
      }
    }
    const currentPaths = new Set(this.hashes.keys());
    const removedPaths = new Set(
      [...previous.files.keys()].filter((path) => !currentPaths.has(path)),
    );
    this.enterpriseRelations = resolveEnterpriseRelations(
      this.enterpriseRelations,
      this.symbols.filter((symbol) => symbol.language === "java"),
    );
    // Each language resolves only its own edges; cross-language calls stay unresolved.
    // Resolution depends on the complete current symbol graph, so cached edges must be
    // invalidated even when their caller file did not change.
    for (const call of this.calls) resetCallResolution(call);
    for (const adapter of languages()) {
      const context: ResolveContext = {
        root: this.root,
        symbols: this.symbols.filter(
          (symbol) => symbol.language === adapter.id,
        ),
        calls: this.calls.filter(
          (call) => (call.language ?? "java") === adapter.id,
        ),
        imports: this.imports.filter(
          (record) => record.language === adapter.id,
        ),
        exports: this.exports.filter(
          (record) => record.language === adapter.id,
        ),
        sourceOf: (symbol) => this.sourceFor(symbol),
      };
      if (context.symbols.length) adapter.resolveCalls(context);
    }
    this.storage.save(
      this.hashes,
      this.symbols,
      this.calls,
      this.imports,
      this.exports,
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
      symbolsUpdated: this.symbols.length,
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
    // An overload signature is API surface; the implementation is the target.
    const preferImplementation = (matches: SymbolRecord[]) => {
      const implementations = matches.filter(
        (symbol) => !symbol.metadata?.overloadSignature,
      );
      return implementations.length ? implementations : matches;
    };
    const exact = this.symbols.filter(
      (s) =>
        s.id === input ||
        s.canonicalIdentity === input ||
        s.qualifiedName === input ||
        s.signature === input,
    );
    if (exact.length) return preferImplementation(exact);
    const qualifiedSuffix = this.symbols.filter((s) =>
      s.qualifiedName?.endsWith(`.${input}`),
    );
    return preferImplementation(
      qualifiedSuffix.length
        ? qualifiedSuffix
        : this.symbols.filter((s) => s.name === input),
    );
  }
  callers(target: SymbolRecord) {
    // A cfg-gated call (spec §40) carries every alternative in runtimeTargetIds, not just the
    // resolvedTargetId it settled on — a non-first alternative must still be reachable as a
    // caller/dependency edge, or context composition can never include it (see docs/rust-support.md).
    return this.calls
      .filter((call) =>
        (call.runtimeTargetIds ?? [call.resolvedTargetId]).includes(target.id),
      )
      .map((call) => this.symbols.find((s) => s.id === call.callerId))
      .filter((s): s is SymbolRecord => Boolean(s));
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
    return this.calls
      .filter((call) => call.callerId === target.id)
      .flatMap(
        (call) =>
          call.runtimeTargetIds ??
          (call.resolvedTargetId ? [call.resolvedTargetId] : []),
      )
      .map((id) => this.symbols.find((s) => s.id === id))
      .filter((s): s is SymbolRecord => Boolean(s));
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
        this.symbols.filter(
          (symbol) =>
            symbol.kind === "method" && symbol.name === call.calleeName,
        ).length > 1,
    );
  }
  diagnostics() {
    const simpleNames = new Map<string, number>();
    for (const symbol of this.symbols)
      simpleNames.set(symbol.name, (simpleNames.get(symbol.name) ?? 0) + 1);
    const ids = new Set<string>();
    let collisions = 0;
    for (const symbol of this.symbols) {
      if (ids.has(symbol.id)) collisions++;
      ids.add(symbol.id);
    }
    const resolutionKindCounts = Object.fromEntries(
      [...new Set(this.calls.map((call) => call.resolutionKind))].map(
        (kind) => [
          kind,
          this.calls.filter((call) => call.resolutionKind === kind).length,
        ],
      ),
    );
    const byLanguage = Object.fromEntries(
      languages().map((adapter) => [
        adapter.id,
        {
          symbols: this.symbols.filter(
            (symbol) => symbol.language === adapter.id,
          ).length,
          calls: this.calls.filter(
            (call) => (call.language ?? "java") === adapter.id,
          ).length,
          imports: this.imports.filter(
            (record) => record.language === adapter.id,
          ).length,
          exports: this.exports.filter(
            (record) => record.language === adapter.id,
          ).length,
        },
      ]),
    );
    const kindCount = (kind: string) =>
      this.symbols.filter((symbol) => symbol.kind === kind).length;
    return {
      filesIndexed: new Set(this.symbols.map((symbol) => symbol.filePath)).size,
      symbolsIndexed: this.symbols.length,
      methodsIndexed: kindCount("method"),
      constructorsIndexed: kindCount("constructor"),
      classesIndexed: kindCount("class"),
      interfacesIndexed: kindCount("interface"),
      recordsIndexed: kindCount("record"),
      enumsIndexed: kindCount("enum"),
      functionsIndexed: kindCount("function"),
      typesIndexed: kindCount("type"),
      componentsIndexed: this.symbols.filter(
        (symbol) => symbol.metadata?.reactComponent,
      ).length,
      duplicateSimpleNames: [...simpleNames.values()].filter(
        (count) => count > 1,
      ).length,
      ambiguousLookups: 0,
      symbolIdCollisions: collisions,
      callEdgesTotal: this.calls.length,
      callEdgesExact: this.calls.filter((call) => call.confidence === "exact")
        .length,
      callEdgesProbable: this.calls.filter(
        (call) => call.confidence === "probable",
      ).length,
      callEdgesUnresolved: this.calls.filter(
        (call) => call.confidence === "unresolved",
      ).length,
      externalCallEdges: this.calls.filter((call) => call.externalPackage)
        .length,
      importsTotal: this.imports.length,
      importsResolved: this.imports.filter((record) => record.resolvedFile)
        .length,
      externalImports: this.imports.filter((record) => record.externalPackage)
        .length,
      reexportsTotal: this.exports.filter((record) => record.fromModule).length,
      reexportsResolved: this.exports.filter(
        (record) => record.fromModule && record.resolvedFile,
      ).length,
      byLanguage,
      resolutionKindCounts,
    };
  }
  sourceFor(symbol: SymbolRecord) {
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
    return readFileSync(full, "utf8");
  }
}

export type LanguageSummary = Record<LanguageId, number>;
