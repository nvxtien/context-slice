# ContextSlice

> Less context. Unchanged signal.
>
> Give your coding assistant the smallest useful slice of your codebase.

<p align="center">
  <img src="assets/context-slice-hero.png" alt="Source files converging into a focused ContextSlice context" width="100%" />
</p>

You just joined a codebase with hundreds of files. Where do you start without
feeding an entire repository to an AI assistant?

ContextSlice builds a small, task-specific context from Java, TypeScript, TSX,
JavaScript, Python, Rust, and Go source. It finds the target symbol, follows
relevant callers and callees, and reports what was included or left out.

It is local, read-only, and deterministic: Tree-sitter performs the structural
analysis, SQLite stores the index, and no source code is sent to a hosted
service by ContextSlice.

## Quick start

### Claude Code plugin

Install it directly from the GitHub marketplace:

```text
/plugin marketplace add nvxtien/context-slice
/plugin install context-slice@context-slice-marketplace
```

The plugin provides a skill that tells Claude Code to request a focused
ContextSlice preview before reading source files. The MCP server then targets
the project Claude Code has open. The plugin starts the published
`context-slice@1.9.0` npm runtime, so Claude needs npm registry access on first
use. The package installs native dependencies for the current platform; later
runs use the local npm cache.

### Codex plugin

Add the GitHub marketplace to Codex:

```sh
codex plugin marketplace add nvxtien/context-slice
codex plugin marketplace list
```

Then open `/plugins`, choose `Context Slice Marketplace`, and install
`context-slice`. The plugin includes the same ContextSlice skill and stdio MCP
server for the project Codex has open.

### CLI and MCP

```sh
context-slice init
context-slice preview "explain the payment retry flow" --explain
```

## How it works

1. Discover a repository and scan supported source while ignoring common generated/build directories.
2. Store symbols, call edges, hashes, schema version, and refresh time in a local SQLite cache.
3. Refresh before preview or MCP tool execution so changed source files are not silently served stale.
4. Select a target from task text, then include the target body plus ranked direct callers/callees until the strict token budget is full.

Available MCP tools are `context.search`, `context.symbol`, `context.callers`, `context.preview`, `context.slice`, and `context.diff`. MCP stdout contains protocol messages only; diagnostics must not corrupt stdio framing.

## Supported languages

| Language   | Extensions                     | Notes                                                                                                                                                                             |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Java       | `.java`                        | Classes, interfaces, records, enums, methods, constructors                                                                                                                        |
| TypeScript | `.ts`, `.mts`, `.cts`, `.d.ts` | Imports, re-exports and barrels, overloads, arrow functions                                                                                                                       |
| TSX        | `.tsx`                         | React components, handlers, JSX component references                                                                                                                              |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs`  | Same adapter as TypeScript (JS is parsed as untyped TS); CommonJS (`require`/`module.exports`) is not recognized as imports/exports — see Known limitations below                 |
| Python     | `.py`, `.pyi`                  | Packages and `__init__` re-exports, decorators, `self`/`cls`, dataclasses                                                                                                         |
| Rust       | `.rs`                          | Functions, structs, enums, traits, impls, modules; `use`/re-export resolution; self/associated/trait call resolution                                                              |
| Go         | `.go`                          | Functions, methods (incl. generic receivers), structs, interfaces, struct embedding and interface satisfaction; same-package, import-qualified and receiver-typed call resolution |

One repository can hold all of them. See [docs/typescript-support.md](docs/typescript-support.md), [docs/python-support.md](docs/python-support.md) and [docs/rust-support.md](docs/rust-support.md) for what each language's resolution does and does not cover.

## Installation

### Local development

For local development, install and link the executable from this checkout:

```sh
npm ci
npm run build
npm link
```

### npm package

Node.js 20 or newer is required. Install the published package with:

```sh
npm install -g context-slice@1.9.0
context-slice --version
```

For a local tarball smoke test:

```sh
npm pack
npm install -g ./context-slice-1.9.0.tgz
```

For package/release validation, run `npm run benchmark:v08`.

### CLI examples

In any supported repository:

```sh
cd /absolute/path/to/my-java-project
context-slice init
context-slice preview "explain payment retry flow" --explain
```

`init` creates `.context-slice/index.sqlite`. Repository discovery uses
`--repo` when given, otherwise the nearest Git root, otherwise the working
directory.

Use `context-slice --version` and `context-slice --help` to inspect the
installed package.

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

## Example

```text
Target: demo.PaymentService.retryPayment
Context: 286/1200 tokens; 3 items included

Included:
- task target: demo.PaymentService.retryPayment — Selected because the task names retryPayment.
- direct caller: demo.PaymentController.retry — Direct caller of demo.PaymentService.retryPayment.
- direct callee: demo.PaymentService.audit — Direct callee of demo.PaymentService.retryPayment.
```

ContextSlice may include relevant sibling members and a compact enclosing-type
skeleton. See [docs/context-composition.md](docs/context-composition.md).

The target body is always first. Related symbols use compact skeletons. The command never silently exceeds its budget; skipped candidates are reported as `context budget`, and unresolved calls remain unresolved rather than being guessed.

## MCP verification

The marketplace plugins configure MCP automatically. Verify Claude with:

```sh
claude mcp list
```

The expected result is `plugin:context-slice:context-slice - ✔ Connected`.
Codex can verify the same server with `codex mcp list`.

## Behavior

- Call resolution distinguishes exact, probable, and unresolved edges; it does not invent runtime dispatch targets.
- Preview, status, doctor, and MCP lookup operations are read-only except for the local `.context-slice/` cache.
- The target repository is not edited.

## Benchmarks

Run benchmarks locally:

```sh
npm run benchmark:v07
```

Reports are written under `benchmarks/results/`. Packaging validation is
available with `npm run benchmark:v08`.

## Limitations

- Java, TypeScript, TSX, JavaScript, Python, Rust and Go only; no other languages, embeddings, vector database, compiler, tsserver, type checker, rust-analyzer, rustc, or LSP integration.
- Python is dynamic: receivers built by factories, `getattr`, dynamic imports and monkey patching stay unresolved rather than guessed.
- Rust macro-generated semantics and some trait dispatch remain unresolved; `rust-analyzer` and `rustc` are not used.
- TypeScript resolution is structural. Receivers whose type needs inference, CommonJS `require`, and imports that leave the checked-out source stay unresolved rather than guessed.
- JavaScript CommonJS (`require()`/`module.exports`) is not recognized as imports/exports; only ES `import`/`export` syntax is supported. See [benchmarks/results/v1.7-javascript-support.md](benchmarks/results/v1.7-javascript-support.md).
- Go struct-embedding promotion lookup remains same-package. See [benchmarks/results/v1.6-go-support.md](benchmarks/results/v1.6-go-support.md).
- Target selection from task text is heuristic and may choose a nearby but not ideal symbol. Naming the method in the task gives a better slice.
- Tree-sitter analysis cannot prove runtime dispatch, framework-generated implementations, or all generic/fluent call behavior.
- Token counts are estimates, not model-provider usage telemetry.
- Sibling composition uses syntactic evidence (`this.field` and Java field names). State shared through an intermediate object is not detected.
- The local index is an aid to request context, not a substitute for code review or tests.
- The Claude Code marketplace plugin needs npm registry access on first use to install `context-slice@1.9.0` and its native dependencies; offline use works only after the npm cache is populated.
- The Claude plugin is validated with Claude Code 2.1.285 on macOS arm64. Other Claude Code releases and plugin hosts may differ in MCP startup behavior.
- Validated on macOS arm64 (Node 20.19.5 and 22.12.0). Linux and Windows are unverified.
- Usability evidence comes from a scripted self clean-room trial; no external developer trial has been run yet.

## Development

```sh
npm ci
npm run build
npm test
npm run benchmark:v07
```
