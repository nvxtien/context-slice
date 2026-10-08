# Architecture Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce architectural coupling while preserving the current CLI/MCP behavior and SQLite cache format semantics.

**Architecture:** Keep `ProjectIndex` as the public facade, but move scanning, language grouping, resolution orchestration, and query indexes behind focused modules. Make enterprise registration instance-owned and keep SQLite behind a snapshot/store boundary.

**Tech Stack:** TypeScript, Node.js, Tree-sitter adapters, better-sqlite3, node:test.

**Spec:** The architecture review in the preceding conversation.

## Global Constraints

- Preserve the existing `ProjectIndex`, CLI, MCP, and language adapter public behavior.
- Keep the local SQLite cache and deterministic read-only source workflow.
- Do not add dependencies.
- Preserve unresolved-call behavior; do not guess dynamic dispatch.

## Review Focus

- A new language receives only its own records and still resolves cross-file calls correctly.
- A second `ProjectIndex` in the same process does not share enterprise registrations accidentally.
- A current SQLite cache hydrates the same symbols, calls, and enterprise relations as a rebuild.
- A changed file does not invalidate unrelated call edges.
- CLI and MCP callers continue to use the existing facade.

### Task 1: Instance-owned enterprise registry

**Files:**
- Create: `src/languages/enterprise/registry.ts` registry factory/types
- Modify: `src/languages/java/enterprise/*.ts`, `src/indexer/index.ts`, bootstrap
- Test: `tests/java-enterprise-registry.test.ts`

- [x] Add a failing test proving two registry instances do not share extractors.
- [x] Implement a registry object and pass it through `ProjectIndex`.
- [x] Keep existing module registration as the default bootstrap path.
- [x] Run registry and enterprise tests.

### Task 2: Per-language resolution snapshots

**Files:**
- Create: `src/indexer/language-snapshot.ts`
- Modify: `src/languages/adapter.ts`, `src/indexer/index.ts`
- Test: `tests/indexer-boundaries.test.ts`

- [x] Add a failing test asserting each adapter receives only its language records.
- [x] Build language snapshots once per rebuild instead of filtering arrays inside the adapter loop.
- [x] Keep `ResolveContext` field names stable for adapters.
- [x] Run adapter and mixed-language tests.

### Task 3: Extract query/index state from `ProjectIndex`

**Files:**
- Create: `src/indexer/query-index.ts`
- Modify: `src/indexer/index.ts`
- Test: `tests/symbol-index.test.ts`

- [x] Add failing tests for lookup, caller, dependency, and symbol-name behavior through the existing facade.
- [x] Move derived maps and lookup methods into `QueryIndex`.
- [x] Make `ProjectIndex` delegate query operations and retain only lifecycle/orchestration state.
- [x] Run query, preview, and MCP tests.

### Task 4: Storage snapshot boundary

**Files:**
- Create: `src/storage/index-snapshot.ts`
- Modify: `src/storage/sqlite.ts`, `src/indexer/index.ts`
- Test: `tests/cache.test.ts`, `tests/contract.test.ts`

- [x] Add failing tests for loading/saving a typed snapshot without exposing SQLite row details.
- [x] Define the snapshot type and store interface; keep SQLite as the implementation.
- [x] Move row grouping/serialization behind the store boundary.
- [x] Run cache migration, corruption, and persistence tests.

### Task 5: Resolution invalidation boundary

**Files:**
- Create: `src/indexer/resolution-pipeline.ts`
- Modify: `src/indexer/index.ts`, `src/languages/adapter.ts`
- Test: `tests/cache.test.ts`, language resolution suites

- [x] Add a failing test for an unchanged file retaining its resolved edges after an unrelated edit.
- [x] Extract reset/group/resolve behavior into a pipeline with explicit affected-file inputs.
- [x] Preserve a safe full-graph fallback when the dependency impact is ambiguous.
- [x] Run the full suite, build, format check, and jsoup benchmark.

### Final verification

- [x] Run `npm run build`.
- [x] Run `npm run format:check`.
- [x] Run `npm test`.
- [x] Run `npm run benchmark`.
- [x] Review the final diff and preserve unrelated untracked files.
