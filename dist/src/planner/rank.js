export function rankSymbol(symbol, query, intent = "") {
    const terms = `${query} ${intent}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const text = `${symbol.name} ${symbol.qualifiedName ?? ""} ${symbol.signature ?? ""} ${symbol.filePath} ${symbol.annotations.join(" ")}`.toLowerCase();
    const matches = terms.filter((term) => text.includes(term)).length;
    const exact = symbol.name.toLowerCase() === query.trim().toLowerCase() ? 0.5 : 0;
    return Number((matches / Math.max(terms.length, 1) + exact).toFixed(4));
}
