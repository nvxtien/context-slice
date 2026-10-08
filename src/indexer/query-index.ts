import type { CallEdge, SymbolRecord } from "../types/model.js";

export class QueryIndex {
  private symbols = new Map<string, SymbolRecord>();
  private byName = new Map<string, SymbolRecord[]>();
  private byQualifiedName = new Map<string, SymbolRecord[]>();
  private byCanonicalIdentity = new Map<string, SymbolRecord[]>();
  private bySignature = new Map<string, SymbolRecord[]>();
  private callsByCaller = new Map<string, CallEdge[]>();
  private callsByTarget = new Map<string, CallEdge[]>();
  private childrenByParent = new Map<string, SymbolRecord[]>();
  private moduleScopeByFile = new Map<string, SymbolRecord>();
  private methodCountByName = new Map<string, number>();

  rebuild(symbols: SymbolRecord[], calls: CallEdge[]) {
    this.symbols = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    this.byName = new Map();
    this.byQualifiedName = new Map();
    this.byCanonicalIdentity = new Map();
    this.bySignature = new Map();
    this.childrenByParent = new Map();
    this.moduleScopeByFile = new Map();
    this.methodCountByName = new Map();
    const add = (
      map: Map<string, SymbolRecord[]>,
      key: string | undefined,
      symbol: SymbolRecord,
    ) => {
      if (!key) return;
      const matches = map.get(key);
      if (matches) matches.push(symbol);
      else map.set(key, [symbol]);
    };
    for (const symbol of symbols) {
      add(this.byName, symbol.name, symbol);
      add(this.byQualifiedName, symbol.qualifiedName, symbol);
      add(this.byCanonicalIdentity, symbol.canonicalIdentity, symbol);
      add(this.bySignature, symbol.signature, symbol);
      if (symbol.parentId) {
        const children = this.childrenByParent.get(symbol.parentId);
        if (children) children.push(symbol);
        else this.childrenByParent.set(symbol.parentId, [symbol]);
      }
      if (symbol.kind === "namespace" && symbol.metadata?.moduleScope === true)
        this.moduleScopeByFile.set(symbol.filePath, symbol);
      if (symbol.kind === "method")
        this.methodCountByName.set(
          symbol.name,
          (this.methodCountByName.get(symbol.name) ?? 0) + 1,
        );
    }
    this.callsByCaller = new Map();
    this.callsByTarget = new Map();
    for (const call of calls) {
      const callers = this.callsByCaller.get(call.callerId);
      if (callers) callers.push(call);
      else this.callsByCaller.set(call.callerId, [call]);
      const targetIds =
        call.runtimeTargetIds ??
        (call.resolvedTargetId ? [call.resolvedTargetId] : []);
      for (const id of targetIds) {
        const targets = this.callsByTarget.get(id);
        if (targets) targets.push(call);
        else this.callsByTarget.set(id, [call]);
      }
    }
  }

  symbolById(id: string) {
    return this.symbols.get(id);
  }

  childrenOf(parentId: string) {
    return this.childrenByParent.get(parentId) ?? [];
  }

  moduleScopeSymbol(filePath: string) {
    return this.moduleScopeByFile.get(filePath);
  }

  callsFor(caller: SymbolRecord) {
    return this.callsByCaller.get(caller.id) ?? [];
  }

  callers(target: SymbolRecord) {
    return (this.callsByTarget.get(target.id) ?? [])
      .map((call) => this.symbols.get(call.callerId))
      .filter((symbol): symbol is SymbolRecord => Boolean(symbol));
  }

  dependencies(target: SymbolRecord) {
    return (this.callsByCaller.get(target.id) ?? [])
      .flatMap(
        (call) =>
          call.runtimeTargetIds ??
          (call.resolvedTargetId ? [call.resolvedTargetId] : []),
      )
      .map((id) => this.symbols.get(id))
      .filter((symbol): symbol is SymbolRecord => Boolean(symbol));
  }

  methodCount(name: string) {
    return this.methodCountByName.get(name) ?? 0;
  }

  resolveSymbol(input: string) {
    const preferImplementation = (matches: SymbolRecord[]) => {
      const implementations = matches.filter(
        (symbol) => !symbol.metadata?.overloadSignature,
      );
      return implementations.length ? implementations : matches;
    };
    const exact = [
      this.symbols.get(input),
      ...(this.byCanonicalIdentity.get(input) ?? []),
      ...(this.byQualifiedName.get(input) ?? []),
      ...(this.bySignature.get(input) ?? []),
    ].filter(
      (symbol, index, matches): symbol is SymbolRecord =>
        Boolean(symbol) && matches.indexOf(symbol) === index,
    );
    if (exact.length) return preferImplementation(exact);
    const qualifiedSuffix = [...this.symbols.values()].filter((symbol) =>
      symbol.qualifiedName?.endsWith(`.${input}`),
    );
    return preferImplementation(
      qualifiedSuffix.length ? qualifiedSuffix : (this.byName.get(input) ?? []),
    );
  }
}
