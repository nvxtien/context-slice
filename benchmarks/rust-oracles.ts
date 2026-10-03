// Independent oracles for the Rust real-repository evaluation.
// Deliberately imports NOTHING from src/languages/rust/ (no resolveRustModule,
// rustModuleIndex or modulePathFor): expectations come from the Rust
// filesystem rules and raw tree-sitter syntax only.
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import { basename, dirname, posix } from "node:path";

const ROOT_STEMS = new Set(["mod.rs", "lib.rs", "main.rs"]);

/** Rust rule for `mod name;` declared in `declaringFile` (repo-relative, `/`-separated). */
export function expectedModuleFile(
  declaringFile: string,
  modName: string,
  fileExists: (path: string) => boolean,
  inlineChain: string[] = [],
): string | undefined {
  const dir0 = dirname(declaringFile);
  const base = ROOT_STEMS.has(basename(declaringFile))
    ? dir0
    : posix.join(dir0, basename(declaringFile, ".rs"));
  const dir = posix.join(base, ...inlineChain);
  for (const candidate of [`${dir}/${modName}.rs`, `${dir}/${modName}/mod.rs`])
    if (fileExists(candidate)) return candidate;
  return undefined;
}

export type ModDeclaration = {
  name: string;
  inlineChain: string[];
  cfg: boolean;
  pathAttribute?: string;
  line: number;
};

let parser: Parser | undefined;

/** File-backed `mod foo;` declarations (including ones nested in inline `mod a { }` bodies). */
export function modDeclarations(source: string): ModDeclaration[] {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Rust as any);
  }
  const out: ModDeclaration[] = [];
  const visit = (node: Parser.SyntaxNode, chain: string[]) => {
    for (const child of node.namedChildren) {
      if (child.type === "mod_item") {
        const name = child.childForFieldName("name")?.text ?? "";
        const body = child.childForFieldName("body");
        if (body) {
          visit(body, [...chain, name]);
          continue;
        }
        const attrs: string[] = [];
        for (
          let prev = child.previousNamedSibling;
          prev && prev.type === "attribute_item";
          prev = prev.previousNamedSibling
        )
          attrs.push(prev.text);
        const pathAttr = attrs
          .map((a) => /path\s*=\s*"([^"]*)"/.exec(a)?.[1])
          .find((v) => v !== undefined);
        out.push({
          name,
          inlineChain: chain,
          cfg: attrs.some((a) => /#\[\s*cfg/.test(a)),
          pathAttribute: pathAttr,
          line: child.startPosition.row + 1,
        });
      } else if (child.type !== "function_item") visit(child, chain);
    }
  };
  visit(parseSource(source).rootNode, []);
  return out;
}

// node tree-sitter rejects string input over 32 KiB unless bufferSize is raised.
function parseSource(source: string) {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Rust as any);
  }
  return parser.parse(source, undefined, { bufferSize: 4 * 1024 * 1024 });
}

/** Line spans of inline `mod name { .. }` bodies, for "is this import inside an inline module?". */
export function inlineModSpans(source: string) {
  const spans: Array<{ name: string; startLine: number; endLine: number }> = [];
  const visit = (node: Parser.SyntaxNode) => {
    for (const child of node.namedChildren) {
      if (child.type === "mod_item" && child.childForFieldName("body"))
        spans.push({
          name: child.childForFieldName("name")?.text ?? "",
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      if (child.type !== "function_item") visit(child);
    }
  };
  visit(parseSource(source).rootNode);
  return spans;
}

export function hasSyntaxError(source: string): boolean {
  return parseSource(source).rootNode.hasError;
}

export function classifyUse(record: {
  module: string;
}): "anchored" | "non-anchored" {
  const first = record.module.split("::")[0];
  return first === "crate" || first === "self" || first === "super"
    ? "anchored"
    : "non-anchored";
}

type NameIndex = {
  symbols: Array<{
    filePath: string;
    name: string;
    kind: string;
    source?: string;
  }>;
  exports: Array<{ filePath: string; exportedName: string }>;
};

/**
 * PROXY for use-resolution precision, not ground truth: does the resolved
 * file plausibly define/re-export/contain (as submodule) the imported name?
 * "unverifiable" = the name appears as a word inside an enum declared in that
 * file (a variant import); it is not counted as a hit.
 */
export function targetContainsName(
  index: NameIndex,
  resolvedFile: string,
  importedName: string,
): boolean | "unverifiable" {
  if (
    index.symbols.some(
      (s) => s.filePath === resolvedFile && s.name === importedName,
    )
  )
    return true;
  if (
    index.exports.some(
      (e) => e.filePath === resolvedFile && e.exportedName === importedName,
    )
  )
    return true;
  const word = new RegExp(`\\b${importedName.replace(/[^\w]/g, "")}\\b`);
  if (
    /^[A-Z]/.test(importedName) &&
    index.symbols.some(
      (s) =>
        s.filePath === resolvedFile &&
        s.kind === "enum" &&
        word.test(s.source ?? ""),
    )
  )
    return "unverifiable";
  return false;
}
