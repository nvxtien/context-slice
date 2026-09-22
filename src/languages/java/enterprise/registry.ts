import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";

export type EnterpriseExtractor = (
  symbols: SymbolRecord[],
  filePath: string,
  source: string,
) => EnterpriseRelation[];

let extractors: EnterpriseExtractor[] = [];

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
  return extractors.flatMap((extractor) => extractor(symbols, filePath, source));
}

/** Test-only: clears registrations between test files so registry state doesn't leak. */
export function __resetEnterpriseExtractorsForTests() {
  extractors = [];
}
