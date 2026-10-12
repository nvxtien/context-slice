// v1.10 indexing benchmark for the languages added since v1.9: C, C++, C#, Kotlin.
// Unlike the Rust/Python/TypeScript task benchmarks, this does not assert hand-verified
// "required facts" against real-world source (that needs deep per-repo reading we have not
// done yet for these four). It only measures what the indexer can report about itself:
// cold/warm index time and call-edge resolution rate on real, pinned checkouts. Treat a low
// callEdgesExact rate as a signal to investigate the adapter, not as a pass/fail gate.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

type Repository = {
  id: string;
  scale: string;
  commit: string;
  source: string;
  scope: string;
  kind: string;
};
type LanguageManifest = { language: string; file: string };

const manifests: LanguageManifest[] = [
  { language: "C", file: "benchmarks/c-repositories.json" },
  { language: "C++", file: "benchmarks/cpp-repositories.json" },
  { language: "C#", file: "benchmarks/csharp-repositories.json" },
  { language: "Kotlin", file: "benchmarks/kotlin-repositories.json" },
];

function evaluateRepository(repository: Repository, root: string) {
  const repositoryRoot = resolve(root, repository.source);
  if (!existsSync(repositoryRoot)) return undefined;
  const cold = new ProjectIndex(repositoryRoot).rebuild();
  const warm = new ProjectIndex(repositoryRoot).rebuild();
  const index = new ProjectIndex(repositoryRoot);
  index.rebuild();
  const diagnostics = index.diagnostics();
  return {
    repository: repository.id,
    scale: repository.scale,
    kind: repository.kind,
    commit: repository.commit,
    scope: repository.scope,
    files: cold.filesByExtension,
    parseErrors: cold.parseErrors,
    symbols: diagnostics.symbolsIndexed,
    callEdges: diagnostics.callEdgesTotal,
    callEdgesExact: diagnostics.callEdgesExact,
    callEdgesUnresolved: diagnostics.callEdgesUnresolved,
    callEdgesExactRate:
      diagnostics.callEdgesTotal > 0
        ? diagnostics.callEdgesExact / diagnostics.callEdgesTotal
        : null,
    coldIndexMs: cold.elapsedMs,
    warmIndexMs: warm.elapsedMs,
  };
}

function main() {
  const root = process.cwd();
  const outputDir = join(root, "benchmarks/results");
  mkdirSync(outputDir, { recursive: true });
  const results = manifests.map(({ language, file }) => {
    const repositories = JSON.parse(
      readFileSync(join(root, file), "utf8"),
    ) as Repository[];
    const repos = repositories.map(
      (repository) =>
        evaluateRepository(repository, root) ?? {
          repository: repository.id,
          status: "N/A (run `npm run benchmark:checkouts` first)",
        },
    );
    return { language, repositories: repos };
  });
  const report = {
    version: "1.10-c-family-indexing",
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    note: "Indexing performance and call-edge resolution rate only; no hand-verified ground-truth facts yet for these four languages.",
    results,
  };
  writeFileSync(
    join(outputDir, "v1.10-c-family-indexing.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const rows = results.flatMap(({ language, repositories }) =>
    repositories.map((r: any) =>
      "status" in r
        ? `| ${language} | ${r.repository} | ${r.status} | | | | |`
        : `| ${language} | ${r.repository} | ${r.symbols} | ${r.callEdges} | ${r.callEdgesExactRate === null ? "n/a" : `${(r.callEdgesExactRate * 100).toFixed(1)}%`} | ${r.coldIndexMs} ms | ${r.warmIndexMs} ms |`,
    ),
  );
  const markdown = [
    "# ContextSlice v1.10 — C/C++/C#/Kotlin Indexing",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    report.note,
    "",
    "| Language | Repository | Symbols | Call edges | Exact resolution | Cold index | Warm index |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(join(outputDir, "v1.10-c-family-indexing.md"), markdown);
  console.log(markdown);
}

main();
