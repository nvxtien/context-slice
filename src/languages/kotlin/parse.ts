import Parser from "tree-sitter";
import Kotlin from "tree-sitter-kotlin";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  SymbolKind,
  SymbolRecord,
} from "../../types/model.js";
import type { ParsedFile } from "../adapter.js";

type Node = Parser.SyntaxNode;

export const LANGUAGE_ID = "kotlin";

let parser: Parser | undefined;
function kotlinParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Kotlin as any);
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
const named = (node: Node, type: string) =>
  node.namedChildren.find((c) => c.type === type);
const namedAll = (node: Node, type: string) =>
  node.namedChildren.filter((c) => c.type === type);
/** tree-sitter-kotlin declares no node fields at all (verified against node-types.json),
 * so a literal keyword like "interface"/"class"/"enum" is only reachable as an anonymous
 * child token, never via childForFieldName. */
const hasKeyword = (node: Node, keyword: string) =>
  node.children.some((c) => !c.isNamed && c.text === keyword);

function canonicalId(
  filePath: string,
  kind: SymbolKind,
  name: string,
  parameters?: string,
) {
  return [filePath, kind, name, parameters].filter(Boolean).join("::");
}

/** Every "*_modifier" node's own text (e.g. "private", "override", "data", "suspend") —
 * each is a named wrapper around one anonymous keyword token, so its own .text already
 * is that keyword. */
function modifiersOf(node: Node): string[] {
  const modifiersNode = named(node, "modifiers");
  return modifiersNode ? modifiersNode.namedChildren.map((c) => c.text) : [];
}

/** A delegation_specifier's named base type, e.g. "Base" for "Base()" (constructor_invocation)
 * or "Greeter" for a plain interface name (user_type). */
function delegationTypeName(spec: Node): string | undefined {
  const typeIdentifier = spec.descendantsOfType("type_identifier")[0];
  return typeIdentifier?.text;
}

function paramListText(params: Node | undefined): string {
  if (!params) return "()";
  const parts = namedAll(params, "class_parameter")
    .concat(namedAll(params, "parameter"))
    .map((p) => p.text);
  return `(${parts.join(", ")})`;
}

/** A call_expression's callee name and (when syntactically simple) receiver text. For a chain
 * like "a.b.c()" the receiver is the full "a.b" text, matching how other adapters in this
 * project (Go, Java) treat a dotted receiver as one opaque unit rather than resolving each hop. */
function buildCallEdge(
  callNode: Node,
  filePath: string,
  callerId: string,
): CallEdge | undefined {
  const target = callNode.namedChildren[0];
  const callSuffix = named(callNode, "call_suffix");
  const valueArgs = callSuffix
    ? named(callSuffix, "value_arguments")
    : undefined;
  const argumentCount = valueArgs
    ? namedAll(valueArgs, "value_argument").length
    : 0;

  let calleeName = "";
  let receiverText: string | undefined;
  if (!target) return undefined;
  if (target.type === "simple_identifier") {
    calleeName = target.text;
  } else if (target.type === "navigation_expression") {
    const suffix = target.namedChildren.at(-1);
    if (suffix?.type !== "navigation_suffix") return undefined;
    calleeName = text(suffix.namedChildren.at(-1));
    const receiver = target.namedChildren[0];
    receiverText =
      receiver?.type === "this_expression" ? "this" : receiver?.text;
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

export function parseKotlin(filePath: string, source: string): ParsedFile {
  const symbols: SymbolRecord[] = [];
  const calls: CallEdge[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  let parseError = false;
  let tree: Parser.Tree;
  try {
    tree = kotlinParser().parse((index: number) =>
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
  let packageName: string | undefined;

  function propertyNameAndType(propertyNode: Node): {
    name?: string;
    typeText?: string;
  } {
    const decl = named(propertyNode, "variable_declaration");
    if (!decl) return {};
    const name = text(named(decl, "simple_identifier"));
    const typeNode =
      named(decl, "user_type") ??
      named(decl, "nullable_type") ??
      named(decl, "function_type");
    return { name, typeText: typeNode?.text };
  }

  /** Shared by secondary_constructor and anonymous_initializer: both are "constructor"-kind
   * symbols whose body must be queued in `callables` so collectCalls can see calls inside them. */
  function emitConstructor(
    node: Node,
    options: {
      ownerId: string;
      name: string;
      qualifiedName: string;
      parameters?: string;
      signature: string;
      modifiers: string[];
    },
  ) {
    const { ownerId, name, qualifiedName, parameters, signature, modifiers } =
      options;
    const body = named(node, "statements");
    const id = uniqueId(
      canonicalId(filePath, "constructor", qualifiedName, parameters),
    );
    const symbol: SymbolRecord = {
      id,
      language: LANGUAGE_ID,
      kind: "constructor",
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
      source: node.text,
      body: body?.text,
    };
    symbols.push(symbol);
    callables.push({ symbol, body });
  }

  /** Walks one class/interface/object/companion body, emitting member symbols with
   * `parentId: ownerId` and queuing nested declarations (e.g. a companion object, a
   * nested class) through the same entry point so arbitrary nesting depth works. */
  function walkClassBody(bodyNode: Node, ownerId: string, ownerName: string) {
    for (const child of bodyNode.namedChildren) {
      if (child.type === "function_declaration") {
        emitFunction(child, ownerId, ownerName);
      } else if (child.type === "secondary_constructor") {
        const parameters = paramListText(
          named(child, "function_value_parameters"),
        );
        // ownerName is the owner's full qualifiedName (e.g. "Outer.Inner"), not its simple
        // name, so the constructor's own name must be split back out of it.
        const simpleName = ownerName.split(".").pop()!;
        emitConstructor(child, {
          ownerId,
          name: simpleName,
          qualifiedName: `${ownerName}.${simpleName}`,
          parameters,
          signature: `constructor${parameters}`,
          modifiers: modifiersOf(child),
        });
      } else if (
        child.type === "property_declaration" ||
        child.type === "class_declaration" ||
        child.type === "object_declaration" ||
        child.type === "companion_object"
      ) {
        emitMember(child, ownerId, ownerName);
      } else if (child.type === "anonymous_initializer") {
        // An `init { ... }` block runs real code — same reasoning as Python's/TypeScript's
        // synthetic module-scope owner for top-level statements: without an owner symbol here,
        // every call inside it (a very common Kotlin pattern) would be silently invisible to
        // collectCalls, which only walks bodies already queued in `callables`.
        emitConstructor(child, {
          ownerId,
          name: "<init>",
          qualifiedName: `${ownerName}.<init>`,
          signature: "init",
          modifiers: [],
        });
      }
    }
  }

  function emitMember(node: Node, ownerId: string, ownerName: string) {
    if (node.type === "property_declaration") {
      const { name, typeText } = propertyNameAndType(node);
      if (!name) return;
      const id = uniqueId(
        canonicalId(filePath, "field", `${ownerName}.${name}`),
      );
      symbols.push({
        id,
        language: LANGUAGE_ID,
        kind: "field",
        name,
        qualifiedName: `${ownerName}.${name}`,
        canonicalIdentity: id,
        signature: node.text,
        filePath,
        range: range(node),
        parentId: ownerId,
        annotations: [],
        modifiers: modifiersOf(node),
        metadata: typeText ? { declaredType: typeText } : undefined,
        source: node.text,
      });
    } else {
      emitTypeDeclaration(node, ownerId, ownerName);
    }
  }

  function emitFunction(
    node: Node,
    ownerId: string | undefined,
    ownerName: string | undefined,
  ) {
    const name = text(named(node, "simple_identifier"));
    if (!name) return;
    const params = named(node, "function_value_parameters");
    const parameters = paramListText(params);
    const qualifiedName = ownerName ? `${ownerName}.${name}` : name;
    const kind: SymbolKind = ownerId ? "method" : "function";
    const id = uniqueId(canonicalId(filePath, kind, qualifiedName, parameters));
    const fnChildren = node.namedChildren;
    const paramsIndex = params ? fnChildren.indexOf(params) : -1;
    const returnTypeNode = fnChildren.find(
      (c, i) =>
        i > paramsIndex &&
        (c.type === "user_type" ||
          c.type === "nullable_type" ||
          c.type === "not_nullable_type" ||
          c.type === "parenthesized_type"),
    );
    const body = named(node, "function_body");
    const symbol: SymbolRecord = {
      id,
      language: LANGUAGE_ID,
      kind,
      name,
      qualifiedName,
      canonicalIdentity: id,
      signature: `fun ${name}${parameters}${returnTypeNode ? `: ${returnTypeNode.text}` : ""}`,
      filePath,
      range: range(node),
      bodyRange: body ? range(body) : undefined,
      parentId: ownerId,
      annotations: [],
      modifiers: modifiersOf(node),
      metadata: returnTypeNode
        ? { returnType: returnTypeNode.text }
        : undefined,
      source: node.text,
      body: body?.text,
    };
    symbols.push(symbol);
    callables.push({ symbol, body });
  }

  function emitTypeDeclaration(
    node: Node,
    parentId: string | undefined,
    ownerName?: string,
  ) {
    const isObject = node.type === "object_declaration";
    const isCompanion = node.type === "companion_object";
    const name = isCompanion
      ? text(named(node, "type_identifier")) || "Companion"
      : text(named(node, "type_identifier"));
    if (!name) return;

    const isInterface =
      !isObject && !isCompanion && hasKeyword(node, "interface");
    const kind: SymbolKind = isInterface ? "interface" : "class";
    const qualifiedName = ownerName ? `${ownerName}.${name}` : name;
    const id = uniqueId(canonicalId(filePath, kind, qualifiedName));

    const supertypes = namedAll(node, "delegation_specifier")
      .map(delegationTypeName)
      .filter((t): t is string => Boolean(t));

    const modifiers = modifiersOf(node);
    if (isObject) modifiers.push("object");
    if (isCompanion) modifiers.push("companion");
    if (hasKeyword(node, "enum")) modifiers.push("enum");

    const keywordLabel = isInterface
      ? "interface"
      : isObject
        ? "object"
        : "class";
    const symbol: SymbolRecord = {
      id,
      language: LANGUAGE_ID,
      kind,
      name,
      qualifiedName,
      packageName,
      canonicalIdentity: id,
      signature: `${keywordLabel} ${name}`,
      filePath,
      range: range(node),
      parentId,
      supertypes: supertypes.length ? supertypes : undefined,
      annotations: [],
      modifiers,
      source: node.text,
    };
    symbols.push(symbol);

    // Primary constructor parameters declared with val/var become fields; plain parameters
    // are constructor-only and have no symbol of their own (mirrors Go's struct-field model).
    const primaryCtor = named(node, "primary_constructor");
    if (primaryCtor) {
      for (const param of namedAll(primaryCtor, "class_parameter")) {
        const bindingKind = named(param, "binding_pattern_kind");
        if (!bindingKind) continue;
        const paramName = text(named(param, "simple_identifier"));
        if (!paramName) continue;
        const typeNode =
          named(param, "user_type") ?? named(param, "nullable_type");
        const fieldId = uniqueId(
          canonicalId(filePath, "field", `${qualifiedName}.${paramName}`),
        );
        symbols.push({
          id: fieldId,
          language: LANGUAGE_ID,
          kind: "field",
          name: paramName,
          qualifiedName: `${qualifiedName}.${paramName}`,
          canonicalIdentity: fieldId,
          signature: param.text,
          filePath,
          range: range(param),
          parentId: id,
          annotations: [],
          modifiers: modifiersOf(param),
          metadata: typeNode ? { declaredType: typeNode.text } : undefined,
          source: param.text,
        });
      }
    }

    const body = named(node, "class_body") ?? named(node, "enum_class_body");
    if (body) walkClassBody(body, id, qualifiedName);
  }

  for (const child of tree.rootNode.namedChildren) {
    if (child.type === "package_header") {
      packageName = text(named(child, "identifier"));
    } else if (child.type === "import_list") {
      for (const header of namedAll(child, "import_header")) {
        const identifier = named(header, "identifier");
        const module = text(identifier);
        if (!module) continue;
        const wildcard = Boolean(named(header, "wildcard_import"));
        const alias = named(header, "import_alias")?.namedChildren.at(-1)?.text;
        if (wildcard) {
          imports.push({
            filePath,
            language: LANGUAGE_ID,
            module,
            kind: "namespace",
            typeOnly: false,
            wildcard: true,
            range: range(header),
          });
        } else {
          const importedName = module.split(".").pop();
          imports.push({
            filePath,
            language: LANGUAGE_ID,
            module,
            importedName,
            localName: alias ?? importedName,
            kind: "named",
            typeOnly: false,
            range: range(header),
          });
        }
      }
    } else if (
      child.type === "class_declaration" ||
      child.type === "object_declaration"
    ) {
      emitTypeDeclaration(child, undefined);
    } else if (child.type === "function_declaration") {
      emitFunction(child, undefined, undefined);
    } else if (child.type === "property_declaration") {
      const { name, typeText } = propertyNameAndType(child);
      if (!name) continue;
      const id = uniqueId(canonicalId(filePath, "variable", name));
      symbols.push({
        id,
        language: LANGUAGE_ID,
        kind: "variable",
        name,
        qualifiedName: name,
        packageName,
        canonicalIdentity: id,
        signature: child.text,
        filePath,
        range: range(child),
        annotations: [],
        modifiers: modifiersOf(child),
        metadata: typeText ? { declaredType: typeText } : undefined,
        source: child.text,
      });
    }
  }

  if (packageName) {
    for (const symbol of symbols) symbol.packageName = packageName;
  }

  for (const { symbol, body } of callables) {
    if (body) collectCalls(body, symbol.id, filePath, calls);
  }

  return { symbols, calls, imports, exports, parseError };
}
