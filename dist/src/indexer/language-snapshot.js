export function languageSnapshots(symbols, calls, imports, exports) {
    const snapshots = new Map();
    const get = (id) => {
        const existing = snapshots.get(id);
        if (existing)
            return existing;
        const snapshot = {
            id,
            symbols: [],
            calls: [],
            imports: [],
            exports: [],
        };
        snapshots.set(id, snapshot);
        return snapshot;
    };
    for (const symbol of symbols)
        get(symbol.language).symbols.push(symbol);
    for (const call of calls)
        get(call.language ?? "java").calls.push(call);
    for (const record of imports)
        get(record.language).imports.push(record);
    for (const record of exports)
        get(record.language).exports.push(record);
    return snapshots;
}
