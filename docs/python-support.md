# Python support

ContextSlice indexes Python with Tree-sitter. There is no Pyright, mypy, Jedi, language server, or runtime import execution: resolution is structural, and anything Python decides at runtime is reported as unresolved rather than guessed.

Measured behaviour: [benchmarks/results/v1.3-python-support.md](../benchmarks/results/v1.3-python-support.md).

## Files

`.py` and `.pyi` are indexed. These directories are skipped: `__pycache__`, `.venv`, `venv`, `env`, `site-packages`, `.pytest_cache`, `.mypy_cache`, `.pyright`, `.ruff_cache`, `.tox`, `.nox`, `.eggs`, plus the shared `build`, `dist` and `out`.

Interpreter environments are never indexed. That is what keeps a slice small in a real project.

## Symbols

Indexed: modules, functions, async functions, nested functions, lambdas bound to a name, classes, `__init__` as a constructor, methods, `@property` getters and setters, `@classmethod`, `@staticmethod`, dataclass fields and class-level assignments, and module-level variables.

Identity is the file, the enclosing chain, the kind, the name and the parameter names:

```text
src/orders/service.py::OrderService::method::create(self, order)
src/orders/service.py::function::create_order(order)
src/orders/service.py::outer::function::inner()
```

A nested `inner` can never collide with a module-level `inner`. Parameter _names_ are used, not annotations, so adding a type hint does not change a symbol's identity.

Decorators are kept verbatim as annotations (`@dataclass`, `@router.get("/users")`), searchable and available as context. No framework semantics are hard-coded.

A file's top-level statements are owned by a synthetic module symbol, because Python runs real code at import time and those calls matter.

## Imports and packages

Recorded per binding: module, imported name, alias, and kind (`import x`, `import x as y`, `from .m import a`, `from .m import a as b`, `from . import m`, `from x import *`).

Module paths are derived from the repository layout: a directory is a package while it holds `__init__.py`, and resolution anchors at the **highest** package ancestor. That handles both the `src/` layout and namespace-style subdirectories without `__init__.py` (Flask's `sansio/`, for example).

Package re-exports are followed through `__init__.py` chains with cycle protection, so `from package import create_order` reaches the defining module. `__all__` is read as export metadata when it is a plain list of strings; arbitrary expressions are not evaluated.

Anything that does not resolve to indexed source is recorded as an external package. A submodule of an indexed package that simply is not checked out stays unresolved rather than being called external.

## Call resolution

| Kind                          | Example                                                  | Notes                                |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------ |
| `same-file`                   | `helper()` in the same module                            | nearest lexical scope first          |
| `imported` / `aliased-import` | `from .service import create_order as make`              | alias recorded as evidence           |
| `namespace-import`            | `import service as svc; svc.create()`                    | module alias                         |
| `this-member`                 | `self.validate()`, `cls.create()`                        | `self` and `cls`                     |
| `declared-type`               | `self.repo.save()`, `service = Service(); service.run()` | constructor annotation or assignment |
| `constructor`                 | `Service()`, `cls(...)`                                  | resolves to `__init__`               |
| `static`                      | `Service.build()`                                        | class receiver                       |
| `external-package`            | `requests.post()`, `len()`                               | package or builtin recorded          |

`await service.create()` is the same call as `service.create()`; async status is metadata.

## What stays unresolved

By design, and reported rather than guessed:

- a receiver whose type comes from a call: `obj = factory(); obj.run()`
- `getattr(obj, name)()` and `setattr`
- `importlib.import_module(name)` and `__import__`
- monkey patching such as `SomeClass.run = replacement`
- comprehension elements and other values with no static type
- imports that leave the checked-out source

In the benchmark repositories roughly half of all call edges stay unresolved. That is normal for Python and is only a problem when a task actually needs the missing edge — which, across the 15 benchmark tasks, never happened.

## Why no type checker

No required fact in the v1.3 benchmark was lost because a Python type could not be inferred. Structural resolution covered every measured task, so Pyright, mypy or Jedi would add a heavy dependency and a project system without a measured benefit. The decision is recorded with its evidence in the benchmark report and should be revisited if that changes.

## Limitations

- Instance fields are not indexed as symbols, so a class skeleton lists methods and class-level assignments only.
- Receiver typing uses a single unambiguous binding; a reassigned variable drops the evidence.
- `pyproject.toml` is not parsed: package roots come from the directory layout.
- Multiple unrelated package roots in one repository are resolved independently and never merged.
