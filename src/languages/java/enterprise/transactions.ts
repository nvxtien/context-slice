import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";
import { registerEnterpriseExtractor } from "./registry.js";

const TRANSACTIONAL_RE = /@Transactional(?:\(([^]*?)\))?/;
const KEPT_ATTRS = new Set(["readOnly", "propagation", "isolation", "rollbackFor", "noRollbackFor", "timeout"]);

/**
 * The symbol's own header text (annotations + declaration), stopping before its body's
 * opening "{". Same string/paren-depth-aware scan as spring-mvc.ts's header(), re-derived
 * here (each family extractor is self-contained, per convention) rather than imported —
 * a naive indexOf("{") would misfire if an attribute value ever contained a brace.
 */
function header(symbol: SymbolRecord): string {
  const text = symbol.source;
  let inString = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "{" && depth === 0) return text.slice(0, i);
  }
  return text;
}

/**
 * Guards against a "@Transactional(...)"-shaped match that is itself commented out on its
 * own physical line (e.g. "// example: @Transactional(readOnly = true)"). Re-derived from
 * spring-mvc.ts's matchIsInsideLineComment: parseJava's leading-trivia scan strips a "//"
 * prefix out of symbol.source itself, so the header text alone can never see it — this maps
 * the match position back to the real file line and checks only that line for a preceding "//".
 */
function matchIsInsideLineComment(
  symbol: SymbolRecord,
  headerText: string,
  match: RegExpMatchArray,
  fullSource: string,
): boolean {
  const index = match.index ?? 0;
  const before = headerText.slice(0, index);
  const lastNewline = before.lastIndexOf("\n");
  const lineNumber = symbol.range.startLine + (before.match(/\n/g)?.length ?? 0);
  const column = lastNewline === -1 ? symbol.range.startColumn + index : index - lastNewline - 1;
  const fileLine = fullSource.split("\n")[lineNumber - 1] ?? "";
  return fileLine.slice(0, column).includes("//");
}

/** Splits an annotation argument list on commas outside (), strings, so dotted constants
 * (Propagation.REQUIRES_NEW) and .class literals never get mis-split. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let inString = false;
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function extractTransactionRelations(
  symbols: SymbolRecord[],
  filePath: string,
  source: string,
): EnterpriseRelation[] {
  const relations: EnterpriseRelation[] = [];

  for (const method of symbols.filter((s) => s.kind === "method")) {
    const methodHeader = header(method);
    const match = methodHeader.match(TRANSACTIONAL_RE);
    if (!match) continue;
    if (matchIsInsideLineComment(method, methodHeader, match, source)) continue;

    const rawArgs = match[1];
    if (rawArgs === undefined || rawArgs.trim() === "") continue; // bare or empty-parens: no fact to record

    const evidence: string[] = [];
    for (const pair of splitTopLevel(rawArgs)) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      if (!KEPT_ATTRS.has(name)) continue;
      evidence.push(pair.replace(/\s+/g, " ").trim());
    }
    if (evidence.length === 0) continue;

    const targetLabel = evidence
      .map((e) => {
        const eq = e.indexOf("=");
        return `${e.slice(0, eq).trim()}=${e.slice(eq + 1).trim()}`;
      })
      .join(", ");

    relations.push({
      kind: "TRANSACTION_BOUNDARY",
      family: "transactions",
      sourceSymbolId: method.id,
      targetLabel,
      confidence: "exact",
      evidence,
      range: method.range,
      filePath,
    });
  }

  return relations;
}

registerEnterpriseExtractor(extractTransactionRelations);
