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
    for (const call of calls) {
      const caller = symbols.find((symbol) => symbol.id === call.callerId);
      if (!caller) continue;
      const parent = symbols.find((symbol) => symbol.id === caller.parentId);
      const candidates = symbols.filter(
        (symbol) =>
          (symbol.kind === "method" || symbol.kind === "constructor") &&
          symbol.name === call.calleeName,
      );
      const sameType = candidates.filter(
        (candidate) => candidate.parentId === caller.parentId,
      );
      const source = sourceOf(caller);
      const declaredType = call.receiverText
        ? (source.match(
            new RegExp(
              `(?:\\b([A-Za-z_$][\\w$]*)\\s+${call.receiverText}\\b|\\b([A-Za-z_$][\\w$]*)\\s+${call.receiverText}\\s*[=;])`,
            ),
          )?.[1] ??
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
              symbols.find((symbol) => symbol.id === candidate.parentId)
                ?.name === receiverType,
          )
        : [];
      const inherited =
        parent?.supertypes?.flatMap((supertype) =>
          candidates.filter(
            (candidate) =>
              symbols.find((symbol) => symbol.id === candidate.parentId)
                ?.name === supertype,
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
        call.confidence =
          receiverType &&
          symbols.find((symbol) => symbol.id === target.parentId)?.kind ===
            "interface"
            ? "probable"
            : "exact";
        call.resolutionKind =
          call.resolutionKind === "constructor"
            ? "constructor"
            : inherited.includes(target)
              ? "inherited"
              : receiverType
                ? symbols.find((symbol) => symbol.id === target.parentId)
                    ?.kind === "interface"
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
