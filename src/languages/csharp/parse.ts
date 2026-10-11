import Parser from "tree-sitter";
import CSharp from "tree-sitter-c-sharp";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  SymbolKind,
  SymbolRecord,
} from "../../types/model.js";
import type { ParsedFile } from "../adapter.js";

type Node = Parser.SyntaxNode;

export const LANGUAGE_ID = "csharp";

let parser: Parser | undefined;
function csharpParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(CSharp as any);
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
/** Unlike Kotlin's grammar, tree-sitter-c-sharp declares proper node fields (verified against
 * node-types.json), so field access works for both named and anonymous children — e.g. the
 * `this`/`base` receiver token in a member_access_expression's `expression` field. */
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

/** A declaration's own modifier keywords ("public", "static", "async", ...): each is a plain
 * named "modifier" sibling of the declaration, not wrapped in a container like Kotlin's. */
function modifiersOf(node: Node): string[] {
  return namedAll(node, "modifier").map((m) => m.text);
}

/** A base_list entry's short type name, stripped of namespace qualification and generic
 * arguments to match the short `name` symbols are indexed by (e.g. "Base", not "My.Ns.Base"
 * or "List<int>"). No distinction is made between a base class and an implemented interface —
 * the grammar doesn't mark one, same conservative choice as Kotlin's delegationTypeName. */
function baseTypeName(node: Node): string | undefined {
  if (node.type === "identifier") return node.text;
  if (node.type === "qualified_name") return field(node, "name")?.text;
  if (node.type === "generic_name") return node.namedChildren[0]?.text;
  return undefined;
}

function paramListText(params: Node | undefined): string {
  if (!params) return "()";
  const parts = namedAll(params, "parameter").map((p) => p.text);
  return `(${parts.join(", ")})`;
}

/** An invocation_expression's callee name and (when syntactically simple) receiver text,
 * covering a bare call, a generic call (`Foo<T>()`, generics dropped), a member access
 * (`a.b.c()` — the receiver is the full "a.b" text, matching Go/Java/Kotlin's choice to treat
 * a dotted receiver as one opaque unit), and a null-conditional call (`obj?.Method()`). */
function buildCallEdge(
  callNode: Node,
  filePath: string,
  callerId: string,
): CallEdge | undefined {
  const callee = field(callNode, "function");
  const args = field(callNode, "arguments");
  const argumentCount = args ? namedAll(args, "argument").length : 0;
  if (!callee) return undefined;

  let calleeName = "";
  let receiverText: string | undefined;
  if (callee.type === "identifier") {
    calleeName = callee.text;
  } else if (callee.type === "generic_name") {
    calleeName = text(callee.namedChildren[0]);
  } else if (callee.type === "member_access_expression") {
    calleeName = text(field(callee, "name"));
    receiverText = field(callee, "expression")?.text;
  } else if (callee.type === "conditional_access_expression") {
    const binding = callee.namedChildren.find(
      (c) => c.type === "member_binding_expression",
    );
    if (!binding) return undefined;
    calleeName = text(field(binding, "name"));
    receiverText = field(callee, "condition")?.text;
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
    if (child.type === "invocation_expression") {
      const edge = buildCallEdge(child, filePath, ownerId);
      if (edge) calls.push(edge);
    }
    collectCalls(child, ownerId, filePath, calls);
  }
}

export function parseCsharp(filePath: string, source: string): ParsedFile {
  const symbols: SymbolRecord[] = [];
  const calls: CallEdge[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  let parseError = false;
  let tree: Parser.Tree;
  try {
    tree = csharpParser().parse((index: number) =>
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

  /** Shared by every symbol kind this adapter emits. `body` (when given, even as null) queues
   * the symbol in `callables` so collectCalls walks it; a property with no body (a plain
   * auto-property) is never queued, since there is nothing to walk. */
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
      supertypes?: string[];
      packageName?: string;
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
      packageName: options.packageName,
      canonicalIdentity: id,
      signature,
      filePath,
      range: range(node),
      bodyRange: body ? range(body) : undefined,
      parentId: ownerId,
      supertypes: options.supertypes?.length ? options.supertypes : undefined,
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

  /** The members a primary constructor's parameter list implies (record/class/struct): each
   * parameter becomes a public "property"-kind symbol owned by the type, mirroring how a real
   * C# primary constructor auto-generates one property per parameter. */
  function emitPrimaryConstructorMembers(
    paramList: Node,
    ownerId: string,
    ownerQualifiedName: string,
    packageName: string | undefined,
  ) {
    for (const param of namedAll(paramList, "parameter")) {
      const paramName = text(field(param, "name"));
      if (!paramName) continue;
      const typeText = field(param, "type")?.text;
      emitSymbol(
        param,
        ownerId,
        "property",
        paramName,
        `${ownerQualifiedName}.${paramName}`,
        `${ownerQualifiedName}.${paramName}`,
        undefined,
        param.text,
        [],
        {
          metadata: typeText ? { declaredType: typeText } : undefined,
          packageName,
        },
      );
    }
  }

  /** A property's call-bearing body: an expression-bodied property's `=> expr` (field "value"),
   * or each get/set accessor's own body (block or `=> expr`) when the property has accessors.
   * A plain auto-property (`{ get; set; }`, no accessor body) has nothing to walk. */
  function propertyCallBodies(node: Node): Node[] {
    const accessors = field(node, "accessors");
    if (accessors) {
      return namedAll(accessors, "accessor_declaration")
        .map((a) => field(a, "body"))
        .filter((b): b is Node => Boolean(b));
    }
    const value = field(node, "value");
    return value?.type === "arrow_expression_clause" ? [value] : [];
  }

  function emitMethod(
    node: Node,
    ownerId: string,
    ownerQualifiedName: string,
    packageName: string | undefined,
  ) {
    const name = text(field(node, "name"));
    if (!name) return;
    const parameters = paramListText(field(node, "parameters"));
    const qualifiedName = `${ownerQualifiedName}.${name}`;
    const returnType = field(node, "returns")?.text;
    const body = field(node, "body");
    emitSymbol(
      node,
      ownerId,
      "method",
      name,
      qualifiedName,
      qualifiedName,
      parameters,
      `${returnType ? `${returnType} ` : ""}${name}${parameters}`,
      modifiersOf(node),
      {
        body,
        metadata: returnType ? { returnType } : undefined,
        packageName,
      },
    );
  }

  function emitConstructor(
    node: Node,
    ownerId: string,
    ownerQualifiedName: string,
    ownerSimpleName: string,
    packageName: string | undefined,
  ) {
    const parameters = paramListText(field(node, "parameters"));
    const qualifiedName = `${ownerQualifiedName}.${ownerSimpleName}`;
    emitSymbol(
      node,
      ownerId,
      "constructor",
      ownerSimpleName,
      qualifiedName,
      qualifiedName,
      parameters,
      `${ownerSimpleName}${parameters}`,
      modifiersOf(node),
      { body: field(node, "body"), packageName },
    );
  }

  function emitField(
    node: Node,
    ownerId: string,
    ownerQualifiedName: string,
    packageName: string | undefined,
  ) {
    const declaration = node.namedChildren.find(
      (c) => c.type === "variable_declaration",
    );
    if (!declaration) return;
    const typeText = field(declaration, "type")?.text;
    const modifiers = modifiersOf(node);
    for (const declarator of namedAll(declaration, "variable_declarator")) {
      const name = text(field(declarator, "name"));
      if (!name) continue;
      emitSymbol(
        declarator,
        ownerId,
        "field",
        name,
        `${ownerQualifiedName}.${name}`,
        `${ownerQualifiedName}.${name}`,
        undefined,
        declarator.text,
        modifiers,
        {
          metadata: typeText ? { declaredType: typeText } : undefined,
          packageName,
        },
      );
    }
  }

  function emitProperty(
    node: Node,
    ownerId: string,
    ownerQualifiedName: string,
    packageName: string | undefined,
  ) {
    const name = text(field(node, "name"));
    if (!name) return;
    const typeText = field(node, "type")?.text;
    const bodies = propertyCallBodies(node);
    const symbol = emitSymbol(
      node,
      ownerId,
      "property",
      name,
      `${ownerQualifiedName}.${name}`,
      `${ownerQualifiedName}.${name}`,
      undefined,
      node.text,
      modifiersOf(node),
      {
        metadata: typeText ? { declaredType: typeText } : undefined,
        packageName,
      },
    );
    // Not every property has one single body to attribute to `callables` (an accessor list can
    // hold two), so its call-bearing nodes are walked directly rather than through `callables`.
    for (const body of bodies) collectCalls(body, symbol.id, filePath, calls);
  }

  /** Walks one type's member list (class/struct/interface/record body, or an enum's member
   * list), emitting member symbols with `parentId: ownerId` and recursing into nested type
   * declarations through the same entry point so arbitrary nesting depth works. A nested type
   * and its members inherit `packageName` unchanged — only a namespace boundary changes it. */
  function walkTypeBody(
    bodyNode: Node,
    ownerId: string,
    ownerQualifiedName: string,
    ownerSimpleName: string,
    packageName: string | undefined,
  ) {
    for (const child of bodyNode.namedChildren) {
      if (child.type === "method_declaration") {
        emitMethod(child, ownerId, ownerQualifiedName, packageName);
      } else if (child.type === "constructor_declaration") {
        emitConstructor(
          child,
          ownerId,
          ownerQualifiedName,
          ownerSimpleName,
          packageName,
        );
      } else if (child.type === "field_declaration") {
        emitField(child, ownerId, ownerQualifiedName, packageName);
      } else if (child.type === "property_declaration") {
        emitProperty(child, ownerId, ownerQualifiedName, packageName);
      } else if (child.type === "enum_member_declaration") {
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
          { packageName },
        );
      } else if (isTypeDeclaration(child)) {
        emitTypeDeclaration(child, ownerId, ownerQualifiedName, packageName);
      }
    }
  }

  function isTypeDeclaration(node: Node): boolean {
    return (
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "struct_declaration" ||
      node.type === "record_declaration" ||
      node.type === "enum_declaration"
    );
  }

  function emitTypeDeclaration(
    node: Node,
    parentId: string | undefined,
    ownerQualifiedName: string | undefined,
    packageName: string | undefined,
  ) {
    const name = text(field(node, "name"));
    if (!name) return;

    const kind: SymbolKind =
      node.type === "interface_declaration"
        ? "interface"
        : node.type === "record_declaration"
          ? "record"
          : node.type === "enum_declaration"
            ? "enum"
            : "class";
    const qualifiedName = ownerQualifiedName
      ? `${ownerQualifiedName}.${name}`
      : name;

    const baseList = node.namedChildren.find((c) => c.type === "base_list");
    const supertypes = baseList
      ? baseList.namedChildren
          .map(baseTypeName)
          .filter((t): t is string => Boolean(t))
      : [];

    const modifiers = modifiersOf(node);
    if (node.type === "struct_declaration") modifiers.push("struct");

    const symbol = emitSymbol(
      node,
      parentId,
      kind,
      name,
      qualifiedName,
      qualifiedName,
      undefined,
      `${node.type.replace("_declaration", "")} ${name}`,
      modifiers,
      { supertypes, packageName },
    );

    const primaryCtorParams = node.namedChildren.find(
      (c) => c.type === "parameter_list",
    );
    if (primaryCtorParams)
      emitPrimaryConstructorMembers(
        primaryCtorParams,
        symbol.id,
        qualifiedName,
        packageName,
      );

    const body = field(node, "body");
    if (body) walkTypeBody(body, symbol.id, qualifiedName, name, packageName);
  }

  function walkNamespaceMembers(
    members: Node[],
    packageName: string | undefined,
  ) {
    for (const child of members) {
      if (child.type === "using_directive") {
        const alias = field(child, "name")?.text;
        const target = child.namedChildren.at(-1);
        const module = target ? text(target) : "";
        if (!module) continue;
        if (alias) {
          imports.push({
            filePath,
            language: LANGUAGE_ID,
            module,
            importedName: module.split(".").pop(),
            localName: alias,
            kind: "named",
            typeOnly: false,
            range: range(child),
          });
        } else {
          imports.push({
            filePath,
            language: LANGUAGE_ID,
            module,
            kind: "namespace",
            typeOnly: false,
            wildcard: true,
            range: range(child),
          });
        }
      } else if (child.type === "namespace_declaration") {
        const name = text(field(child, "name"));
        const nested = packageName ? `${packageName}.${name}` : name;
        const body = field(child, "body");
        if (body) walkNamespaceMembers(body.namedChildren, nested);
      } else if (isTypeDeclaration(child)) {
        emitTypeDeclaration(child, undefined, undefined, packageName);
      }
    }
  }

  let fileScopedPackage: string | undefined;
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === "file_scoped_namespace_declaration") {
      fileScopedPackage = text(field(child, "name"));
    }
  }
  walkNamespaceMembers(tree.rootNode.namedChildren, fileScopedPackage);

  for (const { symbol, body } of callables) {
    if (body) collectCalls(body, symbol.id, filePath, calls);
  }

  return { symbols, calls, imports, exports, parseError };
}
