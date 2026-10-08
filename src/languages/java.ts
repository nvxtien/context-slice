import { parseJava } from "../parser/java-parser.js";
import type { SymbolRecord } from "../types/model.js";
import {
  registerLanguage,
  type LanguageAdapter,
  type ResolveContext,
} from "./adapter.js";

export const javaAdapter: LanguageAdapter = {
  id: "java",
  label: "Java",
  extensions: [".java"],
  ignoredDirectories: ["target", ".gradle"],
  parse(filePath, source) {
    const parsed = parseJava(filePath, source);
    return { ...parsed, imports: [], exports: [] };
  },
  resolveCalls({ symbols, calls, sourceOf }: ResolveContext) {
    const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const callableByName = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols) {
      if (symbol.kind !== "method" && symbol.kind !== "constructor") continue;
      const list = callableByName.get(symbol.name);
      if (list) list.push(symbol);
      else callableByName.set(symbol.name, [symbol]);
    }
    for (const call of calls) {
      const caller = byId.get(call.callerId);
      if (!caller) continue;
      const parent = caller.parentId ? byId.get(caller.parentId) : undefined;
      const candidates = callableByName.get(call.calleeName) ?? [];
      const sameType = candidates.filter(
        (candidate) => candidate.parentId === caller.parentId,
      );
      const source = sourceOf(caller);
      const declaredTypeMatch = call.receiverText
        ? source.match(
            new RegExp(
              `(?:\\b([A-Za-z_$][\\w$]*)\\s+${call.receiverText}\\b|\\b([A-Za-z_$][\\w$]*)\\s+${call.receiverText}\\s*[=;])`,
            ),
          )
        : undefined;
      const declaredType = call.receiverText
        ? (declaredTypeMatch?.[1] ??
          declaredTypeMatch?.[2] ??
          source.match(
            new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s+${call.receiverText}\\b`),
          )?.[1])
        : undefined;
      const receiverType =
        declaredType ??
        (call.receiverText && /^[A-Z]/.test(call.receiverText)
          ? call.receiverText
          : undefined);
      const typed = receiverType
        ? candidates.filter(
            (candidate) =>
              (candidate.parentId
                ? byId.get(candidate.parentId)
                : undefined)?.name === receiverType,
          )
        : [];
      const inherited =
        parent?.supertypes?.flatMap((supertype) =>
          candidates.filter(
            (candidate) =>
              (candidate.parentId
                ? byId.get(candidate.parentId)
                : undefined)?.name === supertype,
          ),
        ) ?? [];
      const narrowed = (items: SymbolRecord[]) =>
        call.argumentCount === undefined
          ? items
          : items.filter(
              (candidate) =>
                (candidate.signature?.match(/\(([^)]*)\)/)?.[1].trim()
                  ? candidate.signature.match(/\(([^)]*)\)/)![1].split(",")
                      .length
                  : 0) === call.argumentCount,
            );
      const options =
        call.resolutionKind === "constructor"
          ? narrowed(
              candidates.filter(
                (candidate) => candidate.kind === "constructor",
              ),
            )
          : receiverType
            ? narrowed(typed)
            : sameType.length
              ? narrowed(sameType)
              : narrowed(inherited);
      if (options.length === 1) {
        const target = options[0];
        call.declaredTargetId = target.id;
        call.resolvedTargetId = target.id;
        const targetParent = target.parentId
          ? byId.get(target.parentId)
          : undefined;
        call.confidence =
          receiverType && targetParent?.kind === "interface"
            ? "probable"
            : "exact";
        call.resolutionKind =
          call.resolutionKind === "constructor"
            ? "constructor"
            : inherited.includes(target)
              ? "inherited"
              : receiverType
                ? targetParent?.kind === "interface"
                  ? "interface"
                  : /^[A-Z]/.test(call.receiverText ?? "")
                    ? "static"
                    : "explicit-receiver"
                : "same-type";
        call.evidence = [
          `unique ${call.resolutionKind} target ${target.qualifiedName}`,
        ];
      } else if (options.length > 1) {
        call.confidence = "unresolved";
        call.resolutionKind = receiverType ? "interface" : "unresolved";
        call.evidence = [`${options.length} plausible targets remain`];
      }
    }
  },
};

registerLanguage(javaAdapter);
