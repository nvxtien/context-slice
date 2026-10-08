export class QueryIndex {
    symbols = new Map();
    byName = new Map();
    byQualifiedName = new Map();
    byQualifiedSuffix = new Map();
    byCanonicalIdentity = new Map();
    bySignature = new Map();
    callsByCaller = new Map();
    callsByTarget = new Map();
    childrenByParent = new Map();
    moduleScopeByFile = new Map();
    methodCountByName = new Map();
    rebuild(symbols, calls) {
        this.symbols = new Map(symbols.map((symbol) => [symbol.id, symbol]));
        this.byName = new Map();
        this.byQualifiedName = new Map();
        this.byQualifiedSuffix = new Map();
        this.byCanonicalIdentity = new Map();
        this.bySignature = new Map();
        this.childrenByParent = new Map();
        this.moduleScopeByFile = new Map();
        this.methodCountByName = new Map();
        const add = (map, key, symbol) => {
            if (!key)
                return;
            const matches = map.get(key);
            if (matches)
                matches.push(symbol);
            else
                map.set(key, [symbol]);
        };
        for (const symbol of symbols) {
            add(this.byName, symbol.name, symbol);
            add(this.byQualifiedName, symbol.qualifiedName, symbol);
            if (symbol.qualifiedName) {
                let dot = symbol.qualifiedName.indexOf(".");
                while (dot >= 0) {
                    add(this.byQualifiedSuffix, symbol.qualifiedName.slice(dot + 1), symbol);
                    dot = symbol.qualifiedName.indexOf(".", dot + 1);
                }
            }
            add(this.byCanonicalIdentity, symbol.canonicalIdentity, symbol);
            add(this.bySignature, symbol.signature, symbol);
            if (symbol.parentId) {
                const children = this.childrenByParent.get(symbol.parentId);
                if (children)
                    children.push(symbol);
                else
                    this.childrenByParent.set(symbol.parentId, [symbol]);
            }
            if (symbol.kind === "namespace" && symbol.metadata?.moduleScope === true)
                this.moduleScopeByFile.set(symbol.filePath, symbol);
            if (symbol.kind === "method")
                this.methodCountByName.set(symbol.name, (this.methodCountByName.get(symbol.name) ?? 0) + 1);
        }
        this.callsByCaller = new Map();
        this.callsByTarget = new Map();
        this.addCalls(calls);
    }
    addCalls(calls) {
        for (const call of calls) {
            const callers = this.callsByCaller.get(call.callerId);
            if (callers)
                callers.push(call);
            else
                this.callsByCaller.set(call.callerId, [call]);
            const targetIds = call.runtimeTargetIds ??
                (call.resolvedTargetId ? [call.resolvedTargetId] : []);
            for (const id of targetIds) {
                const targets = this.callsByTarget.get(id);
                if (targets)
                    targets.push(call);
                else
                    this.callsByTarget.set(id, [call]);
            }
        }
    }
    symbolById(id) {
        return this.symbols.get(id);
    }
    childrenOf(parentId) {
        return this.childrenByParent.get(parentId) ?? [];
    }
    moduleScopeSymbol(filePath) {
        return this.moduleScopeByFile.get(filePath);
    }
    callsFor(caller) {
        return this.callsByCaller.get(caller.id) ?? [];
    }
    callers(target) {
        return (this.callsByTarget.get(target.id) ?? [])
            .map((call) => this.symbols.get(call.callerId))
            .filter((symbol) => Boolean(symbol));
    }
    dependencies(target) {
        return (this.callsByCaller.get(target.id) ?? [])
            .flatMap((call) => call.runtimeTargetIds ??
            (call.resolvedTargetId ? [call.resolvedTargetId] : []))
            .map((id) => this.symbols.get(id))
            .filter((symbol) => Boolean(symbol));
    }
    methodCount(name) {
        return this.methodCountByName.get(name) ?? 0;
    }
    resolveSymbol(input) {
        const preferImplementation = (matches) => {
            const implementations = matches.filter((symbol) => !symbol.metadata?.overloadSignature);
            return implementations.length ? implementations : matches;
        };
        const exact = [
            this.symbols.get(input),
            ...(this.byCanonicalIdentity.get(input) ?? []),
            ...(this.byQualifiedName.get(input) ?? []),
            ...(this.bySignature.get(input) ?? []),
        ].filter((symbol, index, matches) => Boolean(symbol) && matches.indexOf(symbol) === index);
        if (exact.length)
            return preferImplementation(exact);
        const qualifiedSuffix = this.byQualifiedSuffix.get(input) ?? [];
        return preferImplementation(qualifiedSuffix.length ? qualifiedSuffix : (this.byName.get(input) ?? []));
    }
}
