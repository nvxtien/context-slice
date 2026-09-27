// Task 4 (v1.4 Phase 2): measures whether the real dependency-injection extractor
// (src/languages/java/enterprise/dependency-injection.ts) recovers the correct
// INJECTS_DEPENDENCY relation on real repositories, graded against the independent oracle in
// benchmarks/java-enterprise-di-oracle.ts (never the extractor grading itself).
//
// Oracle design note: the oracle records raw injection points (file, className, kind, typeName)
// without judging bean identity. This script independently judges, from the oracle's OWN
// project-type-name scan (projectTypeNameCounts — a plain `class/interface/enum/record NAME`
// regex over every file, nothing shared with the product), whether each oracle entry's type is a
// unique project bean (should resolve "exact"), an ambiguous one (should be absent or
// "unresolved"), or external (should produce no relation at all) — so the grading is never
// circular on the extractor's own resolution logic.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import {
  extractOracleDependencyInjection,
  projectTypeNameCounts,
  type OracleEntry,
} from "./java-enterprise-di-oracle.js";

type Repository = { id: string; source: string };
type FailureCategory =
  | "ANNOTATION_EXTRACTION"
  | "DI_RESOLUTION"
  | "CONTEXT_COMPOSITION"
  | "TOKEN_BUDGET"
  | "GROUND_TRUTH"
  | "UNKNOWN";

type Miss = { repo: string; oracle: OracleEntry; expectedBean: "unique" | "ambiguous" | "external"; category: FailureCategory; detail: string };
type FalsePositive = { repo: string; filePath: string; targetLabel: string | undefined; detail: string };

const root = process.cwd();
const outDir = join(root, "benchmarks/results");
mkdirSync(outDir, { recursive: true });

const repositories = JSON.parse(readFileSync(join(root, "benchmarks/repositories.json"), "utf8")) as Repository[];
const targets = repositories.filter((r) => r.id === "spring-petclinic" || r.id === "petclinic-rest");

let oracleBeanTotal = 0; // only entries whose type is a genuine, uniquely-resolvable project bean
let matched = 0;
let falsePositiveCount = 0;
const misses: Miss[] = [];
const falsePositives: FalsePositive[] = [];
type KindCounts = { oracleTotal: number; oracleBeanTotal: number; matched: number };
type RepoStats = {
  oracleTotal: number;
  oracleBeanTotal: number;
  matched: number;
  falsePositives: number;
  byKind: Record<"constructor" | "field" | "setter", KindCounts>;
};
function emptyKindCounts(): Record<"constructor" | "field" | "setter", KindCounts> {
  return {
    constructor: { oracleTotal: 0, oracleBeanTotal: 0, matched: 0 },
    field: { oracleTotal: 0, oracleBeanTotal: 0, matched: 0 },
    setter: { oracleTotal: 0, oracleBeanTotal: 0, matched: 0 },
  };
}
const perRepo: Record<string, RepoStats> = {};

for (const repo of targets) {
  const repoRoot = join(root, repo.source);
  const oracleEntries = extractOracleDependencyInjection(repoRoot, repo.id);
  const typeNameCounts = projectTypeNameCounts(repoRoot);
  perRepo[repo.id] = { oracleTotal: oracleEntries.length, oracleBeanTotal: 0, matched: 0, falsePositives: 0, byKind: emptyKindCounts() };
  for (const e of oracleEntries) perRepo[repo.id].byKind[e.injectionKind].oracleTotal++;

  const index = new ProjectIndex(repoRoot);
  index.rebuild();
  // Scoped to src/main/java to match the oracle's own scope (brief Step 1) — src/test/java has
  // real, legitimate @Autowired test fixtures the oracle never looked at, so including them here
  // would count genuine extractor hits as spurious false positives (an oracle-scope mismatch,
  // not an extractor defect).
  const diRelations = index.enterpriseRelations.filter(
    (r) => r.kind === "INJECTS_DEPENDENCY" && r.filePath.startsWith("src/main/java/"),
  );

  const claimedRelations = new Set<typeof diRelations[number]>();

  for (const oracle of oracleEntries) {
    const count = typeNameCounts.get(oracle.typeName) ?? 0;
    const expectedBean: "unique" | "ambiguous" | "external" = count === 1 ? "unique" : count > 1 ? "ambiguous" : "external";

    // Find the source symbol this oracle entry should be attributed to: the class (field/setter
    // container) for field/setter kinds is resolved differently per the product's own documented
    // design (field -> class symbol; setter -> setter method symbol; constructor -> ctor symbol).
    let candidateRelations;
    if (oracle.injectionKind === "constructor") {
      const ctor = index.symbols.find(
        (s) =>
          s.filePath === oracle.file &&
          s.kind === "constructor" &&
          s.name === oracle.className &&
          s.range.startLine <= oracle.startLine &&
          oracle.startLine <= s.range.endLine,
      );
      candidateRelations = ctor ? diRelations.filter((r) => r.sourceSymbolId === ctor.id) : [];
    } else if (oracle.injectionKind === "field") {
      const cls = index.symbols.find((s) => s.filePath === oracle.file && s.kind === "class" && s.name === oracle.className);
      candidateRelations = cls ? diRelations.filter((r) => r.sourceSymbolId === cls.id) : [];
    } else {
      const setter = index.symbols.find(
        (s) => s.filePath === oracle.file && s.kind === "method" && s.name === oracle.memberName,
      );
      candidateRelations = setter ? diRelations.filter((r) => r.sourceSymbolId === setter.id) : [];
    }

    const relation = candidateRelations.find((r) => r.targetLabel === oracle.typeName);

    if (expectedBean === "unique") {
      oracleBeanTotal++;
      perRepo[repo.id].oracleBeanTotal++;
      perRepo[repo.id].byKind[oracle.injectionKind].oracleBeanTotal++;
      if (!relation) {
        misses.push({
          repo: repo.id,
          oracle,
          expectedBean,
          category: candidateRelations.length === 0 ? "ANNOTATION_EXTRACTION" : "DI_RESOLUTION",
          detail:
            candidateRelations.length === 0
              ? "Extractor produced no INJECTS_DEPENDENCY relation for this injection point at all."
              : `Extractor produced relation(s) for this source but none with targetLabel="${oracle.typeName}" (got: ${candidateRelations.map((r) => r.targetLabel).join(", ") || "none"}).`,
        });
        continue;
      }
      if (relation.confidence !== "exact") {
        misses.push({
          repo: repo.id,
          oracle,
          expectedBean,
          category: "DI_RESOLUTION",
          detail: `Type "${oracle.typeName}" is a unique project bean but relation confidence="${relation.confidence}" (expected "exact").`,
        });
        claimedRelations.add(relation);
        continue;
      }
      matched++;
      perRepo[repo.id].matched++;
      perRepo[repo.id].byKind[oracle.injectionKind].matched++;
      claimedRelations.add(relation);
    } else {
      // Ambiguous or external: a relation is fine as long as it is never "exact" (never a
      // fabricated bean identity — §13). Absent, or present-and-unresolved, are both correct.
      if (relation) claimedRelations.add(relation);
      if (relation && relation.confidence === "exact") {
        misses.push({
          repo: repo.id,
          oracle,
          expectedBean,
          category: "DI_RESOLUTION",
          detail: `Type "${oracle.typeName}" is ${expectedBean} (project-type count=${count}) but extractor claimed confidence="exact" (targetSymbolId=${relation.targetSymbolId}) — a fabricated bean identity.`,
        });
        falsePositives.push({
          repo: repo.id,
          filePath: relation.filePath,
          targetLabel: relation.targetLabel,
          detail: `"exact" relation for a non-unique/external type "${oracle.typeName}" (project-type count=${count}).`,
        });
      }
    }
  }

  // Extra "exact" relations the oracle has no corresponding injection point for at all — false
  // positives per plan §57 (real DI relations must trace to a real injection point).
  for (const relation of diRelations) {
    if (relation.confidence !== "exact") continue;
    if (claimedRelations.has(relation)) continue;
    falsePositives.push({
      repo: repo.id,
      filePath: relation.filePath,
      targetLabel: relation.targetLabel,
      detail: "Extractor emitted an \"exact\" INJECTS_DEPENDENCY relation the oracle has no corresponding injection point for.",
    });
  }
}

falsePositiveCount = falsePositives.length;
for (const fp of falsePositives) perRepo[fp.repo].falsePositives++;

const dependency_linkage_recall = oracleBeanTotal ? matched / oracleBeanTotal : 1;
const dependency_linkage_precision = matched + falsePositiveCount ? matched / (matched + falsePositiveCount) : 1;

const failureAttribution: Record<FailureCategory, number> = {
  ANNOTATION_EXTRACTION: 0,
  DI_RESOLUTION: 0,
  CONTEXT_COMPOSITION: 0,
  TOKEN_BUDGET: 0,
  GROUND_TRUTH: 0,
  UNKNOWN: 0,
};
for (const m of misses) failureAttribution[m.category]++;

const results = {
  generatedAt: new Date().toISOString(),
  oracleBeanTotal,
  matched,
  falsePositiveCount,
  dependency_linkage_recall,
  dependency_linkage_precision,
  perRepo,
  failureAttribution,
  misses,
  falsePositives,
};

writeFileSync(join(outDir, "v1.4-phase2-dependency-injection.json"), JSON.stringify(results, null, 2) + "\n");

console.log(`Oracle bean total: ${oracleBeanTotal}, matched: ${matched}, false positives: ${falsePositiveCount}`);
console.log(`dependency_linkage_recall: ${(dependency_linkage_recall * 100).toFixed(1)}%`);
console.log(`dependency_linkage_precision: ${(dependency_linkage_precision * 100).toFixed(1)}%`);
console.log("Failure attribution:", failureAttribution);
for (const [repoId, stats] of Object.entries(perRepo)) {
  console.log(
    `${repoId} sample composition: constructor=${stats.byKind.constructor.oracleTotal}` +
      ` field=${stats.byKind.field.oracleTotal} setter=${stats.byKind.setter.oracleTotal}` +
      ` (unique-bean/matched: ctor ${stats.byKind.constructor.matched}/${stats.byKind.constructor.oracleBeanTotal},` +
      ` field ${stats.byKind.field.matched}/${stats.byKind.field.oracleBeanTotal},` +
      ` setter ${stats.byKind.setter.matched}/${stats.byKind.setter.oracleBeanTotal})`,
  );
}
if (existsSync(join(outDir, "v1.4-phase2-dependency-injection.json"))) {
  console.log("Wrote benchmarks/results/v1.4-phase2-dependency-injection.json");
}
