# ContextSlice v0.2 Validation

Generated: 2026-09-27T10:12:32.663Z

## STATUS

Fixture validation passed. Real-repository and agent comparison runs are pending because no external repository checkout or agent telemetry is available in this workspace.

## Index and cache

- Cold index: {"files":4,"filesScanned":4,"filesParsed":4,"parseErrors":0,"cacheHits":0,"filesByExtension":{".java":4},"filesByLanguage":{"Java":4},"symbols":10,"symbolsUpdated":10,"calls":15,"imports":0,"exports":0,"elapsedMs":13}
- Warm index: {"files":4,"filesScanned":4,"filesParsed":0,"parseErrors":0,"cacheHits":4,"filesByExtension":{".java":4},"filesByLanguage":{"Java":4},"symbols":10,"symbolsUpdated":10,"calls":15,"imports":0,"exports":0,"elapsedMs":3}
- Unresolved call rate: 0.7333
- Ambiguous call rate: 0.0667

## Benchmark

| Repo | Task | Budget | Baseline tokens | Slice tokens | Reduction | Required fact recall | Min sufficient budget |
|---|---|---:|---:|---:|---:|---:|---:|
| test-fixtures/java | fixture-retry-payment | 256 | 315 | 255 | 19.05% | 4/4 | 256 |
| test-fixtures/java | fixture-retry-payment | 512 | 315 | 255 | 19.05% | 4/4 | 256 |
| test-fixtures/java | fixture-retry-payment | 1024 | 315 | 255 | 19.05% | 4/4 | 256 |
| test-fixtures/java | fixture-retry-payment | 2048 | 315 | 255 | 19.05% | 4/4 | 256 |
| test-fixtures/java | fixture-retry-payment | 4096 | 315 | 255 | 19.05% | 4/4 | 256 |
| test-fixtures/java | fixture-retry-payment | 8192 | 315 | 255 | 19.05% | 4/4 | 256 |

- Median token reduction: 19.05%
- Required facts are matched deterministically from declared patterns.
- Agent baseline metrics are not reported because this environment does not expose agent runtime telemetry.

## TREE-SITTER LIMITATIONS

Interface dispatch, overloads and unknown receivers remain unresolved or probable. This report measures the limitation instead of treating it as exact resolution.

## LSP/JDT DECISION

Insufficient evidence for v0.3 LSP/JDT integration. Make that decision only after small, medium and bounded large real repositories show how often unresolved or ambiguous edges cause required-fact loss or failed tasks.