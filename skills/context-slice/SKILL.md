---
name: context-slice
description: Use before reading source files to understand, implement, or explain something in a Java, TypeScript/TSX, JavaScript, Python, Rust, or Go repository. Serves a budget-bounded, relevance-ranked slice of the codebase (target symbol plus ranked callers/callees) through MCP tools instead of whole-file reads, shrinking how much context window the task consumes.
---

# Context Slice

Context Slice is an MCP server that indexes a repository's symbols and call
graph (via Tree-sitter, no LLM involved) and serves a compact, explainable
slice of it — not whole files. Prefer its tools over `Read`/`Grep` on source
files whenever the task is about a specific symbol, function, class, or
behavior in a supported repository, so the model spends tokens on the
relevant code instead of re-reading entire files to find it.

**Supported languages:** Java, TypeScript, TSX, JavaScript, Python, Rust, Go.
For any other language, or a question with no clear target symbol (e.g.
"what does this project do overall"), fall back to normal file reading.

## Workflow

1. **Start with `context.preview`** for any implementation or explanation
   task: `{ task: "<the task in the user's own words>" }`. It returns a
   selected target symbol, its rendered body, ranked direct callers/callees
   included under the token budget, inclusion/omission explanations, and any
   unresolved calls. Read the explanations — they say _why_ each piece was
   included, and what was left out and why.
2. **Do not assume an unresolved call has a concrete implementation.**
   Tree-sitter analysis cannot prove runtime dispatch (reflection, DI
   proxies, framework-generated code, Python/Go dynamic dispatch). An
   unresolved call in the result means exactly that — unresolved, not
   "has no implementation."
3. **Drill in with the other tools once you know the target symbol's id or
   name:**
   - `context.symbol` — read one symbol as `signature` / `skeleton` / `body`
     / `full` source. Use the smallest `detail` level that answers the
     question; only use `full` when the exact source text matters.
   - `context.callers` — bounded-depth callers of a symbol (`depth` 1-5).
   - `context.slice` — a strict-budget slice centered on one symbol instead
     of a task description.
   - `context.search` — find candidate symbols by name/text when you don't
     yet know the exact target.
   - `context.diff` — a `git diff` under a strict token budget, when the
     task is about recent changes.
4. **Only fall back to `Read`/`Grep` on raw source files** when: the
   language isn't supported, the repository has no index yet and a quick
   one-off answer is needed, or a tool result's explanation says the
   information isn't in the index (e.g. a file outside the checked-out
   source, or an unresolved dynamic call you must manually verify).

## Notes

- The index lives in `.context-slice/` inside the target repository and
  refreshes automatically on every tool call — changed files are never
  served stale, and there is no separate "build the index" step to run
  first.
- Every tool call targets the project Claude Code currently has open
  (`CONTEXT_SLICE_ROOT`), not the context-slice plugin's own source.
- All tool output is structural (symbols, call edges, source text) derived
  from the repository itself — never benchmark answers, expected results, or
  anything from outside the checked-out source.
