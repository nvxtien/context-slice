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

export interface IndexStore {
  load(): IndexSnapshot;
  metadata(): Record<string, string>;
  save(
    snapshot: IndexSnapshot,
    changedPaths?: ReadonlySet<string>,
    removedPaths?: ReadonlySet<string>,
  ): void;
  close(): void;
}
