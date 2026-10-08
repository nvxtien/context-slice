const registry = [];
export function registerLanguage(adapter) {
    registry.push(adapter);
    return adapter;
}
export function languages() {
    return registry;
}
export function adapterFor(filePath) {
    const lower = filePath.toLowerCase();
    let best;
    for (const adapter of registry)
        for (const extension of adapter.extensions)
            if (lower.endsWith(extension) && (best?.length ?? 0) < extension.length)
                best = { adapter, length: extension.length };
    return best?.adapter;
}
export function supportedExtensions() {
    return registry.flatMap((adapter) => adapter.extensions);
}
export function ignoredDirectories() {
    return new Set(registry.flatMap((adapter) => adapter.ignoredDirectories ?? []));
}
