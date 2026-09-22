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
