# ContextSlice

> A local, deterministic code index that serves a small, ranked slice of a
> codebase — a target symbol plus its callers and callees — instead of whole
> files.

<p align="center">
  <img src="assets/context-slice-hero.png" alt="Source files converging into a focused ContextSlice context" width="100%" />
</p>

When you use AI to write code, the model doesn’t spend tokens just writing the
final answer. A large part of the cost often comes from the code it has to
read first: the target file, its callers and callees, dependencies, tests, and
configuration.

Reading more code means more tokens, slower responses, and more noise around
the detail that actually matters. One way to cut that cost is to reduce how
much code the agent has to read in the first place.

ContextSlice is an attempt at that. It builds a small, task-specific context from
Java, TypeScript, TSX, JavaScript, Python, Rust, Go, C, C++, C#, and Kotlin
source. It finds the target symbol, follows relevant callers and callees,
and reports what was included or left out.

In short: instead of giving an AI assistant the whole repository, give it a
small slice of the codebase.

> **Read the results below before expecting savings.** In end-to-end tests
> with Claude Code, an agent that uses Grep and ranged reads was as accurate
> and cheaper without ContextSlice. See
> [What the measurements show](#what-the-measurements-show).

## What the measurements show

### Does the slice keep what a task needs?

Yes, on the tasks we checked. For 108 hand-written tasks (locate, explain,
change, impact) on pinned open-source repositories in Java, Python, Rust, Go,
TypeScript, JavaScript, C, C++, C# and Kotlin, every source fact a task
requires was present in the slice at an 8192-token budget (100% required-fact
recall). Per-language and per-task numbers are in
[`benchmarks/results/`](benchmarks/results/); the `benchmark:*` scripts in
`package.json` reproduce them.

The same results also report how much smaller the slice is than the whole
files it comes from (84-99% depending on language). We do not present that as
a saving: an agent rarely reads whole files, so it says little about what an
agent spends. The next section measures that directly.

### End to end with Claude Code

The same agent (Claude Code, Sonnet 5.5, read-only tools) answered the same
code questions on real repositories with and without the ContextSlice plugin.
A separate Claude call graded each answer against a rubric written beforehand.
Eleven questions on Flask, zod, Spring PetClinic, ripgrep `ignore`, cobra,
Serilog, NestJS, Django, Excalidraw, Keycloak and jsoup, two runs each:

|                                   | Rubric score | Tool-result tokens (mean) | Turns (mean) | Cost per run (mean) |
| --------------------------------- | ------------ | ------------------------- | ------------ | ------------------- |
| Without ContextSlice (Grep, Read) | 92.5%        | 2,598                     | 5.6          | $0.066              |
| With ContextSlice                 | 92.5%        | 5,593                     | 7.7          | $0.099              |

(Weighted over the two rounds: six questions with the earlier, larger
response format, five harder ones with the compact one.)

Accuracy was the same within noise. ContextSlice did not reduce tokens or
cost for this agent: Grep followed by a ranged read already finds the right
code, and the agent usually still read files after calling the preview. This
held on a 14,000-line file and on "which code calls this function" questions.

Limits of this evidence: 11 questions, two runs each, rubrics written by the
tool's author, one agent and one model, repositories up to a few hundred
files of the kind covered above. It says nothing about weaker agents, agents
without a search tool, very large monorepos, or tasks that edit code. The
method and raw results are in [`benchmarks/e2e/`](benchmarks/e2e/).

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

## How it works

1. Discover a repository and scan supported source while ignoring common generated/build directories.
2. Store symbols, call edges, hashes, schema version, and refresh time in a local SQLite cache.
3. Refresh before preview or MCP tool execution so changed source files are not silently served stale.
4. Select a target from task text, then include the target body plus ranked direct callers/callees until the strict token budget is full.

Available MCP tools are `context.search`, `context.symbol`, `context.callers`, `context.preview`, `context.slice`, and `context.diff`. MCP stdout contains protocol messages only; diagnostics must not corrupt stdio framing.

## CLI

```sh
context-slice init
context-slice status
context-slice doctor
context-slice preview "explain retryPayment" --budget 1200 --explain
context-slice preview "explain retryPayment" --json
context-slice mark-dirty src/PaymentService.java
context-slice mcp
```

| Command             | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `init`              | Discover the repository and create/refresh the local index. |
| `index`             | Refresh the index explicitly.                               |
| `status`            | Show readiness, schema, cache freshness, and last refresh.  |
| `doctor`            | Check repository, source, cache, and MCP command readiness. |
| `preview <task>`    | Return a deterministic, strict-budget context preview.      |
| `mark-dirty [file]` | Tell a running MCP index that source changed.               |
| `mcp`               | Start the stdio MCP server with the stable public command.  |

Use `--repo /absolute/path` to select a repository (defaults to the nearest Git root). `--json` emits a stable, automation-oriented result; normal output is quiet, `--explain` adds why each item was included or omitted. `--budget <tokens>` sets the strict token budget for `preview`. `context-slice --version` and `context-slice --help` work without a repository checkout.

Exit codes are `0` for success, `2` for user/configuration errors, and `1` for unexpected failures. Errors include a remediation, for example increasing `--budget` when the selected target cannot fit.

## Supported languages

| Language   | Extensions                                  | Notes                                                                                                                                                                             |
| ---------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Java       | `.java`                                     | Classes, interfaces, records, enums, methods, constructors                                                                                                                        |
| TypeScript | `.ts`, `.mts`, `.cts`, `.d.ts`              | Imports, re-exports and barrels, overloads, arrow functions                                                                                                                       |
| TSX        | `.tsx`                                      | React components, handlers, JSX component references                                                                                                                              |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs`               | Same adapter as TypeScript (JS is parsed as untyped TS); CommonJS (`require`/`module.exports`) is not recognized as imports/exports — see Known limitations below                 |
| Python     | `.py`, `.pyi`                               | Packages and `__init__` re-exports, decorators, `self`/`cls`, dataclasses                                                                                                         |
| Rust       | `.rs`                                       | Functions, structs, enums, traits, impls, modules; `use`/re-export resolution; self/associated/trait call resolution                                                              |
| Go         | `.go`                                       | Functions, methods (incl. generic receivers), structs, interfaces, struct embedding and interface satisfaction; same-package, import-qualified and receiver-typed call resolution |
| C          | `.c`                                        | Functions at global scope (no classes/namespaces); global name-based call resolution; calls through function pointers are left unresolved rather than guessed                     |
| C++        | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx`, `.h` | Classes, structs, namespaces; same-type/inherited call resolution, including out-of-class method definitions (`Class::method`); a `.h` file is parsed as C++, not C               |
| C#         | `.cs`                                       | Classes, structs, records, methods, constructors; same-type/inherited/global name-based call resolution (no namespace-to-directory import resolution)                             |
| Kotlin     | `.kt`, `.kts`                               | Classes, objects, top-level functions, constructors; same-type/inherited/global name-based call resolution (no package-to-directory import resolution)                            |

One repository can hold all of them. See [docs/typescript-support.md](docs/typescript-support.md), [docs/python-support.md](docs/python-support.md) and [docs/rust-support.md](docs/rust-support.md) for what each language's resolution does and does not cover.

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

## Limitations

- Java, TypeScript, TSX, JavaScript, Python, Rust, Go, C, C++, C#, and Kotlin only; this is not a semantic search or build tool: it does not use vector embeddings, a vector database, a compiler, a type checker, or LSP services such as `tsserver`, `rust-analyzer`, or `rustc`.
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
