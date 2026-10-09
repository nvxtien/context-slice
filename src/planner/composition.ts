import type { ProjectIndex } from "../indexer/index.js";
import type { SymbolRecord } from "../types/model.js";
import { estimateTokens } from "./budget.js";

/** Why a sibling of the target was composed into the slice. */
export type CompositionReason =
  "enclosing type" | "enterprise relation" | "file imports";

export interface CompositionCandidate {
  symbol?: SymbolRecord;
  label: string;
  reason: CompositionReason;
  evidence: string[];
  rendered: string;
  estimatedTokens: number;
  filePath: string;
}

const TYPE_KINDS = new Set([
  "class",
  "interface",
  "enum",
  "record",
  "namespace",
]);
/** A skeleton stays compact even for a large class. */
const MAX_SKELETON_MEMBERS = 12;

/** The first line of a declaration, exactly as written, without its opening brace. */
export function declarationLine(symbol: SymbolRecord) {
  return (symbol.source ?? "")
    .split("\n")[0]
    .trim()
    .replace(/\s*\{\s*$/, "")
    .replace(/\s*=>\s*$/, "")
    .trim();
}

/**
 * Java fields are not indexed as symbols, so read their declarations from the
 * enclosing type's source. Analysis only: nothing is added to the index, so
 * retrieval and ranking are untouched.
 */
function javaFieldDeclarations(parent: SymbolRecord) {
  if (parent.language !== "java") return [];
  return [
    ...(parent.body ?? parent.source ?? "").matchAll(
      /^\s*(?:(?:public|protected|private|static|final|transient|volatile)\s+)*[A-Za-z_$][\w$<>,.[\]\s]*?\s+[A-Za-z_$][\w$]*\s*(?:=[^;]*)?;/gm,
    ),
  ]
    .map((match) => match[0].trim())
    .filter((declaration) => !/[()]/.test(declaration));
}

/**
 * Compose a compact skeleton of the target's enclosing type: its own
 * declaration line, its field declarations and up to 12 member declaration
 * lines. Never a body, so this can never become a whole-class dump.
 */
export function composeSiblings(
  index: ProjectIndex,
  target: SymbolRecord,
  /** Symbols already in the slice: the skeleton must not repeat them. */
  alreadyIncluded: ReadonlySet<string> = new Set(),
): CompositionCandidate[] {
  const parent = target.parentId
    ? index.symbolById(target.parentId)
    : undefined;
  if (!parent || !TYPE_KINDS.has(parent.kind)) return [];
  const members = index
    .childrenOf(parent.id)
    .filter((symbol) => symbol.id !== target.id);
  if (!members.length) return [];

  const remaining = members.filter((member) => !alreadyIncluded.has(member.id));
  const shown = remaining
    .sort((a, b) => a.range.startLine - b.range.startLine)
    .slice(0, MAX_SKELETON_MEMBERS);
  const lines = [
    `// Enclosing type of ${target.name}`,
    declarationLine(parent),
    ...javaFieldDeclarations(parent).map((declaration) => `  ${declaration}`),
    ...shown.map((member) => `  ${declarationLine(member)}`),
  ];
  if (remaining.length > shown.length)
    lines.push(`  // … ${remaining.length - shown.length} more members`);
  const rendered = lines.join("\n");
  return [
    {
      symbol: parent,
      label: parent.qualifiedName ?? parent.name,
      reason: "enclosing type",
      evidence: [
        `${target.name} is declared in ${parent.name}; declaration lines only, ${shown.length} of ${members.length} members${
          members.length - remaining.length > 0
            ? `, ${members.length - remaining.length} already in the slice`
            : ""
        }`,
      ],
      rendered,
      estimatedTokens: estimateTokens(rendered),
      filePath: parent.filePath,
    },
  ];
}

/**
 * Compose each related file's top-level `use` declarations (Task 1's
 * synthetic per-file import symbol) into the slice, so a caller's imports
 * explain names the caller's skeleton references. Rust only: other
 * languages don't get a synthetic import symbol to find.
 */
export function composeImportContext(
  index: ProjectIndex,
  target: SymbolRecord,
  relatedFiles: ReadonlySet<string>,
  alreadyIncluded: ReadonlySet<string>,
): CompositionCandidate[] {
  if (target.language !== "rust") return [];
  const candidates: CompositionCandidate[] = [];
  const seen = new Set<string>();
  for (const file of relatedFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    const symbol = index.moduleScopeSymbol(file);
    if (!symbol || alreadyIncluded.has(symbol.id) || !symbol.source) continue;
    candidates.push({
      symbol,
      label: `Imports in ${file}`,
      reason: "file imports",
      evidence: [`file-level use declarations for ${file}`],
      rendered: symbol.source,
      estimatedTokens: estimateTokens(symbol.source),
      filePath: file,
    });
  }
  return candidates;
}

/**
 * Compose the route(s) that reach the target: a ROUTE_TO_HANDLER relation
 * whose source is the target itself, or an already-included caller of it
 * (recovering the controller→service direction when the target is a
 * service method one hop below the route handler). Java only: other
 * languages have no Spring MVC extractor to find relations from.
 */
/** Pull the injected field/param/setter name out of a DI relation's evidence text. */
function fieldOrParamName(evidence: string): string | undefined {
  return (
    evidence.match(/constructor parameter \S+ (\S+)/)?.[1] ??
    evidence.match(/@\w+ field \S+ (\S+)/)?.[1] ??
    evidence.match(/@\w+ setter (\w+)\(/)?.[1]
  );
}

function injectionMechanism(evidence: string): string {
  if (evidence.startsWith("constructor parameter"))
    return "constructor-injected";
  if (/@\w+ field /.test(evidence)) return "field-injected";
  if (/@\w+ setter /.test(evidence)) return "setter-injected";
  return "dependency-injected";
}

/**
 * Compose the dependencies the target's own type injects, but only the ones
 * relevant to this task: a dependency is surfaced only when the resolved
 * type owns a member already present in `relatedIds` (a direct caller or
 * callee already in the slice) — otherwise it's annotation spam. Java only:
 * other languages have no DI extractor to find relations from.
 */
export function composeDependencyContext(
  index: ProjectIndex,
  target: SymbolRecord,
  relatedIds: ReadonlySet<string>,
  alreadyIncluded: ReadonlySet<string>,
): CompositionCandidate[] {
  if (target.language !== "java") return [];

  let owner: SymbolRecord | undefined =
    target.kind === "class" ? target : undefined;
  let cursor = target.parentId ? index.symbolById(target.parentId) : undefined;
  while (!owner && cursor) {
    if (cursor.kind === "class") owner = cursor;
    else
      cursor = cursor.parentId ? index.symbolById(cursor.parentId) : undefined;
  }
  if (!owner) return [];

  const ownSymbolIds = new Set(
    index
      .childrenOf(owner.id)
      .filter((s) => s.kind === "constructor" || s.kind === "method")
      .map((s) => s.id),
  );
  ownSymbolIds.add(owner.id);

  const candidates: CompositionCandidate[] = [];
  const seenRelations = new Set<string>();
  for (const relation of index.enterpriseRelations) {
    if (relation.kind !== "INJECTS_DEPENDENCY") continue;
    if (relation.confidence === "unresolved") continue;
    if (!ownSymbolIds.has(relation.sourceSymbolId)) continue;
    if (!relation.targetSymbolId) continue;
    const dependencyMembers = index.childrenOf(relation.targetSymbolId);
    const isRelevant = dependencyMembers.some((s) => relatedIds.has(s.id));
    if (!isRelevant) continue;
    const key = `${relation.sourceSymbolId}:${relation.targetSymbolId}`;
    if (seenRelations.has(key)) continue;
    seenRelations.add(key);

    const evidence = relation.evidence[0] ?? "";
    const name = fieldOrParamName(evidence);
    const mechanism = injectionMechanism(evidence);
    const rendered = `// Dependency\n${owner.name}.${name ?? relation.targetLabel} → ${relation.targetLabel} (${mechanism})`;
    candidates.push({
      label: relation.targetLabel ?? "dependency",
      reason: "enterprise relation",
      evidence: relation.evidence,
      rendered,
      estimatedTokens: estimateTokens(rendered),
      filePath: relation.filePath,
    });
  }
  return candidates;
}

/**
 * Compose the transaction attributes carried by the target itself or by an
 * already-included caller/callee — a method's own @Transactional attributes
 * matter regardless of which symbol in the slice they belong to, since this
 * family's relations are already keyed directly to the method (no
 * class-ownership walk needed, unlike composeDependencyContext). Java only:
 * other languages have no @Transactional extractor to find relations from.
 */
export function composeTransactionContext(
  index: ProjectIndex,
  target: SymbolRecord,
  relatedIds: ReadonlySet<string>,
  alreadyIncluded: ReadonlySet<string>,
): CompositionCandidate[] {
  if (target.language !== "java") return [];
  const candidateIds = new Set([target.id, ...relatedIds]);
  const candidates: CompositionCandidate[] = [];
  for (const relation of index.enterpriseRelations) {
    if (relation.kind !== "TRANSACTION_BOUNDARY") continue;
    if (!candidateIds.has(relation.sourceSymbolId)) continue;
    // The method symbol is looked up only for a friendlier label/name; it is
    // never attached as `symbol` here, since it is always already in the
    // slice (as the target itself, or as an already-included caller/callee)
    // and the shared composition loop in buildPreview dedupes candidates by
    // symbol id — attaching it would silently drop this very candidate.
    const methodSymbol = index.symbolById(relation.sourceSymbolId);
    const name =
      methodSymbol?.qualifiedName ?? methodSymbol?.name ?? target.name;
    const rendered = `// Transaction\n${name} (${relation.targetLabel})`;
    candidates.push({
      label: relation.targetLabel ?? "transaction",
      reason: "enterprise relation",
      evidence: relation.evidence,
      rendered,
      estimatedTokens: estimateTokens(rendered),
      filePath: methodSymbol?.filePath ?? relation.filePath,
    });
  }
  return candidates;
}

const JPA_RELATION_KINDS = new Set([
  "ENTITY_RELATION",
  "PERSISTS_ENTITY",
  "REPOSITORY_QUERY",
]);

/** `"@OneToMany on field pets"` → `{ relKind: "OneToMany", field: "pets" }`. */
function entityRelationParts(evidence: string) {
  const match = evidence.match(/^@(\w+) on field (\w+)/);
  return { relKind: match?.[1], field: match?.[2] };
}

/** `"extends JpaRepository<Owner, Integer>"` → `"JpaRepository"`. */
function baseRepositoryName(evidence: string): string | undefined {
  return evidence.match(/extends\s+(\w+)/)?.[1];
}

/**
 * Compose the JPA entity relationships and Spring Data repository/query
 * facts relevant to the target: an ENTITY_RELATION owned by the target's
 * enclosing entity class (fields aren't indexed as symbols, so a member
 * target needs the class-ownership walk, same as composeDependencyContext),
 * or a PERSISTS_ENTITY/REPOSITORY_QUERY keyed directly to the target itself
 * (repository interface or query method are already indexed symbols, so no
 * walk is needed for those two). An ENTITY_RELATION is further gated by
 * relevance (its resolved target entity must own a member already in
 * `relatedIds`), same "no annotation spam" rule composeDependencyContext
 * applies — PERSISTS_ENTITY/REPOSITORY_QUERY don't need this, they're
 * already scoped to the single interface/method, not an owning class with
 * multiple children. Java only: other languages have no JPA/Spring Data
 * extractor to find relations from.
 */
export function composeJpaContext(
  index: ProjectIndex,
  target: SymbolRecord,
  relatedIds: ReadonlySet<string>,
  alreadyIncluded: ReadonlySet<string>,
): CompositionCandidate[] {
  if (target.language !== "java") return [];

  let owner: SymbolRecord | undefined =
    target.kind === "class" ? target : undefined;
  let cursor = target.parentId ? index.symbolById(target.parentId) : undefined;
  while (!owner && cursor) {
    if (cursor.kind === "class") owner = cursor;
    else
      cursor = cursor.parentId ? index.symbolById(cursor.parentId) : undefined;
  }

  const candidateIds = new Set([target.id, ...relatedIds]);
  if (owner) candidateIds.add(owner.id);

  const candidates: CompositionCandidate[] = [];
  const seenRelations = new Set<string>();
  for (const relation of index.enterpriseRelations) {
    if (!JPA_RELATION_KINDS.has(relation.kind)) continue;
    if (relation.confidence === "unresolved") continue;
    if (!candidateIds.has(relation.sourceSymbolId)) continue;
    // Unlike PERSISTS_ENTITY/REPOSITORY_QUERY (already keyed directly to the
    // interface/method, no class-ownership walk involved), an
    // ENTITY_RELATION is keyed to the whole owning class, so without a
    // relevance gate every relationship field on that class would surface
    // for any member target — same "no annotation spam" discipline as
    // composeDependencyContext: only surface it when its resolved target
    // entity type owns a member already in the slice.
    if (relation.kind === "ENTITY_RELATION") {
      if (!relation.targetSymbolId) continue;
      const targetMembers = index.childrenOf(relation.targetSymbolId);
      if (!targetMembers.some((s) => relatedIds.has(s.id))) continue;
    }
    // evidence[0] names the declaring field (e.g. "@ManyToOne on field
    // billingAddress"): without it, two distinct fields of the same kind on
    // the same class pointing at the same target type (billingAddress and
    // shippingAddress, both @ManyToOne Address) would collapse into one key
    // and silently drop the second relation.
    const key = `${relation.sourceSymbolId}:${relation.kind}:${relation.targetLabel ?? ""}:${relation.evidence[0] ?? ""}`;
    if (seenRelations.has(key)) continue;
    seenRelations.add(key);

    // The source symbol is looked up only for a friendlier label/name; it is
    // never attached as `symbol` here, since it may already be in the slice
    // (as the target itself, its enclosing class, or an already-included
    // relative) and the shared composition loop in buildPreview dedupes
    // candidates by symbol id — attaching it would silently drop this very
    // candidate.
    const sourceSymbol = index.symbolById(relation.sourceSymbolId);
    const name = sourceSymbol?.name ?? target.name;
    let rendered: string;
    if (relation.kind === "ENTITY_RELATION") {
      const { relKind, field } = entityRelationParts(
        relation.evidence[0] ?? "",
      );
      rendered = `// Entity relationship\n${name}${field ? `.${field}` : ""} → ${relation.targetLabel}${relKind ? ` (${relKind})` : ""}`;
    } else if (relation.kind === "PERSISTS_ENTITY") {
      const base = baseRepositoryName(relation.evidence[0] ?? "");
      rendered = `// Repository\n${name} → ${relation.targetLabel}${base ? ` (${base})` : ""}`;
    } else {
      rendered = `// Query\n${name} → ${relation.evidence.join(", ")}`;
    }

    candidates.push({
      label: relation.targetLabel ?? relation.kind,
      reason: "enterprise relation",
      evidence: relation.evidence,
      rendered,
      estimatedTokens: estimateTokens(rendered),
      filePath: sourceSymbol?.filePath ?? relation.filePath,
    });
  }
  return candidates;
}

export function composeRouteContext(
  index: ProjectIndex,
  target: SymbolRecord,
  relatedIds: ReadonlySet<string>,
  alreadyIncluded: ReadonlySet<string>,
): CompositionCandidate[] {
  if (target.language !== "java") return [];
  const candidateIds = new Set([target.id, ...relatedIds]);
  const candidates: CompositionCandidate[] = [];
  const seenRelations = new Set<string>();
  for (const relation of index.enterpriseRelations) {
    if (relation.kind !== "ROUTE_TO_HANDLER") continue;
    if (relation.confidence === "unresolved") continue;
    if (!candidateIds.has(relation.sourceSymbolId)) continue;
    const key = `${relation.sourceSymbolId}:${relation.kind}:${relation.targetLabel ?? ""}`;
    if (seenRelations.has(key)) continue;
    seenRelations.add(key);
    // The handler symbol is looked up only for a friendlier filePath; it is
    // never attached as `symbol` here, since it may already be in the slice
    // (as the target itself, or as an already-included caller) and the
    // shared composition loop in buildPreview dedupes candidates by symbol
    // id — attaching it would silently drop the very route line this
    // function exists to surface.
    const handlerSymbol = index.symbolById(relation.sourceSymbolId);
    const rendered = `// Route\n${relation.targetLabel} → ${handlerSymbol?.name ?? target.name}`;
    candidates.push({
      label: relation.targetLabel ?? "route",
      reason: "enterprise relation",
      evidence: relation.evidence,
      rendered,
      estimatedTokens: estimateTokens(rendered),
      filePath: handlerSymbol?.filePath ?? relation.filePath,
    });
  }
  return candidates;
}
