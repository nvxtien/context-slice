# ContextSlice v0.2 Validation

Generated: 2026-09-19T15:21:07.215Z

## STATUS

Fixture validation passed. Real-repository and agent comparison runs are pending because no external repository checkout or agent telemetry is available in this workspace.

## Index and cache

- Cold index: {"files":4,"filesScanned":4,"filesParsed":4,"cacheHits":0,"symbols":10,"symbolsUpdated":10,"calls":15,"elapsedMs":7}
- Warm index: {"files":4,"filesScanned":4,"filesParsed":0,"cacheHits":4,"symbols":10,"symbolsUpdated":10,"calls":15,"elapsedMs":2}
- Unresolved call rate: 0.8
- Ambiguous call rate: 0.1333

## Benchmark

| Repo | Task | Budget | Baseline tokens | Slice tokens | Reduction | Required fact recall | Min sufficient budget |
|---|---|---:|---:|---:|---:|---:|---:|
| fixture-small | fixture-retry-locate | 256 | 315 | 221 | 29.84% | 5/5 | 256 |
| fixture-small | fixture-retry-locate | 512 | 315 | 221 | 29.84% | 5/5 | 256 |
| fixture-small | fixture-retry-locate | 1024 | 315 | 221 | 29.84% | 5/5 | 256 |
| fixture-small | fixture-retry-locate | 2048 | 315 | 221 | 29.84% | 5/5 | 256 |
| fixture-small | fixture-retry-locate | 4096 | 315 | 221 | 29.84% | 5/5 | 256 |
| fixture-small | fixture-retry-locate | 8192 | 315 | 221 | 29.84% | 5/5 | 256 |
| fixture-small | fixture-retry-impact | 256 | 315 | 221 | 29.84% | 3/3 | 256 |
| fixture-small | fixture-retry-impact | 512 | 315 | 221 | 29.84% | 3/3 | 256 |
| fixture-small | fixture-retry-impact | 1024 | 315 | 221 | 29.84% | 3/3 | 256 |
| fixture-small | fixture-retry-impact | 2048 | 315 | 221 | 29.84% | 3/3 | 256 |
| fixture-small | fixture-retry-impact | 4096 | 315 | 221 | 29.84% | 3/3 | 256 |
| fixture-small | fixture-retry-impact | 8192 | 315 | 221 | 29.84% | 3/3 | 256 |

- Median token reduction: 29.84%
- Required facts are matched deterministically from declared patterns.
- Agent baseline metrics are not reported because this environment does not expose agent runtime telemetry.

## TREE-SITTER LIMITATIONS

Interface dispatch, overloads and unknown receivers remain unresolved or probable. This report measures the limitation instead of treating it as exact resolution.

## LSP/JDT DECISION

Insufficient evidence for v0.3 LSP/JDT integration. Make that decision only after small, medium and bounded large real repositories show how often unresolved or ambiguous edges cause required-fact loss or failed tasks.