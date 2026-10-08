import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  LanguageId,
  SymbolRecord,
} from "../types/model.js";

export interface ParsedFile {
  symbols: SymbolRecord[];
  calls: CallEdge[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  parseError: boolean;
}

/** Everything a language needs to resolve its own call edges across files. */
export interface ResolveContext {
  root: string;
  symbols: SymbolRecord[];
  calls: CallEdge[];
  /** Calls whose derived resolution is stale; omitted means all calls. */
  callsToResolve?: CallEdge[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  /** Full text of the file a symbol was parsed from. */
  sourceOf(symbol: SymbolRecord): string;
}

export interface LanguageAdapter {
  id: LanguageId;
  label: string;
  /** Lowercase file suffixes this adapter claims, longest match wins. */
  extensions: string[];
  /** Directory names to skip in addition to the core ignore list. */
  ignoredDirectories?: string[];
  parse(filePath: string, source: string): ParsedFile;
  /** Resolve this language's calls in place. Called once per rebuild. */
  resolveCalls(context: ResolveContext): void;
}

const registry: LanguageAdapter[] = [];

export function registerLanguage(adapter: LanguageAdapter) {
  registry.push(adapter);
  return adapter;
}

export function languages(): LanguageAdapter[] {
  return registry;
}

export function adapterFor(filePath: string): LanguageAdapter | undefined {
  const lower = filePath.toLowerCase();
  let best: { adapter: LanguageAdapter; length: number } | undefined;
  for (const adapter of registry)
    for (const extension of adapter.extensions)
      if (lower.endsWith(extension) && (best?.length ?? 0) < extension.length)
        best = { adapter, length: extension.length };
  return best?.adapter;
}

export function supportedExtensions(): string[] {
  return registry.flatMap((adapter) => adapter.extensions);
}

export function ignoredDirectories(): Set<string> {
  return new Set(
    registry.flatMap((adapter) => adapter.ignoredDirectories ?? []),
  );
}
