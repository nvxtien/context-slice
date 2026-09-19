# ContextSlice v0.7 — Developer Workflow Integration

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice v0.1 through v0.6 are already implemented and validated.

Current v0.6 results:

- 15/15 benchmark tasks
- required-fact recall: 100%
- retrieval recall: 100%
- median context reduction: 94.55%
- whole-file fallback rate: 0%
- tests: 18/18 pass
- build passes
- benchmark:v06 passes
- git diff --check passes

Current product positioning:

> ContextSlice builds the minimum sufficient code context for a developer’s task before that context is sent to Codex, Claude Code, or another AI coding assistant.

Tagline:

> Less code in context. Fewer tokens. Same required information.

The core engine is now sufficiently validated for the current scope.

The purpose of v0.7 is not to add more semantic intelligence.

The purpose is:

> Make ContextSlice easy enough to install, configure, trust, and use in a normal developer workflow.

The central risk in v0.7 is no longer retrieval correctness.

It is developer friction.

---

## 1. Primary objective

A developer should be able to:

1. install ContextSlice,
2. point it at a repository,
3. connect it to Codex or Claude Code,
4. issue a normal coding task,
5. receive minimum sufficient context,
6. understand what ContextSlice included and why,
7. see how much context/token budget was saved,
8. recover gracefully when the index is stale or context is insufficient,

without needing to understand Tree-sitter, the internal index schema, or benchmark internals.

Target onboarding goal:

> A technically experienced developer should be able to reach a successful ContextSlice-assisted query in a few minutes.

Do not optimize this milestone around exact elapsed onboarding minutes unless measured in a real user study.

---

## 2. Product principle

Use this rule throughout v0.7:

> ContextSlice should disappear into the developer workflow.

The developer should think in terms of:

- task
- code
- context
- tokens
- confidence

not:

- parser internals
- graph internals
- cache schema
- AST nodes
- benchmark machinery

Internal implementation details should remain available for diagnostics, but not be required for normal use.

---

## 3. Scope

Focus on:

- installation
- repository initialization
- MCP setup
- Codex integration
- Claude Code integration
- CLI ergonomics
- diagnostics
- trust/explainability
- stale-index detection
- context preview
- context/token savings display
- interactive latency
- dogfooding on ContextSlice itself
- documentation

Do not add in v0.7:

- JDT/LSP
- embeddings
- vector DB
- SaaS
- cloud sync
- GUI/dashboard
- automatic code editing
- multi-language support
- hidden LLM calls

---

## 4. CLI entry point

Provide one primary executable.

Suggested:

```bash
context-slice
```

The exact package/bin structure may vary.

Primary commands should be small and memorable.

Recommended:

```bash
context-slice init
context-slice index
context-slice status
context-slice doctor
context-slice preview "<task>"
context-slice mcp
```

Avoid a large command surface.

---

## 5. init

`context-slice init` should:

- detect repository root
- validate supported language presence
- create minimal local ContextSlice config if needed
- initialize cache/index
- print next steps

Do not require configuration when defaults are sufficient.

Example desired output:

```text
ContextSlice initialized.

Repository: /path/to/repo
Java files: 214
Index: ready

Next:
  context-slice preview "explain payment retry flow"
```

Avoid verbose internal logs by default.

---

## 6. Repository auto-detection

Detect repository root using deterministic rules.

Prefer:

1. explicit `--repo`
2. nearest Git root
3. current directory

Reject ambiguous or invalid roots clearly.

Respect repository boundaries and existing path safety rules.

---

## 7. index

`context-slice index` should:

- run or refresh indexing
- show concise progress
- distinguish cold, warm, and incremental behavior
- report diagnostics

Example:

```text
Indexed 214 Java files
Parsed: 3
Cache hits: 211
Symbols: 4,812
Call edges: 9,204
Duration: 420ms
```

Do not dump per-file parser logs unless verbose mode is enabled.

---

## 8. status

`context-slice status` should answer:

- is ContextSlice initialized?
- is the index ready?
- is the cache current?
- how many source files/symbols are indexed?
- which schema/version is active?
- when was the index last refreshed?
- is the current repository supported?

Example:

```text
Repository: ready
Index: current
Schema: 0.5.2
Java files: 214
Symbols: 4,812
Last refresh: 12s ago
```

---

## 9. doctor

Add:

```bash
context-slice doctor
```

It should diagnose common setup problems:

- not inside repository
- no supported source files
- cache unreadable
- schema mismatch
- stale/corrupt index
- Git unavailable
- MCP command misconfiguration
- unsupported Node version
- missing runtime dependency

Output should include actionable remediation.

Example:

```text
✓ Node runtime
✓ Repository detected
✓ Java source detected
✓ Index readable
✗ Index stale

Fix:
  context-slice index
```

Avoid vague messages such as:

```text
something went wrong
```

---

## 10. preview

Add a developer-facing context preview command.

Example:

```bash
context-slice preview "add idempotency protection to retryPayment"
```

The command should:

1. identify likely target symbols,
2. build a ContextSlice package,
3. render the developer-visible context,
4. show token/context metrics,
5. explain inclusions.

Example:

```text
Task:
add idempotency protection to retryPayment

Target:
PaymentService.retryPayment(String)

Context:
  target source        322 tokens
  callers               84 tokens
  callees              118 tokens
  annotations           14 tokens
  tests                203 tokens
  metadata              41 tokens

Total:
  782 estimated tokens

Manual baseline:
  13,842 estimated tokens

Reduction:
  94.35%

Required facts preserved:
  100%
```

Do not require benchmark ground truth during normal production preview.

If required-fact recall is benchmark-only, do not display fake production recall.

In normal usage replace it with appropriate runtime information such as:

```text
Context confidence: high
```

only if confidence has a deterministic basis.

---

## 11. Human-readable context preview

The preview should be readable before sending it to an assistant.

The developer should be able to inspect:

- target
- callers
- callees
- key annotations
- relevant source
- related tests
- unresolved/ambiguous relations

Provide a compact default view.

Add verbose/debug mode for deeper inspection.

---

## 12. Why is this included?

Expose explainability at the CLI level.

For each major context item, make its reason available.

Example:

```text
PaymentRetryJob.execute
  reason: direct caller
  distance: 1
  confidence: exact
```

This can be shown inline or through an option such as:

```bash
context-slice preview "..." --explain
```

Do not overwhelm default output.

---

## 13. Why is this missing?

When context cannot include something important, explain why.

Examples:

```text
PaymentRepository.save
  unresolved implementation
  declaration included instead

OwnerMapper.convert
  omitted due to context budget
```

This is important for trust.

Silent omission should be avoided when the system knows a candidate was relevant but excluded.

---

## 14. Context budget control

Expose developer-friendly budget options.

Example:

```bash
context-slice preview "..." --budget 2048
```

Support sensible defaults.

If the requested budget is too small, return:

- partial context
- clear truncation reason
- suggested minimum budget if known

Do not silently exceed the requested budget.

---

## 15. Context savings display

Show savings in developer terms.

Preferred:

```text
Manual baseline: 12.4K estimated tokens
ContextSlice:     0.8K estimated tokens
Reduction:        93.5%
```

If no manual baseline is available during normal usage, do not invent one.

Instead show:

```text
ContextSlice package: 0.8K estimated tokens
```

Optionally compare against:

- enclosing files
- selected whole files

only when the comparison is deterministic.

---

## 16. MCP server UX

Keep stdio MCP support.

Provide a simple command:

```bash
context-slice mcp
```

This should start the MCP server without requiring the user to know internal entry-point paths.

The command should be stable across package releases.

---

## 17. Codex setup

Document a minimal Codex setup path.

Provide copy-pasteable configuration using the stable executable.

Do not rely on repository-specific absolute paths where avoidable.

The docs should explain:

- installation
- MCP registration/configuration
- how to verify the server is visible
- first test prompt
- troubleshooting

Keep current product naming consistent.

---

## 18. Claude Code setup

Document a minimal Claude Code setup path.

Again use:

```text
context-slice mcp
```

as the stable server command.

Explain:

- setup
- verification
- first task
- how to tell whether ContextSlice was used

Do not claim specific Claude Code behavior that was not exercised.

---

## 19. Assistant instructions

Provide an optional short instruction snippet developers can add to their coding assistant configuration.

Recommended behavior:

```text
Use ContextSlice before reading complete source files when locating or understanding task-relevant code.

Read a whole file only when the slice is insufficient or exact surrounding context is necessary.
```

Keep it short.

Do not require elaborate system prompts.

---

## 20. Trust model

The developer should be able to answer:

- What did ContextSlice include?
- Why?
- What did it omit?
- Was anything unresolved?
- Is the index current?
- Did ContextSlice hit its token budget?
- Did it fall back to whole files?

Expose these facts directly.

Do not rely on opaque scores alone.

---

## 21. Stale index detection

Detect source changes after the last index refresh.

Possible states:

```text
CURRENT
STALE
REFRESHING
ERROR
```

When stale:

- warn clearly
- refresh incrementally where practical
- avoid returning silently outdated context

Do not require a full cold rebuild for a one-file change.

---

## 22. Auto-refresh policy

Choose a conservative policy.

Recommended:

- before preview/query, check relevant file hashes
- refresh changed files incrementally
- avoid filesystem watchers in v0.7 unless already trivial and reliable

Do not add complex daemon infrastructure.

The CLI/MCP server should remain easy to reason about.

---

## 23. MCP stale-index behavior

The MCP server must not silently serve stale context.

Before serving a query:

- validate cache freshness sufficiently for the requested operation
- refresh changed files if needed
- expose refresh metadata when useful

Keep latency bounded.

---

## 24. Interactive latency benchmark

Measure whether ContextSlice is responsive enough for daily developer use.

Measure separately:

- cold initialization/index
- warm `context.search`
- warm `context.symbol`
- warm `context.slice`
- incremental refresh after one-file edit
- first MCP query
- subsequent MCP query

Record median and worst-case in the benchmark environment.

Do not claim universal latency.

---

## 25. Suggested responsiveness goals

These are targets, not guaranteed requirements:

```text
warm lookup: effectively interactive
warm slice: effectively interactive
single-file refresh: low enough not to disrupt normal use
```

Do not prematurely micro-optimize.

Measure first.

---

## 26. Dogfood ContextSlice on itself

Use ContextSlice repository as a dogfood project where practical.

Since ContextSlice is TypeScript and current production parsing is Java-only, do not add TypeScript support just for dogfooding.

Instead dogfood the workflow pieces that are language-independent:

- CLI
- init/status/doctor
- MCP startup
- repository detection
- cache handling
- configuration
- error paths

For semantic slicing dogfood, continue using the pinned Java repositories.

Do not expand language scope in v0.7.

---

## 27. Installation

Make local installation straightforward.

Support at least one clear path such as:

```bash
npm install -g ...
```

or:

```bash
npx ...
```

depending on current package strategy.

If the package is not published, document local install/link steps accurately.

Do not pretend npm registry publication exists if it does not.

---

## 28. First-run experience

The first run should not require manual database setup.

ContextSlice should create its local cache automatically.

The user should not need to know where SQLite lives unless troubleshooting.

Example first-run:

```bash
cd my-java-project
context-slice init
context-slice preview "explain payment retry flow"
```

---

## 29. Config file

Only add config if needed.

Prefer zero-config defaults.

If a config file is necessary, keep it minimal.

Suggested:

```json
{
  "language": "java",
  "exclude": ["generated/**"]
}
```

Avoid exposing internal scoring weights in normal config.

Do not create a large configuration surface.

---

## 30. Ignore rules

Continue ignoring common generated/build directories.

Allow developer overrides where necessary.

Show ignored paths in verbose diagnostics.

Avoid surprising indexing of:

- target
- build
- generated output
- vendored dependencies

---

## 31. Errors

Define user-facing error categories.

Examples:

```text
REPOSITORY_NOT_FOUND
NO_SUPPORTED_SOURCE
INDEX_STALE
INDEX_CORRUPT
SYMBOL_NOT_FOUND
SYMBOL_AMBIGUOUS
BUDGET_TOO_SMALL
MCP_START_FAILED
```

Each should have:

- concise message
- cause
- remediation

---

## 32. Exit codes

Use meaningful non-zero exit codes for CLI failure.

Document them if practical.

At minimum distinguish:

- success
- user/configuration error
- internal failure

Do not over-engineer dozens of codes.

---

## 33. Machine-readable CLI output

Add optional JSON output for automation.

Example:

```bash
context-slice status --json
context-slice preview "..." --json
```

Human-readable output remains the default.

The JSON schema should be stable enough for scripts.

---

## 34. Logging

Default logging should be quiet and useful.

Use:

```text
normal
verbose
debug
```

Do not emit parser internals during normal commands.

For MCP stdio mode, never pollute stdout with diagnostic logs that break protocol framing.

Send diagnostics to stderr or an appropriate logging sink.

This is release-critical.

---

## 35. MCP protocol safety

Add tests ensuring:

- stdout contains only valid MCP protocol output
- logs do not corrupt stdio
- startup errors are surfaced correctly
- graceful shutdown works

This is a critical integration test.

---

## 36. Context preview safety

Never modify repository files from preview commands.

`preview` is read-only.

The same applies to:

- search
- symbol lookup
- caller lookup
- status
- doctor

Only cache/index files may change.

---

## 37. Developer workflow benchmark

Add a v0.7 workflow benchmark.

Evaluate at least:

1. fresh install/init
2. first index
3. first preview
4. warm preview
5. edit one Java file
6. preview again
7. MCP startup
8. MCP query

Record:

- commands required
- errors
- latency
- files reparsed
- context size
- whole-file fallback
- stale-index behavior

---

## 38. Usability checklist

Create a deterministic usability checklist.

Example:

```text
[ ] install command documented
[ ] init works in repository root
[ ] init works from nested directory
[ ] status reports ready state
[ ] doctor identifies stale cache
[ ] preview returns context
[ ] preview respects budget
[ ] preview can explain inclusions
[ ] MCP starts with one stable command
[ ] logs do not corrupt MCP stdout
[ ] source edit triggers incremental refresh
[ ] whole-file fallback is visible
```

Do not call this a user study.

It is an engineering usability checklist.

---

## 39. Optional real-developer test

If a second developer is available, conduct a lightweight manual trial.

Ask them to:

1. install ContextSlice
2. connect it to one assistant
3. run one Java task
4. report friction points

Record qualitative findings.

This is optional.

Do not block v0.7 on external participants.

---

## 40. Reports

Generate:

```text
benchmarks/results/v0.7-developer-workflow.md
benchmarks/results/v0.7-developer-workflow.json
```

Include:

1. Executive summary
2. Installation path
3. CLI commands
4. MCP setup
5. Workflow benchmark
6. Latency
7. stale-index behavior
8. context/token display
9. usability checklist
10. error handling
11. dogfood findings
12. limitations
13. next step

---

## 41. README update

Refactor README toward actual developer adoption.

Recommended order:

1. What ContextSlice does
2. Why context windows get wasted
3. Quick start
4. Example context reduction
5. CLI usage
6. Codex setup
7. Claude Code setup
8. How it works
9. Trust/explainability
10. Benchmarks
11. Limitations
12. Development

Put Quick Start near the top.

Do not lead with internal architecture.

---

## 42. Quick Start target

README should make this flow obvious:

```bash
# install
...

cd my-java-project

context-slice init

context-slice preview "explain retryPayment"

context-slice mcp
```

Then show assistant integration.

---

## 43. Product language

Use:

> ContextSlice reduces the amount of source code developers place into AI coding assistants’ context windows.

Also acceptable:

> ContextSlice builds minimum sufficient code context for the task at hand.

Avoid:

> ContextSlice optimizes the agent.

Avoid claiming:

> 95% token savings everywhere.

Instead write:

> In the current 15-task benchmark across three pinned Java repositories, ContextSlice reduced median context size by 94.55% while preserving 100% required-fact recall.

Keep benchmark scope attached to the number.

---

## 44. No benchmark leakage

Developer-facing preview and MCP behavior must not access:

- requiredFacts
- expectedSymbols
- benchmark answers
- manual baseline definitions

Benchmark data must remain isolated.

Normal product behavior must operate only from:

- task text
- repository content
- index
- configuration

Add a regression check if practical.

---

## 45. Definition of done

v0.7 is complete when:

- build passes
- all existing tests pass
- new CLI tests pass
- new MCP stdio safety tests pass
- init works
- index works
- status works
- doctor works
- preview works
- preview respects token budget
- preview explains inclusions
- stale-index detection works
- single-file incremental refresh works
- MCP starts through a stable command
- Codex setup is documented
- Claude Code setup is documented
- normal logs do not corrupt MCP stdout
- JSON CLI mode works for key commands
- workflow benchmark is generated
- README has a clear Quick Start
- benchmark leakage is absent
- v0.6 correctness metrics remain intact
- no major semantic architecture dependency is added

---

## 46. Final implementation report

At completion output:

```text
STATUS

BUILD / TESTS

CLI

INSTALLATION

INIT / INDEX

STATUS / DOCTOR

PREVIEW

CONTEXT / TOKEN DISPLAY

STALE INDEX

INCREMENTAL REFRESH

MCP STDIO SAFETY

CODEX SETUP

CLAUDE CODE SETUP

WORKFLOW LATENCY

USABILITY CHECKLIST

DOGFOOD

V0.6 REGRESSION

KNOWN LIMITATIONS

NEXT STEP
```

Every claim must be exercised.

---

## 47. Guiding principle

The central question for v0.7 is:

> Can a developer start using ContextSlice in a normal coding workflow without needing to understand how ContextSlice works internally?

The engine is already strong enough for the current benchmark.

Now make the tool easy to adopt, easy to inspect, and easy to trust.
