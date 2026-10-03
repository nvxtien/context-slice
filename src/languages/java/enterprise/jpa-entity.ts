import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";
import {
  registerEnterpriseExtractor,
  registerEnterpriseResolver,
} from "./registry.js";

// Two-phase, like dependency-injection.ts: the per-file extractor emits provisional
// "unresolved" ENTITY_RELATIONs whose targetLabel carries the raw target simple name
// (the side-channel the resolver reads); resolveEntityRelations then applies the
// unique-simple-name rule once every project symbol is known.

const RELATION_ANNOTATIONS = new Set([
  "OneToOne",
  "OneToMany",
  "ManyToOne",
  "ManyToMany",
]);
const COLLECTION_RE = /\b(?:List|Set|Collection)<\s*([\w.]+)\s*>/;

/** Strips a leading "@" and any dotted package prefix, e.g. "@javax.persistence.ManyToOne" -> "ManyToOne". */
function bareName(annotation: string): string {
  return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}

/**
 * Matches ONE specific, already-AST-confirmed relationship annotation's own argument text
 * (mappedBy/fetch/cascade). Detection of WHICH relationship annotation (if any) is present
 * happens via SymbolRecord.annotations, never via this regex -- this only ever runs to
 * extract an argument list for a name already known to be real. The optional
 * `(?:[\w.]+\.)?` prefix tolerates a fully-qualified annotation name the same way
 * bareName() already tolerates one for detection.
 */
function relationArgsRegex(name: string): RegExp {
  return new RegExp(`@(?:[\\w.]+\\.)?${name}\\b(?:\\s*\\(([^)]*)\\))?`);
}

/** Same qualified-name-tolerant pattern as relationArgsRegex, for the fixed @JoinColumn name. */
function joinColumnArgsRegex(): RegExp {
  return /@(?:[\w.]+\.)?JoinColumn\s*\(([^)]*)\)/;
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

function extractEntityRelations(
  symbols: SymbolRecord[],
  filePath: string,
  _source: string,
): EnterpriseRelation[] {
  const relations: EnterpriseRelation[] = [];
  const entities = symbols.filter(
    (s) =>
      s.filePath === filePath &&
      s.kind === "class" &&
      s.annotations.includes("@Entity"),
  );
  for (const entity of entities) {
    const fields = symbols.filter(
      (s) => s.kind === "field" && s.parentId === entity.id,
    );
    for (const field of fields) {
      const relationName = field.annotations
        .map(bareName)
        .find((name) => RELATION_ANNOTATIONS.has(name));
      if (!relationName) continue;

      const relationMatch = field.source.match(relationArgsRegex(relationName));
      const typeText = field.metadata?.declaredType ?? "";
      const rawTarget =
        typeText.match(COLLECTION_RE)?.[1] ??
        typeText.replace(/<.*>/s, "").trim();

      const hasJoinColumn = field.annotations.some(
        (a) => bareName(a) === "JoinColumn",
      );
      const joinColumn = hasJoinColumn
        ? field.source.match(joinColumnArgsRegex())?.[1]
        : undefined;

      relations.push({
        kind: "ENTITY_RELATION",
        family: "spring-data-jpa",
        sourceSymbolId: entity.id,
        targetLabel: rawTarget.slice(rawTarget.lastIndexOf(".") + 1),
        confidence: "unresolved", // provisional until resolveEntityRelations runs
        evidence: [
          `@${relationName} on field ${field.name}`,
          ...explicitAttributes(relationMatch?.[1] ?? ""),
          ...(joinColumn !== undefined
            ? [`@JoinColumn(${joinColumn.trim()})`]
            : []),
        ],
        range: entity.range,
        filePath,
      });
    }
  }
  return relations;
}

/** Same rule as DI bean identity: 1 match exact, 0 dropped, 2+ unresolved (never guessed). */
function resolveEntityRelations(
  relations: EnterpriseRelation[],
  allSymbols: SymbolRecord[],
): EnterpriseRelation[] {
  const projectTypes = allSymbols.filter(
    (s) => s.kind === "class" || s.kind === "interface",
  );
  return relations.flatMap((r) => {
    if (r.kind !== "ENTITY_RELATION" || r.family !== "spring-data-jpa")
      return [r];
    const candidates = projectTypes.filter((s) => s.name === r.targetLabel);
    if (candidates.length === 0) return [];
    const { targetSymbolId: _stale, ...rest } = r;
    if (candidates.length > 1)
      return [{ ...rest, confidence: "unresolved" as const }];
    return [
      {
        ...rest,
        confidence: "exact" as const,
        targetSymbolId: candidates[0].id,
      },
    ];
  });
}

registerEnterpriseExtractor(extractEntityRelations);
registerEnterpriseResolver(resolveEntityRelations);
