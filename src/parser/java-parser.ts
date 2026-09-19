import Parser from "tree-sitter";
import Java from "tree-sitter-java";
import type { CallEdge, SourceRange, SymbolKind, SymbolRecord } from "../types/model.js";

const annotationRe = /@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/g;
const typeRe = /((?:\s*@[A-Za-z_$][\w$]*(?:\([^\n]*\))?\s*)*)((?:(?:public|protected|private|static|final|abstract|default|sealed|non-sealed)\s+)*)\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g;
const methodRe = /((?:\s*@[A-Za-z_$][\w$]*(?:\([^\n]*\))?\s*)*)((?:(?:public|protected|private|static|final|abstract|default|synchronized|native)\s+)*)(?:<[A-Za-z0-9_, ? extends super]+>\s+)?([A-Za-z_$][\w$<>?,.\[\]]*)\s+([A-Za-z_$][\w$]*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:throws\s+[A-Za-z_$][\w$., ]*)?\{/g;

function point(source: string, offset: number) { const lines = source.slice(0, offset).split("\n"); return { line: lines.length, column: lines.at(-1)?.length ?? 0 }; }
function sourceRange(source: string, start: number, end: number): SourceRange { const a = point(source, start); const b = point(source, end); return { startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column }; }
function closingBrace(source: string, open: number): number { let depth = 0; for (let i = open; i < source.length; i++) { if (source[i] === "{") depth++; else if (source[i] === "}") { depth--; if (depth === 0) return i + 1; } } return source.length; }
function annotationList(text: string): string[] { return [...text.matchAll(annotationRe)].map((m) => `@${m[1]}`); }
function canonicalId(filePath: string, packageName: string, typeChain: string[], kind: SymbolKind, name: string, parameters = "") { return `${filePath}::${packageName || "<default>"}::${typeChain.join(".") || "<file>"}::${kind}::${name}${parameters ? `(${parameters})` : ""}`; }
function parameterSignature(parameters: string) { return parameters.replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/g, "").replace(/\b(final|volatile|transient)\s+/g, "").replace(/\s+/g, " ").trim(); }

export function parseJava(filePath: string, source: string) {
  const parser = new Parser(); parser.setLanguage(Java as any); let parseError = false;
  try { parser.parse(source); } catch { parseError = true; }
  const symbols: SymbolRecord[] = []; const types: SymbolRecord[] = [];
  const packageName = source.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1] ?? "";
  for (const match of source.matchAll(typeRe)) {
    const start = match.index ?? 0; const name = match[4]; const open = source.indexOf("{", start + match[0].length); const end = open >= 0 ? closingBrace(source, open) : start + match[0].length;
    const kind = match[3] as SymbolKind; const parent = types.filter((item) => item.range.startLine <= point(source, start).line && item.range.endLine >= point(source, end).line && item.range.startLine !== point(source, start).line).sort((a, b) => (a.range.endLine - a.range.startLine) - (b.range.endLine - b.range.startLine))[0]; const typeChain = [...(parent?.qualifiedName?.split(".").slice(packageName ? packageName.split(".").length : 0) ?? []), name]; const canonicalIdentity = canonicalId(filePath, packageName, typeChain, kind, name); const symbol: SymbolRecord = { id: canonicalIdentity, language: "java", kind, name, packageName, qualifiedName: `${packageName ? `${packageName}.` : ""}${typeChain.join(".")}`, canonicalIdentity, signature: `${kind} ${name}`, filePath, range: sourceRange(source, start, end), bodyRange: open >= 0 ? sourceRange(source, open, end) : undefined, parentId: parent?.id, annotations: annotationList(match[1]), modifiers: match[2].trim().split(/\s+/).filter(Boolean), source: source.slice(start, end), body: open >= 0 ? source.slice(open, end) : undefined };
    symbols.push(symbol); types.push(symbol);
  }
  for (const match of source.matchAll(methodRe)) {
    const start = match.index ?? 0; const name = match[4]; if (match[3] === "new" || ["if", "for", "while", "switch", "catch", "else", "try", "finally", "return"].includes(name)) continue; const open = start + match[0].lastIndexOf("{"); const end = open >= start ? closingBrace(source, open) : start + match[0].length; const parent = types.filter((item) => item.range.startLine <= point(source, start).line && item.range.endLine >= point(source, end).line).sort((a, b) => b.range.startLine - a.range.startLine)[0];
    const kind: SymbolKind = parent?.name === name ? "constructor" : "method"; const parameters = parameterSignature(match[5]); const signature = `${name}(${parameters}): ${match[3]}`; const typeChain = parent?.qualifiedName ? parent.qualifiedName.replace(`${packageName}.`, "").split(".") : []; const canonicalIdentity = canonicalId(filePath, packageName, typeChain, kind, name, parameters);
    symbols.push({ id: canonicalIdentity, language: "java", kind, name, packageName, qualifiedName: `${packageName ? `${packageName}.` : ""}${[...typeChain, name].join(".")}`, canonicalIdentity, signature, filePath, range: sourceRange(source, start, end), bodyRange: open >= 0 ? sourceRange(source, open, end) : undefined, parentId: parent?.id, annotations: annotationList(match[1]), modifiers: match[2].trim().split(/\s+/).filter(Boolean), source: source.slice(start, end), body: open >= 0 ? source.slice(open, end) : undefined });
  }
  const identityCounts = new Map<string, number>();
  for (const symbol of symbols) { const count = identityCounts.get(symbol.canonicalIdentity ?? symbol.id) ?? 0; if (count > 0) symbol.id = `${symbol.canonicalIdentity}#${count + 1}`; identityCounts.set(symbol.canonicalIdentity ?? symbol.id, count + 1); }
  const calls: CallEdge[] = []; const callable = symbols.filter((s) => s.kind === "method" || s.kind === "constructor");
  for (const caller of callable) for (const match of (caller.body ?? "").matchAll(/(?:(\w+)\.)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const calleeName = match[2]; if (["if", "for", "while", "switch", "catch", "new", "return"].includes(calleeName)) continue;
    calls.push({ callerId: caller.id, receiverText: match[1], calleeName, filePath, range: caller.range, confidence: "unresolved" });
  }
  return { symbols, calls, parseError };
}
