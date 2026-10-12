import type { SymbolRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";

/** A symbol's owning type name for same-type/inherited matching. Mirrors java.ts's/kotlin's/
 * csharp's resolver family for the common case (parentId resolves to a real owner symbol in
 * this same file). Extended for C++'s dominant idiom: a method defined out-of-class
 * (`void Greeter::Greet() {...}`, used once a class is declared in a header) has no parentId
 * — parse.ts never set one, since the owning class symbol lives in a different file's parse —
 * so its owner name is instead read back out of its own qualifiedName ("Greeter.Greet" ->
 * "Greeter"). Without this, every out-of-class method would resolve only through the weaker
 * global byName fallback, degrading the single most common C++ call-resolution case. */
function ownerNameOf(
  symbol: SymbolRecord,
  byId: Map<string, SymbolRecord>,
): string | undefined {
  if (symbol.parentId) return byId.get(symbol.parentId)?.name;
  if (symbol.kind !== "method" && symbol.kind !== "constructor")
    return undefined;
  const suffix = `.${symbol.name}`;
  return symbol.qualifiedName?.endsWith(suffix)
    ? symbol.qualifiedName.slice(0, -suffix.length)
    : undefined;
}

export function resolveCppCalls({
  symbols,
  calls,
  callsToResolve,
}: ResolveContext): void {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const byName = new Map<string, SymbolRecord[]>();
  const byOwnerAndName = new Map<string, SymbolRecord[]>();
  const add = (
    map: Map<string, SymbolRecord[]>,
    key: string,
    s: SymbolRecord,
  ) => {
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  };
  for (const symbol of symbols) {
    if (
      symbol.kind !== "method" &&
      symbol.kind !== "constructor" &&
      symbol.kind !== "function"
    )
      continue;
    add(byName, symbol.name, symbol);
    const ownerName = ownerNameOf(symbol, byId);
    if (ownerName) add(byOwnerAndName, `${ownerName}\0${symbol.name}`, symbol);
  }

  for (const call of callsToResolve ?? calls) {
    const caller = byId.get(call.callerId);
    if (!caller) continue;
    const callerOwnerName = ownerNameOf(caller, byId);
    const sameType = callerOwnerName
      ? (byOwnerAndName.get(`${callerOwnerName}\0${call.calleeName}`) ?? [])
      : [];
    // supertypes are only ever attached to a real class symbol declared in this file, so an
    // out-of-class method (no parentId) never has a `parent` here and therefore never
    // resolves "inherited" — a known gap from not cross-file-linking to the header's class.
    const parent = caller.parentId ? byId.get(caller.parentId) : undefined;
    const inherited =
      parent?.supertypes?.flatMap(
        (supertype) =>
          byOwnerAndName.get(`${supertype}\0${call.calleeName}`) ?? [],
      ) ?? [];
    // receiverText capitalized (C++'s type naming convention) names a type directly, e.g.
    // "Base::Foo()" or "Logger::Instance()" — a lowercase receiver ("this", a local variable)
    // falls through to sameType/inherited instead, a known accepted gap mirroring the rest of
    // this resolver family.
    const receiverType =
      call.receiverText && /^[A-Z]/.test(call.receiverText)
        ? call.receiverText
        : undefined;
    const typed = receiverType
      ? (byOwnerAndName.get(`${receiverType}\0${call.calleeName}`) ?? [])
      : [];
    const candidates = byName.get(call.calleeName) ?? [];

    const rawOptions = receiverType
      ? typed
      : sameType.length
        ? sameType
        : inherited.length
          ? inherited
          : candidates;
    // A C++ method almost always has both a header prototype (no body) and a .cpp definition
    // (a body) indexed as two separate symbols — there is no cross-file declaration/definition
    // merge. Left alone, every such call would see 2 options and go "unresolved". Since the
    // prototype is never where anyone wants to land, prefer the lone symbol with a body when
    // exactly one of several same-named options has one.
    const defined = rawOptions.filter((s) => Boolean(s.body));
    const options = defined.length === 1 ? defined : rawOptions;

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
            : "same-file";
      call.evidence = [
        `unique ${call.resolutionKind} target ${target.qualifiedName}`,
      ];
    } else if (options.length > 1) {
      call.confidence = "unresolved";
      call.evidence = [`${options.length} plausible targets remain`];
    }
  }
}
