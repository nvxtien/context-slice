// Task 5 (v1.4 Phase 4): measures whether the real JPA/Spring Data extractors
// (src/languages/java/enterprise/jpa-entity.ts, spring-data.ts) recover the correct
// ENTITY_RELATION / PERSISTS_ENTITY / REPOSITORY_QUERY relations on real repositories, graded
// against the independent oracle in benchmarks/java-enterprise-jpa-oracle.ts (never the
// extractor grading itself). Mirrors the structure of benchmarks/v1.4-phase3-transactions.ts.
//
// Two genuinely separate mechanisms get two separate recall/precision pairs, per the task brief:
// - entity_relation_recall/precision: ENTITY_RELATION (JPA field relationships)
// - repository_linkage_recall/precision: PERSISTS_ENTITY + REPOSITORY_QUERY together (both are
//   facts about a repository interface; splitting them further would be noise, not signal, since
//   REPOSITORY_QUERY only exists at all once PERSISTS_ENTITY has resolved its owning interface).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import type { SymbolRecord } from "../src/types/model.js";
import {
  extractOracleJpaSpringData,
  type EntityRelationEntry,
  type PersistsEntityEntry,
  type RepositoryQueryEntry,
} from "./java-enterprise-jpa-oracle.js";

type Repository = { id: string; source: string };
type FailureCategory =
  | "ENTITY_NOT_FOUND"
  | "RELATION_NOT_EXTRACTED"
  | "ATTRIBUTE_MISMATCH"
  | "TARGET_RESOLUTION"
  | "INTERFACE_NOT_FOUND"
  | "METHOD_NOT_FOUND"
  | "PERSISTS_ENTITY_MISSING"
  | "REPOSITORY_QUERY_MISSING"
  | "UNKNOWN";

type EntityMiss = { repo: string; oracle: EntityRelationEntry; category: FailureCategory; detail: string };
type PersistsMiss = { repo: string; oracle: PersistsEntityEntry; category: FailureCategory; detail: string };
type QueryMiss = { repo: string; oracle: RepositoryQueryEntry; category: FailureCategory; detail: string };
type FalsePositive = { repo: string; kind: string; filePath: string; targetLabel: string | undefined; detail: string };

const root = process.cwd();
const outDir = join(root, "benchmarks/results");
mkdirSync(outDir, { recursive: true });

const repositories = JSON.parse(readFileSync(join(root, "benchmarks/repositories.json"), "utf8")) as Repository[];
const targets = repositories.filter((r) => r.id === "spring-petclinic" || r.id === "petclinic-rest");

/** Balanced, string-aware paramCount for a method SymbolRecord's own declaration text —
 * independent of the oracle's own splitExtendsList/parseMethod (small re-derivation, per every
 * prior phase's discipline of not sharing parsing helpers between oracle and eval script). */
function paramCountOf(symbol: SymbolRecord): number {
  const text = symbol.source;
  const nameIdx = text.indexOf(symbol.name);
  if (nameIdx === -1) return -1;
  const openIdx = text.indexOf("(", nameIdx);
  if (openIdx === -1) return -1;
  let depth = 0;
  let inString = false;
  let closeIdx = -1;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return -1;
  const paramsText = text.slice(openIdx + 1, closeIdx).trim();
  if (paramsText === "") return 0;
  // top-level comma split, angle-depth aware (generic params like Map<String, Long> x)
  let angleDepth = 0;
  let count = 1;
  for (const ch of paramsText) {
    if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth--;
    else if (ch === "," && angleDepth === 0) count++;
  }
  return count;
}

let entityOracleTotal = 0;
let entityMatched = 0;
const entityMisses: EntityMiss[] = [];
const entityFalsePositives: FalsePositive[] = [];

let linkageOracleTotal = 0;
let linkageMatched = 0;
const persistsMisses: PersistsMiss[] = [];
const queryMisses: QueryMiss[] = [];
const linkageFalsePositives: FalsePositive[] = [];

type RepoStats = {
  entityOracleTotal: number;
  entityMatched: number;
  linkageOracleTotal: number;
  linkageMatched: number;
};
const perRepo: Record<string, RepoStats> = {};

for (const repo of targets) {
  const repoRoot = join(root, repo.source);
  const oracle = extractOracleJpaSpringData(repoRoot, repo.id);
  perRepo[repo.id] = { entityOracleTotal: oracle.entityRelations.length, entityMatched: 0, linkageOracleTotal: oracle.persistsEntity.length + oracle.repositoryQueries.length, linkageMatched: 0 };

  const index = new ProjectIndex(repoRoot);
  index.rebuild();
  const entityRelations = index.enterpriseRelations.filter((r) => r.kind === "ENTITY_RELATION" && r.family === "spring-data-jpa");
  const persistsRelations = index.enterpriseRelations.filter((r) => r.kind === "PERSISTS_ENTITY" && r.family === "spring-data-jpa");
  const queryRelations = index.enterpriseRelations.filter((r) => r.kind === "REPOSITORY_QUERY" && r.family === "spring-data-jpa");

  const claimedEntity = new Set<(typeof entityRelations)[number]>();
  const claimedPersists = new Set<(typeof persistsRelations)[number]>();
  const claimedQuery = new Set<(typeof queryRelations)[number]>();

  // ---- ENTITY_RELATION grading ----
  for (const oe of oracle.entityRelations) {
    entityOracleTotal++;

    const entitySymbol = index.symbols.find((s) => s.filePath === oe.file && s.kind === "class" && s.name === oe.entityClass);
    if (!entitySymbol) {
      entityMisses.push({ repo: repo.id, oracle: oe, category: "ENTITY_NOT_FOUND", detail: `No class-kind symbol "${oe.entityClass}" found in ${oe.file}.` });
      continue;
    }

    const candidates = entityRelations.filter((r) => r.sourceSymbolId === entitySymbol.id);
    const fieldTag = `@${oe.relationKind} on field ${oe.fieldName}`;
    const relation = candidates.find((r) => r.evidence.includes(fieldTag));
    if (!relation) {
      entityMisses.push({
        repo: repo.id,
        oracle: oe,
        category: "RELATION_NOT_EXTRACTED",
        detail: `Entity "${oe.entityClass}" has no ENTITY_RELATION with evidence "${fieldTag}" (candidates: ${candidates.map((r) => r.evidence[0]).join(" | ") || "none"}).`,
      });
      continue;
    }

    const expectedAttrs = [
      oe.mappedBy !== undefined ? `mappedBy = "${oe.mappedBy}"` : undefined,
      oe.fetch !== undefined ? `fetch = ${oe.fetch}` : undefined,
      oe.cascade !== undefined ? `cascade = ${oe.cascade}` : undefined,
    ].filter((x): x is string => x !== undefined);
    const missingAttrs = expectedAttrs.filter((a) => !relation.evidence.includes(a));
    const joinColumnOk = oe.joinColumn === undefined || relation.evidence.some((e) => e.startsWith("@JoinColumn(") && e.includes(oe.joinColumn!));
    if (missingAttrs.length > 0 || !joinColumnOk) {
      entityMisses.push({
        repo: repo.id,
        oracle: oe,
        category: "ATTRIBUTE_MISMATCH",
        detail: `Field "${oe.fieldName}" on "${oe.entityClass}" matched relation kind but evidence is missing: ${[...missingAttrs, ...(joinColumnOk ? [] : [`@JoinColumn(${oe.joinColumn})`])].join(", ")} (got: ${relation.evidence.join(" | ")}).`,
      });
      claimedEntity.add(relation);
      continue;
    }

    // Target resolution: unique-simple-name rule — targetSymbolId set iff exactly one project
    // type shares the target's simple name.
    const targetCandidates = index.symbols.filter((s) => (s.kind === "class" || s.kind === "interface") && s.name === oe.targetSimpleName);
    if (targetCandidates.length === 1) {
      if (relation.targetSymbolId !== targetCandidates[0].id || relation.confidence !== "exact") {
        entityMisses.push({
          repo: repo.id,
          oracle: oe,
          category: "TARGET_RESOLUTION",
          detail: `Field "${oe.fieldName}" -> "${oe.targetSimpleName}" is uniquely resolvable but relation has confidence="${relation.confidence}" targetSymbolId="${relation.targetSymbolId}" (expected exact match to ${targetCandidates[0].id}).`,
        });
        claimedEntity.add(relation);
        continue;
      }
    }

    entityMatched++;
    perRepo[repo.id].entityMatched++;
    claimedEntity.add(relation);
  }

  for (const relation of entityRelations) {
    if (claimedEntity.has(relation)) continue;
    entityFalsePositives.push({ repo: repo.id, kind: "ENTITY_RELATION", filePath: relation.filePath, targetLabel: relation.targetLabel, detail: "Extractor emitted an ENTITY_RELATION the oracle has no corresponding field-level annotation for." });
  }

  // ---- PERSISTS_ENTITY grading ----
  for (const pe of oracle.persistsEntity) {
    linkageOracleTotal++;

    const ifaceSymbol = index.symbols.find((s) => s.filePath === pe.file && s.kind === "interface" && s.name === pe.interfaceName);
    if (!ifaceSymbol) {
      persistsMisses.push({ repo: repo.id, oracle: pe, category: "INTERFACE_NOT_FOUND", detail: `No interface-kind symbol "${pe.interfaceName}" found in ${pe.file}.` });
      continue;
    }

    const candidates = persistsRelations.filter((r) => r.sourceSymbolId === ifaceSymbol.id);
    if (candidates.length === 0) {
      persistsMisses.push({ repo: repo.id, oracle: pe, category: "PERSISTS_ENTITY_MISSING", detail: `Interface "${pe.interfaceName}" produced no PERSISTS_ENTITY relation at all.` });
      continue;
    }

    const entityCandidates = index.symbols.filter((s) => (s.kind === "class" || s.kind === "interface") && s.name === pe.entitySimpleName);
    const expectSymbolId = entityCandidates.length === 1 ? entityCandidates[0].id : undefined;
    const relation = candidates.find((r) => (expectSymbolId ? r.targetSymbolId === expectSymbolId && r.confidence === "exact" : r.targetLabel === pe.entitySimpleName));
    if (!relation) {
      persistsMisses.push({
        repo: repo.id,
        oracle: pe,
        category: "TARGET_RESOLUTION",
        detail: `Interface "${pe.interfaceName}" has a PERSISTS_ENTITY relation but it does not resolve to entity "${pe.entitySimpleName}" (got targetSymbolId="${candidates[0].targetSymbolId}" confidence="${candidates[0].confidence}").`,
      });
      claimedPersists.add(candidates[0]);
      continue;
    }

    linkageMatched++;
    perRepo[repo.id].linkageMatched++;
    claimedPersists.add(relation);
  }

  for (const relation of persistsRelations) {
    if (claimedPersists.has(relation)) continue;
    linkageFalsePositives.push({ repo: repo.id, kind: "PERSISTS_ENTITY", filePath: relation.filePath, targetLabel: relation.targetLabel, detail: "Extractor emitted a PERSISTS_ENTITY relation the oracle has no corresponding <Entity,Id>-shaped interface for." });
  }

  // ---- REPOSITORY_QUERY grading ----
  // Ground truth is entity-level ("this repository has this queryable method"), not tied to a
  // single symbol: a method may legitimately be declared on more than one interface in the same
  // repository family (a plain interface + its @Override sibling). Any one of those declaration
  // sites carrying a REPOSITORY_QUERY relation satisfies the fact.
  for (const qe of oracle.repositoryQueries) {
    linkageOracleTotal++;

    const methodSymbols = qe.declaredIn.flatMap((file) =>
      index.symbols.filter((s) => s.filePath === file && s.kind === "method" && s.name === qe.methodName && paramCountOf(s) === qe.paramCount),
    );
    if (methodSymbols.length === 0) {
      queryMisses.push({
        repo: repo.id,
        oracle: qe,
        category: "METHOD_NOT_FOUND",
        detail: `No method-kind symbol "${qe.methodName}" (paramCount=${qe.paramCount}) found in any of [${qe.declaredIn.join(", ")}].`,
      });
      continue;
    }

    // A method can legitimately be declared on more than one interface in the family (a plain
    // interface plus its @Override sibling): claim every matching relation found across all
    // declaring symbols, not just the first, so a second, equally-correct relation for the SAME
    // oracle fact is never left over as an unclaimed "false positive".
    const foundRelations = methodSymbols.flatMap((sym) => queryRelations.filter((r) => r.sourceSymbolId === sym.id));
    const relation = foundRelations[0];
    for (const r of foundRelations) claimedQuery.add(r);
    if (!relation) {
      queryMisses.push({
        repo: repo.id,
        oracle: qe,
        category: "REPOSITORY_QUERY_MISSING",
        detail: `Entity "${qe.entitySimpleName}" repository method "${qe.methodName}"/${qe.paramCount} (declared in [${qe.declaredIn.join(", ")}]) has no REPOSITORY_QUERY relation on any of its declaring symbols.`,
      });
      continue;
    }

    linkageMatched++;
    perRepo[repo.id].linkageMatched++;
    claimedQuery.add(relation);
  }

  for (const relation of queryRelations) {
    if (claimedQuery.has(relation)) continue;
    linkageFalsePositives.push({ repo: repo.id, kind: "REPOSITORY_QUERY", filePath: relation.filePath, targetLabel: relation.targetLabel, detail: "Extractor emitted a REPOSITORY_QUERY relation the oracle has no corresponding derived-query/@Query method for." });
  }
}

const entityFalsePositiveCount = entityFalsePositives.length;
const linkageFalsePositiveCount = linkageFalsePositives.length;

const entity_relation_recall = entityOracleTotal ? entityMatched / entityOracleTotal : 1;
const entity_relation_precision = entityMatched + entityFalsePositiveCount ? entityMatched / (entityMatched + entityFalsePositiveCount) : 1;
const repository_linkage_recall = linkageOracleTotal ? linkageMatched / linkageOracleTotal : 1;
const repository_linkage_precision = linkageMatched + linkageFalsePositiveCount ? linkageMatched / (linkageMatched + linkageFalsePositiveCount) : 1;

const entityFailureAttribution: Record<string, number> = {};
for (const m of entityMisses) entityFailureAttribution[m.category] = (entityFailureAttribution[m.category] ?? 0) + 1;
const linkageFailureAttribution: Record<string, number> = {};
for (const m of [...persistsMisses, ...queryMisses]) linkageFailureAttribution[m.category] = (linkageFailureAttribution[m.category] ?? 0) + 1;

const results = {
  generatedAt: new Date().toISOString(),
  entity_relation: {
    oracleTotal: entityOracleTotal,
    matched: entityMatched,
    falsePositiveCount: entityFalsePositiveCount,
    recall: entity_relation_recall,
    precision: entity_relation_precision,
    failureAttribution: entityFailureAttribution,
    misses: entityMisses,
    falsePositives: entityFalsePositives,
  },
  repository_linkage: {
    oracleTotal: linkageOracleTotal,
    matched: linkageMatched,
    falsePositiveCount: linkageFalsePositiveCount,
    recall: repository_linkage_recall,
    precision: repository_linkage_precision,
    failureAttribution: linkageFailureAttribution,
    persistsMisses,
    queryMisses,
    falsePositives: linkageFalsePositives,
  },
  perRepo,
};

writeFileSync(join(outDir, "v1.4-phase4-jpa-spring-data.json"), JSON.stringify(results, null, 2) + "\n");

console.log(`entity_relation: oracle=${entityOracleTotal} matched=${entityMatched} falsePositives=${entityFalsePositiveCount}`);
console.log(`entity_relation_recall: ${(entity_relation_recall * 100).toFixed(1)}%  entity_relation_precision: ${(entity_relation_precision * 100).toFixed(1)}%`);
console.log(`repository_linkage: oracle=${linkageOracleTotal} matched=${linkageMatched} falsePositives=${linkageFalsePositiveCount}`);
console.log(`repository_linkage_recall: ${(repository_linkage_recall * 100).toFixed(1)}%  repository_linkage_precision: ${(repository_linkage_precision * 100).toFixed(1)}%`);
console.log("entity_relation failure attribution:", entityFailureAttribution);
console.log("repository_linkage failure attribution:", linkageFailureAttribution);
for (const [repoId, stats] of Object.entries(perRepo)) {
  console.log(`${repoId}: entity ${stats.entityMatched}/${stats.entityOracleTotal}  linkage ${stats.linkageMatched}/${stats.linkageOracleTotal}`);
}
console.log("Wrote benchmarks/results/v1.4-phase4-jpa-spring-data.json");
