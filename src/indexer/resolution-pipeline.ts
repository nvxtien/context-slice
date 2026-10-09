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
  declarationChangedPaths: ReadonlySet<string>;
  affectedPaths: ReadonlySet<string>;
  imports: ImportRecord[];
  exports: ExportRecord[];
  snapshots: Map<string, LanguageSnapshot>;
  sourceOf(symbol: SymbolRecord): string;
  changedPaths: ReadonlySet<string>;
  removedPaths: ReadonlySet<string>;
}

export class ResolutionPipeline {
  resolve(input: ResolutionInput) {
    if (input.changedPaths.size === 0 && input.removedPaths.size === 0)
      return new Set<string>();
    const fullResolve =
      input.removedPaths.size > 0 || input.declarationChangedPaths.size > 0;
    // A file's declaration shape unchanged means every symbol it declares kept the same
    // name/signature/parent/supertypes, so a call elsewhere that already resolved to one of
    // those symbols is still correctly resolved -- only calls IN the changed files themselves
    // (and only when the project needs re-scoping, i.e. the caller's own affectedPaths) need
    // re-resolving. The caller (ProjectIndex.rebuild()) always supplies affectedPaths, so this
    // never falls back to a looser project-wide guess.
    const affectedPaths = fullResolve ? undefined : input.affectedPaths;
    const callsToResolve = affectedPaths
      ? input.calls.filter((call) => affectedPaths.has(call.filePath))
      : input.calls;
    for (const call of callsToResolve) resetCallResolution(call);
    for (const adapter of languages()) {
      const snapshot = input.snapshots.get(adapter.id);
      if (!snapshot?.symbols.length) continue;
      const snapshotCalls = new Set(snapshot.calls);
      const context: ResolveContext = {
        root: input.root,
        symbols: snapshot.symbols,
        calls: snapshot.calls,
        callsToResolve: callsToResolve.filter((call) =>
          snapshotCalls.has(call),
        ),
        imports: snapshot.imports,
        exports: snapshot.exports,
        sourceOf: input.sourceOf,
      };
      adapter.resolveCalls(context);
    }
    return affectedPaths;
  }
}
