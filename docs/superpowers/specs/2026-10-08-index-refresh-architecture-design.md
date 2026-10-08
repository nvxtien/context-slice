# Index Refresh Architecture Design

## Goal

Keep MCP responsive on unchanged repositories and reduce incremental index write
cost without changing preview, call-resolution, or cache-format behavior.

Assumed workload: one local developer, repositories from hundreds to roughly
10,000 source files, several MCP requests per session.

## Scope

This change covers four connected boundaries:

1. MCP refresh should rebuild only when the repository changed.
2. SQLite should replace only file-owned rows that changed, while preserving
   graph-wide resolution correctness.
3. Language registration should have one explicit bootstrap path.
4. Derived call-resolution fields should be reset by one shared helper.

`ProjectIndex` is not split into multiple classes in this change. That larger
refactor is deferred until there is a concrete need beyond these fixes.

## Design

### Freshness

`ProjectIndex` keeps a lightweight signature for each discovered source file:
relative path, size, modification time, and change time. `refreshIfStale()`
uses this signature to skip rebuilds when the repository is unchanged. A new,
deleted, or changed file invalidates the snapshot and runs the existing rebuild
pipeline.

The current content-hash path remains authoritative during rebuild. The
lightweight signature is only a fast gate; it is not persisted as the cache's
correctness key.

MCP calls use `refreshIfStale()` instead of rebuilding unconditionally. The
first request always builds the index.

### Incremental SQLite writes

The indexer computes changed and removed file paths while scanning. Storage
updates file and symbol rows only for those paths. Calls, imports, and exports
remain graph-wide replacement sets whenever a rebuild occurs because changing
one symbol or export can change resolution in an unchanged caller.

All writes stay inside one SQLite transaction. A rebuild with no source changes
does not write the database.

### Adapter bootstrap

One bootstrap module imports and registers all language adapters and Java
enterprise extractors. Entry points import that bootstrap once. Discovery and
indexing therefore see the same registry, including Rust and future adapters.

### Resolution state

Resolution fields are derived from the current symbol graph. A shared helper
clears those fields before each graph-resolution pass while preserving parse
facts such as the syntactic call kind and evidence needed by language-specific
resolvers.

## Data flow

```text
MCP request
  -> refreshIfStale()
      -> lightweight file signatures
      -> [unchanged] reuse in-memory index
      -> [changed] scan + parse/cache + resolve + incremental save
  -> query / preview / diff
```

## Compatibility

- Public CLI and MCP tool names do not change.
- Existing `.context-slice/index.sqlite` files remain readable.
- No new dependency is required.
- The existing full rebuild path remains available for `init` and `index`.

## Tests

- Unchanged MCP/index refresh does not rebuild twice.
- A changed, added, or deleted file invalidates the freshness gate.
- A changed target re-resolves cached callers.
- Incremental storage preserves unchanged symbols and removes deleted-file rows.
- All entry points expose the same adapter registry.
- Existing full test suite and build remain green.

## Deferred

- Splitting `ProjectIndex` into scanner, cache, graph builder, and query facade.
- Persisting a separate dependency graph or using filesystem watchers.
- Per-edge incremental resolution.
