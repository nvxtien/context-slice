import type { SymbolRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";

/** Mirrors java.ts's resolver: no cross-file import resolution (Kotlin's package system doesn't
 * map to directories the way Go's does), just same-type/inherited/global name matching, which
 * covers the common single-module case this project's other "heuristic" resolvers target. */
export function resolveKotlinCalls({
  symbols,
  calls,
  callsToResolve,
}: ResolveContext): void {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const byName = new Map<string, SymbolRecord[]>();
  const byOwnerAndName = new Map<string, SymbolRecord[]>();
  const add = (map: Map<string, SymbolRecord[]>, key: string, s: SymbolRecord) => {
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  };
  for (const symbol of symbols) {
    // Unlike Java (every callable is a method/constructor), Kotlin also has top-level
    // file-scope functions — parse.ts emits those as kind "function", and they must be
    // globally name-indexed too, just with no owner (they have no parentId).
    if (
      symbol.kind !== "method" &&
      symbol.kind !== "constructor" &&
      symbol.kind !== "function"
    )
      continue;
    add(byName, symbol.name, symbol);
    const owner = symbol.parentId ? byId.get(symbol.parentId) : undefined;
    if (owner) add(byOwnerAndName, `${owner.name}\0${symbol.name}`, symbol);
  }

  for (const call of callsToResolve ?? calls) {
    const caller = byId.get(call.callerId);
    if (!caller) continue;
    const parent = caller.parentId ? byId.get(caller.parentId) : undefined;
    const sameType = parent
      ? byOwnerAndName.get(`${parent.name}\0${call.calleeName}`) ?? []
      : [];
    const inherited =
      parent?.supertypes?.flatMap(
        (supertype) => byOwnerAndName.get(`${supertype}\0${call.calleeName}`) ?? [],
      ) ?? [];
    // receiverText capitalized (Kotlin's object/class naming convention) names a type directly,
    // e.g. "Singleton.foo()" or "Companion.foo()" — a lowercase receiver is a local variable
    // whose real type this resolver doesn't infer, a known accepted gap (mirrors java.ts's own
    // declaredType heuristic being best-effort, not exhaustive).
    const receiverType =
      call.receiverText && /^[A-Z]/.test(call.receiverText)
        ? call.receiverText
        : undefined;
    const typed = receiverType
      ? byOwnerAndName.get(`${receiverType}\0${call.calleeName}`) ?? []
      : [];
    const candidates = byName.get(call.calleeName) ?? [];

    const options = receiverType
      ? typed
      : sameType.length
        ? sameType
        : inherited.length
          ? inherited
          : candidates;

    if (options.length === 1) {
      const target = options[0];
      call.resolvedTargetId = target.id;
      call.confidence = receiverType ? "probable" : "exact";
      call.resolutionKind = receiverType
        ? "explicit-receiver"
        : inherited.includes(target)
          ? "inherited"
          : sameType.includes(target)
            ? "same-type"
            // Resolved through the global name fallback (no owner/receiver involved) — a
            // same-file or same-module direct call, e.g. a top-level function.
            : "same-file";
      call.evidence = [`unique ${call.resolutionKind} target ${target.qualifiedName}`];
    } else if (options.length > 1) {
      call.confidence = "unresolved";
      call.evidence = [`${options.length} plausible targets remain`];
    }
  }
}
