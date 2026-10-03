import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";
import { registerEnterpriseExtractor } from "./registry.js";

const KEPT_ATTRS = new Set([
  "readOnly",
  "propagation",
  "isolation",
  "rollbackFor",
  "noRollbackFor",
  "timeout",
]);

/** Strips a leading "@" and any dotted package prefix, e.g. "@org.springframework...Transactional" -> "Transactional". */
function bareName(annotation: string): string {
  return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}

/**
 * Matches an already-AST-confirmed @Transactional annotation's own argument text. Detection
 * of whether the annotation is present happens via SymbolRecord.annotations, never via this
 * regex -- this only ever runs to extract an argument list once .annotations has confirmed
 * the annotation is real. The optional `(?:[\w.]+\.)?` prefix tolerates a fully-qualified
 * annotation name the same way bareName() already tolerates one for detection -- without it,
 * a qualified @Transactional would be correctly DETECTED but its attributes would never be
 * found, silently downgrading it to "no fact to record" (the same brief's Review Focus item 2).
 */
function transactionalArgsRegex(): RegExp {
  return /@(?:[\w.]+\.)?Transactional(?:\(([^]*?)\))?/;
}

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
    const hasTransactional = method.annotations.some(
      (a) => bareName(a) === "Transactional",
    );
    if (!hasTransactional) continue;

    const match = header(method).match(transactionalArgsRegex());
    const rawArgs = match?.[1];
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
