import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  SymbolKind,
  SymbolRecord,
} from "../../types/model.js";
import type { ParsedFile } from "../adapter.js";

type Node = Parser.SyntaxNode;

export const LANGUAGE_ID = "go";

let parser: Parser | undefined;
function goParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Go as any);
  }
  return parser;
}

const range = (node: Node) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});
const field = (node: Node, name: string) => node.childForFieldName(name);
const text = (node: Node | null | undefined) => node?.text ?? "";

/**
 * A method's receiver base type name, e.g. "User" for "*User"/"User", or
 * "Stack" for a generic receiver "*Stack[T]"/"Stack[T]" (verified: the
 * receiver's own parameter_declaration has a "type" field that is either a
 * pointer_type node (whose own namedChild(0) is the base type_identifier or
 * a generic_type), a generic_type node directly, or a type_identifier node
 * directly for a plain value receiver. generic_type's base identifier is
 * reachable via its own "type" field, verified empirically — not a "name"
 * field as one might guess).
 */
function receiverBaseTypeName(methodNode: Node): string | undefined {
  const receiverList = field(methodNode, "receiver");
  const paramDecl = receiverList?.namedChildren.find(
    (c) => c.type === "parameter_declaration",
  );
  let typeNode = paramDecl ? field(paramDecl, "type") : undefined;
  if (!typeNode) return undefined;
  if (typeNode.type === "pointer_type") {
    typeNode = typeNode.namedChild(0) ?? undefined;
  }
  if (!typeNode) return undefined;
  if (typeNode.type === "generic_type") {
    const base = field(typeNode, "type");
    return base?.type === "type_identifier" ? base.text : undefined;
  }
  return typeNode.type === "type_identifier" ? typeNode.text : undefined;
}

function canonicalId(filePath: string, kind: SymbolKind, name: string, parameters?: string) {
  return [filePath, kind, name, parameters].filter(Boolean).join("::");
}

export function parseGo(filePath: string, source: string): ParsedFile {
  const symbols: SymbolRecord[] = [];
  const calls: CallEdge[] = [];
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  let parseError = false;
  let tree: Parser.Tree;
  try {
    // tree-sitter's node binding rejects large single-string inputs; feed it in chunks,
    // matching every other adapter in this project (rust, typescript).
    tree = goParser().parse((index: number) => source.slice(index, index + 4_096));
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

  const structByName = new Map<string, SymbolRecord>();
  const pendingMethods: { node: Node; receiverName: string | undefined }[] = [];

  for (const child of tree.rootNode.namedChildren) {
    if (child.type === "function_declaration") {
      const name = text(field(child, "name"));
      if (!name) continue;
      const parameters = text(field(child, "parameters"));
      const id = uniqueId(canonicalId(filePath, "function", name, parameters));
      symbols.push({
        id,
        language: LANGUAGE_ID,
        kind: "function",
        name,
        qualifiedName: name,
        canonicalIdentity: id,
        signature: `func ${name}${parameters}`,
        filePath,
        range: range(child),
        bodyRange: field(child, "body") ? range(field(child, "body")!) : undefined,
        annotations: [],
        modifiers: [],
        source: child.text,
        body: field(child, "body")?.text,
      });
    } else if (child.type === "method_declaration") {
      // Deferred: struct symbols may appear later in this same file's top-level
      // children (Go has no forward-declaration ordering requirement), so method
      // linkage runs in a second pass below once every struct in this file is known.
      pendingMethods.push({ node: child, receiverName: receiverBaseTypeName(child) });
    } else if (child.type === "type_declaration") {
      for (const spec of child.namedChildren.filter(
        (c) => c.type === "type_spec" || c.type === "type_alias",
      )) {
        const name = text(field(spec, "name"));
        const typeNode = field(spec, "type");
        if (!name || !typeNode) continue;
        if (typeNode.type === "struct_type") {
          const id = uniqueId(canonicalId(filePath, "class", name));
          const symbol: SymbolRecord = {
            id,
            language: LANGUAGE_ID,
            kind: "class",
            name,
            qualifiedName: name,
            canonicalIdentity: id,
            signature: `type ${name} struct`,
            filePath,
            range: range(spec),
            annotations: [],
            modifiers: [],
            source: spec.text,
          };
          symbols.push(symbol);
          structByName.set(name, symbol);
          // struct_type's field list is a NAMED CHILD (field_declaration_list), not
          // reachable via childForFieldName("body") — verified empirically: field()
          // returns undefined here, so the fallback lookup is required, not optional.
          const fieldList = typeNode.namedChildren.find((c) => c.type === "field_declaration_list");
          for (const fieldDecl of fieldList?.namedChildren.filter((c) => c.type === "field_declaration") ?? []) {
            // An embedded field (e.g. plain "Base") has no "name" field, only "type" —
            // verified empirically: field_declaration's name field is absent for embeds.
            const fieldName = text(field(fieldDecl, "name")) || text(field(fieldDecl, "type"));
            if (!fieldName) continue;
            const fieldId = uniqueId(canonicalId(filePath, "field", `${name}.${fieldName}`));
            symbols.push({
              id: fieldId,
              language: LANGUAGE_ID,
              kind: "field",
              name: fieldName,
              qualifiedName: `${name}.${fieldName}`,
              canonicalIdentity: fieldId,
              signature: fieldDecl.text,
              filePath,
              range: range(fieldDecl),
              parentId: id,
              annotations: [],
              modifiers: [],
              source: fieldDecl.text,
            });
          }
        } else if (typeNode.type === "interface_type") {
          const id = uniqueId(canonicalId(filePath, "interface", name));
          symbols.push({
            id,
            language: LANGUAGE_ID,
            kind: "interface",
            name,
            qualifiedName: name,
            canonicalIdentity: id,
            signature: `type ${name} interface`,
            filePath,
            range: range(spec),
            annotations: [],
            modifiers: [],
            source: spec.text,
          });
        } else {
          const id = uniqueId(canonicalId(filePath, "type", name));
          symbols.push({
            id,
            language: LANGUAGE_ID,
            kind: "type",
            name,
            qualifiedName: name,
            canonicalIdentity: id,
            signature: `type ${name} ${text(typeNode)}`,
            filePath,
            range: range(spec),
            annotations: [],
            modifiers: [],
            source: spec.text,
          });
        }
      }
    } else if (child.type === "const_declaration" || child.type === "var_declaration") {
      const kind = child.type === "const_declaration" ? "const" : "var";
      const specType = kind === "const" ? "const_spec" : "var_spec";
      for (const spec of child.namedChildren.filter((c) => c.type === specType)) {
        // const_spec/var_spec's "name" field only yields the FIRST identifier in a
        // multi-name spec (e.g. "var a, b int"); Phase 1 scope is single-name specs,
        // the common case — multi-name specs are a known, accepted gap, not a bug to
        // chase here (mirrors this project's established "accepted divergence" pattern
        // for narrow multi-declarator gaps elsewhere, e.g. Java field extraction).
        const name = text(field(spec, "name"));
        if (!name) continue;
        const id = uniqueId(canonicalId(filePath, "variable", name));
        symbols.push({
          id,
          language: LANGUAGE_ID,
          kind: "variable",
          name,
          qualifiedName: name,
          canonicalIdentity: id,
          signature: spec.text,
          filePath,
          range: range(spec),
          annotations: [],
          modifiers: [],
          source: spec.text,
        });
      }
    }
  }

  // Second pass: by now structByName holds every struct declared in THIS file (built
  // in the first pass above), so same-file receiver linkage is real here. A method
  // whose receiver type isn't in this file's own structByName correctly gets
  // parentId: undefined with supertypes still set — never dropped, never misattributed.
  for (const { node: methodNode, receiverName } of pendingMethods) {
    const name = text(field(methodNode, "name"));
    if (!name) continue;
    const parameters = text(field(methodNode, "parameters"));
    const qualifiedName = receiverName ? `${receiverName}.${name}` : name;
    const id = uniqueId(canonicalId(filePath, "method", qualifiedName, parameters));
    const receiverStruct = receiverName ? structByName.get(receiverName) : undefined;
    symbols.push({
      id,
      language: LANGUAGE_ID,
      kind: "method",
      name,
      qualifiedName,
      canonicalIdentity: id,
      signature: `func (${receiverName ?? ""}) ${name}${parameters}`,
      filePath,
      range: range(methodNode),
      bodyRange: field(methodNode, "body") ? range(field(methodNode, "body")!) : undefined,
      parentId: receiverStruct?.id,
      supertypes: receiverName ? [receiverName] : undefined,
      annotations: [],
      modifiers: [],
      source: methodNode.text,
      body: field(methodNode, "body")?.text,
    });
  }

  return { symbols, calls, imports, exports, parseError };
}
