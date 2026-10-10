import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";
import {
  registerEnterpriseExtractor,
  __resetEnterpriseExtractorsForTests,
} from "../src/languages/java/enterprise/registry.js";

test("enterpriseRelations is empty when no extractor is registered", () => {
  __resetEnterpriseExtractorsForTests();
  const dir = mkdtempSync(join(tmpdir(), "cs-enterprise-"));
  writeFileSync(join(dir, "A.java"), "package a;\nclass A {}\n");
  const index = new ProjectIndex(dir);
  index.rebuild();
  assert.deepEqual(index.enterpriseRelations, []);
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

test("collects relations a registered extractor emits for a Java file", () => {
  __resetEnterpriseExtractorsForTests();
  registerEnterpriseExtractor((symbols, filePath) =>
    symbols.length
      ? [
          {
            kind: "TESTS_SYMBOL" as const,
            family: "test-linkage" as const,
            sourceSymbolId: symbols[0].id,
            confidence: "probable" as const,
            evidence: ["smoke"],
            range: symbols[0].range,
            filePath,
          },
        ]
      : [],
  );
  const dir = mkdtempSync(join(tmpdir(), "cs-enterprise-"));
  writeFileSync(join(dir, "A.java"), "package a;\nclass A {}\n");
  const index = new ProjectIndex(dir);
  index.rebuild();
  assert.equal(index.enterpriseRelations.length, 1);
  assert.equal(index.enterpriseRelations[0].kind, "TESTS_SYMBOL");
  __resetEnterpriseExtractorsForTests();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

test("relations survive a second rebuild that hits the parse cache", () => {
  __resetEnterpriseExtractorsForTests();
  registerEnterpriseExtractor((symbols, filePath) =>
    symbols.length
      ? [
          {
            kind: "TESTS_SYMBOL" as const,
            family: "test-linkage" as const,
            sourceSymbolId: symbols[0].id,
            confidence: "probable" as const,
            evidence: ["smoke"],
            range: symbols[0].range,
            filePath,
          },
        ]
      : [],
  );
  const dir = mkdtempSync(join(tmpdir(), "cs-enterprise-"));
  writeFileSync(join(dir, "A.java"), "package a;\nclass A {}\n");
  const index = new ProjectIndex(dir);
  index.rebuild();
  index.rebuild(); // second call: this file now hits the cache-hit branch
  assert.equal(index.enterpriseRelations.length, 1);
  __resetEnterpriseExtractorsForTests();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});
