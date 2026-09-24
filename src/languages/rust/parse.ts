import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import type { SourceRange } from "../../types/model.js";

export type Node = Parser.SyntaxNode;

export const LANGUAGE_ID = "rust";

let parser: Parser | undefined;
export function rustParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Rust as any);
  }
  return parser;
}

export const range = (node: Node): SourceRange => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});
export const field = (node: Node, name: string) => node.childForFieldName(name);
export const text = (node: Node | null | undefined) => node?.text ?? "";

import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  SymbolKind,
  SymbolMetadata,
  SymbolRecord,
} from "../../types/model.js";
import type { ParsedFile } from "../adapter.js";

const ITEM_TYPES = new Set([
  "function_item",
  "function_signature_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "impl_item",
  "mod_item",
  "const_item",
  "static_item",
  "type_item",
]);

// SymbolKind (src/types/model.ts) has no "struct" or "trait" member —
// verified directly against the live type before writing this plan, do not
// add "struct"/"trait" as kind values, tsc will reject them.
const KIND_BY_NODE_TYPE: Record<string, SymbolKind> = {
  function_item: "function",
  function_signature_item: "function",
  struct_item: "class", // closest existing kind for a data-bearing named type
  enum_item: "enum",
  trait_item: "interface", // closest existing kind: a trait is a behavioral contract
  impl_item: "type", // impl blocks are containers, not themselves a named declaration; shares "type" with type aliases deliberately, revisit if this causes ambiguity in a later phase
  mod_item: "namespace",
  const_item: "variable",
  static_item: "variable",
  type_item: "type",
};

const isPub = (node: Node) =>
  node.children.some((child) => child.type === "visibility_modifier");
// `async` is not a direct child of function_item — tree-sitter-rust 0.21 nests
// it inside a `function_modifiers` child (verified empirically; the brief's
// "direct child" assumption didn't hold here, unlike visibility_modifier).
const isAsync = (node: Node) =>
  node.children.some(
    (child) =>
      child.type === "async" ||
      (child.type === "function_modifiers" &&
        child.children.some((c) => c.type === "async")),
  );

function canonicalId(filePath: string, chain: string[], kind: SymbolKind, name: string) {
  return [filePath, ...chain, kind, name].join("::");
}

/**
 * The crate-relative module path a `use` statement would need to name this
 * file, per the standard `src/lib.rs`/`src/main.rs`/`src/foo.rs`/`src/foo/mod.rs`
 * layout (spec §10). Computed purely from this file's own path — no
 * repository-wide listing is needed, since the convention is per-file.
 * Multi-crate workspaces and `src/bin/*.rs` binaries are not modeled (§41-46,
 * §60, deferred).
 */
export function modulePathFor(filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, "/");
  const srcMatch = /(^|\/)src\//.exec(normalized); // segment-safe: not `mysrc/`
  const relative = srcMatch ? normalized.slice(srcMatch.index + srcMatch[0].length) : normalized;
  const parts = relative.split("/").filter(Boolean);
  const last = parts.pop() ?? "";
  const base = last.replace(/\.rs$/, "");
  if (base === "lib" || base === "main" || base === "mod") return parts;
  return [...parts, base];
}

/** impl blocks have no `name` field — label them by their Self type (+ trait, if any). */
function implLabel(node: Node): string {
  const selfType = text(field(node, "type"));
  const traitNode = field(node, "trait");
  return traitNode ? `impl ${text(traitNode)} for ${selfType}` : `impl ${selfType}`;
}

function itemName(node: Node): string {
  if (node.type === "impl_item") return implLabel(node);
  return text(field(node, "name"));
}

/**
 * Flattens a `scoped_identifier` chain (or a bare `crate`/`self`/`super`/
 * `identifier` leaf) into its segments in source order, e.g.
 * `crate::service::create_order` -> ["crate", "service", "create_order"].
 */
function pathSegments(node: Node): string[] {
  if (node.type === "scoped_identifier") {
    const path = field(node, "path");
    const name = text(field(node, "name"));
    return path ? [...pathSegments(path), name] : [name];
  }
  return [text(node)];
}

/** One `use` statement can bind several names (a grouped list) — always returns an array, even for the common single-binding case. */
function parseUseDeclaration(
  node: Node,
  filePath: string,
): ImportRecord[] {
  const argument = field(node, "argument");
  if (!argument) return [];
  const baseRecord = {
    filePath,
    language: LANGUAGE_ID,
    kind: "named" as const,
    typeOnly: false,
    range: range(node),
  };
  const records: ImportRecord[] = [];
  const leaf = (full: string[], localName?: string) => {
    const importedName = full.at(-1);
    if (!importedName) return;
    const module = full.length > 1 ? full.slice(0, -1).join("::") : importedName;
    records.push({ ...baseRecord, module, importedName, localName: localName ?? importedName });
  };
  const wildcard = (full: string[]) => {
    if (full.length) records.push({ ...baseRecord, module: full.join("::"), wildcard: true });
  };
  // `self` inside `m::{self}` imports module `m` itself (module = m's parent path).
  const selfLeaf = (prefix: string[], alias?: string) => {
    const name = prefix.at(-1);
    if (!name) return;
    records.push({
      ...baseRecord,
      module: prefix.length > 1 ? prefix.slice(0, -1).join("::") : name,
      importedName: name,
      localName: alias ?? name,
    });
  };

  // Recursive over the tree-sitter-rust 0.21 use shapes: scoped_use_list
  // (path + use_list), use_list, use_wildcard, use_as_clause, scoped_identifier,
  // identifier/self/crate/super. Any other node type emits nothing.
  const useTree = (item: Node, prefix: string[]): void => {
    switch (item.type) {
      case "use_list":
        for (const child of item.namedChildren) useTree(child, prefix);
        return;
      case "scoped_use_list": {
        const path = field(item, "path");
        const list = field(item, "list");
        if (list) useTree(list, [...prefix, ...(path ? pathSegments(path) : [])]);
        return;
      }
      case "use_wildcard": {
        const path = item.namedChild(0);
        wildcard([...prefix, ...(path ? pathSegments(path) : [])]);
        return;
      }
      case "use_as_clause": {
        const path = field(item, "path");
        const alias = text(field(item, "alias"));
        if (!path || !alias) return;
        if (path.type === "self") selfLeaf(prefix, alias);
        else if (isPathNode(path)) leaf([...prefix, ...pathSegments(path)], alias);
        return;
      }
      case "self":
        selfLeaf(prefix);
        return;
      default:
        if (isPathNode(item)) leaf([...prefix, ...pathSegments(item)]);
    }
  };
  useTree(argument, []);
  return records;
}

const isPathNode = (node: Node) =>
  ["scoped_identifier", "identifier", "self", "crate", "super"].includes(node.type);

const isComment = (n: Node) => n.type.endsWith("comment");
const namedNoComments = (n: Node | null) => (n?.namedChildren ?? []).filter((c) => !isComment(c));

/** Names of an impl's own generic type parameters (not lifetimes/consts). */
function typeParamNames(impl: Node): Set<string> {
  const names = new Set<string>();
  for (const p of field(impl, "type_parameters")?.namedChildren ?? []) {
    const n = p.type === "type_identifier" ? p : (field(p, "left") ?? field(p, "name"));
    if (n?.type === "type_identifier") names.add(n.text);
  }
  return names;
}

/**
 * Base type name: strips generics, `&`/`&mut`, `dyn`, lifetimes and path prefixes.
 * Undefined for shapes that are not one named type (slices, arrays, tuples, fn pointers,
 * multi-bound `dyn`, `impl Trait`, `!`, `_`) and for names in `generics`.
 */
function baseTypeName(node: Node | null, generics?: Set<string>): string | undefined {
  if (!node) return undefined;
  let name: string;
  switch (node.type) {
    case "generic_type":
    case "reference_type":
    case "pointer_type":
      return baseTypeName(field(node, "type"), generics);
    case "dynamic_type":
      return baseTypeName(field(node, "trait"), generics);
    case "scoped_type_identifier":
      name = text(field(node, "name"));
      break;
    case "type_identifier":
      name = node.text;
      break;
    default:
      return undefined;
  }
  return generics?.has(name) ? undefined : name;
}

function symbolMetadata(node: Node): SymbolMetadata | undefined {
  const meta: SymbolMetadata = {};
  if (node.type === "function_item" && isAsync(node)) meta.async = true;
  if (node.type === "impl_item") {
    const generics = typeParamNames(node);
    meta.implSelfType = baseTypeName(field(node, "type"), generics);
    const trait = baseTypeName(field(node, "trait"), generics);
    if (trait) meta.implTrait = trait;
  } else if (node.type === "struct_item") {
    const types: Record<string, string> = {};
    const body = field(node, "body");
    if (body?.type === "field_declaration_list") {
      for (const f of body.namedChildren)
        if (f.type === "field_declaration") types[text(field(f, "name"))] = text(field(f, "type"));
    } else if (body) {
      body.childrenForFieldName("type").forEach((t, i) => (types[String(i)] = t.text));
    }
    if (Object.keys(types).length) meta.declaredTypes = types;
  } else if (node.type === "function_item" || node.type === "function_signature_item") {
    const types: Record<string, string> = {};
    // declaredTypes.self is "&self" | "&mut self" | "self" for plain receivers, or the raw type
    // text (e.g. "Box<Self>") for a typed `self: T`. Pattern params (`(a, b): T`, `_: T`) are skipped.
    for (const p of namedNoComments(field(node, "parameters"))) {
      if (p.type === "self_parameter") {
        const ref = p.children.some((c) => c.type === "&");
        types.self = ref ? (p.children.some((c) => c.type === "mutable_specifier") ? "&mut self" : "&self") : "self";
      } else if (p.type === "parameter") {
        const pattern = field(p, "pattern");
        if (pattern?.type === "identifier" || pattern?.type === "self") types[pattern.text] = text(field(p, "type"));
      }
    }
    if (Object.keys(types).length) meta.declaredTypes = types;
  }
  return Object.keys(meta).length ? meta : undefined;
}

/** Dot count of a pure ident/self field chain, or undefined if it contains anything else. */
const chainDots = (node: Node): number | undefined => {
  if (node.type === "self" || node.type === "identifier") return 0;
  if (node.type !== "field_expression") return undefined;
  const inner = chainDots(field(node, "value")!);
  return inner === undefined ? undefined : inner + 1;
};

/** Chains of <= 3 dots: source text. `<field>` = chain too long; `<expr>` = chain contains a call/index/etc. */
function receiverOf(node: Node): string {
  const dots = chainDots(node);
  if (dots !== undefined) return dots <= 3 ? node.text : "<field>";
  return node.type === "field_expression" ? "<expr>" : `<${node.type.replace(/_expression$/, "")}>`;
}

/** Path prefix text without generic arguments (`Vec::<u8>` -> `Vec`). */
const prefixText = (node: Node): string =>
  node.type === "generic_type" ? text(field(node, "type")) : node.text;

/** Turns a call_expression / macro_invocation into an unresolved edge. */
function callEdge(node: Node, filePath: string, callerId: string): CallEdge {
  const edge: CallEdge = {
    callerId,
    calleeName: "",
    filePath,
    language: LANGUAGE_ID,
    range: range(node),
    confidence: "unresolved",
    resolutionKind: "unresolved",
    evidence: [],
  };
  if (node.type === "macro_invocation") {
    const macro = field(node, "macro")!;
    edge.calleeName = macro.type === "scoped_identifier" ? text(field(macro, "name")) : macro.text;
    if (macro.type === "scoped_identifier") edge.receiverText = prefixText(field(macro, "path")!);
    edge.argumentCount = 0;
    edge.evidence = [`macro:${edge.calleeName}`];
    return edge;
  }
  edge.argumentCount = namedNoComments(field(node, "arguments")).length;
  let fn = field(node, "function")!;
  if (fn.type === "generic_function") fn = field(fn, "function")!;
  if (fn.type === "field_expression") {
    edge.calleeName = text(field(fn, "field"));
    edge.receiverText = receiverOf(field(fn, "value")!);
  } else if (fn.type === "scoped_identifier") {
    edge.calleeName = text(field(fn, "name"));
    const path = field(fn, "path");
    if (path) edge.receiverText = prefixText(path);
    const qualified = path?.type === "bracketed_type" ? path.namedChild(0) : null;
    if (qualified?.type === "qualified_type")
      edge.evidence = [`qualified:${baseTypeName(field(qualified, "alias"))}`];
  } else if (fn.type === "identifier") {
    edge.calleeName = fn.text;
  } else {
    const inner = fn.type === "parenthesized_expression" ? fn.namedChild(0) : null;
    edge.calleeName =
      inner?.type === "field_expression"
        ? text(field(inner, "field"))
        : inner?.type === "identifier"
          ? inner.text
          : "<expr>";
    edge.evidence = ["no-type:callee-expression"];
  }
  return edge;
}

export function parseRust(filePath: string, source: string): ParsedFile {
  const symbols: SymbolRecord[] = [];
  const seenIds = new Set<string>();
  let parseError = false;
  let tree: Parser.Tree;
  try {
    // The node binding rejects string inputs of ~32KB or more, so feed it in small chunks.
    tree = rustParser().parse((index: number) => source.slice(index, index + 4_096));
    parseError = tree.rootNode.hasError;
  } catch {
    return { symbols: [], calls: [], imports: [], exports: [], parseError: true };
  }

  const modulePath = modulePathFor(filePath);
  const fnByNode = new Map<number, SymbolRecord>();

  function walk(node: Node, parent: SymbolRecord | undefined, chain: string[]) {
    // `#[...]` attributes are siblings that precede their item: collect them as annotations.
    let attributes: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === "attribute_item") {
        attributes.push(child.text);
        continue;
      }
      if (!ITEM_TYPES.has(child.type)) {
        if (!child.type.endsWith("comment")) attributes = [];
        // Not a top-level item itself, but it may contain one (e.g. a source_file
        // wraps everything; an impl/trait/mod body wraps its members directly, so
        // this branch mainly matters for source_file's implicit top level).
        walk(child, parent, chain);
        continue;
      }
      const name = itemName(child);
      if (!name) continue;
      const kind = KIND_BY_NODE_TYPE[child.type];
      const canonicalIdentity = canonicalId(filePath, chain, kind, name);
      // Two items at the same nesting level can share a name (e.g. multiple
      // `impl Foo` blocks, or #[cfg(...)]-gated fn overloads), which would
      // otherwise collide on `id` — a SQLite primary key — and crash the
      // whole project's indexing. Disambiguate with the node's own start
      // line: deterministic and human-readable, unlike an incrementing
      // counter that could shift under fixture reordering.
      let id = canonicalIdentity;
      if (seenIds.has(id)) id = `${canonicalIdentity}#${child.startPosition.row + 1}`;
      seenIds.add(id);
      const modifiers = isPub(child) ? ["pub"] : [];
      const symbol: SymbolRecord = {
        id,
        language: LANGUAGE_ID,
        kind,
        name,
        qualifiedName: [...modulePath, ...chain, name].join("::"),
        canonicalIdentity,
        signature: child.text.split("\n")[0].trim(),
        filePath,
        range: range(child),
        bodyRange: field(child, "body") ? range(field(child, "body")!) : undefined,
        parentId: parent?.id,
        annotations: attributes,
        modifiers,
        metadata: symbolMetadata(child),
        source: child.text,
        body: field(child, "body")?.text,
      };
      attributes = [];
      symbols.push(symbol);
      if (child.type === "function_item") fnByNode.set(child.id, symbol);
      const body = field(child, "body");
      if (body) walk(body, symbol, [...chain, name]);
    }
  }

  walk(tree.rootNode, undefined, []);
  const calls: CallEdge[] = [];
  // Caller = innermost enclosing fn (closures/async blocks belong to it); token trees are opaque.
  const collectCalls = (node: Node, caller: SymbolRecord | undefined) => {
    for (const child of node.namedChildren) {
      if (child.type === "token_tree") continue;
      const owner = fnByNode.get(child.id) ?? caller;
      if (owner && (child.type === "call_expression" || child.type === "macro_invocation"))
        calls.push(callEdge(child, filePath, owner.id));
      collectCalls(child, owner);
    }
  };
  collectCalls(tree.rootNode, undefined);
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  const collectUses = (node: Node) => {
    if (node.type === "use_declaration") {
      const records = parseUseDeclaration(node, filePath);
      imports.push(...records);
      if (isPub(node)) {
        for (const record of records)
          exports.push({
            filePath,
            language: LANGUAGE_ID,
            exportedName: record.localName ?? record.importedName ?? "",
            fromModule: record.module,
            sourceName: record.importedName,
            wildcard: record.wildcard,
            typeOnly: false,
            range: record.range,
          });
      }
      return; // a use_declaration has no nested items worth descending into
    }
    for (const child of node.namedChildren) collectUses(child);
  };
  collectUses(tree.rootNode);
  return { symbols, calls, imports, exports, parseError };
}
