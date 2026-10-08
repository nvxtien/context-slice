export const renderSignature = (s) => s.signature ?? `${s.kind} ${s.name}`;
export function renderSkeleton(s, calls = []) {
    return [
        renderSignature(s),
        s.metadata?.exported ? `\nEXPORT\n${s.metadata.exported}` : "",
        s.annotations.length ? `\nANNOTATIONS\n${s.annotations.join("\n")}` : "",
        calls.length ? `\nCALLS\n${calls.join("\n")}` : "",
    ]
        .join("\n")
        .trim();
}
