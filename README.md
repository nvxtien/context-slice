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

The result is:

- Less context to read and pay for: return the target symbol plus the most relevant callers and callees instead of whole files.
- Better signal: rank results by task relevance and keep unresolved runtime dispatch explicit instead of guessing.
- Predictable output: enforce a token budget and explain why items were included or omitted.
- Local control: keep source analysis and the SQLite index in the repository; the target source is never edited.

## Quick start

### Claude Code plugin

Install it directly from the GitHub marketplace:

```text
/plugin marketplace add nvxtien/context-slice
/plugin install context-slice@context-slice-marketplace
```

The plugin provides a skill that tells Claude Code to request a focused
ContextSlice preview before reading source files. Its `PreToolUse` hook also
blocks supported source reads until `context.preview` has completed, so this
is enforced at runtime rather than relying only on prompt compliance. The MCP
server then targets the project Claude Code has open. The plugin starts the published
the latest published `context-slice` npm runtime, so Claude needs npm registry access on first
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
npm install -g context-slice
context-slice init
context-slice preview "explain the payment retry flow" --explain
```

The CLI requires Node.js 20 or newer.

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
| `mark-dirty`     | Force hash verification for changed files.                       |
| `mcp`            | Start the stdio MCP server with the stable public command.       |

Use `--repo /absolute/path` to select a repository. `--json` provides a stable automation-oriented result. Normal commands are quiet; `--explain` displays why each item was included or omitted.

The local cache is `<repository>/.context-slice/`. Remove it and run `init` to
rebuild from scratch.

Exit codes are `0` for success, `2` for user or configuration errors, and `1` for unexpected failures. Errors include a remediation, for example increasing `--budget` when the selected target cannot fit.

## Benchmarks

Run benchmarks locally:

```sh
npm run benchmark:v07
```

Reports are written under `benchmarks/results/`. Packaging validation is
available with `npm run benchmark:v08`.

On the current macOS arm64 Java fixture, the workflow benchmark measured a
median 6.309 ms one-file incremental refresh; this is local evidence, not a
universal latency guarantee.

### Context-window evidence

We also ran five paired, fresh-session trials on the Emporia repository: one
direct-read run using `grep`/`Read`, and one ContextSlice run. The numbers below
measure source context returned to the model, not provider billing telemetry.

| Trial | Task | ContextSlice result | Evidence quality |
| --- | --- | ---: | --- |
| 1 | Authentication flow | ~12–17% fewer tokens | Measured, but the two runs used slightly different baselines. |
| 2 | Portfolio authorization | ~44% fewer tokens vs. actual direct-read output | Measured; whole-file comparison would overstate this as ~77%. |
| 3 | `PortfolioAdminController.provision` impact/call graph | ~77% fewer tokens | Strongest paired result: 4,675 direct-read vs. 1,066 sliced tokens. |
| 4 | Login failure root cause | ~1,470 sliced tokens | Reduction estimate of 75–85% is hypothetical; the direct-read run stopped to clarify the premise. |
| 5 | Audit event after portfolio provisioning | 1,218 sliced tokens | No valid reduction number: direct-read already answered the narrow question with little measured context. |

These trials show the expected pattern: ContextSlice is most useful for
cross-layer flows, impact analysis, and caller/callee tracing. It is less useful
for a narrow existence check or when the relevant implementation is already a
small number of files. A result only counts as a measured reduction when both
runs count the actual tool output; a hypothetical whole-file baseline is not a
measured context cost.

The ContextSlice runs also exposed a retrieval limitation: broad natural-language
tasks can select an off-target symbol. Naming a method, class, or entry point
explicitly, then using `context_slice` with a budget, produces more reliable
comparisons. Full-file reads and unused tool output must be counted when
estimating context size; index files scanned inside the MCP server do not count
unless their contents are returned to the model.

## Limitations

- Java, TypeScript, TSX, JavaScript, Python, Rust and Go only; this is not a semantic search or build tool: it does not use vector embeddings, a vector database, a compiler, a type checker, or LSP services such as `tsserver`, `rust-analyzer`, or `rustc`.
- The index is syntax-based, so runtime dispatch, framework-generated implementations, and some generic or fluent call chains may remain unresolved.
- Python analysis is AST-based and conservative: when a receiver or target cannot be determined from syntax alone—such as with factory-created receivers, `getattr`, dynamic imports, or monkey patching—the edge remains unresolved rather than guessed.
- Rust analysis is syntax-based and conservative: macro-expanded semantics and trait dispatch that require expansion or type checking may remain unresolved; `rust-analyzer` and `rustc` are not required.
- TypeScript resolution uses declared and imported structure: when a receiver type cannot be determined from those facts, or an import leaves the checkout, the edge remains unresolved rather than guessed.
- JavaScript module analysis currently follows ES module syntax. CommonJS `require()` and `module.exports` are parsed safely but are not yet represented as import/export edges. See [benchmarks/results/v1.7-javascript-support.md](benchmarks/results/v1.7-javascript-support.md).
- Go analysis resolves struct-embedding promotion when the embedded type and methods are visible in the same package directory. Cross-package promoted methods and constructor-returned interface implementations that require deeper type-flow inference may remain unresolved. See [benchmarks/results/v1.6-go-support.md](benchmarks/results/v1.6-go-support.md).
- Task-to-symbol selection is heuristic; naming the method or symbol explicitly gives a more precise slice.
- Sibling composition follows direct syntactic evidence (`this.field` and Java field names); state shared through an intermediate object is not included.
- Token counts are estimates for budget enforcement, not model-provider usage telemetry.
- The local index provides focused request context; verify behavior with normal code review and tests.
- Metadata is the fast freshness path. Watcher or `mark-dirty` notifications verify file content hashes when source changes need confirmation.
- The Claude plugin is validated with Claude Code 2.1.285 on macOS arm64. Other Claude Code releases and plugin hosts may differ in MCP startup behavior.
- The source-read guard depends on Claude Code plugin hook support; hosts that install only the MCP server or skill do not enforce it.
- Validated on macOS arm64 (Node 20.19.5 and 22.12.0); Linux and Windows use a directory-tree watcher fallback but are not CI-validated.

## Development

```sh
npm ci
npm run build
npm test
npm run benchmark:v07
```
