# End-to-end pilot: Claude with and without ContextSlice

Same agent (Claude Code, Sonnet 5.5, read-only tools), same questions, same real repositories. Only
the ContextSlice plugin (skill, guard hook, MCP server built from this checkout) differs.

- Questions and rubrics: `tasks.json`, written before any run. One question each on Flask, zod v3,
  Spring PetClinic, ripgrep `ignore`, cobra and Serilog.
- Grading: a separate Claude call with no tools scores each answer against the rubric, blind to the
  condition.
- Measured per run: rubric score, tokens returned by tools (characters / 4), turns, cost.
- Run: `npx tsx benchmarks/e2e/run.ts --reps 2` (needs `npm run build` and the benchmark checkouts).
  Raw results: `benchmarks/results/e2e-pilot-before-lean.json` (first six questions, original response format),
  `e2e-pilot-lean.json` (same, compact response) and `e2e-hard.json` (`tasks-hard.json`, run with `--tasks-file tasks-hard.json`).

## Result (6 tasks x 2 conditions x 2 repetitions)

|                                      | Rubric score | Tool-result tokens (mean) | Turns (mean) | Cost per run (mean) |
| ------------------------------------ | ------------ | ------------------------- | ------------ | ------------------- |
| Baseline (Grep/Read)                 | 95.3%        | 2,689                     | 6.0          | $0.068              |
| With ContextSlice, original response | 96.9%        | 6,193                     | 7.6          | $0.102              |
| With ContextSlice, lean response     | 95.3%        | 4,190                     | 8.5          | $0.092              |

The lean response (`leanPreview` in `src/workflow/preview.ts`) drops the duplicated top-level
`rendered`, the full target record, token-accounting tables, unresolved-call evidence and the ids of
omitted symbols, and uses compact JSON. Responses shrank by about half in characters
(65k to 32k over five sample previews) and tool-result tokens by a third in the agent runs.

Accuracy is the same within noise. ContextSlice still did **not** reduce tokens or cost on these
questions, even with the lean response; it only narrowed the gap.

## Why, and limits

- The questions each live in one or two functions of one file, where Grep followed by a ranged Read
  is already close to optimal (about 2.7k tokens). The earlier "context reduction" figures compare
  against reading whole files, which agents rarely do.
- `context_preview` returned 5-12k tokens originally, and the agent usually still reads files afterwards, so the
  slice is paid for on top of the reads. The skill also costs a ToolSearch round trip.
- Six tasks, two repetitions, rubrics written by the tool's author: a pilot, not a verdict. Harder
  cross-file tasks and larger files may favour the tool; this run does not show it.
- The guard hook only covers `.java .ts .tsx .js .mjs .cjs .py .rs .go`, so the Serilog (C#) runs
  were not enforced.

## Second round: harder questions

Five more questions (`tasks-hard.json`): NestJS dependency lookup, Django `bulk_create`, Excalidraw
double click (a 14,000-line file), Keycloak callers of one method, jsoup implicit `<p>` closing. Two
runs each, compact response format.

|                      | Rubric score | Tool-result tokens (mean) | Turns (mean) | Cost per run (mean) |
| -------------------- | ------------ | ------------------------- | ------------ | ------------------- |
| Baseline (Grep/Read) | 89.3%        | 2,489                     | 5.2          | $0.064              |
| With ContextSlice    | 87.5%        | 4,872                     | 7.9          | $0.094              |

Neither the large file nor the "who calls this" question favoured the tool: Grep found the right
place in one or two calls.
