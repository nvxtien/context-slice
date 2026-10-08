import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  LanguageId,
  SourceRange,
  SymbolKind,
  SymbolMetadata,
  SymbolRecord,
} from "../../types/model.js";
import type { ParsedFile } from "../adapter.js";

type Node = Parser.SyntaxNode;

export const LANGUAGE_ID = "typescript";
export const JAVASCRIPT_LANGUAGE_ID = "javascript";
// tree-sitter-typescript's "typescript" grammar can't parse JSX (ambiguous with type
// assertions), so a .jsx/.js-with-jsx file needs the "tsx" grammar regardless of language id.
const jsxDialect = (filePath: string) =>
  [".tsx", ".jsx"].some((ext) => filePath.toLowerCase().endsWith(ext));
const isJavaScriptFile = (filePath: string) =>
  [".jsx", ".mjs", ".cjs", ".js"].some((ext) =>
    filePath.toLowerCase().endsWith(ext),
  );
export const isDeclarationFile = (filePath: string) =>
  filePath.toLowerCase().endsWith(".d.ts");

const parsers = new Map<string, Parser>();
function parserFor(filePath: string) {
  const dialect = jsxDialect(filePath) ? "tsx" : "typescript";
  let parser = parsers.get(dialect);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(
      (dialect === "tsx"
        ? (TypeScript as any).tsx
        : (TypeScript as any).typescript) as any,
    );
    parsers.set(dialect, parser);
  }
  return parser;
}

const range = (node: Node): SourceRange => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});
const field = (node: Node, name: string) => node.childForFieldName(name);
const text = (node: Node | null | undefined) => node?.text ?? "";
const isCallable = (node: Node | null | undefined) =>
  node?.type === "arrow_function" ||
  node?.type === "function_expression" ||
  node?.type === "function";

/** `src/order.ts::OrderService::method::create(OrderInput)` — stable across edits. */
function canonicalId(
  filePath: string,
  chain: string[],
  kind: SymbolKind,
  name: string,
  parameters?: string,
) {
  return [
    filePath,
    ...chain,
    kind,
    parameters === undefined ? name : `${name}(${parameters})`,
  ].join("::");
}

function parameterSignature(parameters: Node | null) {
  if (!parameters) return "";
  return parameters.namedChildren
    .map((parameter) => {
      const type = field(parameter, "type");
      const pattern = field(parameter, "pattern") ?? parameter.namedChild(0);
      const typeText = text(type).replace(/^:\s*/, "").trim();
      return typeText || text(pattern).trim();
    })
    .filter(Boolean)
    .join(", ");
}

function returnType(node: Node) {
  const declared = field(node, "return_type");
  return declared ? text(declared).replace(/^:\s*/, "").trim() : undefined;
}

const looksLikeComponent = (name: string, node: Node, filePath: string) =>
  jsxDialect(filePath) && /^[A-Z]/.test(name) && containsJsx(node);

function containsJsx(node: Node): boolean {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (
      current.type === "jsx_element" ||
      current.type === "jsx_self_closing_element" ||
      current.type === "jsx_fragment"
    )
      return true;
    stack.push(...current.namedChildren);
  }
  return false;
}

interface Scope {
  /** Local binding name -> declared or constructed type, for receiver typing. */
  types: Map<string, string>;
}

export function parseTypeScript(filePath: string, source: string): ParsedFile {
  const symbols: SymbolRecord[] = [];
  const calls: CallEdge[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  const languageId: LanguageId = isJavaScriptFile(filePath)
    ? JAVASCRIPT_LANGUAGE_ID
    : LANGUAGE_ID;
  const declarationOnly = isDeclarationFile(filePath);
  let parseError = false;
  let tree: Parser.Tree;
  try {
    // The node binding rejects inputs of 32KB or more, so always feed it in small chunks.
    tree = parserFor(filePath).parse((index: number) =>
      source.slice(index, index + 4_096),
    );
  } catch {
    return { symbols, calls, imports, exports, parseError: true };
  }
  if (tree.rootNode.hasError) parseError = true;

  const scopes: Scope[] = [{ types: new Map() }];
  const declaredTypeOf = (name: string) => {
    for (let at = scopes.length - 1; at >= 0; at--) {
      const found = scopes[at].types.get(name);
      if (found) return found;
    }
    return undefined;
  };
  const noteBinding = (name: string, type: string | undefined) => {
    if (name && type) scopes.at(-1)!.types.set(name, type);
  };

  let moduleSymbol: SymbolRecord | undefined;
  /** Top-level statements need an owner so their calls are not dropped. */
  const moduleOwner = () => {
    if (!moduleSymbol) {
      // Named after the file so it can never shadow a declared symbol.
      const name = filePath;
      moduleSymbol = {
        id: `${filePath}::module::${name}`,
        language: languageId,
        kind: "namespace",
        name,
        qualifiedName: name,
        canonicalIdentity: `${filePath}::module::${name}`,
        signature: `module ${name}`,
        filePath,
        range: range(tree.rootNode),
        annotations: [],
        modifiers: [],
        metadata: { moduleScope: true },
        source: "",
      };
      symbols.push(moduleSymbol);
    }
    return moduleSymbol;
  };

  const addSymbol = (
    node: Node,
    kind: SymbolKind,
    name: string,
    chain: string[],
    options: {
      parameters?: string;
      signature?: string;
      parentId?: string;
      supertypes?: string[];
      metadata?: SymbolMetadata;
      bodyNode?: Node | null;
    } = {},
  ) => {
    const id = canonicalId(filePath, chain, kind, name, options.parameters);
    const body = options.bodyNode ?? undefined;
    const symbol: SymbolRecord = {
      id,
      language: languageId,
      kind,
      name,
      qualifiedName: [...chain, name].join("."),
      canonicalIdentity: id,
      signature: options.signature ?? `${kind} ${name}`,
      filePath,
      range: range(node),
      bodyRange: body ? range(body) : undefined,
      parentId: options.parentId,
      supertypes: options.supertypes,
      annotations: [],
      modifiers: [],
      metadata: {
        ...options.metadata,
        ...(declarationOnly ? { declarationOnly: true } : {}),
      },
      source: node.text,
      body: body?.text,
    };
    symbols.push(symbol);
    return symbol;
  };

  // ---- imports -------------------------------------------------------------
  const importStatement = (node: Node) => {
    const module = text(field(node, "source")).replace(/^["'`]|["'`]$/g, "");
    const clause = node.namedChildren.find(
      (child) => child.type === "import_clause",
    );
    const typeOnly = node.text.startsWith("import type");
    const base = {
      filePath,
      language: languageId,
      module,
      typeOnly,
      range: range(node),
    };
    if (!clause) {
      imports.push({ ...base, kind: "side-effect" });
      return;
    }
    for (const child of clause.namedChildren) {
      if (child.type === "identifier")
        imports.push({
          ...base,
          kind: "default",
          importedName: "default",
          localName: child.text,
        });
      else if (child.type === "namespace_import")
        imports.push({
          ...base,
          kind: "namespace",
          localName: text(child.namedChild(0)),
        });
      else if (child.type === "named_imports")
        for (const specifier of child.namedChildren.filter(
          (item) => item.type === "import_specifier",
        )) {
          const name = text(field(specifier, "name"));
          const alias = text(field(specifier, "alias"));
          imports.push({
            ...base,
            kind: "named",
            importedName: name,
            localName: alias || name,
            typeOnly: typeOnly || specifier.text.startsWith("type "),
          });
        }
    }
  };

  // ---- exports -------------------------------------------------------------
  const declaredNames = (declaration: Node): string[] => {
    if (
      declaration.type === "lexical_declaration" ||
      declaration.type === "variable_declaration"
    )
      return declaration.namedChildren
        .filter((child) => child.type === "variable_declarator")
        .map((child) => text(field(child, "name")))
        .filter(Boolean);
    const name = text(field(declaration, "name"));
    return name ? [name] : [];
  };
  const exportStatement = (node: Node) => {
    const source = field(node, "source");
    const module = source
      ? text(source).replace(/^["'`]|["'`]$/g, "")
      : undefined;
    const typeOnly = node.text.startsWith("export type");
    const base = {
      filePath,
      language: languageId,
      typeOnly,
      range: range(node),
    };
    const declaration = field(node, "declaration");
    const isDefault = node.children.some((child) => child.type === "default");
    if (declaration) {
      if (isDefault) {
        const name = text(field(declaration, "name")) || "default";
        exports.push({
          ...base,
          exportedName: "default",
          localName: name || undefined,
        });
      } else
        for (const name of declaredNames(declaration))
          exports.push({ ...base, exportedName: name, localName: name });
      return;
    }
    if (isDefault) {
      // `export default handler;` or `export default () => {}`
      const value = node.namedChildren.find(
        (child) => child.type !== "export_clause",
      );
      exports.push({
        ...base,
        exportedName: "default",
        localName: value?.type === "identifier" ? value.text : undefined,
      });
      return;
    }
    const clause = node.namedChildren.find(
      (child) => child.type === "export_clause",
    );
    if (clause) {
      for (const specifier of clause.namedChildren.filter(
        (child) => child.type === "export_specifier",
      )) {
        const name = text(field(specifier, "name"));
        const alias = text(field(specifier, "alias"));
        exports.push({
          ...base,
          exportedName: alias || name,
          localName: module ? undefined : name,
          fromModule: module,
          sourceName: module ? name : undefined,
        });
      }
      return;
    }
    if (module) {
      const namespaceAlias = node.namedChildren.find(
        (child) => child.type === "namespace_export",
      );
      exports.push({
        ...base,
        exportedName: namespaceAlias ? text(namespaceAlias.namedChild(0)) : "*",
        fromModule: module,
        wildcard: !namespaceAlias,
      });
    }
  };

  // ---- calls ---------------------------------------------------------------
  const addCall = (node: Node, owner: SymbolRecord) => {
    const callee = field(node, "function");
    if (!callee) return;
    const argumentsNode = field(node, "arguments");
    const argumentCount = argumentsNode
      ? argumentsNode.namedChildren.length
      : 0;
    const shared = {
      callerId: owner.id,
      argumentCount,
      filePath,
      language: languageId,
      range: range(node),
      confidence: "unresolved" as const,
      evidence: [] as string[],
    };
    if (callee.type === "identifier") {
      calls.push({
        ...shared,
        calleeName: callee.text,
        resolutionKind: "unresolved",
      });
      return;
    }
    if (
      callee.type === "member_expression" ||
      callee.type === "subscript_expression"
    ) {
      const object = field(callee, "object");
      const property = field(callee, "property");
      if (!property || property.type !== "property_identifier") return;
      const thisProperty =
        object?.type === "member_expression" &&
        field(object, "object")?.type === "this" &&
        field(object, "property")?.type === "property_identifier"
          ? `this.${text(field(object, "property"))}`
          : undefined;
      const receiverText =
        object?.type === "identifier" || object?.type === "this"
          ? object.text
          : thisProperty;
      calls.push({
        ...shared,
        calleeName: property.text,
        receiverText,
        receiverType:
          receiverText && receiverText !== "this"
            ? declaredTypeOf(receiverText)
            : undefined,
        optionalChaining: callee.text.includes("?."),
        resolutionKind: "unresolved",
      });
    }
  };

  const addNew = (node: Node, owner: SymbolRecord) => {
    const constructor = field(node, "constructor");
    if (!constructor || constructor.type !== "identifier") return;
    const argumentsNode = field(node, "arguments");
    calls.push({
      callerId: owner.id,
      calleeName: constructor.text,
      argumentCount: argumentsNode ? argumentsNode.namedChildren.length : 0,
      filePath,
      language: languageId,
      range: range(node),
      confidence: "unresolved",
      resolutionKind: "constructor",
      evidence: ["syntactic new expression"],
    });
  };

  const addJsxReference = (node: Node, owner: SymbolRecord) => {
    const name = field(node, "name");
    if (!name || !/^[A-Z]/.test(name.text)) return;
    calls.push({
      callerId: owner.id,
      calleeName: name.text,
      filePath,
      language: languageId,
      range: range(node),
      confidence: "unresolved",
      resolutionKind: "jsx-reference",
      evidence: ["JSX element reference"],
    });
  };

  // ---- traversal -----------------------------------------------------------
  /** Walk a subtree, attributing calls to `owner` and declaring nested callables. */
  const walk = (
    node: Node,
    owner: SymbolRecord | undefined,
    chain: string[],
  ) => {
    for (const child of node.namedChildren) visit(child, owner, chain);
  };

  function bindingType(declarator: Node): string | undefined {
    const type = field(declarator, "type");
    if (type) {
      const name = text(type).replace(/^:\s*/, "").replace(/<.*$/s, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) return name;
    }
    const value = field(declarator, "value");
    if (value?.type === "new_expression") {
      const constructor = field(value, "constructor");
      if (constructor?.type === "identifier") return constructor.text;
    }
    if (value?.type === "await_expression") {
      const inner = value.namedChild(0);
      if (inner?.type === "new_expression") {
        const constructor = field(inner, "constructor");
        if (constructor?.type === "identifier") return constructor.text;
      }
    }
    return undefined;
  }

  /** `this.x = new T()` in any member body tells us the property's type. */
  function assignedPropertyTypes(body: Node | null) {
    const found = new Map<string, string>();
    if (!body) return found;
    const stack = [body];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "assignment_expression") {
        const left = field(node, "left");
        const right = field(node, "right");
        const value =
          right?.type === "await_expression" ? right.namedChild(0) : right;
        if (
          left?.type === "member_expression" &&
          field(left, "object")?.type === "this" &&
          value?.type === "new_expression"
        ) {
          const constructor = field(value, "constructor");
          if (constructor?.type === "identifier")
            found.set(text(field(left, "property")), constructor.text);
        }
      }
      stack.push(...node.namedChildren);
    }
    return found;
  }

  function classMembers(
    body: Node | null,
    chain: string[],
    parent: SymbolRecord,
  ) {
    if (!body) return;
    const assigned = assignedPropertyTypes(body);
    for (const member of body.namedChildren) {
      if (member.type === "method_definition") {
        const name = text(field(member, "name"));
        if (name === "constructor")
          for (const parameter of field(member, "parameters")?.namedChildren ??
            [])
            if (parameter.type === "required_parameter") {
              const accessibility = parameter.children.find((child) =>
                ["accessibility_modifier", "readonly"].includes(child.type),
              );
              const propertyName = text(
                field(parameter, "pattern") ?? parameter.namedChild(0),
              );
              const annotation = text(field(parameter, "type"))
                .replace(/^:\s*/, "")
                .replace(/<.*$/s, "")
                .trim();
              if (accessibility && propertyName)
                addSymbol(parameter, "property", propertyName, chain, {
                  parentId: parent.id,
                  signature: `${propertyName}: ${annotation}`,
                  metadata: /^[A-Za-z_$][\w$]*$/.test(annotation)
                    ? { declaredType: annotation }
                    : undefined,
                });
            }
        const parameters = parameterSignature(field(member, "parameters"));
        const kindToken = member.children.find((child) =>
          ["get", "set"].includes(child.type),
        )?.type;
        const kind: SymbolKind =
          name === "constructor"
            ? "constructor"
            : kindToken === "get"
              ? "getter"
              : kindToken === "set"
                ? "setter"
                : "method";
        const body = field(member, "body");
        const symbol = addSymbol(member, kind, name, chain, {
          parameters,
          signature: `${name}(${parameters})${returnType(member) ? `: ${returnType(member)}` : ""}`,
          parentId: parent.id,
          bodyNode: body,
          metadata: { async: member.text.startsWith("async ") },
        });
        scopes.push({ types: new Map() });
        for (const parameter of field(member, "parameters")?.namedChildren ??
          [])
          noteBinding(
            text(field(parameter, "pattern") ?? parameter.namedChild(0)),
            text(field(parameter, "type"))
              .replace(/^:\s*/, "")
              .replace(/<.*$/s, "")
              .trim() || undefined,
          );
        if (body) walk(body, symbol, [...chain, name]);
        scopes.pop();
        continue;
      }
      if (
        member.type === "public_field_definition" ||
        member.type === "property_signature"
      ) {
        const name = text(field(member, "name"));
        const value = field(member, "value");
        if (isCallable(value)) {
          const parameters = parameterSignature(field(value!, "parameters"));
          const symbol = addSymbol(member, "method", name, chain, {
            parameters,
            signature: `${name}(${parameters})`,
            parentId: parent.id,
            bodyNode: field(value!, "body"),
            metadata: { async: value!.text.startsWith("async ") },
          });
          scopes.push({ types: new Map() });
          const body = field(value!, "body");
          if (body) walk(body, symbol, [...chain, name]);
          scopes.pop();
        } else if (name) {
          const annotation = text(field(member, "type"))
            .replace(/^:\s*/, "")
            .replace(/<.*$/s, "")
            .trim();
          addSymbol(member, "property", name, chain, {
            parentId: parent.id,
            signature: `${name}${text(field(member, "type"))}`,
            metadata: /^[A-Za-z_$][\w$]*$/.test(annotation)
              ? { declaredType: annotation }
              : undefined,
          });
        }
        continue;
      }
      if (member.type === "method_signature") {
        const name = text(field(member, "name"));
        const parameters = parameterSignature(field(member, "parameters"));
        addSymbol(member, "method", name, chain, {
          parameters,
          signature: `${name}(${parameters})${returnType(member) ? `: ${returnType(member)}` : ""}`,
          parentId: parent.id,
        });
      }
    }
  }

  function applyAssignedTypes(
    parent: SymbolRecord,
    assigned: Map<string, string>,
  ) {
    for (const [name, type] of assigned) {
      const property = symbols.find(
        (candidate) =>
          candidate.parentId === parent.id &&
          candidate.kind === "property" &&
          candidate.name === name,
      );
      if (property && !property.metadata?.declaredType)
        property.metadata = { ...property.metadata, declaredType: type };
    }
  }

  function visit(
    node: Node,
    owner: SymbolRecord | undefined,
    chain: string[],
  ): void {
    switch (node.type) {
      case "import_statement":
        importStatement(node);
        return;
      case "export_statement": {
        exportStatement(node);
        const declaration = field(node, "declaration");
        if (declaration) visit(declaration, owner, chain);
        else
          for (const child of node.namedChildren)
            if (
              child.type !== "export_clause" &&
              child.type !== "string" &&
              child.type !== "namespace_export"
            )
              visit(child, owner, chain);
        return;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = text(field(node, "name"));
        const heritage = node.namedChildren.find(
          (child) => child.type === "class_heritage",
        );
        const supertypes = heritage
          ? heritage.namedChildren.flatMap((clause) =>
              clause.namedChildren.map((item) =>
                text(item).replace(/<.*$/s, "").trim(),
              ),
            )
          : [];
        const symbol = addSymbol(node, "class", name, chain, {
          signature: `class ${name}`,
          supertypes: supertypes.filter(Boolean),
          bodyNode: field(node, "body"),
        });
        classMembers(field(node, "body"), [...chain, name], symbol);
        applyAssignedTypes(symbol, assignedPropertyTypes(field(node, "body")));
        return;
      }
      case "interface_declaration": {
        const name = text(field(node, "name"));
        const symbol = addSymbol(node, "interface", name, chain, {
          signature: `interface ${name}`,
          bodyNode: field(node, "body"),
        });
        classMembers(field(node, "body"), [...chain, name], symbol);
        return;
      }
      case "type_alias_declaration":
        addSymbol(node, "type", text(field(node, "name")), chain, {
          signature: `type ${text(field(node, "name"))}`,
        });
        return;
      case "enum_declaration":
        addSymbol(node, "enum", text(field(node, "name")), chain, {
          signature: `enum ${text(field(node, "name"))}`,
          bodyNode: field(node, "body"),
        });
        return;
      case "internal_module":
      case "module": {
        const name = text(field(node, "name")).replace(/^["'`]|["'`]$/g, "");
        const symbol = addSymbol(node, "namespace", name, chain, {
          signature: `namespace ${name}`,
          bodyNode: field(node, "body"),
        });
        const body = field(node, "body");
        if (body) walk(body, symbol, [...chain, name]);
        return;
      }
      case "function_signature": {
        // Overload signature or ambient declaration: callable API, no body.
        const name = text(field(node, "name"));
        const parameters = parameterSignature(field(node, "parameters"));
        addSymbol(node, "function", name, chain, {
          parameters,
          signature: `${name}(${parameters})${returnType(node) ? `: ${returnType(node)}` : ""}`,
          metadata: { overloadSignature: !declarationOnly },
        });
        return;
      }
      case "function_declaration":
      case "generator_function_declaration": {
        const name = text(field(node, "name"));
        const parameters = parameterSignature(field(node, "parameters"));
        const body = field(node, "body");
        const symbol = addSymbol(node, "function", name, chain, {
          parameters,
          signature: `${name}(${parameters})${returnType(node) ? `: ${returnType(node)}` : ""}`,
          bodyNode: body,
          parentId: owner?.id,
          metadata: {
            async: node.text.startsWith("async "),
            reactComponent: looksLikeComponent(name, node, filePath),
          },
        });
        scopes.push({ types: new Map() });
        for (const parameter of field(node, "parameters")?.namedChildren ?? [])
          noteBinding(
            text(field(parameter, "pattern") ?? parameter.namedChild(0)),
            text(field(parameter, "type"))
              .replace(/^:\s*/, "")
              .replace(/<.*$/s, "")
              .trim() || undefined,
          );
        if (body) walk(body, symbol, [...chain, name]);
        scopes.pop();
        return;
      }
      case "assignment_expression": {
        // `obj.method = function(){}` / `Foo.prototype.method = () => {}` at module level:
        // mirrors the lexical_declaration callable case below, keyed off the property name
        // instead of a binding name. `module.exports`/`exports` targets are deliberately left
        // alone — that's CommonJS module semantics, a separate, untouched limitation.
        const left = field(node, "left");
        const right = field(node, "right");
        const objectText =
          left?.type === "member_expression"
            ? text(field(left, "object"))
            : undefined;
        const propertyName =
          left?.type === "member_expression"
            ? text(field(left, "property"))
            : undefined;
        if (
          chain.length === 0 &&
          owner === undefined &&
          objectText &&
          propertyName &&
          isCallable(right) &&
          !/^(module\.exports|exports)(\.|$)/.test(objectText)
        ) {
          const parameters = parameterSignature(field(right!, "parameters"));
          const body = field(right!, "body");
          const symbol = addSymbol(
            node,
            "function",
            propertyName,
            [...chain, objectText],
            {
              parameters,
              signature: `${propertyName}(${parameters})${returnType(right!) ? `: ${returnType(right!)}` : ""}`,
              bodyNode: body,
              metadata: {
                async: right!.text.startsWith("async "),
                reactComponent: looksLikeComponent(
                  propertyName,
                  right!,
                  filePath,
                ),
              },
            },
          );
          scopes.push({ types: new Map() });
          for (const parameter of field(right!, "parameters")?.namedChildren ??
            [])
            noteBinding(
              text(field(parameter, "pattern") ?? parameter.namedChild(0)),
              text(field(parameter, "type"))
                .replace(/^:\s*/, "")
                .replace(/<.*$/s, "")
                .trim() || undefined,
            );
          if (body) walk(body, symbol, [...chain, objectText, propertyName]);
          scopes.pop();
          return;
        }
        walk(node, owner, chain);
        return;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        for (const declarator of node.namedChildren.filter(
          (child) => child.type === "variable_declarator",
        )) {
          const name = text(field(declarator, "name"));
          const value = field(declarator, "value");
          noteBinding(name, bindingType(declarator));
          if (isCallable(value)) {
            const parameters = parameterSignature(field(value!, "parameters"));
            const body = field(value!, "body");
            const symbol = addSymbol(declarator, "function", name, chain, {
              parameters,
              signature: `${name}(${parameters})${returnType(value!) ? `: ${returnType(value!)}` : ""}`,
              bodyNode: body,
              parentId: owner?.id,
              metadata: {
                async: value!.text.startsWith("async "),
                reactComponent: looksLikeComponent(name, value!, filePath),
              },
            });
            scopes.push({ types: new Map() });
            for (const parameter of field(value!, "parameters")
              ?.namedChildren ?? [])
              noteBinding(
                text(field(parameter, "pattern") ?? parameter.namedChild(0)),
                text(field(parameter, "type"))
                  .replace(/^:\s*/, "")
                  .replace(/<.*$/s, "")
                  .trim() || undefined,
              );
            if (body) walk(body, symbol, [...chain, name]);
            scopes.pop();
            continue;
          }
          // Only module-level values are searchable symbols; locals are not.
          if (name && chain.length === 0 && owner === undefined)
            addSymbol(declarator, "variable", name, chain, {
              signature: `${name}${text(field(declarator, "type"))}`,
            });
          if (value) visit(value, owner, chain);
        }
        return;
      }
      case "call_expression":
        addCall(node, owner ?? moduleOwner());
        walk(node, owner, chain);
        return;
      case "new_expression":
        addNew(node, owner ?? moduleOwner());
        walk(node, owner, chain);
        return;
      case "jsx_opening_element":
      case "jsx_self_closing_element":
        addJsxReference(node, owner ?? moduleOwner());
        walk(node, owner, chain);
        return;
      case "statement_block":
        scopes.push({ types: new Map() });
        walk(node, owner, chain);
        scopes.pop();
        return;
      default:
        walk(node, owner, chain);
    }
  }

  walk(tree.rootNode, undefined, []);

  if (moduleSymbol) {
    // Represent the file's top-level code: imports, configuration and side effects.
    const declarationTypes = new Set([
      "class_declaration",
      "abstract_class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
      "function_declaration",
      "generator_function_declaration",
      "function_signature",
      "internal_module",
      "module",
    ]);
    const isDeclaration = (node: Node) => {
      const inner =
        node.type === "export_statement"
          ? (field(node, "declaration") ?? node)
          : node;
      return declarationTypes.has(inner.type);
    };
    moduleSymbol.source = tree.rootNode.namedChildren
      .filter((child) => !isDeclaration(child))
      .map((child) => child.text)
      .join("\n");
  }

  // Two declarations can share a canonical identity (overloads, sibling scopes).
  const identityCounts = new Map<string, number>();
  for (const symbol of symbols) {
    const identity = symbol.canonicalIdentity ?? symbol.id;
    const count = identityCounts.get(identity) ?? 0;
    if (count > 0) {
      const previousId = symbol.id;
      symbol.id = `${identity}#${count + 1}`;
      for (const call of calls)
        if (call.callerId === previousId) call.callerId = symbol.id;
      for (const other of symbols)
        if (other.parentId === previousId) other.parentId = symbol.id;
    }
    identityCounts.set(identity, count + 1);
  }

  // Declaration files describe APIs; they never contribute executable edges.
  const executableCalls = declarationOnly ? [] : calls;
  // Link exports to the symbols they expose.
  for (const record of exports) {
    if (!record.localName) continue;
    const symbol = symbols.find(
      (candidate) =>
        candidate.name === record.localName &&
        !candidate.parentId &&
        !candidate.metadata?.overloadSignature,
    );
    if (symbol) {
      record.symbolId = symbol.id;
      symbol.metadata = {
        ...symbol.metadata,
        exported: record.exportedName === "default" ? "default" : "named",
      };
    }
  }
  return {
    symbols,
    calls: executableCalls,
    imports,
    exports,
    parseError,
  };
}
