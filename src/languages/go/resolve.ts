import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallEdge, ImportRecord, SymbolRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";

const CALLABLE_KINDS = new Set(["function", "method"]);

/** Go's package boundary is per-directory, never by matching package-clause name strings. */
function directoryOf(filePath: string): string {
  const dir = dirname(filePath);
  return dir === "." ? "" : dir;
}

/** This project's own go.mod module path, or undefined if none/unreadable — a missing go.mod
 * means every import is treated as external, the correct safe fallback, not a special case. */
function goModulePath(root: string): string | undefined {
  try {
    const text = readFileSync(join(root, "go.mod"), "utf8");
    return text.match(/^module\s+(\S+)/m)?.[1];
  } catch {
    return undefined;
  }
}

/** A method's own receiver variable name, e.g. "u" in "func (u *User) Name(...)" — read directly
 * off the symbol's own .source text rather than re-deriving it from parse.ts, since Phase 1
 * already formats every method's signature/source starting with its receiver clause. */
function receiverVarNameOf(method: SymbolRecord): string | undefined {
  return method.source.match(/^func\s*\(\s*(\w+)\s+/)?.[1];
}

/** Narrow, regex-based binding-type inference over a function body — mirrors
 * src/languages/python/resolve.ts's bindingClass exactly: single unambiguous assignment only,
 * any reassignment or multiple bindings drop the evidence rather than guessing. */
function bindingTypeInBody(body: string, receiver: string): string | undefined {
  const literalOrVar = new RegExp(
    `(?<![\\w.])${receiver}\\s*:?=\\s*(?:&)?([A-Za-z_]\\w*)\\s*\\{|var\\s+${receiver}\\s+\\*?([A-Za-z_]\\w*)\\b`,
    "g",
  );
  const matches = [...body.matchAll(literalOrVar)];
  const reassignments = [...body.matchAll(new RegExp(`(?<![\\w.:])${receiver}\\s*=[^=]`, "g"))].length;
  if (matches.length === 1 && reassignments === 0) {
    const [, literalType, varType] = matches[0];
    if (literalType) return literalType;
    if (varType) return varType;
  }
  if (matches.length === 0 && reassignments === 0) {
    const ctor = body.match(new RegExp(`(?<![\\w.])${receiver}\\s*:=\\s*New([A-Za-z_]\\w*)\\s*\\(`));
    if (ctor) return ctor[1];
  }
  return undefined;
}

function settle(
  call: CallEdge,
  target: SymbolRecord,
  kind: CallEdge["resolutionKind"],
  evidence: string,
) {
  call.resolvedTargetId = target.id;
  call.resolutionKind = kind;
  call.confidence = "exact";
  call.evidence = [...call.evidence, evidence];
}

export function resolveGoCalls(context: ResolveContext): void {
  const symbolsById = new Map(context.symbols.map((s) => [s.id, s]));
  const byDirectory = new Map<string, SymbolRecord[]>();
  for (const symbol of context.symbols) {
    const dir = directoryOf(symbol.filePath);
    const list = byDirectory.get(dir) ?? [];
    list.push(symbol);
    byDirectory.set(dir, list);
  }
  const modulePath = goModulePath(context.root);

  const importsByFile = new Map<string, ImportRecord[]>();
  for (const record of context.imports) {
    const list = importsByFile.get(record.filePath) ?? [];
    list.push(record);
    importsByFile.set(record.filePath, list);
  }

  const resolveDirectCall = (call: CallEdge, caller: SymbolRecord) => {
    const candidates = (byDirectory.get(directoryOf(caller.filePath)) ?? []).filter(
      (s) => CALLABLE_KINDS.has(s.kind) && s.name === call.calleeName,
    );
    if (candidates.length === 1) settle(call, candidates[0], "same-file", "same-package direct call");
  };

  const importLocalName = (record: ImportRecord): string | undefined =>
    record.localName ?? record.module.split("/").pop();

  const resolveQualifiedCall = (call: CallEdge, caller: SymbolRecord): boolean => {
    if (!call.receiverText || !/^[A-Z]/.test(call.calleeName)) return false; // unexported: never a package-qualified target
    const record = (importsByFile.get(caller.filePath) ?? []).find(
      (r) => importLocalName(r) === call.receiverText,
    );
    if (!record) return false;
    if (!modulePath || !(record.module === modulePath || record.module.startsWith(modulePath + "/"))) {
      call.externalPackage = record.module;
      return false;
    }
    const relative = record.module.slice(modulePath.length).replace(/^\//, "");
    const candidates = (byDirectory.get(relative) ?? []).filter(
      (s) => CALLABLE_KINDS.has(s.kind) && s.name === call.calleeName && s.modifiers.includes("exported"),
    );
    if (candidates.length === 1) {
      settle(call, candidates[0], "imported", "package-qualified import call");
      return true;
    }
    return false;
  };

  const resolveMethodCall = (call: CallEdge, caller: SymbolRecord) => {
    if (!call.receiverText) return;
    let typeName: string | undefined;
    if (caller.kind === "method" && caller.supertypes?.[0] && receiverVarNameOf(caller) === call.receiverText) {
      typeName = caller.supertypes[0];
    } else {
      typeName = bindingTypeInBody(caller.body ?? caller.source, call.receiverText);
    }
    if (!typeName) return;
    const method = (byDirectory.get(directoryOf(caller.filePath)) ?? []).find(
      (s) => s.kind === "method" && s.name === call.calleeName && s.supertypes?.includes(typeName!),
    );
    if (method) settle(call, method, "same-type", "receiver-type method call");
  };

  for (const call of context.calls) {
    const caller = symbolsById.get(call.callerId);
    if (!caller) continue;
    if (!call.receiverText) {
      resolveDirectCall(call, caller);
      continue;
    }
    if (resolveQualifiedCall(call, caller)) continue;
    resolveMethodCall(call, caller);
  }
}
