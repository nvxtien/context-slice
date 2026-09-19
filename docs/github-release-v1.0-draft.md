# ContextSlice 1.0.0

> DRAFT. No GitHub Release has been created. Review before publishing.

**Less code in context. Fewer tokens. Same required information.**

ContextSlice helps developers reduce the amount of source code placed into an AI coding assistant's context window. Instead of pasting whole Java files into Codex or Claude Code, you ask for the method that matters plus its direct callers and callees, inside a strict token budget.

```sh
context-slice preview "explain the payment retry flow" --explain
```

```text
Target: demo.PaymentService.retryPayment
Context: 286/1200 tokens; 3 items included

Included:
- task target: demo.PaymentService.retryPayment — Selected because the task names retryPayment.
- direct caller: demo.PaymentController.retry — Direct caller of demo.PaymentService.retryPayment.
- direct callee: demo.PaymentService.audit — Direct callee of demo.PaymentService.retryPayment.
```

Every context package is inspectable: it names the target, the token budget, what was included and why, what the budget omitted, which calls could not be resolved, and whether the index is current.

## What it does

- Indexes Java source with Tree-sitter into a local SQLite cache under `.context-slice/`.
- Picks a target from your task text, then adds ranked direct callers and callees until the token budget is full. It never silently exceeds the budget.
- Distinguishes exact, probable, and unresolved call edges. It does not invent runtime dispatch targets.
- Exposes the same workflow through a CLI and a stdio MCP server. It never edits your repository.

## Install

Not yet on the npm registry. Build and install the tarball from a checkout:

```sh
git clone https://github.com/nvxtien/context-slice.git && cd context-slice
npm ci
npm pack
npm install -g ./context-slice-1.0.0.tgz
context-slice --version
```

Node.js 20 or newer. Then, in a Java repository:

```sh
context-slice init
context-slice preview "explain the owner update flow" --explain
```

## MCP integration

One stable command for both assistants, with no paths into a source checkout:

```sh
codex mcp add context-slice -- context-slice mcp --repo /absolute/path/to/my-java-project
claude mcp add --transport stdio context-slice -- context-slice mcp --repo /absolute/path/to/my-java-project
```

Available tools: `context.search`, `context.symbol`, `context.callers`, `context.preview`, `context.slice`, and `context.diff`.

## Benchmark scope

In the current 15-task benchmark across three pinned Java repositories (spring-petclinic, spring-petclinic-rest, and keycloak services), ContextSlice reduced median context size by 94.55% while preserving 100% required-fact recall and 100% retrieval recall.

Context sizes are deterministic estimates from the built-in estimator, not assistant telemetry, so this is an estimated reduction rather than observed input token usage. The full method and per-task rows are in `benchmarks/results/`.

## Supported scope

- Java source code only.
- Tree-sitter structural and semantic analysis, with no compiler, JDT, or LSP dependency.
- A local MCP server and a local SQLite cache.
- Validated on macOS arm64 with Node 20.19.5 and 22.12.0.

## Limitations

- Java only. No other languages, embeddings, or vector search.
- Tree-sitter cannot prove runtime dispatch, framework-generated implementations, or every generic and fluent call. Those stay unresolved and are reported rather than guessed.
- Target selection from task text is heuristic and may pick a nearby but not ideal symbol. Naming the method gives a better slice.
- Token counts are estimates, not provider telemetry.
- Linux and Windows are unverified.
- Usability evidence is a scripted self clean-room trial. No external developer trial has been run yet.

## Package status

Version 1.0.0, MIT licensed, 20 runtime files and about 17 KB packed. No tests, benchmarks, fixtures, credentials, or local paths ship in the tarball. Registry publication is a separate, explicitly authorized step; until then `npm install -g context-slice` and `npx context-slice` do not work.
