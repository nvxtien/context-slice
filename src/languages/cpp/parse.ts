import Parser from "tree-sitter";
import Cpp from "tree-sitter-cpp";
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

export const LANGUAGE_ID = "cpp";

let parser: Parser | undefined;
function cppParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Cpp as any);
  }
  return parser;
}

/** Splits an out-of-class definition's qualified name (`Class::Method`, or `Ns::Class::Method`)
 * into its immediate owner and member name. The grammar nests a 3+-segment path as
 * scope="first segment", name="the rest" (itself a qualified_identifier) — so for "A::B::C",
 * `field(top,"name")` is the qualified_identifier "B::C", not a plain "C" — the owner is
 * always the second-to-last segment, never `scope` once there is a middle segment. Outer
 * namespace segments (e.g. "Ns" in "Ns::Class::Method") are dropped: qualifiedName only ever
 * carries the owner chain, matching how every in-class member's qualifiedName already omits
 * the enclosing namespace (tracked separately as `packageName`). */
function splitQualifiedMethodName(
  node: Node,
): { owner: Node; name: Node } | undefined {
  let current = node;
  for (;;) {
    const scope = field(current, "scope");
    const name = field(current, "name");
    if (!scope || !name) return undefined;
    if (name.type !== "qualified_identifier") return { owner: scope, name };
    current = name;
  }
}

/** A base_class_clause entry's short type name, recursing through namespace qualification
 * (`std::enable_shared_from_this<D>`) and template specialization to the base identifier. No
 * distinction is made between a base class and an implemented interface — C++ has no separate
 * interface keyword, and the grammar doesn't mark one either way. */
function baseTypeName(node: Node): string | undefined {
  if (node.type === "type_identifier" || node.type === "identifier")
    return node.text;
  if (node.type === "qualified_identifier") {
    const name = field(node, "name");
    return name ? baseTypeName(name) : undefined;
  }
  if (node.type === "template_type") return text(field(node, "name"));
  return undefined;
}

/** `template<...> class/function ...` wraps the real declaration as an untagged sibling of
 * the type-parameter list. Type parameters are deliberately dropped, not modeled — the
 * wrapped declaration is parsed exactly as if it were not templated. */
function unwrapTemplate(node: Node): Node | undefined {
  if (node.type !== "template_declaration") return node;
  return node.namedChildren.find((c) => c.type !== "template_parameter_list");
}

export function parseCpp(filePath: string, source: string): ParsedFile {
  const symbols: SymbolRecord[] = [];
  const calls: CallEdge[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  let parseError = false;
  let tree: Parser.Tree;
  try {
    tree = cppParser().parse((index: number) =>
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

  function emitMethodPrototype(
    functionDeclarator: Node,
    ownerId: string,
    ownerQualifiedName: string,
    packageName: string | undefined,
    modifiers: string[],
  ) {
    const name = simpleName(field(functionDeclarator, "declarator"));
    if (!name) return;
    const parameters = paramListText(field(functionDeclarator, "parameters"));
    const qualifiedName = `${ownerQualifiedName}.${name}`;
    emitSymbol(
      functionDeclarator,
      ownerId,
      "method",
      name,
      qualifiedName,
      qualifiedName,
      parameters,
      `${name}${parameters}`,
      modifiers,
      { packageName },
    );
  }

  /** A field_declaration can hold a data field OR a method prototype (its declarator is a
   * function_declarator), and — like `int a, b;` — several comma-separated declarators. An
   * anonymous nested struct/union member (`union { int i; float f; };`, a common tagged-union
   * idiom) has no declarator at all; real C++ semantics fold its members into the enclosing
   * type directly, so they are walked in here rather than silently dropped. */
  function emitFieldDeclaration(
    node: Node,
    ownerId: string,
    ownerQualifiedName: string,
    ownerSimpleName: string,
    packageName: string | undefined,
    visibility: string,
  ) {
    const typeNode = field(node, "type");
    const hasDeclarator = node.namedChildren.some((c) =>
      DECLARATOR_NODE_TYPES.has(c.type),
    );
    if (!hasDeclarator && typeNode && isTypeDeclaration(typeNode)) {
      const anonBody = field(typeNode, "body");
      if (anonBody)
        walkTypeBody(
          anonBody,
          ownerId,
          ownerQualifiedName,
          ownerSimpleName,
          packageName,
          visibility,
        );
      return;
    }
    const baseModifiers = [...modifiersOf(node), visibility];
    for (const child of node.namedChildren) {
      if (!DECLARATOR_NODE_TYPES.has(child.type)) continue;
      const resolved = unwrapDeclarator(child);
      if (!resolved) continue;
      if (resolved.type === "function_declarator") {
        emitMethodPrototype(
          resolved,
          ownerId,
          ownerQualifiedName,
          packageName,
          baseModifiers,
        );
        continue;
      }
      const name = simpleName(resolved);
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
        baseModifiers,
        {
          metadata: typeNode ? { declaredType: typeNode.text } : undefined,
          packageName,
        },
      );
    }
  }

  /** A bare `declaration` inside a class body is always a constructor or destructor prototype
   * (every other member shape is a field_declaration): `Greeter(int start);` or `~Greeter();`. */
  function emitConstructorPrototype(
    node: Node,
    ownerId: string,
    ownerQualifiedName: string,
    ownerSimpleName: string,
    packageName: string | undefined,
    visibility: string,
  ) {
    const declarator = field(node, "declarator");
    if (!declarator || declarator.type !== "function_declarator") return;
    const nameNode = field(declarator, "declarator");
    const isDtor = nameNode?.type === "destructor_name";
    if (!isDtor && nameNode?.text !== ownerSimpleName) return;
    const parameters = paramListText(field(declarator, "parameters"));
    const qualifiedName = `${ownerQualifiedName}.${ownerSimpleName}`;
    const modifiers = [...modifiersOf(node), visibility];
    if (isDtor) modifiers.push("destructor");
    emitSymbol(
      node,
      ownerId,
      "constructor",
      ownerSimpleName,
      qualifiedName,
      qualifiedName,
      parameters,
      `${ownerSimpleName}${parameters}`,
      modifiers,
      { packageName },
    );
  }

  /** function_definition covers three shapes: a free function, a method/constructor/destructor
   * defined inline inside its class body, and a method defined out-of-class via `Class::Method`
   * — the dominant C++ idiom once a class is declared in a header. The out-of-class case gets
   * no `parentId`: its class symbol lives in a different file's parse, so there is nothing
   * here to point to. resolve.ts falls back to deriving the owner name from qualifiedName. */
  function emitFunctionDefinition(
    node: Node,
    ownerId: string | undefined,
    ownerQualifiedName: string | undefined,
    ownerSimpleName: string | undefined,
    packageName: string | undefined,
    visibility?: string,
  ) {
    const functionDeclarator = unwrapDeclarator(field(node, "declarator"));
    if (
      !functionDeclarator ||
      functionDeclarator.type !== "function_declarator"
    )
      return;
    const nameNode = field(functionDeclarator, "declarator");
    const parameters = paramListText(field(functionDeclarator, "parameters"));
    const body = field(node, "body");
    const modifiers = modifiersOf(node);

    if (nameNode?.type === "qualified_identifier") {
      const split = splitQualifiedMethodName(nameNode);
      if (!split) return;
      const scopeText = simpleName(split.owner);
      const methodName = simpleName(split.name);
      if (!scopeText || !methodName) return;
      const isDtor = split.name.type === "destructor_name";
      if (isDtor) modifiers.push("destructor");
      const kind: SymbolKind =
        isDtor || methodName === scopeText ? "constructor" : "method";
      const symbolName = kind === "constructor" ? scopeText : methodName;
      const qualifiedName = `${scopeText}.${symbolName}`;
      emitSymbol(
        node,
        undefined,
        kind,
        symbolName,
        qualifiedName,
        qualifiedName,
        parameters,
        `${methodName}${parameters}`,
        modifiers,
        { body, packageName },
      );
      return;
    }

    const isDtor = nameNode?.type === "destructor_name";
    const plainName = simpleName(nameNode);
    if (!plainName) return;

    if (
      ownerId &&
      ownerQualifiedName &&
      ownerSimpleName &&
      (isDtor || plainName === ownerSimpleName)
    ) {
      if (isDtor) modifiers.push("destructor");
      if (visibility) modifiers.push(visibility);
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
        modifiers,
        { body, packageName },
      );
      return;
    }

    if (ownerId && ownerQualifiedName) {
      if (visibility) modifiers.push(visibility);
      const qualifiedName = `${ownerQualifiedName}.${plainName}`;
      emitSymbol(
        node,
        ownerId,
        "method",
        plainName,
        qualifiedName,
        qualifiedName,
        parameters,
        `${plainName}${parameters}`,
        modifiers,
        { body, packageName },
      );
      return;
    }

    emitSymbol(
      node,
      undefined,
      "function",
      plainName,
      plainName,
      plainName,
      parameters,
      `${plainName}${parameters}`,
      modifiers,
      { body, packageName },
    );
  }

  /** Walks one class/struct body (or an enum's enumerator_list), tracking the running
   * public/private/protected visibility an access_specifier switches (not a per-member
   * modifier, unlike every other language this project supports), and recursing into nested
   * type declarations through the same entry point. */
  function walkTypeBody(
    bodyNode: Node,
    ownerId: string,
    ownerQualifiedName: string,
    ownerSimpleName: string,
    packageName: string | undefined,
    defaultVisibility: string,
  ) {
    let visibility = defaultVisibility;
    for (const child of bodyNode.namedChildren) {
      if (child.type === "access_specifier") {
        visibility = child.text;
        continue;
      }
      if (child.type === "enumerator") {
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
        continue;
      }
      const actual = unwrapTemplate(child);
      if (!actual) continue;
      if (actual.type === "field_declaration") {
        emitFieldDeclaration(
          actual,
          ownerId,
          ownerQualifiedName,
          ownerSimpleName,
          packageName,
          visibility,
        );
      } else if (actual.type === "declaration") {
        emitConstructorPrototype(
          actual,
          ownerId,
          ownerQualifiedName,
          ownerSimpleName,
          packageName,
          visibility,
        );
      } else if (actual.type === "function_definition") {
        emitFunctionDefinition(
          actual,
          ownerId,
          ownerQualifiedName,
          ownerSimpleName,
          packageName,
          visibility,
        );
      } else if (isTypeDeclaration(actual)) {
        emitTypeDeclaration(actual, ownerId, ownerQualifiedName, packageName);
      }
    }
  }

  function emitTypeDeclaration(
    node: Node,
    parentId: string | undefined,
    ownerQualifiedName: string | undefined,
    packageName: string | undefined,
  ) {
    const name = simpleName(field(node, "name"));
    if (!name) return;

    const kind: SymbolKind = node.type === "enum_specifier" ? "enum" : "class";
    const qualifiedName = ownerQualifiedName
      ? `${ownerQualifiedName}.${name}`
      : name;

    const baseClause = node.namedChildren.find(
      (c) => c.type === "base_class_clause",
    );
    const supertypes = baseClause
      ? baseClause.namedChildren
          .map(baseTypeName)
          .filter((t): t is string => Boolean(t))
      : [];

    const modifiers = modifiersOf(node);
    const isStruct = node.type === "struct_specifier";
    const isUnion = node.type === "union_specifier";
    if (isStruct) modifiers.push("struct");
    if (isUnion) modifiers.push("union");

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
      { supertypes, packageName },
    );

    const body = field(node, "body");
    if (body)
      walkTypeBody(
        body,
        symbol.id,
        qualifiedName,
        name,
        packageName,
        isStruct || isUnion || kind === "enum" ? "public" : "private",
      );
  }

  function walkNamespaceMembers(
    members: Node[],
    packageName: string | undefined,
  ) {
    for (const rawChild of members) {
      const child = unwrapTemplate(rawChild);
      if (!child) continue;
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
      } else if (child.type === "using_declaration") {
        const target = child.namedChildren[0];
        if (!target) continue;
        if (target.type === "qualified_identifier") {
          const scope = field(target, "scope")?.text;
          const name = simpleName(field(target, "name"));
          if (!scope || !name) continue;
          imports.push({
            filePath,
            language: LANGUAGE_ID,
            module: scope,
            importedName: name,
            localName: name,
            kind: "named",
            typeOnly: false,
            range: range(child),
          });
        } else {
          const module = text(target);
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
        }
      } else if (child.type === "namespace_definition") {
        const name = text(field(child, "name"));
        const nested = name
          ? packageName
            ? `${packageName}.${name}`
            : name
          : packageName;
        const body = field(child, "body");
        if (body) walkNamespaceMembers(body.namedChildren, nested);
      } else if (isTypeDeclaration(child)) {
        emitTypeDeclaration(child, undefined, undefined, packageName);
      } else if (child.type === "function_definition") {
        emitFunctionDefinition(
          child,
          undefined,
          undefined,
          undefined,
          packageName,
        );
      } else if (child.type === "declaration") {
        // `struct S { int x; } g;` is one `declaration` node, not a sibling struct/class
        // specifier — the type definition is embedded in its "type" field. The variable `g`
        // itself is still not modeled (a known accepted gap), but the struct/class/union/enum
        // it defines is real and would otherwise be silently lost entirely.
        const typeNode = field(child, "type");
        if (
          typeNode &&
          isTypeDeclaration(typeNode) &&
          field(typeNode, "body")
        ) {
          emitTypeDeclaration(typeNode, undefined, undefined, packageName);
        }
      }
    }
  }

  walkNamespaceMembers(tree.rootNode.namedChildren, undefined);

  for (const { symbol, body } of callables) {
    if (body) collectCalls(body, symbol.id, filePath, calls, LANGUAGE_ID);
  }

  return { symbols, calls, imports, exports, parseError };
}
