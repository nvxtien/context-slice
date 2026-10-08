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
function callSpan(source: string, open: number): { text: string; end: number } {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0)
      return { text: source.slice(open + 1, i), end: i };
  }
  return { text: "", end: open };
}
/** Counts top-level arguments, ignoring commas nested inside (), [] or {}. */
function countArguments(argumentsText: string): number {
  if (!argumentsText.trim()) return 0;
  let depth = 0;
  let count = 1;
  for (const ch of argumentsText) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}
function composePoint(
  anchor: { line: number; column: number },
  local: { line: number; column: number },
) {
  return local.line === 1
    ? { line: anchor.line, column: anchor.column + local.column }
    : { line: anchor.line + local.line - 1, column: local.column };
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
        ? interfaces.text
            .replace(/^implements\s+/, "")
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

/**
 * The nodes to scan for direct method/constructor members of a type's body. For class/interface/record
 * bodies these are the body node's own namedChildren. For an enum, the grammar nests them one level
 * deeper: `enum_body`'s real members (methods, constructors, fields declared after the constant list)
 * live inside a child `enum_body_declarations` node, not as direct children of `enum_body` itself
 * (an enum with no such members after its constants has no `enum_body_declarations` child at all).
 */
function memberNodesOf(bodyNode: Node): Node[] {
  if (bodyNode.type === "enum_body") {
    const decls = bodyNode.namedChildren.find(
      (c) => c.type === "enum_body_declarations",
    );
    return decls ? decls.namedChildren : [];
  }
  return bodyNode.namedChildren;
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
      walkTypes(
        child,
        parent,
        chain,
        filePath,
        source,
        packageName,
        symbols,
        types,
      );
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
      for (const member of memberNodesOf(bodyNode)) {
        if (member.type === "method_declaration") {
          symbols.push(
            methodSymbol(
              member,
              symbol,
              typeChain,
              filePath,
              source,
              packageName,
            ),
          );
        } else if (member.type === "constructor_declaration") {
          symbols.push(
            constructorSymbol(
              member,
              symbol,
              typeChain,
              filePath,
              source,
              packageName,
            ),
          );
        } else if (
          member.type === "field_declaration" ||
          member.type === "constant_declaration"
        ) {
          symbols.push(
            ...fieldSymbols(
              member,
              symbol,
              typeChain,
              filePath,
              source,
              packageName,
            ),
          );
        }
      }
      walkTypes(
        bodyNode,
        symbol,
        typeChain,
        filePath,
        source,
        packageName,
        symbols,
        types,
      );
    }
  }
}

/** `formal_parameters` node text includes its own parens; parameterSignature() expects the bare inner text (matching the old regex's capture group, which never included the parens). */
function parametersText(parametersNode: Node): string {
  const text = parametersNode.text;
  return text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1) : text;
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
    body: bodyNode
      ? source.slice(bodyNode.startIndex, bodyNode.endIndex)
      : undefined,
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

/**
 * A field_declaration (class/enum/record) or constant_declaration (interface — a
 * different node type with an identical internal shape) can carry multiple
 * variable_declarator children (`private int a, b;`), so this returns one SymbolRecord
 * per declarator, all sharing the same declared type/annotations/modifiers. A field has
 * no top-level `type` property on SymbolRecord (only methods put a type-like thing in
 * `.signature`); the declared type goes in `metadata.declaredType`, the same convention
 * the TypeScript and Python adapters already use.
 */
function fieldSymbols(
  node: Node,
  parent: SymbolRecord,
  typeChain: string[],
  filePath: string,
  source: string,
  packageName: string,
): SymbolRecord[] {
  const declaredType = node.childForFieldName("type")!.text;
  const modifiersNode = node.namedChildren.find((c) => c.type === "modifiers");
  const { annotations, modifiers } = modifiersNodeParts(modifiersNode);
  const declarators = node.namedChildren.filter(
    (c) => c.type === "variable_declarator",
  );
  const single = declarators.length === 1;
  return declarators.map((declarator) => {
    const name = declarator.childForFieldName("name")!.text;
    const start = single ? node.startIndex : declarator.startIndex;
    const end = single ? node.endIndex : declarator.endIndex;
    const canonicalIdentity = canonicalId(
      filePath,
      packageName,
      typeChain,
      "field",
      name,
    );
    return {
      id: canonicalIdentity,
      language: "java",
      kind: "field",
      name,
      packageName,
      qualifiedName: `${packageName ? `${packageName}.` : ""}${[...typeChain, name].join(".")}`,
      canonicalIdentity,
      signature: `${name}: ${declaredType}`,
      filePath,
      range: sourceRange(source, start, end),
      bodyRange: undefined,
      parentId: parent.id,
      annotations,
      modifiers,
      metadata: { declaredType },
      source: source.slice(start, end),
      body: undefined,
    };
  });
}

function byRange(a: SymbolRecord, b: SymbolRecord): number {
  return (
    a.range.startLine - b.range.startLine ||
    a.range.startColumn - b.range.startColumn
  );
}

/**
 * Mutates each symbol's `id`, appending `#N` for the Nth+ symbol sharing a `canonicalIdentity`
 * within this file. The old regex parser built `symbols` in a fixed global order — all types
 * (via the type walk), then ALL methods across the whole file in document order (one regex pass),
 * then ALL constructors across the whole file in document order (another pass) — and dedup
 * suffixes were assigned by iterating that order. The new AST walk instead pushes each type's
 * own methods/constructors immediately after the type itself (per-type nested order), which can
 * differ from the old flat order when the file has multiple types. To keep dedup suffixes
 * byte-identical to the old parser regardless of that ordering change, this recomputes the
 * old global order (types, then methods sorted by position, then constructors sorted by
 * position) purely for suffix assignment; the returned `symbols` array itself keeps its
 * (unrelated) per-type nested order. Fields (a new symbol kind with no old-parser precedent to match) are included in this same ordering, inserted after types and before methods — the exact position has no behavioral significance since there is no legacy ordering to preserve for fields, but must stay consistent.
 */
function assignDedupIds(symbols: SymbolRecord[], types: SymbolRecord[]): void {
  const fields = symbols.filter((s) => s.kind === "field").sort(byRange);
  const methods = symbols.filter((s) => s.kind === "method").sort(byRange);
  const constructors = symbols
    .filter((s) => s.kind === "constructor")
    .sort(byRange);
  const dedupOrder = [...types, ...fields, ...methods, ...constructors];
  const identityCounts = new Map<string, number>();
  for (const symbol of dedupOrder) {
    const count =
      identityCounts.get(symbol.canonicalIdentity ?? symbol.id) ?? 0;
    if (count > 0) symbol.id = `${symbol.canonicalIdentity}#${count + 1}`;
    identityCounts.set(symbol.canonicalIdentity ?? symbol.id, count + 1);
  }
}

export function parseJava(filePath: string, source: string) {
  const parser = new Parser();
  parser.setLanguage(Java as any);
  let parseError = false;
  let tree: Parser.Tree | undefined;
  try {
    // The node binding rejects inputs of 32KB or more, so always feed it in small chunks,
    // matching every other adapter in this project (rust, typescript, python, go).
    tree = parser.parse((index: number) => source.slice(index, index + 4_096));
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
    walkTypes(
      tree.rootNode,
      undefined,
      [],
      filePath,
      source,
      packageName,
      symbols,
      types,
    );
  assignDedupIds(symbols, types);
  const calls: CallEdge[] = [];
  const callable = symbols.filter(
    (s) => s.kind === "method" || s.kind === "constructor",
  );
  for (const caller of callable) {
    const body = caller.body ?? "";
    for (const match of body.matchAll(/(?:(\w+)\.)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      const calleeName = match[2];
      const offset = match.index ?? 0;
      const prefix = body.slice(Math.max(0, offset - 8), offset);
      if (
        [
          "if",
          "for",
          "while",
          "switch",
          "catch",
          "return",
          "try",
          "synchronized",
          "assert",
        ].includes(calleeName)
      )
        continue;
      const openIndex = offset + match[0].lastIndexOf("(");
      const { text: argumentsText, end: closeIndex } = callSpan(
        body,
        openIndex,
      );
      const range =
        caller.bodyRange &&
        (() => {
          const anchor = {
            line: caller.bodyRange!.startLine,
            column: caller.bodyRange!.startColumn,
          };
          const start = composePoint(anchor, point(body, offset));
          const end = composePoint(anchor, point(body, closeIndex + 1));
          return {
            startLine: start.line,
            startColumn: start.column,
            endLine: end.line,
            endColumn: end.column,
          };
        })();
      calls.push({
        callerId: caller.id,
        receiverText: match[1],
        calleeName,
        argumentCount: countArguments(argumentsText),
        filePath,
        range: range ?? caller.range,
        confidence: "unresolved",
        resolutionKind: prefix.includes("new") ? "constructor" : "unresolved",
        evidence: prefix.includes("new") ? ["syntactic new expression"] : [],
      });
    }
  }
  return { symbols, calls, parseError };
}
