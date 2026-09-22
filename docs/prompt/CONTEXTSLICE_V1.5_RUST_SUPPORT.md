# ContextSlice v1.5 — Rust Language Support

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice already has strong support for:

- Java
- TypeScript
- TSX

Python and Java enterprise semantics are being developed separately.

The purpose of v1.5 is:

> Add first-class Rust support while preserving ContextSlice's minimum-sufficient-context workflow, conservative semantic resolution, and benchmark-first development discipline.

This is a Rust language-support milestone.

Do not add rust-analyzer, Cargo metadata execution, or compiler integration by default.

Start with deterministic static structure and measure where it fails.

---

## 1. Mandatory benchmark rule

No Rust feature is complete without a reproducible benchmark.

Every semantic capability must be validated through:

- targeted fixtures
- real pinned repositories
- before/after measurements
- regression comparison
- failure attribution

Every implementation report must include:

- baseline
- after
- delta
- context cost
- fact recovery

Tests alone are not sufficient.

---

## 2. Primary objective

Support production-quality Rust source analysis for:

```text
.rs
```

with the existing workflow:

```bash
context-slice init
context-slice status
context-slice preview "<task>"
context-slice mcp
```

No Rust-specific user workflow should be required.

---

## 3. Preserve existing languages

v1.5 must not regress:

- Java
- TypeScript
- TSX
- Python if already merged before v1.5

Required regression gates for currently validated languages remain unchanged.

At minimum:

```text
Java retrieval recall = 100%
Java required-fact recall = 100%

TypeScript retrieval recall = 100%
TypeScript required-fact recall = 100%
TypeScript semantic call recall = 100%
TypeScript semantic call precision = 100%
```

If Python is already present, replay its latest benchmark too.

---

## 4. Language adapter

Add a Rust language adapter under the existing language abstraction.

Conceptually:

```text
core
  ↓
language adapter
  ├── java
  ├── typescript
  ├── python
  └── rust
```

Do not scatter Rust-specific branches through the core planner.

---

## 5. Tree-sitter first

Use a production-supported Tree-sitter Rust grammar.

Production path should remain:

```text
Tree-sitter
+ structural analysis
+ deterministic module/import resolution
+ conservative call resolution
```

Do not add by default:

- rust-analyzer
- rustc integration
- procedural macro execution
- Cargo build
- cargo check
- runtime execution

These may be reconsidered only after benchmark evidence.

---

## 6. File detection

Recognize:

```text
.rs
```

Ignore common generated/build directories by default:

```text
target/
.git/
coverage/
dist/
build/
```

Do not index Cargo build output.

---

## 7. Rust symbols

Index at minimum:

- module
- function
- async function
- const
- static
- struct
- enum
- union
- trait
- impl block
- inherent method
- trait method declaration
- trait method implementation
- associated function
- type alias
- macro definition where structurally useful
- closure assigned to a stable local binding when useful
- test functions

Do not over-index every local binding as a globally searchable symbol.

---

## 8. Functions

Support:

```rust
fn create_order(order: Order) -> Result<Order, Error> {
    ...
}

async fn create_order(...) -> ... {
    ...
}
```

Record:

- name
- parameters
- return type
- async status
- visibility
- generics
- where clause
- enclosing module/impl
- source range

---

## 9. Modules

Support:

```rust
mod service;
mod repository;
```

and inline modules:

```rust
mod service {
    ...
}
```

Represent module ownership explicitly.

---

## 10. File/module mapping

Handle standard Rust module layouts:

```text
src/lib.rs
src/main.rs
src/foo.rs
src/foo/mod.rs
src/foo/bar.rs
```

Resolve module paths conservatively.

Do not implement every historical edition edge case unless benchmark evidence requires it.

---

## 11. use declarations

Support:

```rust
use crate::service::create_order;
use crate::service::create_order as make_order;
use crate::service::{create_order, cancel_order};
use crate::service::*;
use super::repository::OrderRepository;
use self::helpers::validate;
```

Record:

- source path
- imported symbol
- alias
- glob status
- relative anchor: crate/self/super

---

## 12. crate / self / super resolution

Resolve:

```text
crate::
self::
super::
```

deterministically against the local crate/module graph.

This is critical for Rust support.

---

## 13. Glob imports

Support:

```rust
use crate::prelude::*;
```

conservatively.

If multiple imported names collide:

- preserve ambiguity
- do not invent exact targets

Measure glob-related ambiguity separately.

---

## 14. Re-exports

Support:

```rust
pub use crate::service::OrderService;
pub use crate::service::{create_order, cancel_order};
pub use crate::service::*;
```

This is important for crate public APIs and prelude modules.

Add cycle protection.

---

## 15. Canonical symbol identity

Canonical IDs must distinguish:

- crate/module path
- enclosing type/trait/impl
- symbol kind
- symbol name
- parameter signature when useful

Examples:

```text
crate::service::function::create_order(Order)

crate::service::OrderService::impl::method::create(&self, Order)

crate::repository::OrderRepository::trait::method::save(&self, &Order)
```

Avoid source-offset-based identity.

---

## 16. Structs

Index:

```rust
pub struct Order {
    pub id: OrderId,
    status: Status,
}
```

Record:

- fields
- visibility
- types
- generics

Fields should support context composition but should not dominate global search.

---

## 17. Tuple structs

Support:

```rust
struct UserId(String);
```

Preserve field positions/types.

---

## 18. Enums

Index:

```rust
enum Status {
    Pending,
    Paid,
    Failed(String),
}
```

Record:

- variants
- payload types

Variant references should be resolvable where deterministic.

---

## 19. Traits

Index trait declarations.

Example:

```rust
trait Repository {
    fn save(&self, order: &Order) -> Result<(), Error>;
}
```

Record:

- trait name
- methods
- associated types
- supertraits where practical
- default methods

---

## 20. Impl blocks

Support:

```rust
impl OrderService {
    fn create(&self, order: Order) { ... }
}
```

and:

```rust
impl Repository for PostgresRepository {
    fn save(&self, order: &Order) { ... }
}
```

Distinguish:

- inherent impl
- trait impl

---

## 21. Trait implementation relationships

Represent:

```text
PostgresRepository
IMPLEMENTS
Repository
```

when syntactically explicit.

Link implemented methods to trait declarations where deterministic.

Do not infer blanket impl runtime behavior beyond source evidence.

---

## 22. Associated functions

Resolve:

```rust
Order::new(...)
RepositoryImpl::connect(...)
```

when the owning type is structurally known.

---

## 23. Method calls

Extract:

```rust
service.create(order)
repo.save(&order)
value.clone()
```

Record:

- receiver expression
- method name
- argument count
- source range

---

## 24. self method resolution

Resolve:

```rust
impl Service {
    fn run(&self) {
        self.validate();
    }

    fn validate(&self) {}
}
```

when unique in the enclosing impl/type.

---

## 25. Associated self resolution

Support:

```rust
impl Service {
    fn build() -> Self {
        Self::new()
    }
}
```

Resolve `Self::new` when deterministic.

---

## 26. Trait method ambiguity

For:

```rust
obj.run()
```

when multiple traits/inherent impls could define `run`, do not guess.

Prefer:

```text
PROBABLE
UNRESOLVED
```

over false exact resolution.

---

## 27. Fully qualified syntax

Support:

```rust
<T as Trait>::method(...)
Trait::method(&value)
```

where structurally parseable.

Use these forms as strong evidence.

---

## 28. Generics

Preserve:

```rust
fn process<T: Repository>(repo: T) { ... }
```

and:

```rust
where T: Repository
```

as semantic evidence.

Do not attempt full monomorphization.

---

## 29. Generic bounds

Use explicit bounds to improve conservative resolution.

Example:

```rust
fn save_all<R: Repository>(repo: &R) {
    repo.save(...);
}
```

Record possible trait target:

```text
Repository::save
```

but do not invent concrete runtime implementation.

---

## 30. Associated types

Preserve trait associated types:

```rust
trait IteratorLike {
    type Item;
}
```

No full type solving required.

---

## 31. Closures

Support closures:

```rust
let transform = |x| normalize(x);
```

when bound to a stable local name and relevant.

Anonymous closures passed inline need not become global symbols.

---

## 32. Nested lexical context

Track lexical ownership for local closures and nested blocks where useful.

Avoid symbol collisions.

---

## 33. async / await

Treat:

```rust
service.create(order).await
```

as a call to `create` with async metadata.

Do not model executor/runtime behavior.

---

## 34. Result / Option

Do not hard-code semantics for:

- `Result`
- `Option`

as special frameworks.

However, preserve calls such as:

```rust
map
and_then
unwrap_or
```

as external/standard-library calls unless local.

---

## 35. ? operator

Recognize that:

```rust
repo.save(&order)?;
```

contains a call to `save`.

Do not attempt full error propagation semantics in v1.5.

---

## 36. Macros

Rust macros are a major semantic boundary.

Support structurally:

- macro definitions
- macro invocations
- macro names
- invocation arguments as source text if useful

Examples:

```rust
println!("x");
tokio::spawn(...);
route!(...);
```

Do not execute macro expansion.

---

## 37. macro_rules!

Index:

```rust
macro_rules! foo {
    ...
}
```

as macro symbols.

Do not attempt full pattern expansion.

---

## 38. Procedural macros

Preserve attributes such as:

```rust
#[derive(...)]
#[tokio::main]
#[test]
#[cfg(...)]
#[serde(...)]
```

as metadata.

Do not execute procedural macros.

---

## 39. Attributes

Index relevant attributes generically.

Examples:

```rust
#[derive(Clone, Debug)]
#[cfg(test)]
#[cfg(feature = "x")]
#[allow(dead_code)]
```

Keep them available for context, but do not include all attributes by default.

---

## 40. cfg / feature gates

Preserve:

```rust
#[cfg(feature = "foo")]
```

as conditional metadata.

Do not evaluate the active feature set unless static project metadata is explicitly available.

Do not pretend gated code is always active.

---

## 41. Cargo.toml

Read `Cargo.toml` where useful for project structure.

Use it to identify:

- crate name
- workspace members
- edition
- package root
- dependencies as external packages
- features as metadata

Do not run Cargo.

---

## 42. Cargo workspaces

Support common workspace layouts structurally.

Example:

```text
workspace/
  Cargo.toml
  crates/api/
  crates/core/
  crates/db/
```

Resolve local workspace crate relationships where deterministic from manifests.

---

## 43. Local path dependencies

Support:

```toml
[dependencies]
core = { path = "../core" }
```

to link workspace crates.

Do not fetch registry dependencies.

---

## 44. External crates

Imports like:

```rust
use serde::Serialize;
use tokio::sync::mpsc;
```

should be marked external unless source exists in the indexed workspace.

Do not index Cargo registry source by default.

---

## 45. Crate aliases

Handle Cargo dependency rename metadata where practical.

Example:

```toml
foo_alias = { package = "foo", version = "..." }
```

Only if benchmark evidence shows value.

Otherwise detect as external ambiguity.

---

## 46. lib.rs / main.rs entrypoints

Recognize:

- library crate root
- binary crate root

Treat:

```rust
fn main()
```

as an entrypoint symbol.

---

## 47. Tests

Recognize:

```rust
#[test]
fn test_create() {}
```

and test modules under:

```rust
#[cfg(test)]
mod tests { ... }
```

Support structural test linkage where direct calls/imports exist.

---

## 48. Integration tests

Recognize:

```text
tests/*.rs
```

as integration-test source.

Link to production symbols through imports/calls when deterministic.

---

## 49. Test linkage metrics

If test linkage is implemented, measure:

```text
test_linkage_recall
test_linkage_precision
```

using independent ground truth.

---

## 50. Unsafe

Preserve `unsafe` metadata.

Examples:

```rust
unsafe fn foo() {}
unsafe { ... }
```

Include only when task-relevant.

Do not attempt safety proof.

---

## 51. Lifetimes

Preserve lifetime syntax:

```rust
fn get<'a>(&'a self) -> &'a Value
```

Do not solve lifetime constraints.

Use them only as signature context.

---

## 52. References and mutability

Preserve:

- `&T`
- `&mut T`
- `mut`
- ownership-relevant parameter forms

These may matter for explanation tasks.

Do not perform borrow checking.

---

## 53. Ownership-sensitive context

Optional, only if benchmark-supported:

Include ownership/mutability details in minimum sufficient context for tasks about:

- mutation
- borrowing
- moved values

Do not turn v1.5 into a borrow checker.

---

## 54. Standard library calls

Do not resolve standard library internals.

Mark as external/library unless project-local shadowing applies.

---

## 55. Common framework neutrality

Do not hard-code:

- Axum
- Actix
- Tokio
- Rocket
- Tonic
- Serde

semantics in the first Rust milestone.

Retain attributes/macros structurally.

Framework semantics belong in later dedicated milestones with their own benchmarks.

---

## 56. Context composition

Reuse v1.2 composition concepts where appropriate.

For Rust types/impls:

- sibling methods
- struct fields
- trait relations
- constructor/associated functions
- shared field access where structurally extractable

Do not dump entire impl blocks or modules.

---

## 57. Enclosing impl/type skeleton

For large impl blocks, consider compact skeletons:

- method signatures
- no bodies
- omitted-count marker

Only if benchmark evidence shows fact recovery value.

Benchmark before keeping.

---

## 58. Module skeleton

For large modules, a compact declaration skeleton may include:

- structs
- enums
- traits
- function signatures
- impl headers

No bodies by default.

Keep only if it improves required-fact recall efficiently.

---

## 59. Canonical path resolution

Represent symbols with crate/module paths:

```text
crate::orders::service::OrderService
```

This should be the basis for cross-file identity.

---

## 60. Multiple binaries

Support projects with:

```text
src/bin/*.rs
```

as separate binary entrypoints.

Do not merge their local module roots incorrectly.

---

## 61. build.rs

Treat:

```text
build.rs
```

as Rust source but mark it as build-script context.

Do not execute it.

---

## 62. Generated code

Do not index generated code under `target/`.

If source includes generated files checked into the repo, index normally unless configured otherwise.

---

## 63. Include macros

Handle:

```rust
include!("generated.rs")
```

conservatively.

Do not execute arbitrary include paths dynamically.

If literal local file exists and support is simple, optional static linkage is allowed.

Benchmark before keeping.

---

## 64. MCP

The same MCP tools must work for Rust.

Do not add Rust-specific tool names.

Validate:

- search
- symbol
- callers
- slice
- diff
- preview

against Rust symbols.

---

## 65. CLI

The same commands must work:

```bash
context-slice init
context-slice index
context-slice status
context-slice doctor
context-slice preview
context-slice mcp
```

Status should report Rust file/symbol counts.

---

## 66. Mixed-language repositories

Support repositories/workspaces containing:

- Java
- TypeScript/TSX
- Python
- Rust

without crashes or symbol-ID collisions.

No cross-language semantic call resolution is required.

---

## 67. Rust benchmark repositories

Use three real pinned Rust repositories.

Target approximately:

```text
3 repositories × ~5 tasks = ~15 tasks
```

Required categories:

### Small

A compact Rust library or CLI.

### Medium

A service/backend or async application.

### Large

A mature Rust repository or bounded subsystem with:

- modules
- traits
- impls
- generics
- workspace structure
- tests

Do not choose repositories only because they are easy.

---

## 68. Recommended benchmark diversity

At least one repository should exercise:

- traits + impls

At least one should exercise:

- async/await

At least one should exercise:

- Cargo workspace or multiple modules

At least one should contain:

- macros/attributes

---

## 69. Task categories

Use:

- locate
- explain
- change
- impact analysis
- Git diff

Keep methodology aligned with Java/TypeScript/Python benchmarks.

---

## 70. Independent ground truth

Every task must define required facts independently of ContextSlice output.

Production code must not access:

- requiredFacts
- expected symbols
- expected edges
- benchmark answers
- manual baseline

Add benchmark leakage checks where practical.

---

## 71. Mandatory Rust metrics

Report:

```text
required_fact_recall
retrieval_recall
semantic_call_recall
semantic_call_precision
context_reduction
whole_file_fallback
whole_module_fallback
minimum_sufficient_budget
```

---

## 72. Rust-specific metrics

Add:

```text
module_resolution_rate
use_resolution_rate
reexport_resolution_rate
self_method_resolution_rate
trait_method_resolution_rate
impl_trait_linkage_recall
workspace_crate_resolution_rate
macro_unresolved_rate
```

Optional:

```text
test_linkage_recall
test_linkage_precision
```

if implemented.

---

## 73. Trait-resolution metrics

Separate:

- inherent method calls
- trait declaration resolution
- trait implementation resolution
- ambiguous trait calls
- unresolved trait calls

Do not hide ambiguity inside aggregate numbers.

---

## 74. Failure attribution

Every missing fact must be classified:

```text
TARGET_SELECTION
CONTEXT_COMPOSITION
TOKEN_BUDGET
SYMBOL_INDEX
MODULE_RESOLUTION
USE_RESOLUTION
CALL_RESOLUTION
TRAIT_RESOLUTION
IMPL_RESOLUTION
MACRO_EXPANSION_LIMIT
CARGO_WORKSPACE_RESOLUTION
PARSER
RUST_STATIC_LIMIT
GROUND_TRUTH
UNKNOWN
```

---

## 75. rust-analyzer decision gate

At the end of v1.5, quantify:

```text
required facts lost due to missing type resolution
tasks harmed by trait/method ambiguity
tasks harmed by macro expansion absence
workspace/module resolution failures
```

Consider rust-analyzer only if:

1. required facts are lost,
2. real tasks are harmed,
3. failures repeat across repositories,
4. structural analysis cannot reasonably solve them.

---

## 76. No premature rust-analyzer

Do not add to production:

- rust-analyzer
- rustc
- cargo check
- cargo metadata execution
- procedural macro expansion

unless separately approved by benchmark evidence.

Production v1.5 remains static and Tree-sitter-first.

---

## 77. Fixture corpus

Create:

```text
tests/fixtures/rust/
```

Cover at minimum:

- function
- async function
- module
- inline module
- use
- use alias
- glob use
- re-export
- crate/self/super
- struct
- tuple struct
- enum
- trait
- inherent impl
- trait impl
- associated function
- self method call
- Self:: associated call
- fully qualified trait call
- generics
- where clause
- associated type
- closure
- async await
- ? operator
- macro definition
- macro invocation
- attributes
- cfg
- Cargo workspace
- local path dependency
- test function
- integration test
- large impl block
- mixed-language fixture

---

## 78. Negative fixtures

Critical negative cases:

- ambiguous trait method
- glob import collision
- unresolved external crate
- macro-generated symbol not visible statically
- cfg-gated symbol with unknown feature state
- dynamic include path
- overlapping impl-like ambiguity where static certainty is unavailable
- renamed external crate ambiguity
- local binding shadowing imported symbol

Conservative unresolved is preferable to false exact resolution.

---

## 79. Large-file regression

Keep permanent large-file parser regression coverage.

Add at least one large Rust file/module.

No silent parser skips.

---

## 80. Performance

Measure:

- cold Rust index
- warm index
- single-file refresh
- preview latency
- workspace indexing
- large-module behavior

Do not optimize before measuring.

---

## 81. Cache

If language metadata requires schema changes:

- bump safely
- rebuild incompatible older caches
- preserve existing language behavior

Do not corrupt caches.

---

## 82. Packaging

Ensure Rust Tree-sitter grammar/query runtime assets are included.

Run:

- build
- tests
- npm pack
- isolated install
- Rust smoke repository
- MCP smoke

No source-checkout dependency.

---

## 83. Clean-room Rust smoke test

From packaged tarball:

1. fresh Rust repository
2. `context-slice init`
3. `context-slice status`
4. `context-slice preview "<task>"`
5. start MCP
6. invoke at least one Rust-related tool call
7. verify repository remains clean

---

## 84. README

Update supported languages:

```text
Java
TypeScript
TSX
Python
Rust
```

only if Python is already merged; otherwise list actual current support accurately.

Add a Rust quick example.

Clearly state:

- static analysis
- Tree-sitter-first
- no rust-analyzer/rustc dependency
- macro-generated semantics may remain unresolved
- trait dispatch may remain conservative

---

## 85. Rust docs

Add:

```text
docs/rust-support.md
```

Cover:

- modules
- use/re-exports
- structs/enums
- traits/impls
- generics
- async
- macros
- cfg
- Cargo workspace handling
- dynamic/static limitations
- no rust-analyzer dependency

---

## 86. Version

Target:

```text
1.5.0
```

if this is the next feature version.

Do not publish/tag/push automatically.

---

## 87. Benchmark report

Generate:

```text
benchmarks/results/v1.5-rust-support.md
benchmarks/results/v1.5-rust-support.json
```

Include:

1. architecture changes
2. Rust adapter
3. symbol coverage
4. module/use resolution
5. traits/impls
6. async
7. macros/attributes
8. Cargo/workspace behavior
9. real repository tasks
10. required-fact recall
11. retrieval recall
12. semantic call recall/precision
13. context reduction
14. fallback
15. minimum sufficient budget
16. performance
17. Java regression
18. TypeScript regression
19. Python regression if applicable
20. rust-analyzer decision
21. limitations
22. next step

---

## 88. Mandatory comparison table

Include:

```text
| Metric | Java | TypeScript | Python* | Rust v1.5 |
|--------|------|------------|---------|-----------|
| Retrieval recall | baseline | baseline | baseline if available | ... |
| Required-fact recall | baseline | baseline | baseline if available | ... |
| Semantic call recall | baseline | baseline | baseline if available | ... |
| Semantic call precision | baseline | baseline | baseline if available | ... |
| Median context reduction | baseline scope | baseline scope | baseline scope | ... |
| Whole-file fallback | baseline | baseline | baseline | ... |
```

Do not compare languages as if benchmark corpora are equivalent.

---

## 89. Per-feature benchmark discipline

Where practical, measure separately:

```text
baseline
+ module/use resolution
+ re-export resolution
+ inherent method resolution
+ trait/impl linking
+ workspace resolution
```

Record which rule:

- recovers facts
- reduces fallback
- lowers minimum budget
- adds context
- introduces false edges

---

## 90. Feature retention rule

A Rust heuristic should remain only if it:

- recovers required facts, or
- improves retrieval, or
- reduces fallback, or
- lowers minimum sufficient budget, or
- fixes a real correctness bug

without unacceptable false positives or context inflation.

If it adds complexity and shows no benefit across benchmark + targeted corpus, remove it.

---

## 91. No framework-specific hacks

Do not add:

```text
if Axum → ...
if Tokio → ...
if Actix → ...
if Serde → ...
```

to make benchmarks pass.

Framework semantics belong in later dedicated milestones with their own benchmarks.

---

## 92. Definition of done

v1.5 is complete when:

- build passes
- all existing tests pass
- Rust fixtures pass
- Java regression passes
- TypeScript regression passes
- Python regression passes if applicable
- `.rs` indexing works
- modules resolve
- use aliases resolve
- crate/self/super resolve
- re-exports resolve
- structs/enums indexed
- traits indexed
- impls linked
- inherent methods resolve
- trait method resolution is conservative
- async syntax works
- macros/attributes are preserved structurally
- Cargo workspace structure is understood statically
- mixed-language repo works
- real Rust benchmark uses pinned repositories
- required-fact recall reported
- retrieval recall reported
- semantic precision/recall reported
- context reduction reported
- fallback reported
- minimum sufficient budget reported
- failure attribution reported
- rust-analyzer decision is evidence-based
- packaging/clean-room Rust smoke passes
- README/docs updated
- no benchmark leakage
- no framework-specific benchmark hacks

---

## 93. Final implementation report

At completion output:

```text
STATUS

VERSION

BUILD / TESTS

LANGUAGE ADAPTER

JAVA REGRESSION

TYPESCRIPT REGRESSION

PYTHON REGRESSION

RUST FILE SUPPORT

MODULE RESOLUTION

USE / RE-EXPORT RESOLUTION

STRUCT / ENUM INDEXING

TRAITS

IMPL LINKAGE

SELF / ASSOCIATED CALLS

TRAIT METHOD RESOLUTION

ASYNC / AWAIT

MACROS / ATTRIBUTES

CARGO / WORKSPACE

SEMANTIC CALL RECALL

SEMANTIC CALL PRECISION

RETRIEVAL RECALL

REQUIRED-FACT RECALL

CONTEXT REDUCTION

WHOLE-FILE / MODULE FALLBACK

MINIMUM SUFFICIENT BUDGET

FAILURE ATTRIBUTION

PERFORMANCE

CACHE

PACKAGING

CLEAN-ROOM RUST TEST

RUST-ANALYZER DECISION

KNOWN LIMITATIONS

NEXT STEP
```

Every metric must include benchmark scope.

---

## 94. Guiding principle

The central question for v1.5 is:

> Can ContextSlice give Rust developers minimum-sufficient code context across modules, traits, impls, async code, and Cargo workspaces without depending on rust-analyzer or compiler execution?

Prefer deterministic structure.

Prefer conservative unresolved behavior over false certainty.

Benchmark every capability before keeping it.
