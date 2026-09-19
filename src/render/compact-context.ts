import type { SymbolRecord } from "../types/model.js";
export const renderSignature = (s: SymbolRecord) =>
  s.signature ?? `${s.kind} ${s.name}`;
export function renderSkeleton(s: SymbolRecord, calls: string[] = []) {
  return [
    renderSignature(s),
    s.annotations.length ? `\nANNOTATIONS\n${s.annotations.join("\n")}` : "",
    calls.length ? `\nCALLS\n${calls.join("\n")}` : "",
  ]
    .join("\n")
    .trim();
}
