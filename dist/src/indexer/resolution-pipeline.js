import { languages } from "../languages/adapter.js";
import { resetCallResolution } from "./resolution-state.js";
export class ResolutionPipeline {
    resolve(input) {
        if (input.changedPaths.size === 0 && input.removedPaths.size === 0)
            return new Set();
        const fullResolve = input.removedPaths.size > 0 || input.declarationChangedPaths.size > 0;
        const targetIds = new Set();
        if (!fullResolve) {
            for (const symbol of input.symbols)
                if (input.changedPaths.has(symbol.filePath))
                    targetIds.add(symbol.id);
        }
        const affectedPaths = fullResolve
            ? undefined
            : (input.affectedPaths ??
                new Set(input.calls
                    .filter((call) => {
                    const targets = [
                        call.declaredTargetId,
                        call.resolvedTargetId,
                        ...(call.runtimeTargetIds ?? []),
                    ];
                    return (input.changedPaths.has(call.filePath) ||
                        targets.some((target) => target && targetIds.has(target)));
                })
                    .map((call) => call.filePath)));
        const callsToResolve = affectedPaths
            ? input.calls.filter((call) => affectedPaths.has(call.filePath))
            : input.calls;
        for (const call of callsToResolve)
            resetCallResolution(call);
        for (const adapter of languages()) {
            const snapshot = input.snapshots.get(adapter.id);
            if (!snapshot?.symbols.length)
                continue;
            const snapshotCalls = new Set(snapshot.calls);
            const context = {
                root: input.root,
                symbols: snapshot.symbols,
                calls: snapshot.calls,
                callsToResolve: callsToResolve.filter((call) => snapshotCalls.has(call)),
                imports: snapshot.imports,
                exports: snapshot.exports,
                sourceOf: input.sourceOf,
            };
            adapter.resolveCalls(context);
        }
        return affectedPaths;
    }
}
