import { languages, type ResolveContext } from "../languages/adapter.js";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  SymbolRecord,
} from "../types/model.js";
import { resetCallResolution } from "./resolution-state.js";
import type { LanguageSnapshot } from "./language-snapshot.js";

export interface ResolutionInput {
  symbols: SymbolRecord[];
  root: string;
  calls: CallEdge[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  snapshots: Map<string, LanguageSnapshot>;
  sourceOf(symbol: SymbolRecord): string;
  changedPaths: ReadonlySet<string>;
  removedPaths: ReadonlySet<string>;
}

export class ResolutionPipeline {
  resolve(input: ResolutionInput) {
    // Adapters inspect project-wide type/import state, so partial invalidation is unsafe until
    // they expose dependency impact. Keep this full-graph fallback behind one boundary.
    if (input.changedPaths.size === 0 && input.removedPaths.size === 0) return;
    for (const call of input.calls) resetCallResolution(call);
    for (const adapter of languages()) {
      const snapshot = input.snapshots.get(adapter.id);
      if (!snapshot?.symbols.length) continue;
      const context: ResolveContext = {
        root: input.root,
        symbols: snapshot.symbols,
        calls: snapshot.calls,
        imports: snapshot.imports,
        exports: snapshot.exports,
        sourceOf: input.sourceOf,
      };
      adapter.resolveCalls(context);
    }
  }
}
