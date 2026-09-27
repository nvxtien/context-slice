// Task 4 (v1.4 Phase 1): measures whether the real Spring MVC route extractor
// (src/languages/java/enterprise/spring-mvc.ts) recovers the correct ROUTE_TO_HANDLER
// relation on real repositories, graded against the independent oracle in
// benchmarks/java-enterprise-route-oracle.ts (never the extractor grading itself).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { extractOracleRoutes, type OracleEntry } from "./java-enterprise-route-oracle.js";

type Repository = { id: string; source: string };
type FailureCategory =
  | "ANNOTATION_EXTRACTION"
  | "ROUTE_RESOLUTION"
  | "CONTEXT_COMPOSITION"
  | "TOKEN_BUDGET"
  | "GROUND_TRUTH"
  | "UNKNOWN";

type Miss = { repo: string; oracle: OracleEntry; category: FailureCategory; detail: string };
type FalsePositive = { repo: string; filePath: string; targetLabel: string | undefined; detail: string };

const root = process.cwd();
const outDir = join(root, "benchmarks/results");
mkdirSync(outDir, { recursive: true });

const repositories = JSON.parse(readFileSync(join(root, "benchmarks/repositories.json"), "utf8")) as Repository[];
const targets = repositories.filter((r) => r.id === "spring-petclinic" || r.id === "petclinic-rest");

let oracleTotal = 0;
let matched = 0;
let falsePositiveCount = 0;
const misses: Miss[] = [];
const falsePositives: FalsePositive[] = [];
const perRepo: Record<string, { oracleCount: number; matched: number; falsePositives: number }> = {};

for (const repo of targets) {
  const repoRoot = join(root, repo.source);
  const oracleEntries = extractOracleRoutes(repoRoot, repo.id);
  oracleTotal += oracleEntries.length;
  perRepo[repo.id] = { oracleCount: oracleEntries.length, matched: 0, falsePositives: 0 };

  const index = new ProjectIndex(repoRoot);
  index.rebuild();
  const routeRelations = index.enterpriseRelations.filter((r) => r.kind === "ROUTE_TO_HANDLER");

  const claimedByOracleKey = new Set<string>();

  for (const oracle of oracleEntries) {
    // SymbolRecord.range starts at the symbol's leading annotations (see java-parser.ts), not
    // the declaration line itself, so the oracle's declaration-line startLine falls somewhere
    // inside [range.startLine, range.endLine] rather than equaling range.startLine exactly.
    const symbol = index.symbols.find(
      (s) =>
        s.filePath === oracle.file &&
        s.name === oracle.handlerName &&
        s.kind === "method" &&
        s.range.startLine <= oracle.startLine &&
        oracle.startLine <= s.range.endLine,
    );
    const relation = symbol ? routeRelations.find((r) => r.sourceSymbolId === symbol.id) : undefined;

    if (!symbol) {
      misses.push({
        repo: repo.id,
        oracle,
        category: "GROUND_TRUTH",
        detail: "No matching method symbol found at oracle's file+name+line (oracle/parser disagreement).",
      });
      continue;
    }
    const key = `${repo.id}:${symbol.id}`;
    if (!relation) {
      misses.push({
        repo: repo.id,
        oracle,
        category: "ANNOTATION_EXTRACTION",
        detail: "Extractor produced no ROUTE_TO_HANDLER relation for this handler method at all.",
      });
      continue;
    }
    if (relation.confidence === "unresolved") {
      misses.push({
        repo: repo.id,
        oracle,
        category: "ROUTE_RESOLUTION",
        detail: `Relation recorded but confidence=unresolved (targetLabel=${relation.targetLabel}); a real literal route was not composed.`,
      });
      claimedByOracleKey.add(key);
      continue;
    }
    if (relation.targetLabel !== oracle.composedRoute) {
      misses.push({
        repo: repo.id,
        oracle,
        category: "ROUTE_RESOLUTION",
        detail: `Wrong composed route: extractor said "${relation.targetLabel}", oracle expected "${oracle.composedRoute}".`,
      });
      falsePositives.push({
        repo: repo.id,
        filePath: relation.filePath,
        targetLabel: relation.targetLabel,
        detail: `Non-unresolved relation with a route string that does not match ground truth (oracle: "${oracle.composedRoute}").`,
      });
      claimedByOracleKey.add(key);
      continue;
    }
    matched++;
    perRepo[repo.id].matched++;
    claimedByOracleKey.add(key);
  }

  // Extra relations the oracle never expected at all (confidence exact/probable, no oracle entry
  // for that source symbol) — false positives per plan §57.
  for (const relation of routeRelations) {
    if (relation.confidence === "unresolved") continue;
    const key = `${repo.id}:${relation.sourceSymbolId}`;
    if (claimedByOracleKey.has(key)) continue;
    falsePositives.push({
      repo: repo.id,
      filePath: relation.filePath,
      targetLabel: relation.targetLabel,
      detail: "Extractor emitted a non-unresolved ROUTE_TO_HANDLER relation the oracle has no corresponding handler for.",
    });
  }
}

falsePositiveCount = falsePositives.length;
for (const fp of falsePositives) perRepo[fp.repo].falsePositives++;

const route_linkage_recall = oracleTotal ? matched / oracleTotal : 1;
const route_linkage_precision = matched + falsePositiveCount ? matched / (matched + falsePositiveCount) : 1;

const failureAttribution: Record<FailureCategory, number> = {
  ANNOTATION_EXTRACTION: 0,
  ROUTE_RESOLUTION: 0,
  CONTEXT_COMPOSITION: 0,
  TOKEN_BUDGET: 0,
  GROUND_TRUTH: 0,
  UNKNOWN: 0,
};
for (const m of misses) failureAttribution[m.category]++;

const results = {
  generatedAt: new Date().toISOString(),
  oracleTotal,
  matched,
  falsePositiveCount,
  route_linkage_recall,
  route_linkage_precision,
  perRepo,
  failureAttribution,
  misses,
  falsePositives,
};

writeFileSync(join(outDir, "v1.4-phase1-spring-mvc-routes.json"), JSON.stringify(results, null, 2) + "\n");

console.log(`Oracle total: ${oracleTotal}, matched: ${matched}, false positives: ${falsePositiveCount}`);
console.log(`route_linkage_recall: ${(route_linkage_recall * 100).toFixed(1)}%`);
console.log(`route_linkage_precision: ${(route_linkage_precision * 100).toFixed(1)}%`);
console.log("Failure attribution:", failureAttribution);
if (existsSync(join(outDir, "v1.4-phase1-spring-mvc-routes.json"))) {
  console.log("Wrote benchmarks/results/v1.4-phase1-spring-mvc-routes.json");
}
