import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";
import {
  registerEnterpriseExtractor,
  registerEnterpriseResolver,
} from "./registry.js";

// Two-phase like jpa-entity.ts: provisional PERSISTS_ENTITY carries the raw entity simple
// name in targetLabel; this file's own resolver (separate from jpa-entity's, each file
// self-contained) applies the unique-simple-name rule. REPOSITORY_QUERY is a structural
// fact about the method itself, so it is emitted "exact" and never touched by the resolver.

const BASE_RE =
  /\b(?:JpaRepository|CrudRepository|PagingAndSortingRepository|Repository)\s*</g;
const DERIVED_RE = /^(?:find|exists|delete|count)By(?=[A-Z])/;

/** Strips a leading "@" and any dotted package prefix, e.g. "@org.springframework...Query" -> "Query". */
function bareName(annotation: string): string {
  return annotation.slice(annotation.lastIndexOf(".") + 1).replace("@", "");
}

/** Top-level type arguments of the `<...>` opening at `open`, or undefined if unbalanced. */
function typeArguments(
  text: string,
  open: number,
): { args: string[]; end: number } | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<") depth++;
    else if (ch === ">" && --depth === 0) {
      args.push(text.slice(start, i).trim());
      return { args, end: i + 1 };
    } else if (ch === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

/** First known base-repository supertype with exactly two plain type arguments. */
function repositoryShape(
  iface: SymbolRecord,
): { matched: string; entity: string; id: string } | undefined {
  const header = iface.source.slice(
    0,
    iface.source.includes("{") ? iface.source.indexOf("{") : undefined,
  );
  for (const m of header.matchAll(BASE_RE)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const parsed = typeArguments(header, open);
    if (!parsed || parsed.args.length !== 2) continue;
    const [entity, id] = parsed.args;
    // A generic entity argument (Map<String, Long>) names no single project type: drop, never guess.
    if (!/^[\w.]+$/.test(entity)) continue;
    return {
      matched: header.slice(m.index, parsed.end).replace(/\s+/g, " "),
      entity: entity.slice(entity.lastIndexOf(".") + 1),
      id,
    };
  }
  return undefined;
}

/** Split only where And/Or sits between a lowercase/digit end and an uppercase start. */
function derivedProperties(name: string): string[] | undefined {
  if (!DERIVED_RE.test(name)) return undefined;
  return name
    .replace(DERIVED_RE, "")
    .split(/(?<=[a-z0-9])(?:And|Or)(?=[A-Z])/)
    .filter(Boolean)
    .map((seg) => `property: ${seg[0].toLowerCase()}${seg.slice(1)}`);
}

/**
 * Verbatim @Query(...) argument text (string-literal aware); undefined if absent/unbalanced.
 * Detection of whether @Query is present happens via SymbolRecord.annotations first -- never
 * via the search regex below on its own, which previously matched inside comments or string
 * literals anywhere in the method's source (a method body, not just its header, can contain
 * arbitrary text). The qualified-name-tolerant prefix mirrors every prior phase's fix for a
 * fully-qualified annotation name.
 */
function queryText(method: SymbolRecord): string | undefined {
  if (!method.annotations.some((a) => bareName(a) === "Query"))
    return undefined;
  const at = method.source.search(/@(?:[\w.]+\.)?Query\s*\(/);
  if (at === -1) return undefined;
  const open = method.source.indexOf("(", at);
  let depth = 0;
  let inString = false;
  for (let i = open; i < method.source.length; i++) {
    const ch = method.source[i];
    if (ch === '"' && method.source[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0)
      return method.source.slice(open + 1, i).trim();
  }
  return undefined;
}

function extractSpringData(
  symbols: SymbolRecord[],
  filePath: string,
  _source: string,
): EnterpriseRelation[] {
  const relations: EnterpriseRelation[] = [];
  const repositories = new Set<string>();
  for (const iface of symbols) {
    if (iface.filePath !== filePath || iface.kind !== "interface") continue;
    const shape = repositoryShape(iface);
    if (!shape) continue;
    repositories.add(iface.id);
    relations.push({
      kind: "PERSISTS_ENTITY",
      family: "spring-data-jpa",
      sourceSymbolId: iface.id,
      targetLabel: shape.entity,
      confidence: "unresolved", // provisional until resolvePersistsEntity runs
      evidence: [`extends ${shape.matched}`, `id type: ${shape.id}`],
      range: iface.range,
      filePath,
    });
  }
  for (const method of symbols) {
    if (
      method.kind !== "method" ||
      !method.parentId ||
      !repositories.has(method.parentId)
    )
      continue;
    const properties = derivedProperties(method.name);
    const query = queryText(method);
    if (!properties && query === undefined) continue;
    relations.push({
      kind: "REPOSITORY_QUERY",
      family: "spring-data-jpa",
      sourceSymbolId: method.id,
      targetLabel: properties
        ? `${method.name.match(DERIVED_RE)![0]}: ${properties.map((p) => p.slice(10)).join(", ")}`
        : "query",
      confidence: "exact",
      evidence: [
        ...(properties ?? []),
        ...(query !== undefined ? [query] : []),
      ],
      range: method.range,
      filePath,
    });
  }
  return relations;
}

/** Same rule as DI bean identity: 1 match exact, 0 dropped, 2+ unresolved (never guessed). */
function resolvePersistsEntity(
  relations: EnterpriseRelation[],
  allSymbols: SymbolRecord[],
): EnterpriseRelation[] {
  const projectTypes = allSymbols.filter(
    (s) => s.kind === "class" || s.kind === "interface",
  );
  return relations.flatMap((r) => {
    if (r.kind !== "PERSISTS_ENTITY" || r.family !== "spring-data-jpa")
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

/**
 * Real-repository finding (petclinic-rest): a "plain" repository interface with NO generic of
 * its own (e.g. `OwnerRepository`, no `<Entity, Id>`) declares the derived-query methods the
 * service layer actually calls, while a separate sibling (e.g. `SpringDataOwnerRepository`)
 * `extends OwnerRepository, Repository<Owner, Integer>` and re-declares only SOME of them. Under
 * per-file extraction alone, the plain interface's methods get zero REPOSITORY_QUERY relations,
 * because repositoryShape() only recognizes an interface that itself carries the `<Entity, Id>`
 * generic. This resolver closes that gap: once an interface's PERSISTS_ENTITY has resolved
 * "exact" (so we know its entity with certainty, never a guess), walk its own supertype chain
 * (SymbolRecord.supertypes — plain identifier list, already stripped of generics by the parser)
 * and, for every reachable supertype that is itself a project interface with NO generic shape of
 * its own (so it wasn't already extracted directly), run the exact same derived-query/@Query
 * extraction on its methods, attributing REPOSITORY_QUERY relations to the SAME entity the
 * subinterface resolved. A supertype name that doesn't resolve to exactly one project interface
 * (ambiguous or external, e.g. the framework's own `Repository`) is skipped, never guessed —
 * same discipline as resolvePersistsEntity and resolveEntityRelations.
 *
 * ponytail: SymbolRecord.supertypes (java-parser.ts) is built from a regex that stops at the
 * first `<`, so a supertype list like `extends Repository<Owner, Integer>, OwnerRepository`
 * (generic-bearing supertype listed FIRST) loses `OwnerRepository` entirely — this only works
 * reliably when the plain supertype is listed before the generic one, which happens to be every
 * real occurrence seen so far (petclinic-rest always writes the plain interface first). If a
 * real repository is found with the generic-first ordering, the parser's supertypes regex needs
 * fixing (shared file — full shared-file discipline applies), not this resolver.
 */
function resolveRepositoryQueryPropagation(
  relations: EnterpriseRelation[],
  allSymbols: SymbolRecord[],
): EnterpriseRelation[] {
  const persistsByInterface = new Map<string, EnterpriseRelation>();
  for (const r of relations) {
    if (
      r.kind === "PERSISTS_ENTITY" &&
      r.family === "spring-data-jpa" &&
      r.confidence === "exact"
    ) {
      persistsByInterface.set(r.sourceSymbolId, r);
    }
  }
  if (persistsByInterface.size === 0) return relations;

  const interfacesByName = new Map<string, SymbolRecord[]>();
  const interfaceById = new Map<string, SymbolRecord>();
  for (const s of allSymbols) {
    if (s.kind !== "interface") continue;
    interfaceById.set(s.id, s);
    const list = interfacesByName.get(s.name) ?? [];
    list.push(s);
    interfacesByName.set(s.name, list);
  }

  const existingQuerySources = new Set(
    relations
      .filter(
        (r) => r.kind === "REPOSITORY_QUERY" && r.family === "spring-data-jpa",
      )
      .map((r) => r.sourceSymbolId),
  );

  const added: EnterpriseRelation[] = [];
  for (const ifaceId of persistsByInterface.keys()) {
    const iface = interfaceById.get(ifaceId);
    if (!iface) continue;
    const visited = new Set<string>([iface.id]);
    const queue = [...(iface.supertypes ?? [])];
    while (queue.length) {
      const name = queue.shift()!;
      const candidates = interfacesByName.get(name);
      if (!candidates || candidates.length !== 1) continue; // unresolved/ambiguous/external: never guess
      const supIface = candidates[0];
      if (visited.has(supIface.id)) continue;
      visited.add(supIface.id);
      queue.push(...(supIface.supertypes ?? []));
      if (persistsByInterface.has(supIface.id)) continue; // has its own generic: already extracted directly

      for (const method of allSymbols) {
        if (method.kind !== "method" || method.parentId !== supIface.id)
          continue;
        if (existingQuerySources.has(method.id)) continue;
        const properties = derivedProperties(method.name);
        const query = queryText(method);
        if (!properties && query === undefined) continue;
        added.push({
          kind: "REPOSITORY_QUERY",
          family: "spring-data-jpa",
          sourceSymbolId: method.id,
          targetLabel: properties
            ? `${method.name.match(DERIVED_RE)![0]}: ${properties.map((p) => p.slice(10)).join(", ")}`
            : "query",
          confidence: "exact",
          evidence: [
            ...(properties ?? []),
            ...(query !== undefined ? [query] : []),
            `propagated from ${supIface.name} via ${iface.name}`,
          ],
          range: method.range,
          filePath: method.filePath,
        });
        existingQuerySources.add(method.id);
      }
    }
  }
  return added.length === 0 ? relations : [...relations, ...added];
}

registerEnterpriseExtractor(extractSpringData);
registerEnterpriseResolver(resolvePersistsEntity);
registerEnterpriseResolver(resolveRepositoryQueryPropagation);
