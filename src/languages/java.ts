import { parseJava } from "../parser/java-parser.js";
import type { SymbolRecord } from "../types/model.js";
import {
  registerLanguage,
  type LanguageAdapter,
  type ResolveContext,
} from "./adapter.js";

// Keywords that can be followed by `<identifier>` in Java source without declaring that
// identifier's type, so a bare "<word> <receiverText>" match must reject them to avoid
// e.g. "return StringUtil.foo()" being misread as a variable "StringUtil" of type "return".
const NON_TYPE_KEYWORDS = new Set([
  "return",
  "new",
  "throw",
  "yield",
  "case",
  "else",
  "instanceof",
  "assert",
  "synchronized",
  "catch",
  "do",
  "while",
  "if",
  "for",
  "switch",
  "try",
  "finally",
  "break",
  "continue",
]);
/** The declared type preceding `receiverText` in a `Type receiverText` style occurrence
 * anywhere in `source`, skipping any match whose preceding word is a keyword rather than
 * a real type name. */
function declaredTypeOf(
  source: string,
  receiverText: string,
): string | undefined {
  const pattern = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s+${receiverText}\\b`,
    "g",
  );
  for (const match of source.matchAll(pattern))
    if (!NON_TYPE_KEYWORDS.has(match[1])) return match[1];
  return undefined;
}

export const javaAdapter: LanguageAdapter = {
  id: "java",
  label: "Java",
  extensions: [".java"],
  ignoredDirectories: ["target", ".gradle"],
  parse(filePath, source) {
    const parsed = parseJava(filePath, source);
    return { ...parsed, imports: [], exports: [] };
  },
  resolveCalls({ symbols, calls, callsToResolve, sourceOf }: ResolveContext) {
    const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
    const callableByName = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols) {
      if (symbol.kind !== "method" && symbol.kind !== "constructor") continue;
      const list = callableByName.get(symbol.name);
      if (list) list.push(symbol);
      else callableByName.set(symbol.name, [symbol]);
    }
    for (const call of callsToResolve ?? calls) {
      const caller = byId.get(call.callerId);
      if (!caller) continue;
      const parent = caller.parentId ? byId.get(caller.parentId) : undefined;
      const candidates = callableByName.get(call.calleeName) ?? [];
      const sameType = candidates.filter(
        (candidate) => candidate.parentId === caller.parentId,
      );
      const source = sourceOf(caller);
      const declaredType = call.receiverText
        ? declaredTypeOf(source, call.receiverText)
        : undefined;
      const receiverType =
        declaredType ??
        (call.receiverText && /^[A-Z]/.test(call.receiverText)
          ? call.receiverText
          : undefined);
      const typed = receiverType
        ? candidates.filter(
            (candidate) =>
              (candidate.parentId ? byId.get(candidate.parentId) : undefined)
                ?.name === receiverType,
          )
        : [];
      const inherited =
        parent?.supertypes?.flatMap((supertype) =>
          candidates.filter(
            (candidate) =>
              (candidate.parentId ? byId.get(candidate.parentId) : undefined)
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
