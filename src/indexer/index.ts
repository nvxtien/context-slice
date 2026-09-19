import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseJava } from "../parser/java-parser.js";
import type { CallEdge, SymbolRecord } from "../types/model.js";
import { rankSymbol } from "../planner/rank.js";
import { INDEX_VERSION, IndexStorage } from "../storage/sqlite.js";

const ignored = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  ".gradle",
  ".idea",
  ".vscode",
  ".context-slice",
]);
export class ProjectIndex {
  readonly root: string;
  symbols: SymbolRecord[] = [];
  calls: CallEdge[] = [];
  private hashes = new Map<string, string>();
  private readonly storage: IndexStorage;
  constructor(root: string) {
    this.root = resolve(root);
    this.storage = new IndexStorage(this.root);
  }
  private files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (ignored.has(entry.name)) return [];
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? this.files(path)
        : entry.isFile() && entry.name.endsWith(".java")
          ? [path]
          : [];
    });
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
        [...hashes].some(([path, hash]) => previous.files.get(path) !== hash));
    const metadata = this.storage.metadata();
    return {
      state: hasIndex
        ? stale
          ? ("STALE" as const)
          : ("CURRENT" as const)
        : ("UNINITIALIZED" as const),
      javaFiles: files.length,
      indexedFiles: previous.files.size,
      schemaVersion: metadata.schema_version ?? INDEX_VERSION,
      lastRefreshedAt: metadata.last_refreshed_at,
    };
  }
  refresh() {
    const summary = this.rebuild();
    return { summary, freshness: this.inspect() };
  }
  rebuild() {
    const started = Date.now();
    const files = this.files(this.root);
    const previous = this.storage.load();
    this.symbols = [];
    this.calls = [];
    this.hashes = new Map();
    let filesParsed = 0;
    let cacheHits = 0;
    for (const file of files) {
      const filePath = relative(this.root, file);
      const source = readFileSync(file, "utf8");
      const hash = createHash("sha256").update(source).digest("hex");
      this.hashes.set(filePath, hash);
      if (previous.files.get(filePath) === hash) {
        const cachedSymbols = previous.symbols.filter(
          (symbol) => symbol.filePath === filePath,
        );
        this.symbols.push(...cachedSymbols);
        this.calls.push(
          ...previous.calls.filter((call) => call.filePath === filePath),
        );
        cacheHits++;
        continue;
      }
      const parsed = parseJava(filePath, source);
      this.symbols.push(...parsed.symbols);
      this.calls.push(...parsed.calls);
      filesParsed++;
    }
    for (const call of this.calls) {
      const caller = this.symbols.find((symbol) => symbol.id === call.callerId);
      if (!caller) continue;
      const parent = this.symbols.find(
        (symbol) => symbol.id === caller.parentId,
      );
      const candidates = this.symbols.filter(
        (symbol) =>
          (symbol.kind === "method" || symbol.kind === "constructor") &&
          symbol.name === call.calleeName,
      );
      const sameType = candidates.filter(
        (candidate) => candidate.parentId === caller.parentId,
      );
      const source = this.sourceFor(caller);
      const declaredType = call.receiverText
        ? (source.match(
            new RegExp(
              `(?:\\b([A-Za-z_$][\\w$]*)\\s+${call.receiverText}\\b|\\b([A-Za-z_$][\\w$]*)\\s+${call.receiverText}\\s*[=;])`,
            ),
          )?.[1] ??
          source.match(
            new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s+${call.receiverText}\\b`),
          )?.[1])
        : undefined;
      const receiverType =
        declaredType ??
        (call.receiverText && /^[A-Z]/.test(call.receiverText)
          ? call.receiverText
          : undefined);
      const typed = receiverType
        ? candidates.filter(
            (candidate) =>
              this.symbols.find((symbol) => symbol.id === candidate.parentId)
                ?.name === receiverType,
          )
        : [];
      const inherited =
        parent?.supertypes?.flatMap((supertype) =>
          candidates.filter(
            (candidate) =>
              this.symbols.find((symbol) => symbol.id === candidate.parentId)
                ?.name === supertype,
          ),
        ) ?? [];
      const narrowed = (items: SymbolRecord[]) =>
        call.argumentCount === undefined
          ? items
          : items.filter(
              (candidate) =>
                (candidate.signature?.match(/\(([^)]*)\)/)?.[1].trim()
                  ? candidate.signature.match(/\(([^)]*)\)/)![1].split(",")
                      .length
                  : 0) === call.argumentCount,
            );
      const options =
        call.resolutionKind === "constructor"
          ? narrowed(
              candidates.filter(
                (candidate) => candidate.kind === "constructor",
              ),
            )
          : receiverType
            ? narrowed(typed)
            : sameType.length
              ? narrowed(sameType)
              : narrowed(inherited);
      if (options.length === 1) {
        const target = options[0];
        call.declaredTargetId = target.id;
        call.resolvedTargetId = target.id;
        call.confidence =
          receiverType &&
          this.symbols.find((symbol) => symbol.id === target.parentId)?.kind ===
            "interface"
            ? "probable"
            : "exact";
        call.resolutionKind =
          call.resolutionKind === "constructor"
            ? "constructor"
            : inherited.includes(target)
              ? "inherited"
              : receiverType
                ? this.symbols.find((symbol) => symbol.id === target.parentId)
                    ?.kind === "interface"
                  ? "interface"
                  : /^[A-Z]/.test(call.receiverText ?? "")
                    ? "static"
                    : "explicit-receiver"
                : "same-type";
        call.evidence = [
          `unique ${call.resolutionKind} target ${target.qualifiedName}`,
        ];
      } else if (options.length > 1) {
        call.confidence = "unresolved";
        call.resolutionKind = receiverType ? "interface" : "unresolved";
        call.evidence = [`${options.length} plausible targets remain`];
      }
    }
    this.storage.save(this.hashes, this.symbols, this.calls);
    return {
      files: files.length,
      filesScanned: files.length,
      filesParsed,
      cacheHits,
      symbols: this.symbols.length,
      symbolsUpdated: this.symbols.length,
      calls: this.calls.length,
      elapsedMs: Date.now() - started,
    };
  }
  search(query: string, limit = 10) {
    return this.symbols
      .map((symbol) => ({
        id: symbol.id,
        kind: symbol.kind,
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
    const exact = this.symbols.filter(
      (s) =>
        s.id === input ||
        s.canonicalIdentity === input ||
        s.qualifiedName === input ||
        s.signature === input,
    );
    if (exact.length) return exact;
    const qualifiedSuffix = this.symbols.filter((s) =>
      s.qualifiedName?.endsWith(`.${input}`),
    );
    return qualifiedSuffix.length
      ? qualifiedSuffix
      : this.symbols.filter((s) => s.name === input);
  }
  callers(target: SymbolRecord) {
    const ids = new Set([target.id]);
    return this.calls
      .filter((call) => call.resolvedTargetId && ids.has(call.resolvedTargetId))
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
      .map((call) =>
        call.resolvedTargetId
          ? this.symbols.find((s) => s.id === call.resolvedTargetId)
          : undefined,
      )
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
    return {
      filesIndexed: new Set(this.symbols.map((symbol) => symbol.filePath)).size,
      symbolsIndexed: this.symbols.length,
      methodsIndexed: this.symbols.filter((symbol) => symbol.kind === "method")
        .length,
      constructorsIndexed: this.symbols.filter(
        (symbol) => symbol.kind === "constructor",
      ).length,
      classesIndexed: this.symbols.filter((symbol) => symbol.kind === "class")
        .length,
      interfacesIndexed: this.symbols.filter(
        (symbol) => symbol.kind === "interface",
      ).length,
      recordsIndexed: this.symbols.filter((symbol) => symbol.kind === "record")
        .length,
      enumsIndexed: this.symbols.filter((symbol) => symbol.kind === "enum")
        .length,
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
      resolutionKindCounts,
    };
  }
  sourceFor(symbol: SymbolRecord) {
    const full = resolve(this.root, symbol.filePath);
    if (!full.startsWith(this.root + "/") && full !== this.root)
      throw new Error("Path nằm ngoài repository root");
    return readFileSync(full, "utf8");
  }
}
