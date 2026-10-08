# Index Refresh Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated MCP requests cheap on unchanged repositories and make rebuild writes incremental without changing the public CLI/MCP surface or resolution behavior.

**Architecture:** Add one explicit adapter/enterprise bootstrap, keep a lightweight in-memory source signature on `ProjectIndex`, gate MCP refreshes with `refreshIfStale()`, and let SQLite replace file-owned rows only for changed/deleted files while still rebuilding graph-wide derived relations whenever a rebuild is needed. Keep `ProjectIndex` intact for this change.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Node test runner, npm build/test scripts.

**Spec:** `docs/superpowers/specs/2026-10-08-index-refresh-architecture-design.md`

## Global Constraints

- Preserve existing `refresh()` and `rebuild()` behavior for CLI/tests; only MCP switches to the freshness-gated path.
- Keep the existing SQLite schema readable and avoid adding dependencies or a watcher.
- Never trust the lightweight signature as the cache correctness key; content hashes remain authoritative during rebuild.
- Preserve graph-wide call/import/export replacement on every actual rebuild so unchanged callers can be re-resolved after a target changes.
- Preserve parse facts on calls while clearing only derived resolution fields.
- Do not split `ProjectIndex` or introduce a general repository abstraction in this change.
- Preserve the pre-existing user modification in `src/parser/java-parser.ts` and the pre-existing untracked `context-slice-1.8.1.tgz`.

## Review Focus

- Changed, added, and deleted files must all invalidate freshness and update/remove their owned rows.
- A second unchanged MCP request must not scan, parse, resolve, or write SQLite again.
- Adapter registration must be deterministic and idempotent across CLI, MCP, workflow, and tests; Rust must be visible everywhere.
- Storage failures must remain transactional, and no partial file/symbol update may survive.
- Tests must cover both warm in-memory refresh and reopen-from-SQLite behavior.

## Task 1: Centralize adapter and enterprise registration

**Files:** create `src/languages/bootstrap.ts`; update `src/indexer/index.ts`, `src/workflow/repository.ts`, and any entry-point imports that currently rely on side effects; add focused registry coverage under `tests/`.

- [ ] Write a failing test that imports the bootstrap from the indexer/workflow entry points and verifies the same adapter set, including Rust, plus the enterprise extractor registry.
- [ ] Implement one idempotent bootstrap function that imports all language adapters and Java enterprise extractor modules once.
- [ ] Replace duplicated side-effect imports with the bootstrap call/import while keeping adapter modules’ public exports unchanged.
- [ ] Run the focused registry test and `npm run build`.

## Task 2: Add the in-memory freshness gate

**Files:** update `src/indexer/index.ts`; extend `tests/cache.test.ts` and/or add a focused index refresh test.

- [ ] Write failing tests for: first `refreshIfStale()` rebuilds, unchanged second call reuses the in-memory index, and a changed/added/deleted source invalidates it.
- [ ] Add a lightweight per-file signature using relative path, size, mtime, and ctime from the existing discovery pass.
- [ ] Add `refreshIfStale()` that compares the current signature snapshot, rebuilds only on a mismatch, and returns the existing refresh result shape.
- [ ] Keep `refresh()` as the explicit rebuild path and retain content-hash comparison inside `rebuild()`.
- [ ] Run focused cache/index tests and verify no source scan or SQLite write occurs on the unchanged path using observable refresh/storage state rather than test-only production hooks.

## Task 3: Make SQLite file-owned writes incremental

**Files:** update `src/storage/sqlite.ts` and `src/indexer/index.ts`; extend `tests/cache.test.ts` or `tests/contract.test.ts`.

- [ ] Write failing tests that rebuild a project, change one file, add one file, delete one file, and verify unchanged symbols remain while deleted-file rows disappear.
- [ ] Have the rebuild pipeline compute changed and removed relative paths while it already compares hashes/cache records.
- [ ] Change storage save logic to update `files` and `symbols` only for changed/removed paths, while replacing `calls`, `imports`, and `exports` graph-wide for an actual rebuild.
- [ ] Keep all deletes/inserts and metadata updates in one transaction; skip the storage write when no source changed.
- [ ] Verify both same-process and reopened `ProjectIndex` cases, then run the focused storage/cache tests.

## Task 4: Consolidate resolution-state reset

**Files:** create the smallest shared helper near the indexer model (prefer `src/indexer/resolution-state.ts` unless an existing model location is a better fit); update `src/indexer/index.ts`; add a focused unit/regression test.

- [ ] Write a failing test proving the reset clears `declaredTargetId`, `resolvedTargetId`, and `confidence` without clearing syntactic call kind or resolver evidence.
- [ ] Implement the helper and replace the inline reset loop with it.
- [ ] Run the focused resolution/cache tests and confirm cached callers still re-resolve after a target change.

## Task 5: Route MCP through the freshness gate

**Files:** update `src/server/mcp-server.ts`; extend the existing MCP/stdio tests.

- [ ] Write a failing test that sends multiple MCP requests without changing the repository and asserts only the first request refreshes the index; add a changed-file case that refreshes again.
- [ ] Replace the MCP-local `index.refresh()` callback with `index.refreshIfStale()` while leaving tool names, query behavior, and diff behavior unchanged.
- [ ] Run the focused MCP tests and inspect the generated SQLite metadata/rows for regressions.

## Task 6: Full verification and cleanup

- [ ] Run `npm run build`.
- [ ] Run `npm test` and record the full test count and failures.
- [ ] Run targeted formatting checks on changed TypeScript files and `git diff --check`.
- [ ] Remove only test-generated benchmark/manifests or other generated files that are not part of the requested change; preserve the existing tarball and user edits.
- [ ] Review the final diff for accidental schema/API changes and document any skipped pre-existing checks.

## Self-review against the approved spec

- Freshness, incremental storage, bootstrap, and shared resolution reset are each represented by an implementation task and regression test.
- The deferred `ProjectIndex` split, persisted watcher graph, and per-edge incremental resolver are explicitly excluded.
- Compatibility and transactional safety are called out as implementation constraints and verification points.
