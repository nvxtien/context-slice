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
    if (!modulePath || !record.module.startsWith(modulePath)) {
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

  for (const call of context.calls) {
    const caller = symbolsById.get(call.callerId);
    if (!caller) continue;
    if (!call.receiverText) {
      resolveDirectCall(call, caller);
      continue;
    }
    resolveQualifiedCall(call, caller);
    // Strategy 3 (receiver-type method) is added in Task 3.
  }
}
