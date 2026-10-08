import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  LanguageId,
  SymbolRecord,
} from "../types/model.js";

export interface IndexedFileRecord {
  hash: string;
  language: LanguageId;
  parseError: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface IndexSnapshot {
  files: Map<string, IndexedFileRecord>;
  symbols: SymbolRecord[];
  calls: CallEdge[];
  imports: ImportRecord[];
  exports: ExportRecord[];
}

export interface CallStats {
  total: number;
  exact: number;
  probable: number;
  unresolved: number;
  external: number;
  byLanguage: Record<string, number>;
  byResolutionKind: Record<string, number>;
}

export interface IndexStore {
  load(options?: { calls?: boolean; symbols?: "full" | "lean" }): IndexSnapshot;
  loadCalls(): CallEdge[];
  loadCallsForCaller(callerId: string): CallEdge[];
  loadCallsForTarget(targetId: string): CallEdge[];
  callStats(): CallStats;
  metadata(): Record<string, string>;
  save(
    snapshot: IndexSnapshot,
    changedPaths?: ReadonlySet<string>,
    removedPaths?: ReadonlySet<string>,
    callPaths?: ReadonlySet<string>,
  ): void;
  close(): void;
}
