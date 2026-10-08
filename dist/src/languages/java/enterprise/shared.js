/** Strips a leading "@" and any dotted package prefix, e.g. "@org.springframework...Autowired" -> "Autowired". */
export function bareName(annotation) {
    return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}
/** Text from a symbol's declaration up to (not including) its body's opening "{", string-aware. */
export function header(symbol) {
    const text = symbol.source;
    let inString = false;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"' && text[i - 1] !== "\\")
            inString = !inString;
        if (inString)
            continue;
        if (ch === "(")
            depth++;
        else if (ch === ")")
            depth--;
        else if (ch === "{" && depth === 0)
            return text.slice(0, i);
    }
    return text;
}
/** Splits on commas outside (), <>, and strings. */
export function splitTopLevel(text) {
    const parts = [];
    let inString = false;
    let depth = 0;
    let last = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"' && text[i - 1] !== "\\")
            inString = !inString;
        if (inString)
            continue;
        if (ch === "(" || ch === "<")
            depth++;
        else if (ch === ")" || ch === ">")
            depth--;
        else if (ch === "," && depth === 0) {
            parts.push(text.slice(last, i));
            last = i + 1;
        }
    }
    parts.push(text.slice(last));
    return parts.map((p) => p.trim()).filter(Boolean);
}
