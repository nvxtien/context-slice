import Parser from "tree-sitter";
import Java from "tree-sitter-java";
import type {
  CallEdge,
  SourceRange,
  SymbolKind,
  SymbolRecord,
} from "../types/model.js";

const annotationRe = /@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/g;
const typeRe =
  /((?:\s*@[A-Za-z_$][\w$]*(?:\([^\n]*\))?\s*)*)((?:(?:public|protected|private|static|final|abstract|default|sealed|non-sealed)\s+)*)\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g;
// A real handler can look like `public @ResponseBody Vets showResourcesVetList()`: an inline
// return-type annotation AFTER the access modifier, which the original two-fixed-groups shape
// (annotations, then modifiers, then the type) never allowed. Group 3 below accepts zero or more
// EXTRA annotations/modifiers in any order right before the return type, to cover that. It does
// NOT replace groups 1-2 (kept byte-identical to the original regex): group1's leading `\s*` per
// item is what lets a real annotation's match reach backward across a preceding blank line (so
// the annotation ends up part of the symbol's own source), while group2's modifiers have no such
// leading `\s*` and must be immediately adjacent — that asymmetry is exactly what stops a
// plain `public` method with NO annotation from also swallowing a preceding blank line into its
// source (tried merging into one group first; it broke tests/composition.test.ts's Java skeleton
// rendering by doing exactly that for annotation-free methods).
const METHOD_EXTRA_PREFIX_ITEM =
  "(?:@[A-Za-z_$][\\w$]*(?:\\([^\\n]*\\))?|public|protected|private|static|final|abstract|default|synchronized|native)";
const methodRe = new RegExp(
  "((?:\\s*@[A-Za-z_$][\\w$]*(?:\\([^\\n]*\\))?\\s*)*)" + // group1: leading annotations (unchanged)
    "((?:(?:public|protected|private|static|final|abstract|default|synchronized|native)\\s+)*)" + // group2: leading modifiers (unchanged)
    `((?:${METHOD_EXTRA_PREFIX_ITEM}\\s+)*)` + // group3: NEW — extra interleaved annotations/modifiers
    `(?:<[A-Za-z0-9_, ? extends super]+>\\s+)?([A-Za-z_$][\\w$<>?,.\\[\\]]*)\\s+([A-Za-z_$][\\w$]*)\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)\\s*(?:throws\\s+[A-Za-z_$][\\w$., ]*)?(?:\\{|;)`,
  "g",
);
const constructorRe =
  /((?:\s*@[A-Za-z_$][\w$]*(?:\([^\n]*\))?\s*)*)((?:(?:public|protected|private|static|final)\s+)*)\b([A-Z_$][\w$]*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*\{/g;

function point(source: string, offset: number) {
  const lines = source.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
}
function sourceRange(source: string, start: number, end: number): SourceRange {
  const a = point(source, start);
  const b = point(source, end);
  return {
    startLine: a.line,
    startColumn: a.column,
    endLine: b.line,
    endColumn: b.column,
  };
}
function closingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}
function annotationList(text: string): string[] {
  return [...text.matchAll(annotationRe)].map((m) => `@${m[1]}`);
}
const modifierKeywordRe =
  /\b(?:public|protected|private|static|final|abstract|default|synchronized|native)\b/g;
/**
 * Modifier keywords out of a combined annotations+modifiers prefix (see methodRe), in order.
 * Strips parenthesized annotation arguments first so a modifier-keyword substring inside an
 * annotation's own argument text (e.g. `@Description("static config")`) is never miscounted.
 */
function modifierList(text: string): string[] {
  return [...text.replace(/\([^)]*\)/g, "").matchAll(modifierKeywordRe)].map((m) => m[0]);
}
function canonicalId(
  filePath: string,
  packageName: string,
  typeChain: string[],
  kind: SymbolKind,
  name: string,
  parameters = "",
) {
  return `${filePath}::${packageName || "<default>"}::${typeChain.join(".") || "<file>"}::${kind}::${name}${parameters ? `(${parameters})` : ""}`;
}
function parameterSignature(parameters: string) {
  return parameters
    .replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/g, "")
    .replace(/\b(final|volatile|transient)\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function callArguments(source: string, open: number) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0)
      return source.slice(open + 1, i);
  }
  return "";
}

export function parseJava(filePath: string, source: string) {
  const parser = new Parser();
  parser.setLanguage(Java as any);
  let parseError = false;
  try {
    parser.parse(source);
  } catch {
    parseError = true;
  }
  const symbols: SymbolRecord[] = [];
  const types: SymbolRecord[] = [];
  const packageName =
    source.match(
      /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/,
    )?.[1] ?? "";
  for (const match of source.matchAll(typeRe)) {
    const start = match.index ?? 0;
    const name = match[4];
    const open = source.indexOf("{", start + match[0].length);
    const end =
      open >= 0 ? closingBrace(source, open) : start + match[0].length;
    const kind = match[3] as SymbolKind;
    const parent = types
      .filter(
        (item) =>
          item.range.startLine <= point(source, start).line &&
          item.range.endLine >= point(source, end).line &&
          item.range.startLine !== point(source, start).line,
      )
      .sort(
        (a, b) =>
          a.range.endLine -
          a.range.startLine -
          (b.range.endLine - b.range.startLine),
      )[0];
    const typeChain = [
      ...(parent?.qualifiedName
        ?.split(".")
        .slice(packageName ? packageName.split(".").length : 0) ?? []),
      name,
    ];
    const canonicalIdentity = canonicalId(
      filePath,
      packageName,
      typeChain,
      kind,
      name,
    );
    const declaration = source.slice(
      start,
      open >= 0 ? open : start + match[0].length,
    );
    const supertypes = [
      ...declaration.matchAll(
        /\b(?:extends|implements)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/g,
      ),
    ].flatMap((m) => m[1].split(/\s*,\s*/));
    const symbol: SymbolRecord = {
      id: canonicalIdentity,
      language: "java",
      kind,
      name,
      packageName,
      qualifiedName: `${packageName ? `${packageName}.` : ""}${typeChain.join(".")}`,
      canonicalIdentity,
      signature: `${kind} ${name}`,
      filePath,
      range: sourceRange(source, start, end),
      bodyRange: open >= 0 ? sourceRange(source, open, end) : undefined,
      parentId: parent?.id,
      supertypes,
      annotations: annotationList(match[1]),
      modifiers: match[2].trim().split(/\s+/).filter(Boolean),
      source: source.slice(start, end),
      body: open >= 0 ? source.slice(open, end) : undefined,
    };
    symbols.push(symbol);
    types.push(symbol);
  }
  for (const match of source.matchAll(methodRe)) {
    const start = match.index ?? 0;
    const name = match[5];
    if (
      match[4] === "new" ||
      [
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "else",
        "try",
        "finally",
        "return",
      ].includes(name)
    )
      continue;
    const open = start + match[0].lastIndexOf("{");
    const end =
      open >= start ? closingBrace(source, open) : start + match[0].length;
    const parent = types
      .filter(
        (item) =>
          item.range.startLine <= point(source, start).line &&
          item.range.endLine >= point(source, end).line,
      )
      .sort((a, b) => b.range.startLine - a.range.startLine)[0];
    const kind: SymbolKind = parent?.name === name ? "constructor" : "method";
    const parameters = parameterSignature(match[6]);
    const signature = `${name}(${parameters}): ${match[4]}`;
    const typeChain = parent?.qualifiedName
      ? parent.qualifiedName.replace(`${packageName}.`, "").split(".")
      : [];
    const canonicalIdentity = canonicalId(
      filePath,
      packageName,
      typeChain,
      kind,
      name,
      parameters,
    );
    symbols.push({
      id: canonicalIdentity,
      language: "java",
      kind,
      name,
      packageName,
      qualifiedName: `${packageName ? `${packageName}.` : ""}${[...typeChain, name].join(".")}`,
      canonicalIdentity,
      signature,
      filePath,
      range: sourceRange(source, start, end),
      bodyRange: open >= 0 ? sourceRange(source, open, end) : undefined,
      parentId: parent?.id,
      annotations: [...annotationList(match[1]), ...annotationList(match[3])],
      modifiers: [
        ...match[2].trim().split(/\s+/).filter(Boolean),
        ...modifierList(match[3]),
      ],
      source: source.slice(start, end),
      body: open >= 0 ? source.slice(open, end) : undefined,
    });
  }
  for (const match of source.matchAll(constructorRe)) {
    const start = match.index ?? 0;
    const name = match[3];
    const open = start + match[0].lastIndexOf("{");
    const end = closingBrace(source, open);
    const parent = types
      .filter(
        (item) =>
          item.name === name &&
          item.range.startLine <= point(source, start).line &&
          item.range.endLine >= point(source, end).line,
      )
      .sort((a, b) => b.range.startLine - a.range.startLine)[0];
    if (!parent) continue;
    const parameters = parameterSignature(match[4]);
    const signature = `${name}(${parameters}): ${name}`;
    const typeChain = parent.qualifiedName
      ? parent.qualifiedName.replace(`${packageName}.`, "").split(".")
      : [name];
    const canonicalIdentity = canonicalId(
      filePath,
      packageName,
      typeChain,
      "constructor",
      name,
      parameters,
    );
    symbols.push({
      id: canonicalIdentity,
      language: "java",
      kind: "constructor",
      name,
      packageName,
      qualifiedName: `${packageName ? `${packageName}.` : ""}${[...typeChain, name].join(".")}`,
      canonicalIdentity,
      signature,
      filePath,
      range: sourceRange(source, start, end),
      bodyRange: sourceRange(source, open, end),
      parentId: parent.id,
      annotations: annotationList(match[1]),
      modifiers: match[2].trim().split(/\s+/).filter(Boolean),
      source: source.slice(start, end),
      body: source.slice(open, end),
    });
  }
  const identityCounts = new Map<string, number>();
  for (const symbol of symbols) {
    const count =
      identityCounts.get(symbol.canonicalIdentity ?? symbol.id) ?? 0;
    if (count > 0) symbol.id = `${symbol.canonicalIdentity}#${count + 1}`;
    identityCounts.set(symbol.canonicalIdentity ?? symbol.id, count + 1);
  }
  const calls: CallEdge[] = [];
  const callable = symbols.filter(
    (s) => s.kind === "method" || s.kind === "constructor",
  );
  for (const caller of callable)
    for (const match of (caller.body ?? "").matchAll(
      /(?:(\w+)\.)?([A-Za-z_$][\w$]*)\s*\(/g,
    )) {
      const calleeName = match[2];
      const offset = match.index ?? 0;
      const prefix = (caller.body ?? "").slice(Math.max(0, offset - 8), offset);
      if (
        ["if", "for", "while", "switch", "catch", "return"].includes(calleeName)
      )
        continue;
      const argumentsText = callArguments(
        caller.body ?? "",
        offset + match[0].lastIndexOf("("),
      );
      const argumentCount = argumentsText.trim()
        ? argumentsText.split(",").length
        : 0;
      calls.push({
        callerId: caller.id,
        receiverText: match[1],
        calleeName,
        argumentCount,
        filePath,
        range: caller.range,
        confidence: "unresolved",
        resolutionKind: prefix.includes("new") ? "constructor" : "unresolved",
        evidence: prefix.includes("new") ? ["syntactic new expression"] : [],
      });
    }
  return { symbols, calls, parseError };
}
