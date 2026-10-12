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

type Node = Parser.SyntaxNode;

export const LANGUAGE_ID = "c";

let parser: Parser | undefined;
function cParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(C as any);
  }
  return parser;
}

const range = (node: Node) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});
const text = (node: Node | null | undefined) => node?.text ?? "";
const field = (node: Node, name: string) =>
  node.childForFieldName(name) ?? undefined;
const namedAll = (node: Node, type: string) =>
  node.namedChildren.filter((c) => c.type === type);

function canonicalId(
  filePath: string,
  kind: SymbolKind,
  name: string,
  parameters?: string,
) {
  return [filePath, kind, name, parameters].filter(Boolean).join("::");
}

/** C has no classes/namespaces, so unlike the cpp/csharp/kotlin adapters there is nothing to
 * recurse through here — a declarator's name is always already a plain node. Kept as a named
 * function (rather than inlined `.text`) so every call site reads the same as those adapters. */
function simpleName(node: Node | undefined): string {
  return node?.text ?? "";
}

/** "static"/"extern"/"register" get a named storage_class_specifier node; "inline" is a bare
 * anonymous keyword token. C has no access specifiers, no virtual/friend/constexpr. */
const KEYWORD_MODIFIERS = new Set(["inline"]);
function modifiersOf(node: Node): string[] {
  const mods: string[] = [];
  for (const c of node.children) {
    if (c.type === "storage_class_specifier") mods.push(c.text);
    else if (!c.isNamed && KEYWORD_MODIFIERS.has(c.text)) mods.push(c.text);
  }
  return mods;
}

/** Follows a declarator through pointer/array/init wrappers (`int* x`, `int x[]`, `int x = 1`)
 * down to either a function_declarator (this member is callable) or the terminal name-bearing
 * node (identifier/field_identifier). Unlike C++, there is no reference_declarator — C has no
 * references. */
function unwrapDeclarator(node: Node | undefined): Node | undefined {
  let current = node;
  while (current) {
    if (current.type === "function_declarator") return current;
    if (
      current.type === "pointer_declarator" ||
      current.type === "array_declarator" ||
      current.type === "init_declarator"
    ) {
      current = field(current, "declarator");
      continue;
    }
    return current;
  }
  return undefined;
}

function paramListText(params: Node | undefined): string {
  if (!params) return "()";
  const parts = namedAll(params, "parameter_declaration").map((p) => p.text);
  return `(${parts.join(", ")})`;
}

/** A call_expression's callee name and (when syntactically simple) receiver text: a bare call,
 * or a member access (`a.b()` / `a->b()` — most often a function-pointer struct field used as
 * a callback/vtable dispatch; the grammar unifies both operators under field_expression). C has
 * no namespaces or classes, so there is no qualified_identifier callee shape to handle. */
function buildCallEdge(
  callNode: Node,
  filePath: string,
  callerId: string,
): CallEdge | undefined {
  const callee = field(callNode, "function");
  const args = field(callNode, "arguments");
  const argumentCount = args ? args.namedChildren.length : 0;
  if (!callee) return undefined;

  let calleeName = "";
  let receiverText: string | undefined;
  if (callee.type === "identifier" || callee.type === "field_identifier") {
    calleeName = callee.text;
  } else if (callee.type === "field_expression") {
    calleeName = text(field(callee, "field"));
    receiverText = field(callee, "argument")?.text;
  } else {
    return undefined;
  }
  if (!calleeName) return undefined;

  return {
    callerId,
    calleeName,
    receiverText,
    argumentCount,
    filePath,
    language: LANGUAGE_ID,
    range: range(callNode),
    confidence: "unresolved",
    resolutionKind: "unresolved",
    evidence: ["syntactic call"],
  };
}

function collectCalls(
  node: Node,
  ownerId: string,
  filePath: string,
  calls: CallEdge[],
) {
  for (const child of node.namedChildren) {
    if (child.type === "call_expression") {
      const edge = buildCallEdge(child, filePath, ownerId);
      if (edge) calls.push(edge);
    }
    collectCalls(child, ownerId, filePath, calls);
  }
}

function isTypeDeclaration(node: Node): boolean {
  return (
    node.type === "struct_specifier" ||
    node.type === "union_specifier" ||
    node.type === "enum_specifier"
  );
}

const DECLARATOR_NODE_TYPES = new Set([
  "identifier",
  "field_identifier",
  "pointer_declarator",
  "array_declarator",
  "function_declarator",
  "init_declarator",
]);

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
   * there is no call-target to point to (it's assigned at runtime, never statically known). */
  function emitFieldDeclaration(
    node: Node,
    ownerId: string,
    ownerQualifiedName: string,
  ) {
    const typeNode = field(node, "type");
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
    }
    // A bare top-level `declaration` (a function prototype or a global variable) produces no
    // symbol — a known accepted gap, matching the cpp adapter's own scope.
  }

  for (const { symbol, body } of callables) {
    if (body) collectCalls(body, symbol.id, filePath, calls);
  }

  return { symbols, calls, imports, exports, parseError };
}
