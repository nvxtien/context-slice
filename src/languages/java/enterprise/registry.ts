import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";

export type EnterpriseExtractor = (
  symbols: SymbolRecord[],
  filePath: string,
  source: string,
) => EnterpriseRelation[];

/**
 * Project-wide post-pass: extractors only see one file, so a family whose relations need
 * the full symbol set (e.g. DI bean identity) registers a resolver that rewrites its own
 * relations once every file is parsed. Mirrors the parse-then-resolveCalls split.
 */
export type EnterpriseResolver = (
  relations: EnterpriseRelation[],
  allSymbols: SymbolRecord[],
) => EnterpriseRelation[];

let extractors: EnterpriseExtractor[] = [];
let resolvers: EnterpriseResolver[] = [];

/** Called once per family module at import time, mirroring registerLanguage in languages/adapter.ts. */
export function registerEnterpriseExtractor(extractor: EnterpriseExtractor) {
  extractors.push(extractor);
}

/** Runs every registered family extractor over one file's symbols and unions the results. */
export function extractEnterpriseRelations(
  symbols: SymbolRecord[],
  filePath: string,
  source: string,
): EnterpriseRelation[] {
  return extractors.flatMap((extractor) =>
    extractor(symbols, filePath, source),
  );
}

export function registerEnterpriseResolver(resolver: EnterpriseResolver) {
  resolvers.push(resolver);
}

/** Runs every registered resolver in turn over the complete relation and symbol sets. */
export function resolveEnterpriseRelations(
  relations: EnterpriseRelation[],
  allSymbols: SymbolRecord[],
): EnterpriseRelation[] {
  return resolvers.reduce(
    (acc, resolver) => resolver(acc, allSymbols),
    relations,
  );
}

/** Test-only: clears registrations between test files so registry state doesn't leak. */
export function __resetEnterpriseExtractorsForTests() {
  extractors = [];
  resolvers = [];
}
