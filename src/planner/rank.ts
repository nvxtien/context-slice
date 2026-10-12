import type { SymbolRecord } from "../types/model.js";

/** Fraction of query/intent terms found anywhere in `text` (case-insensitive substring match).
 * Shared by rankSymbol and anything else that needs to rank free text against a task — e.g. a
 * composition candidate that has no SymbolRecord of its own (a dependency-injection edge, an
 * enterprise relation) to run rankSymbol on. */
export function rankText(text: string, query: string, intent = "") {
  const terms = `${query} ${intent}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const matches = terms.filter((term) =>
    text.toLowerCase().includes(term),
  ).length;
  return matches / Math.max(terms.length, 1);
}

export function rankSymbol(symbol: SymbolRecord, query: string, intent = "") {
  const text = `${symbol.name} ${symbol.qualifiedName ?? ""} ${symbol.signature ?? ""} ${symbol.filePath} ${symbol.annotations.join(" ")}`;
  const exact =
    symbol.name.toLowerCase() === query.trim().toLowerCase() ? 0.5 : 0;
  return Number((rankText(text, query, intent) + exact).toFixed(4));
}
