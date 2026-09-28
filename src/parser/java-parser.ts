import Parser from "tree-sitter";
import Java from "tree-sitter-java";
import type {
  CallEdge,
  SourceRange,
  SymbolKind,
  SymbolRecord,
} from "../types/model.js";

type Node = Parser.SyntaxNode;

// Java grammar node type -> SymbolKind, matching the old regex parser's exact kind values.
const TYPE_DECL_NODE_TYPES: Record<string, SymbolKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
};

const annotationRe = /@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/g;
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

/** Annotation names + modifier keywords out of a `modifiers` node, in source order (bare annotation names only, no arguments). */
function modifiersNodeParts(modifiersNode: Node | undefined): {
  annotations: string[];
  modifiers: string[];
} {
  const annotations: string[] = [];
  const modifiers: string[] = [];
  for (const child of modifiersNode?.children ?? []) {
    if (child.type === "marker_annotation" || child.type === "annotation") {
      annotations.push(`@${child.childForFieldName("name")!.text}`);
    } else if (!child.isNamed) {
      modifiers.push(child.type);
    }
  }
  return { annotations, modifiers };
}

/** Strip generic type arguments (e.g. `JpaRepository<User, Long>` -> `JpaRepository`), matching the old regex parser's bare-identifier-only behavior. */
function stripGenericArgs(name: string): string {
  const idx = name.indexOf("<");
  return (idx === -1 ? name : name.slice(0, idx)).trim();
}

/** class/interface supertypes: class uses `superclass`/`interfaces` fields, interface uses a direct `extends_interfaces` child (no matching field). */
function supertypesOf(node: Node): string[] {
  if (node.type === "class_declaration") {
    const superclass = node.childForFieldName("superclass");
    const interfaces = node.childForFieldName("interfaces");
    return [
      ...(superclass
        ? [stripGenericArgs(superclass.text.replace(/^extends\s+/, ""))]
        : []),
      ...(interfaces
        ? interfaces
            .text.replace(/^implements\s+/, "")
            .split(/\s*,\s*/)
            .map(stripGenericArgs)
        : []),
    ];
  }
  if (node.type === "interface_declaration") {
    const extendsNode = node.children.find(
      (c) => c.type === "extends_interfaces",
    );
    const typeList = extendsNode?.namedChildren.find(
      (c) => c.type === "type_list",
    );
    return typeList?.namedChildren.map((t) => stripGenericArgs(t.text)) ?? [];
  }
  return [];
}

/** Recursive walk over top-level/nested type declarations (class/interface/enum/record), mirroring src/languages/rust/parse.ts's walk(node, parent, chain) shape. */
function walkTypes(
  node: Node,
  parent: SymbolRecord | undefined,
  chain: string[],
  filePath: string,
  source: string,
  packageName: string,
  symbols: SymbolRecord[],
  types: SymbolRecord[],
) {
  for (const child of node.namedChildren) {
    const kind = TYPE_DECL_NODE_TYPES[child.type];
    if (!kind) {
      walkTypes(child, parent, chain, filePath, source, packageName, symbols, types);
      continue;
    }
    const name = child.childForFieldName("name")!.text;
    const bodyNode = child.childForFieldName("body");
    const typeChain = [...chain, name];
    const canonicalIdentity = canonicalId(
      filePath,
      packageName,
      typeChain,
      kind,
      name,
    );
    const modifiersNode = child.namedChildren.find(
      (c) => c.type === "modifiers",
    );
    const { annotations, modifiers } = modifiersNodeParts(modifiersNode);
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
      range: sourceRange(source, child.startIndex, child.endIndex),
      bodyRange: bodyNode
        ? sourceRange(source, bodyNode.startIndex, bodyNode.endIndex)
        : undefined,
      parentId: parent?.id,
      supertypes: supertypesOf(child),
      annotations,
      modifiers,
      source: source.slice(child.startIndex, child.endIndex),
      body: bodyNode
        ? source.slice(bodyNode.startIndex, bodyNode.endIndex)
        : undefined,
    };
    symbols.push(symbol);
    types.push(symbol);
    if (bodyNode)
      walkTypes(bodyNode, symbol, typeChain, filePath, source, packageName, symbols, types);
  }
}

export function parseJava(filePath: string, source: string) {
  const parser = new Parser();
  parser.setLanguage(Java as any);
  let parseError = false;
  let tree: Parser.Tree | undefined;
  try {
    tree = parser.parse(source);
  } catch {
    parseError = true;
  }
  const symbols: SymbolRecord[] = [];
  const types: SymbolRecord[] = [];
  const packageDecl = tree?.rootNode.namedChildren.find(
    (c) => c.type === "package_declaration",
  );
  const packageName = packageDecl?.namedChildren[0]?.text ?? "";
  if (tree)
    walkTypes(tree.rootNode, undefined, [], filePath, source, packageName, symbols, types);
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
