# Changelog

## 1.3.0 — Python support (unpublished)

- **Python and `.pyi`.** Modules, functions, async functions, nested functions, named lambdas, classes, `__init__`, methods, properties, `@classmethod`, `@staticmethod` and dataclass fields, with decorators kept verbatim as searchable metadata.
- **Packages.** Module paths come from the directory layout, anchored at the highest package ancestor, which covers both `src/` layouts and namespace-style directories without `__init__.py`. Package re-exports are followed through `__init__.py` chains with cycle protection; `__all__` is read when it is a plain list.
- **Call resolution.** Same-module (nearest lexical scope), imported, aliased, module alias, `self`, `cls`, `cls(...)`, constructor-typed attributes (`self.repo.save()`), instance receivers, class receivers, and external packages. Module-level calls are attributed to a module symbol, because Python runs code at import time.
- **Conservative by design.** Factory receivers, `getattr`, dynamic imports and monkey patching stay unresolved. About half of all call edges in the benchmark repositories are unresolved, which cost zero required facts.
- **Benchmark (15 tasks, 3 pinned repositories: itsdangerous, Flask, Django ORM).** Required-fact recall **100%**, retrieval recall **100%**, median context reduction **94.14%**, whole-file fallback **0%**, semantic call recall and precision **100%** on the fixture ground truth. 286 Python files parse with 0 errors in 1.5 s.
- **No type checker.** Zero required facts were lost to dynamic ambiguity, so Pyright, mypy and Jedi were not added. Each of the three receiver rules was measured alone and each recovers an edge no other rule does.
- Fixed: an overload signature no longer shadows its implementation when a symbol is looked up by name.

Not published to npm. No Git tag or GitHub Release was created.

## 1.2.0 — context composition hardening (unpublished)

Closes the v1.1 composition gap: required facts that live beside the target rather than inside it.

- **Enclosing-type skeleton.** A slice for a class member now carries its type's declaration line, field declarations and up to 12 member declaration lines — never a body, so it can never become a whole-class dump. Java fields are read from source for this without being indexed as symbols.
- **Budgeted.** Composition runs after callers and callees and may use at most 35% of the budget, so sibling context fills spare capacity instead of displacing primary context. Omissions are reported with a reason.
- **Results (15 TypeScript tasks).** Required-fact recall 95.56% → **100%**, sibling-context recall 0% → **100%**, whole-file fallback 6.67% → **0%**, whole-class fallback 0%, median context reduction 85.94% → 86.39%. The worst task fell from 1,614 to 244 tokens by reaching full recall at a smaller budget.
- **Java unchanged.** Required-fact recall, retrieval recall and median context reduction (94.55%) all hold exactly.
- **Four rules built, measured, deleted.** Shared-field, accessor, constructor-dependency and lexical-closure composition recovered no required fact across the 30 benchmark tasks and cost 966 tokens, so they were removed rather than kept on synthetic evidence.
- Fixed: nested callables now record their enclosing callable, and a bare call resolves to the nearest lexical scope rather than module level only.

Not published to npm. No Git tag or GitHub Release was created.

## 1.1.0 — TypeScript and TSX support (unpublished)

- **TypeScript and TSX.** `.ts`, `.tsx`, `.mts`, `.cts` and `.d.ts` are indexed with Tree-sitter: classes, interfaces, type aliases, enums, namespaces, functions, methods, accessors, and function-valued variables including arrow functions at any nesting depth.
- **Imports and exports.** Named, default, namespace and type-only imports are recorded per binding. Relative specifiers, directory index files and simple `tsconfig` `baseUrl`/`paths` aliases resolve; re-exports and barrel files are followed with cycle protection; other modules are recorded as external packages.
- **Call resolution.** Same-file, imported, aliased, default, namespace, `this` member, declared-receiver-type, constructor, static and JSX-reference edges, each with evidence. Receivers that need type inference, CommonJS `require`, and imports leaving the checked-out source stay unresolved rather than guessed.
- **Language adapters.** A language boundary replaces language checks in the core; Java is unchanged behind the same interface. Cache schema 1.1.0 stores a language per file, symbol and call, and an incompatible cache is rebuilt automatically.
- **Same workflow.** No new CLI commands and no TypeScript-specific MCP tools. `status` now reports file counts per extension.
- **Benchmark.** 15 TypeScript tasks across three pinned repositories (an Express starter, NestJS core, and Excalidraw's TSX packages): 95.56% required-fact recall, 100% retrieval recall, 83.32% median context reduction, 100% semantic call recall and precision on the fixture ground truth. Java's benchmark is unchanged at 100%/100%/94.55%.
- **No tsserver.** No required fact was lost to missing type inference, so the compiler API was not added. Evidence is in `benchmarks/results/v1.1-typescript-support.md`.
- Fixed: files of 32KB or more were silently skipped by the Tree-sitter node binding; they are now parsed in chunks.
- **Upgrading** from 1.0.0 rebuilds the cache automatically on the next command; nothing to delete. **Downgrading** to 1.0.0 requires `rm -rf .context-slice` first, because 1.0.0 predates the language-aware schema. The older version fails loudly rather than misreading the cache.

Not published to npm. No Git tag or GitHub Release was created.

## 1.0.0 — release validation (unpublished)

First release-ready version. No new features since 0.9.0; this version closes the remaining release-evidence gaps.

- **Minimum sufficient context.** `context-slice preview "<task>"` returns the target method plus compact skeletons of its direct callers and callees, within a strict token budget, and reports what it included, what the budget omitted, and which calls stayed unresolved.
- **Developer context reduction.** In the current 15-task benchmark across three pinned Java repositories, median context size fell by 94.55% while required-fact recall and retrieval recall both stayed at 100%. Context sizes are deterministic estimates, not assistant telemetry.
- **MCP integration.** One stable command, `context-slice mcp`, exposes six tools over stdio. Verified with Claude Code 2.1.277 and Codex CLI 0.153.4.
- **Package and CLI.** `init`, `index`, `status`, `doctor`, `preview`, and `mcp`, installed from a tarball and invoked through PATH. Node 20 or newer.
- **Clean-room validation.** The final merged commit was validated from a fresh clone with a temporary HOME and npm cache, a read-only package directory, an upgrade from the previous version, downgrade safety, and uninstall safety. See `benchmarks/results/v1.0-release-validation.md`.
- **Known limitations.** Java only; Tree-sitter analysis without a compiler, so runtime dispatch and framework-generated behavior stay unresolved rather than guessed; target selection from task text is heuristic; validated on macOS arm64 only; no external developer trial yet.

Not published to npm. No Git tag or GitHub Release was created.

## 0.9.0 — release candidate (unpublished)

Clean-room release-candidate validation; no new features.

- Validated from a fresh Git clone: `npm ci`, build, tests, v0.6/v0.7 regressions, `npm pack`, isolated install with a temporary `HOME` and npm cache, PATH-only invocation, read-only package directory, 0.8.0 → 0.9.0 upgrade, downgrade, and uninstall. See `benchmarks/results/v0.9-clean-room-release-candidate.md`.
- The `.context-slice/` cache directory now contains its own `.gitignore`, so it no longer appears in the target repository's `git status`.
- `npm run benchmark:checkouts` fetches the pinned benchmark repositories, so regressions no longer depend on hand-made local clones.
- `npm run release:rc` runs the clean-room validation.
- README: `npm ci` before `npm pack`, current tarball name, and documented cache cleanup and uninstall.
- A corrupt index cache now fails with `INDEX_CORRUPT` and a `rm -rf .context-slice && context-slice init` remediation, instead of `INTERNAL_ERROR`.
- Fixed the package smoke test's path-with-spaces and nested-cwd checks on macOS, where tmpdir is a symlink.

## 0.8.0 — packaging milestone (unpublished)

- Publish-ready package metadata (license, repository, engines `node >=20`, `bin`) and a minimal tarball of runtime files.
- `context-slice --version` and `--help` read the version from package metadata.
- `npm run benchmark:v08` package smoke test: isolated-prefix install, CLI and MCP from the installed package, reinstall, uninstall, and `npm publish --dry-run`.
