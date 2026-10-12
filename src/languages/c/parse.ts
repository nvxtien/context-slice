import Parser from "tree-sitter";
import C from "tree-sitter-c";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  SymbolKind,
  SymbolRecord,
} from "../../types/model.js";
import type { ParsedFile } from "../adapter.js";
import {
  DECLARATOR_NODE_TYPES,
  canonicalId,
  collectCalls,
  field,
  isTypeDeclaration,
  modifiersOf,
  paramListText,
  range,
  simpleName,
  text,
  unwrapDeclarator,
  type Node,
} from "../c-family/syntax.js";

export const LANGUAGE_ID = "c";

let parser: Parser | undefined;
function cParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(C as any);
  }
  return parser;
}

export function parseC(filePath: string, source: string): ParsedFile {
  const symbols: SymbolRecord[] = [];
  const calls: CallEdge[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  let parseError = false;
  let tree: Parser.Tree;
  try {
    tree = cParser().parse((index: number) =>
      source.slice(index, index + 4_096),
    );
  } catch {
    return { symbols, calls, imports, exports, parseError: true };
  }
  if (tree.rootNode.hasError) parseError = true;

  const seenIds = new Set<string>();
  const uniqueId = (id: string) => {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      return id;
    }
    let n = 2;
    while (seenIds.has(`${id}#${n}`)) n++;
    const deduped = `${id}#${n}`;
    seenIds.add(deduped);
    return deduped;
  };

  const callables: { symbol: SymbolRecord; body: Node | null | undefined }[] =
    [];

  function emitSymbol(
    node: Node,
    ownerId: string | undefined,
    kind: SymbolKind,
    name: string,
    qualifiedName: string,
    idKey: string,
    parameters: string | undefined,
    signature: string,
    modifiers: string[],
    options: {
      body?: Node | null;
      metadata?: SymbolRecord["metadata"];
    } = {},
  ): SymbolRecord {
    const id = uniqueId(canonicalId(filePath, kind, idKey, parameters));
    const body = options.body;
    const symbol: SymbolRecord = {
      id,
      language: LANGUAGE_ID,
      kind,
      name,
      qualifiedName,
      canonicalIdentity: id,
      signature,
      filePath,
      range: range(node),
      bodyRange: body ? range(body) : undefined,
      parentId: ownerId,
      annotations: [],
      modifiers,
      metadata: options.metadata,
      source: node.text,
      body: body?.text,
    };
    symbols.push(symbol);
    if (body !== undefined) callables.push({ symbol, body });
    return symbol;
  }

  /** A field_declaration can hold several comma-separated declarators (`int a, b;`); a
   * function_declarator among them is a function-pointer field, modeled as a plain field since
   * there is no call-target to point to (it's assigned at runtime, never statically known). An
   * anonymous nested struct/union member (`union { int i; float f; };` with no name of its
   * own — a common tagged-union idiom) has no declarator at all; real C semantics fold its
   * members into the enclosing type directly, so they are walked in rather than dropped. */
  function emitFieldDeclaration(
    node: Node,
    ownerId: string,
    ownerQualifiedName: string,
  ) {
    const typeNode = field(node, "type");
    const hasDeclarator = node.namedChildren.some((c) =>
      DECLARATOR_NODE_TYPES.has(c.type),
    );
    if (!hasDeclarator && typeNode && isTypeDeclaration(typeNode)) {
      const anonBody = field(typeNode, "body");
      if (anonBody) walkTypeBody(anonBody, ownerId, ownerQualifiedName);
      return;
    }
    for (const child of node.namedChildren) {
      if (!DECLARATOR_NODE_TYPES.has(child.type)) continue;
      const resolved = unwrapDeclarator(child);
      if (!resolved) continue;
      const name =
        resolved.type === "function_declarator"
          ? simpleName(field(resolved, "declarator"))
          : simpleName(resolved);
      if (!name) continue;
      emitSymbol(
        child,
        ownerId,
        "field",
        name,
        `${ownerQualifiedName}.${name}`,
        `${ownerQualifiedName}.${name}`,
        undefined,
        child.text,
        [],
        { metadata: typeNode ? { declaredType: typeNode.text } : undefined },
      );
    }
  }

  /** Walks one struct/union body (field_declaration_list) or an enum's enumerator_list. */
  function walkTypeBody(
    bodyNode: Node,
    ownerId: string,
    ownerQualifiedName: string,
  ) {
    for (const child of bodyNode.namedChildren) {
      if (child.type === "field_declaration") {
        emitFieldDeclaration(child, ownerId, ownerQualifiedName);
      } else if (child.type === "enumerator") {
        const name = text(field(child, "name"));
        if (!name) continue;
        emitSymbol(
          child,
          ownerId,
          "field",
          name,
          `${ownerQualifiedName}.${name}`,
          `${ownerQualifiedName}.${name}`,
          undefined,
          child.text,
          [],
          {},
        );
      } else if (isTypeDeclaration(child)) {
        emitTypeDeclaration(child, ownerId, ownerQualifiedName, undefined);
      }
    }
  }

  /** `aliasName` overrides the struct/union/enum's own tag name — set when this declaration is
   * reached through a typedef (`typedef struct Point { ... } Point;` or the common tagless
   * form `typedef struct { ... } Point;`), since real C code almost always refers to the
   * typedef name, never `struct Point`. */
  function emitTypeDeclaration(
    node: Node,
    parentId: string | undefined,
    ownerQualifiedName: string | undefined,
    aliasName: string | undefined,
  ) {
    const name = aliasName ?? simpleName(field(node, "name"));
    if (!name) return;

    const kind: SymbolKind = node.type === "enum_specifier" ? "enum" : "class";
    const qualifiedName = ownerQualifiedName
      ? `${ownerQualifiedName}.${name}`
      : name;

    const modifiers: string[] = [];
    if (node.type === "union_specifier") modifiers.push("union");

    const symbol = emitSymbol(
      node,
      parentId,
      kind,
      name,
      qualifiedName,
      qualifiedName,
      undefined,
      `${node.type.replace("_specifier", "")} ${name}`,
      modifiers,
      {},
    );

    const body = field(node, "body");
    if (body) walkTypeBody(body, symbol.id, qualifiedName);
  }

  function emitFunctionDefinition(node: Node) {
    const functionDeclarator = unwrapDeclarator(field(node, "declarator"));
    if (
      !functionDeclarator ||
      functionDeclarator.type !== "function_declarator"
    )
      return;
    const name = simpleName(field(functionDeclarator, "declarator"));
    if (!name) return;
    const parameters = paramListText(field(functionDeclarator, "parameters"));
    const body = field(node, "body");
    const returnType = field(node, "type")?.text;
    emitSymbol(
      node,
      undefined,
      "function",
      name,
      name,
      name,
      parameters,
      `${returnType ? `${returnType} ` : ""}${name}${parameters}`,
      modifiersOf(node),
      { body, metadata: returnType ? { returnType } : undefined },
    );
  }

  for (const child of tree.rootNode.namedChildren) {
    if (child.type === "preproc_include") {
      const path = field(child, "path");
      if (!path) continue;
      // Both forms — <angle-bracket> and "quoted" — are one char in on each side.
      const module = path.text.slice(1, -1);
      if (!module) continue;
      imports.push({
        filePath,
        language: LANGUAGE_ID,
        module,
        kind: "namespace",
        typeOnly: false,
        wildcard: true,
        range: range(child),
      });
    } else if (child.type === "type_definition") {
      const typeNode = field(child, "type");
      const declarator = field(child, "declarator");
      if (
        typeNode &&
        isTypeDeclaration(typeNode) &&
        declarator?.type === "type_identifier"
      ) {
        emitTypeDeclaration(typeNode, undefined, undefined, declarator.text);
      }
      // A typedef of a primitive/pointer/function-pointer type (`typedef unsigned int uint;`,
      // `typedef void (*Callback)(int);`) produces no symbol — a known accepted gap.
    } else if (isTypeDeclaration(child)) {
      emitTypeDeclaration(child, undefined, undefined, undefined);
    } else if (child.type === "function_definition") {
      emitFunctionDefinition(child);
    } else if (child.type === "declaration") {
      // `struct S { int x; } g;` is one `declaration` node, not a sibling struct_specifier —
      // the type definition is embedded in its "type" field. The variable `g` itself is still
      // not modeled (a known accepted gap), but the struct/union/enum it defines is real and
      // would otherwise be silently lost entirely.
      const typeNode = field(child, "type");
      if (typeNode && isTypeDeclaration(typeNode) && field(typeNode, "body")) {
        emitTypeDeclaration(typeNode, undefined, undefined, undefined);
      }
    }
  }

  for (const { symbol, body } of callables) {
    if (body) collectCalls(body, symbol.id, filePath, calls, LANGUAGE_ID);
  }

  return { symbols, calls, imports, exports, parseError };
}
