# ContextSlice v1.3 — Python Language Support

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice currently supports:

- Java
- TypeScript
- TSX

The v1.2 composition milestone is complete with:

- TypeScript required-fact recall: 100%
- TypeScript retrieval recall: 100%
- TypeScript semantic call recall: 100%
- TypeScript semantic call precision: 100%
- TypeScript whole-file fallback: 0%
- Java required-fact recall: 100%
- Java retrieval recall: 100%

The purpose of v1.3 is:

> Add first-class Python support while preserving the existing minimum-sufficient-context workflow, benchmark discipline, and conservative semantic resolution principles.

This is a language-support milestone.

Do not add a Python type checker, language server, or compiler-like dependency unless benchmark evidence proves it is necessary.

---

## 1. Mandatory benchmark rule

No v1.3 language feature is complete without a reproducible benchmark.

Every semantic capability must be validated against:

- targeted fixtures
- real pinned repositories
- before/after metrics
- regression comparison

Every implementation report must include:

- baseline
- after
- delta
- failure attribution

Tests alone are not sufficient.

---

## 2. Primary objective

Support production-quality Python source analysis for:

```text
.py
```

with the same existing workflow:

```bash
context-slice init
context-slice status
context-slice preview "<task>"
context-slice mcp
```

The user should not need Python-specific commands.

---

## 3. Preserve existing languages

v1.3 must not regress:

- Java
- TypeScript
- TSX

Required regression gates:

```text
Java required-fact recall = 100%
Java retrieval recall = 100%

TypeScript required-fact recall = 100%
TypeScript retrieval recall = 100%
TypeScript semantic call recall = 100%
TypeScript semantic call precision = 100%
```

Run existing benchmarks unchanged.

---

## 4. Language adapter

Add a Python language adapter under the existing language abstraction.

Conceptually:

```text
core
  ↓
language adapter
  ├── java
  ├── typescript
  └── python
```

Do not add Python-specific branching throughout core.

Python-specific parsing/resolution logic belongs inside the adapter.

---

## 5. Tree-sitter first

Use a production-supported Tree-sitter Python grammar.

Production path remains:

```text
Tree-sitter
+ structural analysis
+ deterministic import resolution
+ conservative call resolution
```

Do not add by default:

- Pyright
- Pylance
- mypy
- Jedi
- Python LSP
- runtime import execution

These may be reconsidered only after benchmark evidence.

---

## 6. File detection

Recognize:

```text
.py
```

Do not index:

```text
__pycache__
.venv
venv
env
site-packages
build
dist
.coverage
.pytest_cache
.mypy_cache
.pyright
.ruff_cache
.tox
.nox
```

by default.

---

## 7. Python symbols

Index at minimum:

- module
- function
- async function
- class
- method
- async method
- nested function
- lambda when assigned to a stable name and useful
- property
- classmethod
- staticmethod
- decorated callable
- module-level variable when callable-valued
- dataclass
- enum class where structurally identifiable

Do not turn every local assignment into a globally searchable symbol.

---

## 8. Function definitions

Support:

```python
def create_order(order):
    ...

async def create_order(order):
    ...
```

Record:

- name
- parameters
- decorators
- enclosing scope
- async status
- source range

---

## 9. Nested functions

Support lexical identity:

```python
def outer():
    def inner():
        helper()
```

Canonical identity must distinguish:

```text
outer::inner
```

from an unrelated module-level `inner`.

---

## 10. Lambdas

Support named lambda assignments conservatively.

Example:

```python
normalize = lambda x: x.strip()
```

Index as a callable symbol only when the binding is stable and useful.

Anonymous lambdas passed inline do not need standalone global identities.

---

## 11. Classes

Index:

```python
class OrderService:
    ...
```

Include:

- bases
- decorators
- methods
- properties
- class variables where useful

Do not infer metaclass runtime behavior unless structurally explicit.

---

## 12. Constructors

Treat:

```python
def __init__(self, repo):
    self.repo = repo
```

as constructor semantics.

Record instance field assignment where useful for receiver resolution.

---

## 13. self method resolution

Resolve:

```python
class Service:
    def run(self):
        return self.validate()

    def validate(self):
        ...
```

to the local class method when deterministic.

Measure separately.

---

## 14. cls resolution

Resolve:

```python
class Service:
    @classmethod
    def build(cls):
        return cls.create()

    @classmethod
    def create(cls):
        ...
```

when deterministic.

Do not confuse `cls` with arbitrary variables.

---

## 15. Decorators

Parse and attach decorators.

Examples:

```python
@staticmethod
@classmethod
@property
@cached_property
@dataclass
@router.get("/users")
```

Decorator metadata should be searchable/support context.

Do not hard-code framework runtime semantics in the first implementation.

---

## 16. staticmethod

Support:

```python
class Math:
    @staticmethod
    def add(a, b):
        ...
```

Treat as a class-owned callable without `self`.

---

## 17. classmethod

Support:

```python
class Factory:
    @classmethod
    def create(cls):
        ...
```

Preserve class ownership and `cls` receiver semantics.

---

## 18. property

Support:

```python
class User:
    @property
    def name(self):
        ...
```

Record property semantics.

Setter/deleter patterns should link where practical:

```python
@name.setter
def name(self, value):
    ...
```

---

## 19. Dataclasses

Support:

```python
@dataclass
class User:
    id: int
    name: str
```

Index:

- dataclass type
- fields
- annotations
- defaults where practical

Do not generate synthetic methods unless required for context.

---

## 20. Type hints

Parse and preserve type hints:

```python
def find_user(id: str) -> User | None:
    ...
```

Use type hints as structural evidence when available.

Do not treat them as guaranteed runtime truth.

---

## 21. Imports

Support:

```python
import os
import package
import package.module
import package.module as mod
from package import symbol
from package import symbol as alias
from . import local
from .module import symbol
from ..module import symbol
```

Record:

- source module
- imported symbol
- alias
- relative level
- import kind

---

## 22. Relative imports

Resolve relative imports deterministically.

Examples:

```python
from .service import create
from ..models import User
```

Use package structure.

Do not execute Python import machinery.

---

## 23. Package resolution

Treat directories containing `__init__.py` as traditional packages.

Also support namespace-package-like layouts conservatively where repository structure is unambiguous.

Do not assume every directory is importable.

---

## 24. __init__.py

Handle package re-exports.

Example:

```python
# package/__init__.py
from .service import create_order
```

Then:

```python
from package import create_order
```

should resolve when deterministic.

---

## 25. __all__

Support:

```python
__all__ = ["create_order", "OrderService"]
```

as export metadata when statically readable.

Do not evaluate arbitrary expressions to derive `__all__`.

---

## 26. Re-export chains

Support bounded package re-export chains.

Example:

```text
package/__init__.py
→ package/service/__init__.py
→ package/service/order.py
```

Add cycle protection.

Do not infinite-loop.

---

## 27. Module-level calls

This is critical.

Python uses substantial module-level execution.

Extract calls from:

```python
app = create_app()
register_routes(app)
```

Do not restrict call graphs to functions/classes only.

---

## 28. Same-module calls

Resolve:

```python
def a():
    b()

def b():
    ...
```

when unique.

Use lexical scope first for nested functions.

---

## 29. Imported function resolution

Resolve:

```python
from .service import create_order

create_order(order)
```

to the imported symbol when deterministic.

---

## 30. Aliased import resolution

Resolve:

```python
from .service import create_order as make_order

make_order(order)
```

to the original symbol.

Record alias evidence.

---

## 31. Module alias resolution

Support:

```python
import service as svc

svc.create_order(order)
```

when the module and exported symbol are known.

---

## 32. Instance receiver resolution

Use explicit constructor assignments where structurally safe.

Example:

```python
service = OrderService(repo)
service.create(order)
```

may resolve when:

- constructor target is known
- variable binding is local and stable
- no reassignment invalidates the evidence

Do not implement full flow-sensitive typing.

---

## 33. self field receiver resolution

Support:

```python
class Controller:
    def __init__(self, service: OrderService):
        self.service = service

    def handle(self):
        self.service.create(...)
```

Use annotation and constructor assignment evidence where deterministic.

Measure this separately.

---

## 34. Dynamic resolution boundary

Remain conservative for:

```python
obj = factory()
obj.run()
```

when the receiver type is unknown.

Mark unresolved.

Do not guess.

---

## 35. Monkey patching

Do not attempt to model arbitrary monkey patching.

Example:

```python
SomeClass.run = replacement
```

Record assignment/reference if useful, but do not pretend static certainty.

Document as dynamic behavior.

---

## 36. getattr / setattr

For:

```python
getattr(obj, name)()
setattr(obj, name, value)
```

do not invent semantic targets unless the attribute name is a static literal and resolution is unambiguous.

Prefer unresolved.

---

## 37. Dynamic imports

Treat:

```python
importlib.import_module(name)
__import__(name)
```

as dynamic.

Do not execute or guess arbitrary modules.

---

## 38. Async calls

Treat:

```python
await service.create()
```

as the same call target as:

```python
service.create()
```

with async metadata.

---

## 39. Context managers

Parse:

```python
with resource() as r:
    ...
```

and:

```python
async with resource() as r:
    ...
```

Extract calls structurally.

Do not model context manager runtime protocol deeply in v1.3.

---

## 40. Comprehensions

Support calls inside:

```python
[x.transform() for x in items]
```

and generator expressions.

Do not skip nested call expressions.

---

## 41. Decorated frameworks

Framework decorators should be retained structurally.

Examples:

```python
@router.get("/users")
@app.post("/orders")
@celery.task
@pytest.fixture
```

Do not hard-code framework-specific behavior yet.

Use generic decorator metadata.

---

## 42. FastAPI / Flask / Django

At least one real benchmark repository should exercise a common Python web framework.

Preferred benchmark categories:

- FastAPI
- Flask
- Django

But production logic must remain framework-neutral unless benchmark evidence later justifies specialization.

---

## 43. Tests

Index Python tests normally.

Recognize common naming structurally:

```text
test_*.py
*_test.py
```

Do not give framework-specific semantic meaning by default.

---

## 44. Test linkage

Optional but recommended:

Link production symbols to tests through:

- direct imports
- direct calls
- fixtures when structurally obvious

Measure if implemented.

Do not add pytest-specific magic without benchmark evidence.

---

## 45. pyproject.toml

Read `pyproject.toml` only where useful for repository/module roots.

Do not build a full packaging resolver.

Useful metadata may include:

- project source layout
- package roots
- tool configuration

Keep parsing conservative.

---

## 46. src layout

Support common layout:

```text
repo/
  src/
    package/
      __init__.py
```

Import resolution must not assume source packages live at repository root.

This is important for real-world Python.

---

## 47. Multiple package roots

Handle repositories with more than one obvious package root conservatively.

Do not merge unrelated packages accidentally.

Record ambiguity where necessary.

---

## 48. Virtual environments

Never index interpreter environments by default.

Ignore:

```text
.venv/
venv/
env/
site-packages/
```

This is critical for context size.

---

## 49. External packages

Imports like:

```python
import requests
from fastapi import FastAPI
```

should be represented as external dependencies unless source exists inside the indexed repository.

Do not index installed packages by default.

---

## 50. Canonical symbol IDs

Extend canonical IDs to Python.

Examples:

```text
src/orders/service.py::module::function::create_order(order)

src/orders/service.py::OrderService::method::create(self, order)

src/ui/component.py::outer::inner::function::validate()
```

Avoid source-offset-based identity.

---

## 51. Same-name symbols

Distinguish:

- same function name across modules
- same method name across classes
- nested function names
- imported aliases

Add collision tests.

---

## 52. Context composition

Reuse v1.2 composition where appropriate.

For classes:

- shared instance fields
- sibling accessors
- constructor dependencies

For nested functions:

- lexical siblings
- shared captured state

Do not special-case Python by dumping enclosing classes/modules.

---

## 53. Module skeleton

For large Python modules, consider a compact module skeleton:

- function/class declarations
- no bodies
- omitted-count marker

Only if benchmark evidence shows it recovers facts efficiently.

Do not add by default without measurement.

---

## 54. MCP

The same MCP tools must work for Python.

No Python-specific MCP tool names.

Validate:

- search
- symbol
- callers
- slice
- diff
- preview

using Python symbols.

---

## 55. CLI

The same CLI must work.

Status should report Python counts.

Example:

```text
Python: 142 files
```

Exact format may follow existing conventions.

---

## 56. Mixed-language repository

Create/validate a mixed repository containing:

- Java
- TypeScript/TSX
- Python

Verify:

- no symbol ID collisions
- per-language parsing
- per-language resolution
- shared cache correctness
- search across all languages

No cross-language semantic call resolution is required.

---

## 57. Python benchmark repositories

Use three real pinned Python repositories.

Target approximately:

```text
3 repositories × 5 tasks = ~15 tasks
```

Required categories:

### Small

A compact Python backend/library.

### Medium

A real web/service project.

Prefer one of:

- FastAPI
- Flask
- Django

### Large

A mature Python repository or bounded subsystem with:

- packages
- imports
- classes
- async code
- type hints
- tests

Do not choose repositories only because they are easy.

---

## 58. Benchmark task categories

Use:

- locate
- explain
- change
- impact analysis
- Git diff

Keep methodology aligned with Java/TypeScript benchmarks.

---

## 59. Independent ground truth

Each task must define required facts independently of ContextSlice output.

Production code must not access:

- requiredFacts
- expected symbols
- benchmark answers
- manual baseline

Add benchmark leakage regression checks where practical.

---

## 60. Mandatory Python metrics

Report:

```text
required_fact_recall
retrieval_recall
semantic_call_recall
semantic_call_precision
context_reduction
whole_file_fallback
whole_class_or_module_fallback
minimum_sufficient_budget
```

All metrics must state repository/task scope.

---

## 61. Python-specific metrics

Add:

```text
relative_import_resolution_rate
package_reexport_resolution_rate
decorated_symbol_recall
self_method_resolution_rate
cls_method_resolution_rate
instance_receiver_resolution_rate
dynamic_resolution_unresolved_rate
```

Optional:

```text
test_linkage_recall
```

if test linkage is implemented.

---

## 62. Failure attribution

Every missing fact must be classified:

```text
TARGET_SELECTION
CONTEXT_COMPOSITION
TOKEN_BUDGET
SYMBOL_INDEX
CALL_RESOLUTION
IMPORT_RESOLUTION
PACKAGE_RESOLUTION
PARSER
DYNAMIC_LANGUAGE_LIMIT
GROUND_TRUTH
UNKNOWN
```

Do not hide dynamic-language limitations.

---

## 63. Dynamic uncertainty metric

Track unresolved dynamic calls separately.

Example:

```text
dynamic_unresolved_rate
```

This is not automatically a failure.

It becomes a product problem only if required facts are lost.

---

## 64. Pyright/mypy decision gate

At the end of v1.3, quantify:

```text
required facts lost due to missing type inference
tasks harmed by dynamic receiver ambiguity
import/package failures requiring semantic project analysis
```

Consider Pyright/mypy/Jedi only if:

1. required facts are lost,
2. real tasks are harmed,
3. failures repeat across repositories,
4. structural resolution cannot reasonably solve them.

---

## 65. No premature Python semantic engine

Do not add in production:

- Pyright
- mypy daemon
- Jedi
- Python LSP
- runtime interpreter execution

unless separately approved by evidence.

Production v1.3 remains static and Tree-sitter-first.

---

## 66. Fixtures

Create:

```text
tests/fixtures/python/
```

Cover at minimum:

- function
- async function
- nested function
- lambda assignment
- class
- __init__
- self call
- cls call
- staticmethod
- classmethod
- property
- property setter
- dataclass
- type hints
- import
- import alias
- from import
- relative import
- package __init__.py
- __all__
- re-export
- cyclic package export
- module-level call
- instance construction + call
- annotated constructor dependency
- dynamic factory unresolved
- getattr unresolved
- decorator metadata
- comprehension call
- async context
- mixed-language fixture

---

## 67. Negative tests

Ensure ContextSlice does not create false exact edges for:

- monkey-patched members
- unknown factory return
- dynamic getattr
- dynamic import
- ambiguous package root
- reassigned receiver

Conservative unresolved is preferable to false confidence.

---

## 68. Large-file regression

Keep permanent large-file parsing regressions across languages.

Add at least one large Python module.

Verify no silent parser skip.

---

## 69. Performance

Measure:

- cold Python index
- warm index
- single-file refresh
- preview latency
- large-module behavior

Do not optimize before measuring.

---

## 70. Cache

If language metadata requires schema changes:

- bump safely
- rebuild older incompatible caches
- preserve Java/TS behavior

Do not corrupt old caches.

---

## 71. Packaging

Ensure Python Tree-sitter grammar/query runtime assets are included.

Run:

- build
- tests
- npm pack
- isolated install
- Python smoke repo
- MCP smoke

No source-checkout dependency.

---

## 72. Clean-room Python smoke test

From the packaged tarball:

1. fresh Python repo
2. `context-slice init`
3. `context-slice status`
4. `context-slice preview "<task>"`
5. start MCP
6. invoke at least one Python-related tool call
7. verify repository remains clean

---

## 73. README

Update supported languages:

```text
Java
TypeScript
TSX
Python
```

Add a Python quick example.

Clearly state:

- static analysis
- Tree-sitter-first
- no Python runtime execution
- dynamic behavior may remain unresolved

---

## 74. Python docs

Add:

```text
docs/python-support.md
```

Cover:

- supported syntax
- imports/packages
- __init__.py
- decorators
- type hints
- classes/self/cls
- dynamic limitations
- framework neutrality
- no Pyright/mypy dependency

---

## 75. Version

Target:

```text
1.3.0
```

if released as the next feature version.

Do not publish/tag/push automatically.

---

## 76. Benchmark report

Generate:

```text
benchmarks/results/v1.3-python-support.md
benchmarks/results/v1.3-python-support.json
```

Include:

1. architecture changes
2. Python adapter
3. symbol coverage
4. import/package resolution
5. decorators
6. classes/self/cls
7. dynamic resolution boundary
8. real repository tasks
9. required-fact recall
10. retrieval recall
11. semantic recall/precision
12. context reduction
13. whole-file/module fallback
14. minimum sufficient budget
15. performance
16. Java regression
17. TypeScript regression
18. Pyright/mypy decision
19. limitations
20. next step

---

## 77. Mandatory comparison table

Include:

```text
| Metric | Java | TypeScript | Python v1.3 |
|--------|------|------------|-------------|
| Retrieval recall | 100% baseline | 100% baseline | ... |
| Required-fact recall | 100% baseline | 100% baseline | ... |
| Semantic call recall | validated | 100% baseline | ... |
| Semantic call precision | validated | 100% baseline | ... |
| Median context reduction | 93.92% v1.2 Java scope | 86.39% v1.2 TS scope | ... |
| Whole-file fallback | ... | 0% baseline | ... |
```

Do not compare languages as if their task sets are equivalent.

State clearly that benchmark scopes differ.

---

## 78. Per-feature benchmark discipline

If adding multiple Python resolution rules, measure them separately where practical.

Example:

```text
baseline
+ relative imports
+ __init__.py re-exports
+ self resolution
+ constructor receiver resolution
```

Record which rule:

- recovered facts
- reduced fallback
- reduced minimum budget
- added context

Do not retain rules with no measurable value unless justified by targeted correctness coverage.

---

## 79. Feature retention rule

A Python heuristic should remain only if it:

- recovers required facts, or
- improves retrieval, or
- reduces fallback, or
- lowers minimum sufficient budget, or
- fixes a real correctness bug

without causing unacceptable false positives or context inflation.

If it adds complexity and shows no benefit across benchmark + targeted corpus, remove it.

---

## 80. No framework-specific hacks

Do not add:

```text
if FastAPI → ...
if Django → ...
if Flask → ...
```

to make benchmark tasks pass.

Use generic structural rules.

Framework semantics belong in later dedicated milestones with their own benchmarks.

---

## 81. Definition of done

v1.3 is complete when:

- build passes
- all existing tests pass
- Python fixtures pass
- Java regression passes
- TypeScript regression passes
- `.py` indexing works
- functions/async functions indexed
- classes/methods indexed
- decorators retained
- self/cls resolution works where deterministic
- imports/aliases work
- relative imports work
- __init__.py re-exports work
- cyclic exports are safe
- module-level calls work
- dynamic behavior remains conservative
- mixed-language repo works
- real Python benchmark uses pinned repos
- required-fact recall reported
- retrieval recall reported
- semantic precision/recall reported
- context reduction reported
- fallback reported
- minimum sufficient budget reported
- dynamic failure attribution reported
- Pyright/mypy decision is evidence-based
- packaging/clean-room Python smoke passes
- README/docs updated
- no benchmark leakage
- no framework-specific benchmark hacks

---

## 82. Final implementation report

At completion output:

```text
STATUS

VERSION

BUILD / TESTS

LANGUAGE ADAPTER

JAVA REGRESSION

TYPESCRIPT REGRESSION

PYTHON FILE SUPPORT

SYMBOL INDEX

DECORATORS

IMPORT RESOLUTION

PACKAGE / __INIT__ RESOLUTION

SELF / CLS RESOLUTION

INSTANCE RECEIVER RESOLUTION

MODULE-LEVEL CALLS

SEMANTIC CALL RECALL

SEMANTIC CALL PRECISION

RETRIEVAL RECALL

REQUIRED-FACT RECALL

CONTEXT REDUCTION

WHOLE-FILE / MODULE FALLBACK

MINIMUM SUFFICIENT BUDGET

DYNAMIC UNRESOLVED RATE

FAILURE ATTRIBUTION

PERFORMANCE

CACHE

PACKAGING

CLEAN-ROOM PYTHON TEST

PYRIGHT / MYPY DECISION

KNOWN LIMITATIONS

NEXT STEP
```

Every metric must include benchmark scope.

---

## 83. Guiding principle

The central question for v1.3 is:

> Can ContextSlice give Python developers the same minimum-sufficient-context workflow as Java and TypeScript while staying conservative in the face of Python's dynamic semantics?

Prefer deterministic structure.

Measure before adding semantic machinery.
