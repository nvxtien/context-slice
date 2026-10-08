export class EnterpriseRegistry {
    extractors = [];
    resolvers = [];
    registerExtractor(extractor) {
        this.extractors.push(extractor);
    }
    registerResolver(resolver) {
        this.resolvers.push(resolver);
    }
    extractRelations(symbols, filePath, source) {
        return this.extractors.flatMap((extractor) => {
            try {
                return extractor(symbols, filePath, source);
            }
            catch {
                return [];
            }
        });
    }
    resolveRelations(relations, allSymbols) {
        return this.resolvers.reduce((acc, resolver) => {
            try {
                return resolver(acc, allSymbols);
            }
            catch {
                return acc;
            }
        }, relations);
    }
    clone() {
        const registry = new EnterpriseRegistry();
        registry.extractors.push(...this.extractors);
        registry.resolvers.push(...this.resolvers);
        return registry;
    }
    clear() {
        this.extractors.length = 0;
        this.resolvers.length = 0;
    }
}
const defaultRegistry = new EnterpriseRegistry();
/** Called once per family module at import time, mirroring registerLanguage in languages/adapter.ts. */
export function registerEnterpriseExtractor(extractor) {
    defaultRegistry.registerExtractor(extractor);
}
/** Runs every registered family extractor over one file's symbols and unions the results. */
export function extractEnterpriseRelations(symbols, filePath, source) {
    return defaultRegistry.extractRelations(symbols, filePath, source);
}
export function registerEnterpriseResolver(resolver) {
    defaultRegistry.registerResolver(resolver);
}
/** Runs every registered resolver in turn over the complete relation and symbol sets. */
export function resolveEnterpriseRelations(relations, allSymbols) {
    return defaultRegistry.resolveRelations(relations, allSymbols);
}
export function createEnterpriseRegistry() {
    return defaultRegistry.clone();
}
/** Test-only: clears registrations between test files so registry state doesn't leak. */
export function __resetEnterpriseExtractorsForTests() {
    defaultRegistry.clear();
}
