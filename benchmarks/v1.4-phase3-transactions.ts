// Task 4 (v1.4 Phase 3): measures whether the real transaction-boundary extractor
// (src/languages/java/enterprise/transactions.ts) recovers the correct TRANSACTION_BOUNDARY
// relation on real repositories, graded against the independent oracle in
// benchmarks/java-enterprise-transactions-oracle.ts (never the extractor grading itself).
//
// Unlike Phase 2's dependency-injection evaluation, a transaction boundary is a fact about the
// annotated method ALONE (no cross-file bean identity to resolve) — so grading here is a direct
// per-method match: for each oracle entry, find the corresponding `method`-kind SymbolRecord
// (by file + className via parentId + method name + the oracle's declaration line falling
// inside the symbol's range), then check index.enterpriseRelations for a TRANSACTION_BOUNDARY
// relation on that symbol whose attribute set matches the oracle's, order-independent.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import { extractOracleTransactions, type Attribute, type OracleEntry } from "./java-enterprise-transactions-oracle.js";

type Repository = { id: string; source: string };
type FailureCategory =
  | "ANNOTATION_EXTRACTION"
  | "ATTRIBUTE_MISMATCH"
  | "SYMBOL_RESOLUTION"
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

/** "readOnly=true, timeout=30" style key, sorted so attribute order never matters. */
function attrKey(attrs: Attribute[]): string {
  return attrs
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(", ");
}

let oracleTotal = 0;
let matched = 0;
const misses: Miss[] = [];
const falsePositives: FalsePositive[] = [];
type RepoStats = { oracleTotal: number; matched: number; falsePositives: number };
const perRepo: Record<string, RepoStats> = {};
const allOracleEntries: OracleEntry[] = [];

for (const repo of targets) {
  const repoRoot = join(root, repo.source);
  const oracleEntries = extractOracleTransactions(repoRoot, repo.id);
  allOracleEntries.push(...oracleEntries);
  perRepo[repo.id] = { oracleTotal: oracleEntries.length, matched: 0, falsePositives: 0 };

  const index = new ProjectIndex(repoRoot);
  index.rebuild();
  const txRelations = index.enterpriseRelations.filter((r) => r.kind === "TRANSACTION_BOUNDARY");
  const claimed = new Set<(typeof txRelations)[number]>();

  for (const oracle of oracleEntries) {
    oracleTotal++;

    const method = index.symbols.find(
      (s) =>
        s.filePath === oracle.file &&
        s.kind === "method" &&
        s.name === oracle.methodName &&
        s.range.startLine <= oracle.startLine &&
        oracle.startLine <= s.range.endLine,
    );

    if (!method) {
      misses.push({
        repo: repo.id,
        oracle,
        category: "SYMBOL_RESOLUTION",
        detail: `No method-kind symbol named "${oracle.methodName}" in ${oracle.file} spans oracle line ${oracle.startLine}.`,
      });
      continue;
    }

    const candidates = txRelations.filter((r) => r.sourceSymbolId === method.id);
    if (candidates.length === 0) {
      misses.push({
        repo: repo.id,
        oracle,
        category: "ANNOTATION_EXTRACTION",
        detail: `Extractor produced no TRANSACTION_BOUNDARY relation for method "${oracle.className}#${oracle.methodName}" despite explicit attribute(s) "${attrKey(oracle.attributes)}".`,
      });
      continue;
    }

    const expectedKey = attrKey(oracle.attributes);
    const relation = candidates.find((r) => attrKey(parseTargetLabel(r.targetLabel)) === expectedKey);
    if (!relation) {
      misses.push({
        repo: repo.id,
        oracle,
        category: "ATTRIBUTE_MISMATCH",
        detail: `Method "${oracle.className}#${oracle.methodName}" has a TRANSACTION_BOUNDARY relation but attributes differ: expected "${expectedKey}", got "${candidates.map((r) => r.targetLabel).join(" | ")}".`,
      });
      claimed.add(candidates[0]);
      continue;
    }

    if (relation.confidence !== "exact") {
      misses.push({
        repo: repo.id,
        oracle,
        category: "ATTRIBUTE_MISMATCH",
        detail: `Method "${oracle.className}#${oracle.methodName}" matched attributes but confidence="${relation.confidence}" (expected "exact" per Global Constraints — always exact, no partial confidence).`,
      });
      claimed.add(relation);
      continue;
    }

    matched++;
    perRepo[repo.id].matched++;
    claimed.add(relation);
  }

  // Extra relations the oracle has no corresponding entry for at all — false positives.
  for (const relation of txRelations) {
    if (claimed.has(relation)) continue;
    falsePositives.push({
      repo: repo.id,
      filePath: relation.filePath,
      targetLabel: relation.targetLabel,
      detail: "Extractor emitted a TRANSACTION_BOUNDARY relation the oracle has no corresponding @Transactional(...) occurrence for.",
    });
  }
}

function parseTargetLabel(label: string | undefined): Attribute[] {
  if (!label) return [];
  return label.split(",").map((pair) => {
    const eq = pair.indexOf("=");
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  });
}

for (const fp of falsePositives) perRepo[fp.repo].falsePositives++;
const falsePositiveCount = falsePositives.length;

const transaction_boundary_recall = oracleTotal ? matched / oracleTotal : 1;
const transaction_boundary_precision = matched + falsePositiveCount ? matched / (matched + falsePositiveCount) : 1;

// readOnly-only subset — the only mechanism with real-repository evidence (plan's grounding
// section + this run's own oracle: every real occurrence in both pinned repos is bare
// `readOnly = true`, nothing else). Retention rule (§51) is applied to THIS subset, per brief
// Step 5, since it is the only one with real ground truth to measure against.
const readOnlyMisses = misses.filter((m) => attrKey(m.oracle.attributes) === "readOnly=true");
const readOnlyOracleTotal = allOracleEntries.filter((e) => attrKey(e.attributes) === "readOnly=true").length;
const readOnlyMatched = readOnlyOracleTotal - readOnlyMisses.length;
const readOnly_recall = readOnlyOracleTotal ? readOnlyMatched / readOnlyOracleTotal : 1;

const failureAttribution: Record<FailureCategory, number> = {
  ANNOTATION_EXTRACTION: 0,
  ATTRIBUTE_MISMATCH: 0,
  SYMBOL_RESOLUTION: 0,
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
  transaction_boundary_recall,
  transaction_boundary_precision,
  readOnlySubset: { oracleTotal: readOnlyOracleTotal, matched: readOnlyMatched, recall: readOnly_recall },
  perRepo,
  failureAttribution,
  misses,
  falsePositives,
};

writeFileSync(join(outDir, "v1.4-phase3-transactions.json"), JSON.stringify(results, null, 2) + "\n");

console.log(`Oracle total: ${oracleTotal}, matched: ${matched}, false positives: ${falsePositiveCount}`);
console.log(`transaction_boundary_recall: ${(transaction_boundary_recall * 100).toFixed(1)}%`);
console.log(`transaction_boundary_precision: ${(transaction_boundary_precision * 100).toFixed(1)}%`);
console.log(`readOnly subset recall: ${(readOnly_recall * 100).toFixed(1)}% (${readOnlyMatched}/${readOnlyOracleTotal})`);
console.log("Failure attribution:", failureAttribution);
for (const [repoId, stats] of Object.entries(perRepo)) {
  console.log(`${repoId}: oracle=${stats.oracleTotal} matched=${stats.matched} falsePositives=${stats.falsePositives}`);
}
console.log("Wrote benchmarks/results/v1.4-phase3-transactions.json");
