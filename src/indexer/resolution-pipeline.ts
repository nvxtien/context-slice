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
  previousSymbols: SymbolRecord[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  snapshots: Map<string, LanguageSnapshot>;
  sourceOf(symbol: SymbolRecord): string;
  changedPaths: ReadonlySet<string>;
  removedPaths: ReadonlySet<string>;
}

export class ResolutionPipeline {
  resolve(input: ResolutionInput) {
    if (input.changedPaths.size === 0 && input.removedPaths.size === 0) return;
    const declarationShape = (symbol: SymbolRecord) =>
      JSON.stringify([
        symbol.filePath,
        symbol.kind,
        symbol.name,
        symbol.qualifiedName,
        symbol.signature,
        symbol.parentId,
        symbol.supertypes,
      ]);
    const shapesByFile = (symbols: SymbolRecord[]) => {
      const result = new Map<string, string[]>();
      for (const symbol of symbols) {
        const shapes = result.get(symbol.filePath) ?? [];
        shapes.push(declarationShape(symbol));
        result.set(symbol.filePath, shapes);
      }
      for (const shapes of result.values()) shapes.sort();
      return result;
    };
    const currentShapes = shapesByFile(input.symbols);
    const previousShapes = shapesByFile(input.previousSymbols);
    const declarationChanged = [...input.changedPaths].some(
      (path) =>
        JSON.stringify(currentShapes.get(path) ?? []) !==
        JSON.stringify(previousShapes.get(path) ?? []),
    );
    const fullResolve = input.removedPaths.size > 0 || declarationChanged;
    const targetIds = new Set<string>();
    if (!fullResolve) {
      for (const symbol of input.previousSymbols)
        if (input.changedPaths.has(symbol.filePath)) targetIds.add(symbol.id);
      for (const symbol of input.symbols)
        if (input.changedPaths.has(symbol.filePath)) targetIds.add(symbol.id);
    }
    const affectedPaths = fullResolve
      ? undefined
      : new Set(
          input.calls
            .filter((call) => {
              const targets = [
                call.declaredTargetId,
                call.resolvedTargetId,
                ...(call.runtimeTargetIds ?? []),
              ];
              return (
                input.changedPaths.has(call.filePath) ||
                targets.some((target) => target && targetIds.has(target))
              );
            })
            .map((call) => call.filePath),
        );
    const callsToResolve = affectedPaths
      ? input.calls.filter((call) => affectedPaths.has(call.filePath))
      : input.calls;
    for (const call of callsToResolve) resetCallResolution(call);
    for (const adapter of languages()) {
      const snapshot = input.snapshots.get(adapter.id);
      if (!snapshot?.symbols.length) continue;
      const context: ResolveContext = {
        root: input.root,
        symbols: snapshot.symbols,
        calls: snapshot.calls,
        callsToResolve: callsToResolve.filter((call) =>
          snapshot.calls.includes(call),
        ),
        imports: snapshot.imports,
        exports: snapshot.exports,
        sourceOf: input.sourceOf,
      };
      adapter.resolveCalls(context);
    }
  }
}
