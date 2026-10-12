import Parser from "tree-sitter";
import type { CallEdge, SymbolKind } from "../../types/model.js";

export type Node = Parser.SyntaxNode;

/** Shared by the c and cpp adapters: tree-sitter-c's node-type vocabulary is a strict subset
 * of tree-sitter-cpp's (every node type a C file can produce also exists, with the same
 * shape, in the C++ grammar), so every helper below is written against the C++ superset —
 * the C-only node types it can never see (class_specifier, destructor_name, operator_name,
 * reference_declarator, qualified_identifier) simply never match on C source. This is what
 * lets one implementation serve both without the C adapter special-casing anything away. */

export const range = (node: Node) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});
export const text = (node: Node | null | undefined) => node?.text ?? "";
export const field = (node: Node, name: string) =>
  node.childForFieldName(name) ?? undefined;
export const namedAll = (node: Node, type: string) =>
  node.namedChildren.filter((c) => c.type === type);

export function canonicalId(
  filePath: string,
  kind: SymbolKind,
  name: string,
  parameters?: string,
) {
  return [filePath, kind, name, parameters].filter(Boolean).join("::");
}

/** A node's own short name, unwrapping a template specialization (`Box<int>` -> "Box") to its
 * base identifier. Template arguments are deliberately dropped, not modeled. C never produces
 * a template_type, so this is just `.text` for every C call site. */
export function simpleName(node: Node | undefined): string {
  if (!node) return "";
  if (node.type === "template_type") return text(field(node, "name"));
  return node.text;
}

/** "virtual"/"inline"/etc. appear as bare anonymous keyword tokens rather than a named modifier
 * node; "static"/"extern" get a named storage_class_specifier. C's grammar can only ever
 * produce "inline" among these keywords — "virtual"/"explicit"/"friend"/"constexpr"/"mutable"
 * are not valid C tokens at all, so checking for them on C source is always a safe no-op. */
const KEYWORD_MODIFIERS = new Set([
  "virtual",
  "inline",
  "explicit",
  "friend",
  "constexpr",
  "mutable",
]);
export function modifiersOf(node: Node): string[] {
  const mods: string[] = [];
  for (const c of node.children) {
    if (c.type === "storage_class_specifier" || c.type === "virtual_specifier")
      mods.push(c.text);
    else if (!c.isNamed && KEYWORD_MODIFIERS.has(c.text)) mods.push(c.text);
  }
  return mods;
}

/** Follows a declarator through pointer/reference/array/init wrappers (`int* x`, `int& x`,
 * `int x[]`, `int x = 1`) down to either a function_declarator (this member is callable) or
 * the terminal name-bearing node. C never produces a reference_declarator — C has no
 * references — so that branch is simply unreachable on C source, not a C++-only hazard. */
export function unwrapDeclarator(node: Node | undefined): Node | undefined {
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
    if (current.type === "reference_declarator") {
      current = current.namedChildren[0];
      continue;
    }
    return current;
  }
  return undefined;
}

export const DECLARATOR_NODE_TYPES = new Set([
  "identifier",
  "field_identifier",
  "pointer_declarator",
  "reference_declarator",
  "array_declarator",
  "function_declarator",
  "destructor_name",
  "operator_name",
  "init_declarator",
]);

export function paramListText(params: Node | undefined): string {
  if (!params) return "()";
  const parts = namedAll(params, "parameter_declaration").map((p) => p.text);
  return `(${parts.join(", ")})`;
}

/** class_specifier never occurs in a C parse (C has no classes), so this one check safely
 * covers both languages' "this is a struct/union/enum (/class)" test. */
export function isTypeDeclaration(node: Node): boolean {
  return (
    node.type === "class_specifier" ||
    node.type === "struct_specifier" ||
    node.type === "union_specifier" ||
    node.type === "enum_specifier"
  );
}

/** A call_expression's callee name and (when syntactically simple) receiver text: a bare call,
 * a namespace/class-qualified call (`Base::Foo()`, `ns::Func()` — C never produces a
 * qualified_identifier here, so that branch is C++-only in practice), or a member access
 * (`a.b()` / `a->b()`, unified under field_expression in both grammars). */
export function buildCallEdge(
  callNode: Node,
  filePath: string,
  callerId: string,
  languageId: string,
): CallEdge | undefined {
  const callee = field(callNode, "function");
  const args = field(callNode, "arguments");
  const argumentCount = args ? args.namedChildren.length : 0;
  if (!callee) return undefined;

  let calleeName = "";
  let receiverText: string | undefined;
  if (callee.type === "identifier" || callee.type === "field_identifier") {
    calleeName = callee.text;
  } else if (callee.type === "qualified_identifier") {
    calleeName = simpleName(field(callee, "name"));
    receiverText = field(callee, "scope")?.text;
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
    language: languageId,
    range: range(callNode),
    confidence: "unresolved",
    resolutionKind: "unresolved",
    evidence: ["syntactic call"],
  };
}

export function collectCalls(
  node: Node,
  ownerId: string,
  filePath: string,
  calls: CallEdge[],
  languageId: string,
) {
  for (const child of node.namedChildren) {
    if (child.type === "call_expression") {
      const edge = buildCallEdge(child, filePath, ownerId, languageId);
      if (edge) calls.push(edge);
    }
    collectCalls(child, ownerId, filePath, calls, languageId);
  }
}
