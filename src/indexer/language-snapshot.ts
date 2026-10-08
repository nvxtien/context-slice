import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  LanguageId,
  SymbolRecord,
} from "../types/model.js";

export interface LanguageSnapshot {
  id: LanguageId;
  symbols: SymbolRecord[];
  calls: CallEdge[];
  imports: ImportRecord[];
  exports: ExportRecord[];
}

export function languageSnapshots(
  symbols: SymbolRecord[],
  calls: CallEdge[],
  imports: ImportRecord[],
  exports: ExportRecord[],
): Map<LanguageId, LanguageSnapshot> {
  const snapshots = new Map<LanguageId, LanguageSnapshot>();
  const get = (id: LanguageId) => {
    const existing = snapshots.get(id);
    if (existing) return existing;
    const snapshot: LanguageSnapshot = {
      id,
      symbols: [],
      calls: [],
      imports: [],
      exports: [],
    };
    snapshots.set(id, snapshot);
    return snapshot;
  };
  for (const symbol of symbols) get(symbol.language).symbols.push(symbol);
  for (const call of calls) get(call.language ?? "java").calls.push(call);
  for (const record of imports) get(record.language).imports.push(record);
  for (const record of exports) get(record.language).exports.push(record);
  return snapshots;
}
