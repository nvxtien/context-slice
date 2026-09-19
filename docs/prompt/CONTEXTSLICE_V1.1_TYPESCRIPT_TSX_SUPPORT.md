# ContextSlice v1.1 — TypeScript / TSX Language Support

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice v1.0 is release-ready for Java and has already validated:

- deterministic symbol retrieval
- semantic call resolution
- minimum sufficient context
- context/token reduction
- CLI workflow
- MCP integration
- packaging and clean-room release readiness

Current product positioning:

> ContextSlice helps developers reduce the amount of source code placed into an AI coding assistant’s context window.

Tagline:

> Less code in context. Fewer tokens. Same required information.

The purpose of v1.1 is:

> Add first-class TypeScript and TSX support without weakening Java support or introducing a compiler/LSP dependency prematurely.

Do not redesign the whole product.

Do not add tsserver or the TypeScript Compiler API by default.

Use Tree-sitter-first structural analysis and measure where semantic limitations actually matter.

---

## 1. Primary objective

Add production-quality support for:

- `.ts`
- `.tsx`

while preserving:

- Java behavior
- existing CLI
- existing MCP tools
- cache correctness
- token budgeting
- context slicing
- benchmark discipline
- packaging guarantees

The developer should be able to run:

```bash
context-slice init
context-slice preview "explain checkout flow"
context-slice mcp
```

inside a TypeScript or TSX repository without changing the user workflow.

---

## 2. Language architecture

Introduce a clear language boundary.

Prefer an abstraction similar to:

```ts
interface LanguageAdapter {
  id: string;
  extensions: string[];

  parse(input: ParseInput): ParsedFile;

  extractSymbols(file: ParsedFile): SymbolRecord[];

  extractImports(file: ParsedFile): ImportRecord[];

  extractExports(file: ParsedFile): ExportRecord[];

  extractCalls(file: ParsedFile): CallEdge[];

  resolveCalls(
    file: ParsedFile,
    index: SymbolIndex
  ): SemanticCallEdge[];
}
```

The exact API may differ.

The important goal is:

```text
core engine
    ↓
language adapter
    ↓
java
typescript
```

Avoid scattering:

```ts
if (language === "java")
```

throughout the core.

---

## 3. Language ID

Avoid a closed enum such as:

```ts
type Language = "java" | "typescript";
```

Prefer:

```ts
type LanguageId = string;
```

or an equivalent extensible representation.

This reduces future core changes when adding:

- Go
- Rust
- Python
- Kotlin

---

## 4. Preserve Java

v1.1 must not regress Java.

Run all existing Java tests and benchmarks.

Release-blocking:

```text
Java retrieval recall = 100%
Java required-fact recall = 100%
Java semantic-call regressions = none
```

Do not trade Java correctness for cleaner abstractions.

---

## 5. Tree-sitter TypeScript

Add the TypeScript grammar.

Use a production-supported Tree-sitter TypeScript grammar.

Support both:

```text
TypeScript
TSX
```

Do not duplicate parser logic unnecessarily.

Reuse common infrastructure where practical.

---

## 6. File detection

Recognize:

```text
.ts
.tsx
```

Do not treat:

```text
.d.ts
```

exactly like implementation source without deliberate handling.

Declaration files may be useful for types and APIs but should not pollute call graphs as executable code.

Define explicit behavior for `.d.ts`.

---

## 7. TypeScript symbols

At minimum index:

- class
- interface
- type alias
- enum
- namespace/module declaration where relevant
- function declaration
- function expression where named
- arrow function assigned to a named variable
- method
- constructor
- getter
- setter
- property where useful
- variable declaration when function-valued
- exported symbol
- React component when structurally identifiable

Avoid indexing every local variable as a top-level searchable symbol.

---

## 8. Function-valued variables

This is critical.

Support:

```ts
const getUser = async (id: string) => {
  ...
};
```

and:

```ts
const calculate = function (x: number) {
  ...
};
```

These must be represented as callable symbols.

Do not restrict callables to `function_declaration`.

---

## 9. Symbol identity

Extend canonical symbol identity to TypeScript.

It must distinguish:

- file
- module/package context where practical
- enclosing type/function chain
- symbol kind
- symbol name
- parameter signature for callables

Examples:

```text
src/services/order.ts::OrderService::method::create(OrderInput)

src/utils/math.ts::function::calculateTotal(OrderItem[])

src/components/CheckoutButton.tsx::function::CheckoutButton()
```

Avoid unstable identities based on source offsets.

---

## 10. Overloads

Support TypeScript overload declarations conservatively.

Example:

```ts
function parse(x: string): Result;
function parse(x: Buffer): Result;
function parse(x: string | Buffer): Result {
  ...
}
```

Distinguish:

- overload signatures
- implementation declaration

Do not create symbol collisions.

Define which symbol is used as the primary callable target.

---

## 11. Interfaces and type aliases

Index:

```ts
interface UserRepository {
  findById(id: string): Promise<User>;
}
```

and:

```ts
type UserId = string;
```

Interfaces are searchable API symbols.

Type aliases should be available as supporting context but should not dominate retrieval unless relevant.

---

## 12. Imports

Parse and index:

```ts
import { createOrder } from "./order-service";
import { createOrder as makeOrder } from "./order-service";
import Foo from "./foo";
import * as userService from "./user-service";
import type { User } from "./types";
```

Record:

- source module string
- imported name
- local alias
- import kind
- type-only status

This is essential for deterministic resolution.

---

## 13. Relative module resolution

Resolve deterministic relative imports first.

Examples:

```text
./foo
../bar
./service/index
```

Support common file candidates:

```text
.ts
.tsx
/index.ts
/index.tsx
```

Do not implement the entire Node/TS compiler resolution algorithm in v1.1.

Keep behavior explicit.

---

## 14. Exports

Index:

```ts
export function createOrder() {}
export const foo = ...
export class OrderService {}
export default function App() {}
```

Record default vs named export.

This is needed for cross-file resolution.

---

## 15. Re-exports and barrel files

Support:

```ts
export { createOrder } from "./order-service";
export { createOrder as makeOrder } from "./order-service";
export * from "./order-service";
```

Barrel files are common in TypeScript.

Without re-export support, real-project retrieval will degrade quickly.

Implement deterministic chains with cycle protection.

---

## 16. Re-export cycle safety

Detect cycles such as:

```text
a/index.ts
→ b/index.ts
→ a/index.ts
```

Do not infinite-loop.

Record unresolved/cyclic export chains explicitly.

---

## 17. Call extraction

Extract calls such as:

```ts
createOrder(input)
service.create(input)
userService.findById(id)
foo?.bar()
await repository.save(entity)
new OrderService(...)
```

Keep:

- callee name
- receiver text
- argument count
- optional chaining indicator where useful
- source range

---

## 18. Same-file calls

Resolve exact same-file callables when unique.

Example:

```ts
function a() {
  b();
}

function b() {}
```

Confidence can be exact when structurally justified.

---

## 19. Imported function resolution

Resolve:

```ts
import { createOrder } from "./order-service";

createOrder(input);
```

to the exported symbol when deterministic.

This is a major TypeScript v1.1 capability.

---

## 20. Aliased import resolution

Resolve:

```ts
import { createOrder as makeOrder } from "./order-service";

makeOrder(input);
```

to:

```text
createOrder
```

with evidence showing the alias.

---

## 21. Namespace import resolution

Support:

```ts
import * as userService from "./user-service";

userService.findById(id);
```

Resolve member calls where the exported target is unique.

---

## 22. Default import resolution

Support:

```ts
import UserService from "./user-service";

const service = new UserService();
```

Resolve default-exported classes/functions where deterministic.

Do not infer arbitrary CommonJS behavior yet.

---

## 23. Class methods

Support:

```ts
class OrderService {
  create(input: Input) {
    return this.validate(input);
  }

  validate(input: Input) {}
}
```

Resolve:

```text
this.validate
```

within the class.

Handle overload ambiguity conservatively.

---

## 24. Constructor calls

Resolve:

```ts
new OrderService(repo)
```

against indexed constructors/classes.

Do not pretend runtime dependency injection behavior is known.

---

## 25. Object/typed receiver resolution

Where syntax provides a declared type:

```ts
const service: OrderService = ...
service.create(...)
```

use it as deterministic evidence when possible.

Do not implement full control-flow type narrowing.

---

## 26. Type inference boundary

Do not implement full TypeScript type inference in v1.1.

Examples that may remain unresolved:

```ts
const x = factory();
x.run();
```

when `factory()` return type cannot be determined structurally.

Preserve unresolved calls rather than guessing.

---

## 27. Optional chaining

Support syntax:

```ts
service?.run()
user?.profile?.save()
```

Preserve call structure.

Do not invent receiver types.

---

## 28. Async/await

Treat:

```ts
await service.create(...)
```

as the same semantic call as:

```ts
service.create(...)
```

Do not create separate call kinds solely because of `await`.

---

## 29. Promises

Do not attempt to resolve Promise runtime behavior.

For:

```ts
service.create().then(handle)
```

preserve the chain and resolve local/imported `handle` when possible.

Library methods like `then` may remain external.

---

## 30. Arrow functions

Index named arrow functions.

Example:

```ts
const handleClick = () => {
  checkout();
};
```

Ensure `handleClick` is searchable and its calls are extracted.

Anonymous inline arrows need not become globally searchable symbols.

---

## 31. Closures and nested callables

Handle:

```ts
function outer() {
  const inner = () => {
    helper();
  };
}
```

Use enclosing symbol chains.

Avoid collisions with same local names in different functions.

---

## 32. React / TSX

Support structural analysis of TSX.

At minimum:

- function components
- arrow-function components
- class components if present
- local event handlers
- calls inside handlers
- imported hooks/functions
- JSX identifier references where useful

Do not attempt React runtime rendering semantics.

---

## 33. React function components

Recognize common patterns:

```tsx
export function CheckoutButton() {
  ...
}
```

and:

```tsx
export const CheckoutButton = () => {
  ...
};
```

Index as normal callable symbols.

Optional metadata may label them as React-like components.

Do not require component classification for correctness.

---

## 34. Event handlers

For:

```tsx
const handleClick = async () => {
  await checkout();
};

return <button onClick={handleClick}>Buy</button>;
```

ContextSlice should at least represent:

```text
CheckoutButton
  contains handleClick
  handleClick → checkout
```

Do not need DOM event runtime modeling.

---

## 35. Hooks

Treat:

```ts
useEffect(...)
useMemo(...)
useCallback(...)
```

as calls.

Do not add React-specific semantic rules unless benchmark evidence justifies them.

Avoid hard-coding framework behavior.

---

## 36. JSX references

Optional:

Track JSX component references such as:

```tsx
<OrderSummary />
```

as structural references distinct from function calls.

If implemented, use a separate edge kind.

Do not misclassify JSX element usage as normal invocation unless intentionally modeled.

---

## 37. CommonJS

Do not fully support CommonJS in v1.1 unless trivial.

Examples:

```ts
const x = require("./x");
module.exports = ...
```

If encountered:

- parse safely
- avoid false exact resolution
- document as partial/unsupported

ES module support is the priority.

---

## 38. tsconfig awareness

Read `tsconfig.json` where useful.

At minimum support:

- project root discovery
- `baseUrl` awareness
- simple `paths` aliases if practical

Do not implement the entire compiler project system.

---

## 39. Path aliases

Evaluate common aliases:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

If implementation is straightforward and deterministic, support simple aliases.

Otherwise:

- detect alias
- mark unresolved
- report limitation

Do not silently guess.

---

## 40. Monorepos

Do not build a full workspace resolver in v1.1.

But ensure ContextSlice does not break in:

- nested package directories
- multiple `tsconfig.json` files
- npm workspaces

Use nearest/project-root rules conservatively.

Document limitations.

---

## 41. .d.ts behavior

Define explicit handling.

Recommended:

- index declarations
- include APIs/types in search
- do not treat declarations as executable call sources
- do not create runtime call edges from declaration-only files

This helps with library/project declarations without polluting execution structure.

---

## 42. External packages

Imports such as:

```ts
import express from "express";
```

should be represented as external dependencies.

Do not index `node_modules` by default.

Represent:

```text
target-kind: EXTERNAL_PACKAGE
```

or equivalent.

---

## 43. node_modules

Continue excluding:

```text
node_modules
```

from repository indexing.

Do not recursively analyze dependency source by default.

This is important for context/token efficiency.

---

## 44. Generated/build directories

Ignore common TypeScript outputs:

```text
dist
build
coverage
.next
.nuxt
out
.turbo
.cache
```

Be conservative.

Allow config override later if needed.

---

## 45. Cache schema

Bump index/cache schema for language-aware storage.

Use a clear version.

Ensure:

- old Java cache invalidates/rebuilds safely if incompatible
- language identity is stored per file/symbol
- Java and TypeScript can coexist in storage

Do not corrupt existing Java repositories.

---

## 46. Mixed-language repositories

Support repositories containing:

```text
.java
.ts
.tsx
```

without crashing.

The core index should preserve language per symbol.

Do not add cross-language semantic call resolution in v1.1.

Cross-language calls may remain unresolved.

---

## 47. MCP behavior

The same MCP tools must work for TypeScript:

- `context.search`
- `context.symbol`
- `context.callers`
- `context.slice`
- `context.diff`
- `context.preview` if present in current v1 API

Do not create TypeScript-specific MCP tool names.

Language support should be transparent to the developer.

---

## 48. CLI behavior

The same commands must work:

```bash
context-slice init
context-slice index
context-slice status
context-slice doctor
context-slice preview
context-slice mcp
```

Status should report language/file counts.

Example:

```text
Java:        0 files
TypeScript:  84 files
TSX:         22 files
```

Exact formatting may vary.

---

## 49. Search behavior

Search must work across:

- functions
- methods
- classes
- interfaces
- type aliases
- components
- exported symbols

Qualified/import-aware signals may improve ranking.

Do not tune ranking specifically to benchmark answers.

---

## 50. Context rendering

Render TypeScript context naturally.

Example:

```text
TARGET
OrderService.create(CreateOrderInput): Promise<Order>

EXPORT
named

CALLERS
OrderController.create
CheckoutHandler.submit

DEPENDENCIES
OrderRepository.save(Order)
validateOrder(CreateOrderInput)

SOURCE
<exact function/method source>
```

Do not expose raw AST.

---

## 51. Benchmark repository set

Evaluate three real TypeScript/TSX repositories.

Use pinned commits.

Recommended categories:

### Small

A compact TypeScript backend or example project.

Examples may include:

- Fastify TypeScript example
- small Express TypeScript app

### Medium

A real TypeScript backend.

Preferred characteristics:

- services
- imports/exports
- interfaces
- tests
- async calls

A NestJS-based repository is appropriate if manageable.

### Large

A mature TypeScript/TSX codebase or bounded module.

Possible examples:

- VS Code bounded module
- large NestJS project
- React/Next.js module
- another mature public TypeScript repository

Do not choose repositories only because they make the benchmark easy.

---

## 52. React coverage

At least one benchmark repository must contain TSX/React.

This is required to validate:

- `.tsx`
- function components
- arrow components
- local handlers
- imports
- component references

---

## 53. Backend coverage

At least one benchmark repository must be a backend/service project.

Validate:

- async functions
- classes/services
- repository/data-access calls
- imports/re-exports
- tests

---

## 54. Task count

Target:

```text
3 repositories × ~5 tasks = ~15 tasks
```

Task categories:

- locate
- explain
- change
- impact analysis
- Git diff

Keep task methodology comparable to Java benchmarks.

---

## 55. Required facts

Every task must define independent required facts.

Do not derive them from ContextSlice output.

Measure:

```text
required-fact recall
retrieval recall
context reduction
minimum sufficient budget
```

Keep the same benchmark discipline as Java.

---

## 56. TypeScript semantic-call metrics

Measure:

```text
semantic call recall
semantic call precision
false positive edge rate
false negative edge rate
resolution harm
resolution fact loss
```

Separate:

- same-file
- imported
- aliased import
- namespace import
- class method
- interface-like structural calls
- unresolved inferred receiver
- external package

---

## 57. Import-resolution metrics

Add:

```text
relative_import_resolution_rate
reexport_resolution_rate
alias_resolution_rate
external_package_rate
```

These are especially important for TypeScript.

---

## 58. Framework neutrality

Do not hard-code:

```text
NestJS controller
React component
Next.js page
Express handler
```

into production ranking logic solely for benchmarks.

Framework-specific metadata may be added only when generic structural rules justify it.

Avoid benchmark leakage.

---

## 59. Benchmark leakage guard

Production TypeScript retrieval must not access:

- requiredFacts
- expectedSymbols
- benchmark target answers
- manual baseline data

Add regression checks where practical.

---

## 60. Manual context benchmark

Reuse the developer-context benchmark methodology.

For each TypeScript task compare:

```text
manual whole-file context
vs
ContextSlice context
```

Measure:

- context-window reduction
- estimated token reduction
- whole-file avoidance
- fallback rate
- minimum sufficient context

---

## 61. TypeScript test fixtures

Create:

```text
tests/fixtures/typescript/
tests/fixtures/tsx/
```

Cover at minimum:

- function declaration
- async function
- arrow function
- named function expression
- class
- constructor
- methods
- overloads
- interface
- type alias
- enum
- imports
- aliases
- namespace imports
- default imports
- exports
- default exports
- re-exports
- barrel files
- cyclic barrels
- optional chaining
- nested functions
- generics
- `.d.ts`
- TSX function component
- TSX arrow component
- event handler
- method reference-like callback usage
- external package import

---

## 62. Tests

Increase automated tests significantly.

Add exact assertions for:

- symbol IDs
- import resolution
- re-export resolution
- alias handling
- call edges
- confidence
- unresolved cases
- TSX parsing
- cache rebuild
- mixed Java/TS repository
- MCP TypeScript query
- CLI TypeScript preview

Do not only test that parsing succeeds.

---

## 63. Language diagnostics

Extend status/diagnostics.

Example metrics:

```text
typescript_files
tsx_files
typescript_symbols
typescript_call_edges
imports_total
imports_resolved
reexports_total
reexports_resolved
external_imports
unresolved_calls
```

Do not overwhelm normal CLI output.

Expose detailed diagnostics in verbose/JSON mode.

---

## 64. Packaging

Ensure TypeScript grammar/query runtime assets are included in the npm package.

Repeat:

- npm pack
- isolated install
- source path scan
- runtime asset validation

Do not regress v1.0 packaging guarantees.

---

## 65. Clean-room TypeScript smoke test

From an installed tarball:

1. fresh TypeScript repo
2. `context-slice init`
3. `context-slice status`
4. `context-slice preview "<task>"`
5. start MCP
6. make one TypeScript tool call

No source checkout dependency.

---

## 66. Java + TypeScript coexistence test

Create a mixed fixture/repository.

Verify:

- Java indexing unchanged
- TypeScript indexing works
- language IDs preserved
- search can return both
- symbol IDs do not collide
- cache works

No cross-language call resolution is required.

---

## 67. Performance

Measure:

- cold TypeScript index time
- warm index time
- single-file TS refresh
- single-file TSX refresh
- preview latency

Do not over-optimize before measurement.

---

## 68. tsserver decision gate

Do not add tsserver in v1.1.

At the end, quantify:

```text
required facts lost due to missing TypeScript type resolution
tasks harmed by missing type resolution
import/path resolution failures
semantic call failures attributable to type inference
```

Consider tsserver/Compiler API only if:

1. required facts are lost,
2. task correctness is affected,
3. failures repeat across real repositories,
4. Tree-sitter/import analysis cannot reasonably solve them.

---

## 69. No premature TypeScript compiler API

Do not add:

- tsserver
- TypeScript Language Service
- Compiler API program graph
- project references machinery

unless only used externally for benchmark ground truth.

Production ContextSlice remains Tree-sitter-first in v1.1.

---

## 70. Report

Generate:

```text
benchmarks/results/v1.1-typescript-support.md
benchmarks/results/v1.1-typescript-support.json
```

Include:

1. architecture changes
2. language adapter
3. TypeScript symbols
4. import/export resolution
5. re-export/barrel behavior
6. TSX behavior
7. semantic call metrics
8. real repository tasks
9. required-fact recall
10. retrieval recall
11. context reduction
12. fallback rate
13. performance
14. Java regression
15. tsserver decision
16. limitations
17. next step

---

## 71. Comparison table

Include:

```text
| Metric | Java v1.0 | TypeScript v1.1 |
|--------|-----------|-----------------|
| Retrieval recall | 100% | ... |
| Required-fact recall | 100% | ... |
| Median context reduction | 94.55% Java benchmark | ... |
| Semantic call recall | validated | ... |
| Semantic call precision | validated | ... |
| Whole-file fallback | 0% Java benchmark | ... |
```

Keep benchmark scopes explicit.

Do not directly imply one language is better supported based solely on different repository/task sets.

---

## 72. README

Update README.

Supported languages section:

```text
Java
TypeScript
TSX
```

Explain current limitations.

Add TypeScript quick example.

Keep Java example.

Do not present TypeScript support as compiler-complete.

---

## 73. Docs

Add:

```text
docs/typescript-support.md
```

Cover:

- supported syntax
- imports/exports
- re-exports
- TSX
- `.d.ts`
- external packages
- path alias limitations
- no tsserver
- current semantic-resolution boundaries

---

## 74. Version

Use the project's normal versioning policy.

If this is the first post-v1 feature release, target:

```text
1.1.0
```

Do not publish/tag automatically.

---

## 75. No public release action

Do not:

- npm publish
- git tag
- GitHub Release
- push release changes

unless explicitly authorized.

The task is implementation and validation.

---

## 76. Definition of done

v1.1 is complete when:

- language-adapter boundary exists
- Java tests/regressions pass
- `.ts` parsing works
- `.tsx` parsing works
- TypeScript symbols are indexed
- arrow functions are indexed
- imports are indexed
- relative imports resolve
- aliases resolve where deterministic
- default imports resolve
- namespace imports resolve
- exports resolve
- re-exports/barrels resolve
- cyclic re-exports are safe
- class/same-file calls resolve
- unresolved inferred-type calls remain conservative
- `.d.ts` behavior is explicit
- TSX components/handlers parse correctly
- same MCP/CLI workflow works for TypeScript
- mixed Java/TypeScript repository works
- TypeScript benchmark uses real pinned repositories
- required-fact recall is reported
- retrieval recall is reported
- semantic call precision/recall are reported
- context reduction is reported
- fallback rate is reported
- Java correctness does not regress
- npm package contains TypeScript runtime assets
- clean-room TypeScript smoke test passes
- tsserver decision is evidence-based
- README/docs are updated

---

## 77. Final implementation report

At completion output:

```text
STATUS

VERSION

BUILD / TESTS

LANGUAGE ADAPTER

JAVA REGRESSION

TYPESCRIPT FILE SUPPORT

TSX SUPPORT

SYMBOL INDEX

IMPORT RESOLUTION

EXPORT / RE-EXPORT

BARREL FILES

CALL RESOLUTION

SEMANTIC CALL RECALL

SEMANTIC CALL PRECISION

RETRIEVAL RECALL

REQUIRED-FACT RECALL

CONTEXT REDUCTION

WHOLE-FILE FALLBACK

MIXED JAVA / TYPESCRIPT

CACHE

PERFORMANCE

PACKAGING

CLEAN-ROOM TYPESCRIPT TEST

TSSERVER DECISION

KNOWN LIMITATIONS

NEXT STEP
```

Every metric must state its benchmark scope.

---

## 78. Guiding principle

The central question for v1.1 is:

> Can ContextSlice give TypeScript and TSX developers the same minimum-sufficient-context workflow that already works for Java, without requiring a full compiler service?

Prefer deterministic structural resolution.

Measure before adding semantic complexity.
