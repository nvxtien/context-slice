# ContextSlice v0.1 — Implementation Prompt

You are building **ContextSlice**, a local semantic-context MCP server for coding agents such as Codex and Claude Code.

The core idea is simple:

> Coding agents should not read whole source files by default. They should retrieve the smallest semantically sufficient slice of a codebase for the task at hand.

ContextSlice uses Tree-sitter to parse source code, build a compact symbol/dependency view, and expose MCP tools that let an agent progressively expand context only when needed.

The first release must optimize for **correctness, explainability, and measurable token reduction**, not feature count.

---

## 1. Product hypothesis

Typical coding agents waste context by repeatedly reading entire files, broad grep results, and unrelated neighboring code.

For a task such as:

```text
Add idempotency protection to PaymentService.retryPayment.
```

a conventional agent may read:

- the whole controller,
- the whole service,
- the whole repository,
- the whole entity,
- the whole event publisher,
- multiple complete test files,
- configuration that turns out to be irrelevant.

ContextSlice should instead provide:

- the target method body,
- signatures/skeletons of its direct dependencies,
- direct callers,
- relevant annotations,
- relevant tests,
- and only expand more source when explicitly requested.

The goal is **semantic slicing**, not summarization for its own sake.

---

## 2. v0.1 scope

Implement only the following:

- TypeScript
- Node.js
- MCP server over stdio
- Java source code only
- Tree-sitter Java parser
- SQLite persistence/cache
- Git-aware diff support
- no embeddings
- no vector database
- no LSP/compiler integration yet
- no cloud service
- no UI

Expose exactly these five primary MCP tools:

1. `context.search`
2. `context.symbol`
3. `context.callers`
4. `context.slice`
5. `context.diff`

Do not add speculative features until the core loop works and is benchmarked.

---

## 3. Core agent workflow

The intended coding-agent workflow is:

```text
task
  ↓
context.search
  ↓
context.slice
  ↓
reason
  ↓
context.symbol / context.callers when more detail is required
  ↓
edit source
  ↓
context.diff
  ↓
test
```

The desired policy is:

> Prefer ContextSlice retrieval before direct whole-file reads.

Do not make ContextSlice a hard security sandbox in v0.1. It is a semantic retrieval layer, not an access-control system.

---

## 4. Repository architecture

Start with a structure close to:

```text
context-slice/
├── package.json
├── tsconfig.json
├── src/
│   ├── server/
│   │   └── mcp-server.ts
│   ├── parser/
│   │   ├── parser.ts
│   │   └── java-parser.ts
│   ├── indexer/
│   │   ├── symbol-index.ts
│   │   ├── reference-index.ts
│   │   └── call-graph.ts
│   ├── planner/
│   │   ├── rank.ts
│   │   ├── budget.ts
│   │   └── slice.ts
│   ├── storage/
│   │   └── sqlite.ts
│   ├── git/
│   │   └── diff.ts
│   ├── render/
│   │   └── compact-context.ts
│   └── types/
│       └── model.ts
├── queries/
│   └── java/
│       ├── symbols.scm
│       ├── calls.scm
│       ├── imports.scm
│       └── annotations.scm
├── test-fixtures/
│   └── java/
├── tests/
└── benchmarks/
```

You may adjust names if the resulting design is simpler.

Keep modules small and explicit.

---

## 5. Semantic model

Create a compact internal representation for source-code symbols.

At minimum model:

```ts
type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "record"
  | "method"
  | "constructor"
  | "field";

interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

interface SymbolRecord {
  id: string;
  language: "java";
  kind: SymbolKind;
  name: string;
  qualifiedName?: string;
  signature?: string;
  filePath: string;
  range: SourceRange;
  bodyRange?: SourceRange;
  parentId?: string;
  annotations: string[];
  modifiers: string[];
}

interface CallEdge {
  callerId: string;
  receiverText?: string;
  calleeName: string;
  resolvedTargetId?: string;
  filePath: string;
  range: SourceRange;
  confidence: "exact" | "probable" | "unresolved";
}
```

Important:

Tree-sitter alone cannot reliably resolve every Java method invocation to its exact target.

Therefore never pretend unresolved calls are exact.

Preserve uncertainty explicitly.

---

## 6. Tree-sitter responsibilities

Use Tree-sitter for:

- parsing Java,
- extracting declarations,
- extracting method bodies,
- extracting annotations,
- extracting imports,
- extracting method invocations,
- extracting class/interface inheritance syntax,
- incremental re-indexing where practical.

Do not dump raw Tree-sitter AST into LLM context.

Tree-sitter is an implementation detail.

The agent-facing representation must be compact and semantic.

Use query files where appropriate.

Example conceptual queries:

```scheme
(method_declaration
  name: (identifier) @method.name
  parameters: (formal_parameters) @method.params
  body: (block) @method.body)
```

and:

```scheme
(method_invocation
  name: (identifier) @call.name)
```

Queries may evolve according to the actual Java grammar.

---

## 7. Context levels

Support progressive disclosure.

### Level 0 — signature

Example:

```text
PaymentService.retryPayment(String): RetryResult
```

### Level 1 — semantic skeleton

Example:

```text
PaymentService.retryPayment(String): RetryResult

annotations:
  @Transactional

calls:
  PaymentRepository.find
  PaymentRepository.save
  PaymentEventPublisher.publish

branches:
  status == FAILED
```

### Level 2 — body

Return the exact source body for the requested symbol.

### Level 3 — full declaration

Return the enclosing declaration with relevant annotations and imports when necessary.

For v0.1, `context.symbol` may expose these levels through a `detail` argument:

```text
signature | skeleton | body | full
```

Default to `skeleton`.

---

## 8. MCP tool contracts

### 8.1 context.search

Purpose:

Find likely relevant symbols without opening whole files.

Input:

```ts
{
  query: string;
  limit?: number;
}
```

Search signals for v0.1:

- symbol-name matching,
- qualified-name matching,
- file-name matching,
- signature matching,
- annotation matching,
- lexical token overlap.

Do not add embeddings in v0.1.

Return compact results:

```ts
{
  id: string;
  kind: string;
  name: string;
  qualifiedName?: string;
  signature?: string;
  filePath: string;
  score: number;
}
```

---

### 8.2 context.symbol

Purpose:

Retrieve one symbol with progressive detail.

Input:

```ts
{
  symbol: string;
  detail?: "signature" | "skeleton" | "body" | "full";
}
```

Accept either a stable symbol id or a sufficiently specific symbol name.

If the name is ambiguous, return candidates instead of guessing.

---

### 8.3 context.callers

Purpose:

Find symbols that invoke a target symbol.

Input:

```ts
{
  symbol: string;
  depth?: number;
  limit?: number;
}
```

Default depth:

```text
1
```

Clearly indicate call edges that are syntactic or unresolved.

Do not claim compiler-grade call resolution.

---

### 8.4 context.slice

This is the core tool.

Input:

```ts
{
  symbol: string;
  intent?: string;
  budget?: number;
  depth?: number;
}
```

Default token budget:

```text
4000
```

The slice should prioritize:

1. target symbol body,
2. target annotations,
3. direct dependency signatures/skeletons,
4. direct callers,
5. nearby relevant fields/types,
6. relevant tests when identifiable.

Never fill the budget simply because it exists.

Smaller sufficient context is better.

Return both the rendered context and metadata explaining what was included.

Example:

```text
TARGET
PaymentService.retryPayment(String): RetryResult

ANNOTATIONS
@Transactional

CALLERS
PaymentController.retry(String)
PaymentRetryJob.execute(String)

DEPENDENCIES
PaymentRepository.find(String): Payment
PaymentRepository.save(Payment): void
PaymentEventPublisher.publish(Event): void

SOURCE
<exact method body>
```

Also return machine-readable inclusion metadata:

```ts
{
  included: [
    {
      symbolId: "...",
      reason: "target" | "direct-caller" | "direct-callee" | "annotation" | "test",
      estimatedTokens: 123,
      score: 0.94
    }
  ]
}
```

---

### 8.5 context.diff

Purpose:

Expose semantic changes from Git without forcing the agent to reread entire modified files.

Input:

```ts
{
  base?: string;
  head?: string;
  budget?: number;
}
```

Default behavior:

compare working tree against HEAD.

Return:

- changed files,
- changed/added/removed symbols,
- relevant source hunks,
- directly affected callers/callees when known,
- token estimate.

Example:

```text
CHANGED

PaymentService.retryPayment
  branch condition changed
  body changed

AFFECTED CALLERS

PaymentController.retry
PaymentRetryJob.execute
```

Use Git diff plus the before/after symbol index.

Do not attempt deep semantic equivalence in v0.1.

---

## 9. Context planner

Implement deterministic ranking before considering any ML ranking.

A starting score may combine:

```text
score =
    symbol_match
  + lexical_intent_match
  + call_proximity
  + same_type_bonus
  + test_relevance
  - token_cost_penalty
```

Exact weights are implementation details.

The important properties are:

- deterministic,
- inspectable,
- testable,
- explainable.

Every included context item must have a reason.

Do not return an opaque ranking.

---

## 10. Token budgeting

Do not rely on character count alone.

Create a token-estimation abstraction.

For v0.1 it is acceptable to use a conservative heuristic such as:

```text
estimated tokens ≈ characters / 4
```

but isolate this behind an interface so model-specific tokenizers can be added later.

The planner must stop expanding when the requested budget would be exceeded.

Prefer:

```text
signature
→ skeleton
→ body
→ full declaration
```

instead of immediately including full source.

---

## 11. Compact rendering

The output consumed by an LLM must be concise.

Good:

```text
PaymentService.retryPayment(String): RetryResult

@Transactional

CALLS
PaymentRepository.find
PaymentRepository.save
PaymentEventPublisher.publish
```

Bad:

```json
{
  "tree": {
    "type": "method_declaration",
    "children": [
      ...
    ]
  }
}
```

Do not expose raw AST unless a debugging-only internal command explicitly requests it.

---

## 12. Java/Spring awareness

v0.1 is not a Spring parser, but preserve high-value annotations.

At minimum recognize and prominently retain annotations such as:

```text
@Transactional
@RestController
@Controller
@Service
@Repository
@Component
@RequestMapping
@GetMapping
@PostMapping
@PutMapping
@PatchMapping
@DeleteMapping
@PreAuthorize
@Secured
@Entity
@Table
@Id
```

Do not hard-code behavior that assumes every Java project uses Spring.

Annotations are semantic hints, not proof of runtime behavior.

---

## 13. SQLite storage

Persist index information locally.

Suggested local directory:

```text
.context-slice/
```

Suggested contents:

```text
.context-slice/
  index.sqlite
```

At minimum persist:

- indexed files,
- content hash,
- symbols,
- call edges,
- imports,
- annotations,
- indexing version.

Use hashes to avoid reparsing unchanged files.

The cache must be disposable.

Deleting `.context-slice/` must never damage the repository.

Add it to `.gitignore`.

---

## 14. Incremental indexing

On startup:

1. discover Java files,
2. hash them,
3. compare with persisted hashes,
4. parse only new/changed files,
5. delete stale index entries for removed files,
6. rebuild only affected edges when practical.

Correctness is more important than sophisticated incremental optimization.

A full rebuild fallback is acceptable.

---

## 15. Git behavior

Never mutate the user's Git history.

Git support is read-only in v0.1.

Use Git only to inspect:

- HEAD,
- working-tree diff,
- staged diff where useful,
- explicit base/head refs supplied to `context.diff`.

Do not commit automatically.

---

## 16. Security and repository boundaries

ContextSlice runs locally and must stay within the configured repository root.

Reject path traversal outside the repository.

Ignore common heavy/generated directories by default:

```text
.git
node_modules
target
build
dist
out
.gradle
.idea
.vscode
.context-slice
```

Allow configuration later, but avoid a large config system in v0.1.

Do not execute repository source code.

Parsing source is allowed; running arbitrary project code is not part of indexing.

---

## 17. Errors must be explicit

Examples:

- ambiguous symbol,
- symbol not found,
- parse error,
- repository not initialized,
- token budget too small,
- unsupported language,
- Git unavailable.

Do not silently substitute unrelated symbols.

Tree-sitter can often recover partial trees from incomplete code; when a symbol came from an error-containing parse tree, expose that fact.

---

## 18. Testing requirements

Use automated tests from the beginning.

At minimum cover:

### Parser tests

- class extraction,
- interface extraction,
- method extraction,
- constructor extraction,
- field extraction,
- annotation extraction,
- method invocation extraction,
- nested classes,
- overloaded methods,
- records,
- malformed/incomplete Java.

### Index tests

- initial indexing,
- unchanged-file cache hit,
- modified file invalidation,
- removed-file cleanup,
- duplicate simple symbol names.

### Tool tests

- search ranking,
- symbol ambiguity,
- caller lookup,
- slice token limit,
- diff after method change.

### Safety tests

- path traversal rejection,
- ignored directories,
- repository-root enforcement.

---

## 19. Test fixture

Create a small Java/Spring-like fixture representing:

```text
PaymentController
  → PaymentService.retryPayment
      → PaymentRepository.find
      → PaymentRepository.save
      → PaymentEventPublisher.publish

PaymentRetryJob
  → PaymentService.retryPayment
```

Include a few irrelevant classes so retrieval quality can be measured.

Include at least:

- `@PostMapping`,
- `@Transactional`,
- an overloaded method,
- one unresolved call,
- one relevant unit test.

Use this fixture for deterministic tests and the first benchmark.

---

## 20. Benchmark harness

This is mandatory.

Do not claim token savings without measurement.

Create a benchmark that can compare at least:

### Baseline A — whole relevant files

Approximate the context an ordinary agent would receive by concatenating manually identified relevant files.

### ContextSlice

Run `context.slice` for the same task.

Measure:

```text
baseline characters
baseline estimated tokens
slice characters
slice estimated tokens
reduction percentage
included symbols
excluded symbols
```

Use several tasks, for example:

```text
1. Locate all entry points into retryPayment.
2. Add idempotency protection to retryPayment.
3. Explain what happens after a retry is accepted.
4. Identify tests likely affected by changing retryPayment.
5. Inspect a Git change to retryPayment.
```

Token reduction is not enough.

For each benchmark, define a small checklist of **required facts** that the slice must preserve.

Example:

```text
required facts:
- retryPayment is transactional
- controller calls retryPayment
- retry job calls retryPayment
- repository save is invoked
- event publisher is invoked
```

A slice that removes a required fact is a failure even if token reduction is excellent.

---

## 21. Success metrics

Primary:

```text
useful required facts preserved
--------------------------------
estimated input tokens
```

Also record:

```text
token reduction %
retrieval latency
indexing latency
cache-hit latency
number of symbols returned
required-fact recall
```

Do not optimize for token reduction alone.

The product fails if it saves tokens by deleting information required to solve the task correctly.

---

## 22. Non-goals for v0.1

Do not implement yet:

- embeddings,
- vector search,
- semantic LLM summaries,
- automatic code generation,
- code editing,
- compiler-grade Java resolution,
- Eclipse JDT integration,
- tsserver,
- rust-analyzer,
- multi-language parsing,
- web dashboard,
- SaaS backend,
- authentication,
- distributed indexing,
- repository-wide architecture inference,
- automatic prompt rewriting.

Leave clean extension points where appropriate.

---

## 23. Future direction — do not implement now

The architecture should not block later addition of:

```text
Tree-sitter
    +
LSP/compiler index
    +
symbol graph
    +
semantic context planner
```

Possible future resolvers:

- Java → Eclipse JDT LS
- TypeScript → tsserver
- Rust → rust-analyzer

Possible future tools:

```text
context.callees
context.dependencies
context.expand
context.trace
context.why
```

But they are not part of v0.1.

---

## 24. Implementation order

Follow this order unless a concrete technical dependency requires a small adjustment.

### Phase 1 — bootstrap

- initialize TypeScript project,
- configure test runner,
- create CLI entry point,
- detect repository root,
- wire MCP stdio server.

### Phase 2 — Java parsing

- add Tree-sitter Java,
- implement declaration extraction,
- implement annotation extraction,
- implement invocation extraction,
- add parser tests.

### Phase 3 — persistent index

- add SQLite,
- hash files,
- store symbols/edges,
- add incremental refresh,
- add index tests.

### Phase 4 — retrieval tools

Implement:

- `context.search`,
- `context.symbol`,
- `context.callers`.

Add ambiguity handling and compact rendering.

### Phase 5 — slicing

Implement:

- deterministic ranking,
- token estimation,
- budget enforcement,
- `context.slice`,
- inclusion reasons.

### Phase 6 — Git diff

Implement:

- changed files,
- before/after changed symbol detection,
- `context.diff`.

### Phase 7 — benchmark

Add fixture tasks and record baseline vs ContextSlice metrics.

---

## 25. Engineering constraints

Prefer:

- boring code,
- deterministic behavior,
- explicit data structures,
- strong tests,
- small dependency surface.

Avoid:

- unnecessary frameworks,
- clever abstractions,
- premature plugin systems,
- undocumented heuristics,
- hidden LLM calls.

ContextSlice v0.1 must work without any model API key.

---

## 26. README requirements

Create a README that explains:

1. what ContextSlice is,
2. why coding agents waste context,
3. how ContextSlice reduces context,
4. supported scope in v0.1,
5. installation,
6. indexing,
7. MCP configuration example,
8. tool examples,
9. benchmark methodology,
10. limitations,
11. roadmap.

Do not advertise unmeasured claims such as “90% token savings”.

If the benchmark later measures a specific reduction, report it with the fixture/repository/task used.

---

## 27. Definition of done

v0.1 is complete only when all of the following are true:

- project installs cleanly,
- project builds cleanly,
- tests pass,
- MCP server starts over stdio,
- Java fixture is indexed,
- `context.search` works,
- `context.symbol` works,
- `context.callers` works,
- `context.slice` enforces a token budget,
- `context.diff` detects a changed method,
- cache avoids reparsing an unchanged file,
- path traversal is rejected,
- benchmark runs locally,
- benchmark verifies required-fact preservation,
- README documents measured results without exaggeration.

---

## 28. Final implementation report

When implementation is finished, provide a concise report containing:

```text
STATUS
IMPLEMENTED
TESTS
BENCHMARK
KNOWN LIMITATIONS
NEXT STEP
```

Include:

- exact commands executed,
- test count,
- benchmark numbers,
- any unresolved Tree-sitter limitations,
- any behavior that is heuristic rather than exact.

Never state that a feature works unless it was actually exercised.

---

## 29. Guiding principle

Use this principle for every design decision:

> Send the model the smallest context that preserves the facts required to solve the task correctly.

ContextSlice is not trying to understand the entire repository.

It is trying to make the coding agent **ask for less, receive less, and still know enough**.
