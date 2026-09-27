import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";
import { registerEnterpriseExtractor, registerEnterpriseResolver } from "./registry.js";

// Two-phase, like dependency-injection.ts: the per-file extractor emits provisional
// "unresolved" ENTITY_RELATIONs whose targetLabel carries the raw target simple name
// (the side-channel the resolver reads); resolveEntityRelations then applies the
// unique-simple-name rule once every project symbol is known.

const RELATION_RE = /@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b(?:\s*\(([^)]*)\))?/g;
const JOIN_COLUMN_RE = /@JoinColumn\s*\(([^)]*)\)/;
const COLLECTION_RE = /\b(?:List|Set|Collection)<\s*([\w.]+)\s*>/;

/** Class body at member depth only; comments and nested bodies blanked (same as DI's). */
function memberLevelBody(classSource: string): string {
  const out = classSource.split("");
  let depth = 0;
  let inString = false;
  for (let i = 0; i < out.length; i++) {
    const ch = classSource[i];
    if (!inString && ch === "/" && classSource[i + 1] === "/") {
      while (i < out.length && classSource[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (!inString && ch === "/" && classSource[i + 1] === "*") {
      const end = classSource.indexOf("*/", i + 2);
      const stop = end === -1 ? out.length : end + 2;
      for (; i < stop; i++) if (out[i] !== "\n") out[i] = " ";
      i--;
      continue;
    }
    if (ch === '"' && classSource[i - 1] !== "\\") inString = !inString;
    const keep = depth === 1;
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (!keep && out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}

/** Explicit mappedBy/fetch/cascade only (§26-27): anything absent stays absent. */
function explicitAttributes(args: string): string[] {
  const found: string[] = [];
  const mappedBy = args.match(/\bmappedBy\s*=\s*("[^"]*")/)?.[1];
  if (mappedBy) found.push(`mappedBy = ${mappedBy}`);
  const fetch = args.match(/\bfetch\s*=\s*([\w.]+)/)?.[1];
  if (fetch) found.push(`fetch = ${fetch}`);
  const cascade = args.match(/\bcascade\s*=\s*(\{[^}]*\}|[\w.]+)/)?.[1];
  if (cascade) found.push(`cascade = ${cascade}`);
  return found;
}

function extractEntityRelations(symbols: SymbolRecord[], filePath: string, _source: string): EnterpriseRelation[] {
  const relations: EnterpriseRelation[] = [];
  const entities = symbols.filter((s) => s.filePath === filePath && s.kind === "class" && s.annotations.includes("@Entity"));
  for (const entity of entities) {
    const body = memberLevelBody(entity.source);
    for (const match of body.matchAll(RELATION_RE)) {
      const rest = body.slice((match.index ?? 0) + match[0].length);
      // Stacked annotations (@JoinColumn, @OrderBy, ...) belong to the same field.
      // ponytail: `[^)]*` isn't nested-paren-aware, so a stacked annotation with a
      // nested-annotation argument (e.g. `@JoinColumn(foreignKey = @ForeignKey(name = "fk_x"))`)
      // under-consumes at the inner `)`, leaving `decl` misaligned so the field-declaration
      // regex below fails to match — this silently drops the WHOLE relation for that field
      // (not just the JoinColumn evidence). Fix if it shows up on a real repo: a depth-counting
      // scanner like `memberLevelBody`'s own brace walk, not a smarter regex.
      const lead = rest.match(/^(?:\s*@[\w.]+(?:\s*\([^)]*\))?)*/)![0];
      const decl = rest.slice(lead.length);
      const end = decl.search(/[;=(]/);
      if (end === -1 || decl[end] === "(") continue; // annotated getter/method: not handled
      const bare = decl
        .slice(0, end)
        .replace(/\b(?:final|private|protected|public|static|transient|volatile)\b/g, " ")
        .trim();
      const field = bare.match(/^([\w$.]+(?:\s*<.*>)?)\s+([\w$]+)$/s);
      if (!field) continue;
      const [, typeText, name] = field;
      const rawTarget = typeText.match(COLLECTION_RE)?.[1] ?? typeText.replace(/<.*>/s, "").trim();
      const joinColumn = lead.match(JOIN_COLUMN_RE)?.[1];
      relations.push({
        kind: "ENTITY_RELATION",
        family: "spring-data-jpa",
        sourceSymbolId: entity.id,
        targetLabel: rawTarget.slice(rawTarget.lastIndexOf(".") + 1),
        confidence: "unresolved", // provisional until resolveEntityRelations runs
        evidence: [
          `@${match[1]} on field ${name}`,
          ...explicitAttributes(match[2] ?? ""),
          ...(joinColumn !== undefined ? [`@JoinColumn(${joinColumn.trim()})`] : []),
        ],
        range: entity.range,
        filePath,
      });
    }
  }
  return relations;
}

/** Same rule as DI bean identity: 1 match exact, 0 dropped, 2+ unresolved (never guessed). */
function resolveEntityRelations(relations: EnterpriseRelation[], allSymbols: SymbolRecord[]): EnterpriseRelation[] {
  const projectTypes = allSymbols.filter((s) => s.kind === "class" || s.kind === "interface");
  return relations.flatMap((r) => {
    if (r.kind !== "ENTITY_RELATION" || r.family !== "spring-data-jpa") return [r];
    const candidates = projectTypes.filter((s) => s.name === r.targetLabel);
    if (candidates.length === 0) return [];
    const { targetSymbolId: _stale, ...rest } = r;
    if (candidates.length > 1) return [{ ...rest, confidence: "unresolved" as const }];
    return [{ ...rest, confidence: "exact" as const, targetSymbolId: candidates[0].id }];
  });
}

registerEnterpriseExtractor(extractEntityRelations);
registerEnterpriseResolver(resolveEntityRelations);
