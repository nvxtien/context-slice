# ContextSlice

ContextSlice is a local, read-only developer tool for Java, TypeScript and TSX that builds a small, task-specific code context before it is sent to a coding assistant. Instead of opening and pasting whole files, ask for the method, its callers, callees, and explicit omissions that matter to the task.

It indexes source with Tree-sitter, keeps a local SQLite cache, and exposes the same workflow through a CLI and stdio MCP server. It does not edit the target repository.

## Why use it

Large context windows still waste attention when they contain unrelated files. ContextSlice makes the context package inspectable: it reports the target, estimated token budget, included symbols, omissions caused by budget, unresolved calls, and cache freshness.

## Supported languages

| Language   | Extensions                     | Notes                                                       |
| ---------- | ------------------------------ | ----------------------------------------------------------- |
| Java       | `.java`                        | Classes, interfaces, records, enums, methods, constructors  |
| TypeScript | `.ts`, `.mts`, `.cts`, `.d.ts` | Imports, re-exports and barrels, overloads, arrow functions |
| TSX        | `.tsx`                         | React components, handlers, JSX component references        |

One repository can hold all of them. See [docs/typescript-support.md](docs/typescript-support.md) for what TypeScript resolution does and does not cover.

## Scope

- Tree-sitter structural and semantic analysis; no compiler, JDT, tsserver, or LSP dependency.
- A local stdio MCP server and a local SQLite cache under `.context-slice/`.
- Integrates with Codex and Claude Code through one stable command: `context-slice mcp`.
- Validated on macOS arm64 with Node 20 and Node 22. Other platforms are expected to work but are unverified.

## Installation

### Local development

ContextSlice is not published to npm. From this checkout, install and link the local executable:

```sh
npm ci
npm run build
npm link
```

### Tarball validation

The package is publish-ready but is not currently published to the npm registry. Build and install the release-candidate tarball from a checkout (`npm ci` is required because `npm pack` compiles TypeScript first):

```sh
npm ci
npm pack
npm install -g ./context-slice-1.2.0.tgz
context-slice --version
```

Node.js 20 or newer is required. `npm install` downloads the native `better-sqlite3` and `tree-sitter` builds for your platform, so it needs registry access.

The isolated packaging smoke test uses a temporary npm prefix and does not depend on `npm link`:

```sh
npm run benchmark:v08
```

Registry installation (`npm install -g context-slice`) and `npx context-slice` remain publication-dependent and are not claimed as supported yet.

### Quick start

Then, in a Java repository:

```sh
cd /absolute/path/to/my-java-project
context-slice init
context-slice preview "explain payment retry flow" --explain
```

`init` creates `.context-slice/index.sqlite` automatically. Repository discovery uses `--repo` when given, otherwise the nearest Git root, otherwise the working directory.

In a TypeScript or TSX repository the workflow is identical:

```sh
cd /absolute/path/to/my-typescript-project
context-slice init
context-slice preview "explain the order create flow" --explain
```

```text
Target: OrderService.create
Context: 139/1200 tokens; 5 items included

Included:
- task target: OrderService.create — Selected because the task names create.
- direct caller: createOrder — Direct caller of OrderService.create.
- direct callee: SqlOrderRepository.save — Direct callee of OrderService.create.
```

`status` reports the file count per extension, so a mixed repository shows `.java`, `.ts` and `.tsx` separately.

Use `context-slice --version` and `context-slice --help` to inspect the installed package without relying on the source checkout.

### Cache, cleanup, and uninstall

The only files ContextSlice writes are in `<repository>/.context-slice/`. That directory contains its own `.gitignore`, so it never shows up in `git status` and you do not need to edit your repository's `.gitignore`. ContextSlice never writes into its installed package directory.

- Rebuild from scratch: `rm -rf .context-slice && context-slice init`
- Remove ContextSlice from a repository: `rm -rf .context-slice`
- Uninstall the CLI: `npm uninstall -g context-slice` (repository caches are left in place; remove them as above)

Caches are versioned. A cache written by a different index schema, older or newer, is discarded and rebuilt automatically; it is never reused.

## CLI workflow

```sh
context-slice init
context-slice status
context-slice doctor
context-slice preview "explain retryPayment" --budget 1200 --explain
context-slice preview "explain retryPayment" --json
context-slice mcp
```

| Command          | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `init`           | Discover the repository and create/refresh the local index.      |
| `index`          | Refresh the index explicitly.                                    |
| `status`         | Show readiness, schema, cache freshness, and last refresh.       |
| `doctor`         | Check repository, Java source, cache, and MCP command readiness. |
| `preview <task>` | Return a deterministic, strict-budget context preview.           |
| `mcp`            | Start the stdio MCP server with the stable public command.       |

Use `--repo /absolute/path` to select a repository. `--json` provides a stable automation-oriented result. Normal commands are quiet; `--explain` displays why each item was included or omitted.

Exit codes are `0` for success, `2` for user or configuration errors, and `1` for unexpected failures. Errors include a remediation, for example increasing `--budget` when the selected target cannot fit.

## Example: inspectable context reduction

```text
Target: demo.PaymentService.retryPayment
Context: 286/1200 tokens; 3 items included

Included:
- task target: demo.PaymentService.retryPayment — Selected because the task names retryPayment.
- direct caller: demo.PaymentController.retry — Direct caller of demo.PaymentService.retryPayment.
- direct callee: demo.PaymentService.audit — Direct callee of demo.PaymentService.retryPayment.
```

ContextSlice may also include sibling members that share state or local semantics with the target — a field it writes, the getter that exposes it, the constructor that supplies a dependency — plus a declaration-line skeleton of the enclosing type. It does not expand to the whole class or file. See [docs/context-composition.md](docs/context-composition.md).

The target body is always first. Related symbols use compact skeletons. The command never silently exceeds its budget; skipped candidates are reported as `context budget`, and unresolved calls remain unresolved rather than being guessed.

## Codex setup

After installing ContextSlice, register its one stable MCP command for a Java repository:

```sh
codex mcp add context-slice -- context-slice mcp --repo /absolute/path/to/my-java-project
codex mcp list
```

Codex also supports project-scoped configuration in `.codex/config.toml` for trusted projects. See the [official OpenAI MCP documentation](https://developers.openai.com/es-419/docs/extend/mcp?surface=cli) for the current Codex CLI and configuration options.

Suggested assistant instruction:

```text
For Java implementation or explanation tasks, request context.preview with the task first.
Use the target, inclusion explanations, omissions, and unresolved calls to decide whether to
request context.symbol, context.callers, or context.slice. Do not assume unresolved runtime
dispatch has a concrete implementation.
```

## Claude Code setup

Use the equivalent local stdio registration for the same command:

```sh
claude mcp add --transport stdio context-slice -- context-slice mcp --repo /absolute/path/to/my-java-project
claude mcp list
```

Verify command syntax against `claude mcp --help` in the installed Claude Code version before sharing configuration. ContextSlice itself speaks standard stdio MCP; this repository does not claim to have exercised every Claude Code release.

## How it works

1. Discover a Java repository and scan source while ignoring common generated/build directories.
2. Store symbols, call edges, hashes, schema version, and refresh time in a local SQLite cache.
3. Refresh before preview or MCP tool execution so changed Java files are not silently served stale.
4. Select a target from task text, then include the target body plus ranked direct callers/callees until the strict token budget is full.

Available MCP tools are `context.search`, `context.symbol`, `context.callers`, `context.preview`, `context.slice`, and `context.diff`. MCP stdout contains protocol messages only; diagnostics must not corrupt stdio framing.

## Trust and explainability

ContextSlice is deliberately conservative:

- Context previews use only task text, repository source, index data, and configuration. They do not read benchmark answers, required facts, expected symbols, or manual baselines.
- Call resolution distinguishes exact, probable, and unresolved edges. It does not invent runtime dispatch targets.
- `CURRENT`, `STALE`, `REFRESHING`, and `ERROR` are the workflow state vocabulary. The CLI exposes the observable cache state; preview/MCP refresh before serving context.
- Preview, status, doctor, and MCP lookup operations are read-only except for the local cache.

## Benchmarks

Run the workflow benchmark locally:

```sh
npm run benchmark:v07
```

It writes [JSON](benchmarks/results/v0.7-developer-workflow.json) and [Markdown](benchmarks/results/v0.7-developer-workflow.md) reports with fresh init, cold index, first/warm preview, one-file refresh, and first/subsequent MCP query timings. Timings apply only to the recorded local fixture environment. Codex/Claude telemetry is optional and is reported as unavailable when the runtime provides none.

`npm run benchmark:v03` through `benchmark:v06` first run `npm run benchmark:checkouts`, which fetches the pinned benchmark repositories from `benchmarks/repositories.json` (network required; about 120 MB).

Run `npm run benchmark:v08` for the tarball packaging, isolated installation, upgrade, uninstall, MCP, path-with-spaces, nested-cwd, publish-dry-run, and clean-room self-trial report in [JSON](benchmarks/results/v0.8-packaging-installation.json) and [Markdown](benchmarks/results/v0.8-packaging-installation.md). External developer participation is explicitly deferred; this is not a multi-user study.

Earlier semantic/context measurements remain available:

In the 15-task Java benchmark across three pinned Java repositories, ContextSlice reduced median context size by 94.55% while preserving 100% required-fact recall and 100% retrieval recall. In the separate 15-task TypeScript benchmark across three pinned TypeScript/TSX repositories, it reduced median context size by 83.32% with 95.56% required-fact recall and 100% retrieval recall. Context sizes are deterministic estimates from the built-in estimator, not assistant telemetry, so these are estimated token reductions rather than observed input token usage. The two benchmarks use different repositories and tasks and are not comparable to each other.

Run the TypeScript benchmark with `npm run benchmark:v11`; its report is [v1.1 TypeScript support](benchmarks/results/v1.1-typescript-support.md).

- [v0.6 developer context efficiency](benchmarks/results/v0.6-developer-context-efficiency.md) compares auditable manual whole-file baselines with ContextSlice on pinned Java repositories. Token counts are deterministic estimates unless telemetry is explicitly available.
- [v0.5 semantic call resolution](benchmarks/results/v0.5-semantic-call-resolution.md) documents declared versus runtime target limitations.
- [v0.4 symbol index hardening](benchmarks/results/v0.4-symbol-index-hardening.md) documents stable symbol identity and lookup behavior.

## Limitations

- Java, TypeScript and TSX only; no other languages, embeddings, vector database, compiler, tsserver, or LSP integration.
- TypeScript resolution is structural. Receivers whose type needs inference, CommonJS `require`, and imports that leave the checked-out source stay unresolved rather than guessed.
- Target selection from task text is heuristic and may choose a nearby but not ideal symbol. Naming the method in the task gives a better slice.
- Tree-sitter analysis cannot prove runtime dispatch, framework-generated implementations, or all generic/fluent call behavior.
- Token counts are estimates, not model-provider usage telemetry.
- Sibling composition uses syntactic evidence (`this.field` and Java field names). State shared through an intermediate object is not detected.
- The local index is an aid to request context, not a substitute for code review or tests.
- Validated on macOS arm64 (Node 20.19.5 and 22.12.0). Linux and Windows are unverified.
- Usability evidence comes from a scripted self clean-room trial; no external developer trial has been run yet.

## Development

```sh
npm ci
npm run build
npm test
npm run benchmark:v07
```

`npm run release:rc` performs the v0.9 clean-room release-candidate validation: fresh clone, `npm ci`, build, tests, regressions, `npm pack`, and an isolated install with a temporary `HOME` and npm cache against a freshly cloned Java repository. See [docs/release-readiness-v0.9.md](docs/release-readiness-v0.9.md) and [CHANGELOG.md](CHANGELOG.md).
