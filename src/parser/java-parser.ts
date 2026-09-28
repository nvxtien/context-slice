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
    if (bodyNode) {
      for (const member of bodyNode.namedChildren) {
        if (member.type === "method_declaration") {
          symbols.push(
            methodSymbol(member, symbol, typeChain, filePath, source, packageName),
          );
        } else if (member.type === "constructor_declaration") {
          symbols.push(
            constructorSymbol(member, symbol, typeChain, filePath, source, packageName),
          );
        }
      }
      walkTypes(bodyNode, symbol, typeChain, filePath, source, packageName, symbols, types);
    }
  }
}

/** `formal_parameters` node text includes its own parens; parameterSignature() expects the bare inner text (matching the old regex's capture group, which never included the parens). */
function parametersText(parametersNode: Node): string {
  const text = parametersNode.text;
  return text.startsWith("(") && text.endsWith(")")
    ? text.slice(1, -1)
    : text;
}

function methodSymbol(
  node: Node,
  parent: SymbolRecord,
  typeChain: string[],
  filePath: string,
  source: string,
  packageName: string,
): SymbolRecord {
  const name = node.childForFieldName("name")!.text;
  const type = node.childForFieldName("type")!.text;
  const parametersNode = node.childForFieldName("parameters")!;
  const bodyNode = node.childForFieldName("body");
  const modifiersNode = node.namedChildren.find((c) => c.type === "modifiers");
  const { annotations, modifiers } = modifiersNodeParts(modifiersNode);
  const parameters = parameterSignature(parametersText(parametersNode));
  const signature = `${name}(${parameters}): ${type}`;
  const canonicalIdentity = canonicalId(
    filePath,
    packageName,
    typeChain,
    "method",
    name,
    parameters,
  );
  return {
    id: canonicalIdentity,
    language: "java",
    kind: "method",
    name,
    packageName,
    qualifiedName: `${packageName ? `${packageName}.` : ""}${[...typeChain, name].join(".")}`,
    canonicalIdentity,
    signature,
    filePath,
    range: sourceRange(source, node.startIndex, node.endIndex),
    bodyRange: bodyNode
      ? sourceRange(source, bodyNode.startIndex, bodyNode.endIndex)
      : undefined,
    parentId: parent.id,
    annotations,
    modifiers,
    source: source.slice(node.startIndex, node.endIndex),
    body: bodyNode ? source.slice(bodyNode.startIndex, bodyNode.endIndex) : undefined,
  };
}

function constructorSymbol(
  node: Node,
  parent: SymbolRecord,
  typeChain: string[],
  filePath: string,
  source: string,
  packageName: string,
): SymbolRecord {
  const name = node.childForFieldName("name")!.text;
  const parametersNode = node.childForFieldName("parameters")!;
  const bodyNode = node.childForFieldName("body")!;
  const modifiersNode = node.namedChildren.find((c) => c.type === "modifiers");
  const { annotations, modifiers } = modifiersNodeParts(modifiersNode);
  const parameters = parameterSignature(parametersText(parametersNode));
  const signature = `${name}(${parameters}): ${name}`;
  const canonicalIdentity = canonicalId(
    filePath,
    packageName,
    typeChain,
    "constructor",
    name,
    parameters,
  );
  return {
    id: canonicalIdentity,
    language: "java",
    kind: "constructor",
    name,
    packageName,
    qualifiedName: `${packageName ? `${packageName}.` : ""}${[...typeChain, name].join(".")}`,
    canonicalIdentity,
    signature,
    filePath,
    range: sourceRange(source, node.startIndex, node.endIndex),
    bodyRange: sourceRange(source, bodyNode.startIndex, bodyNode.endIndex),
    parentId: parent.id,
    annotations,
    modifiers,
    source: source.slice(node.startIndex, node.endIndex),
    body: source.slice(bodyNode.startIndex, bodyNode.endIndex),
  };
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
