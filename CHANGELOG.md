# Changelog

## 1.2.0 — context composition hardening (unpublished)

Closes the v1.1 composition gap: required facts that live in a sibling of the target rather than in the target itself.

- **Same-type composition.** After callers and callees, a slice may include members of the target's enclosing type that share state with it: a field the target reads or writes, a getter or setter for that field, a constructor that supplies a dependency, or a sibling closure sharing a local. Each carries its evidence.
- **Enclosing-type skeleton.** Declaration lines only — the type's own line, its fields, and up to 12 member signatures — so the assistant sees what sits next to the target without receiving any of their bodies.
- **Never a whole-class dump.** Composition may use at most 35% of the token budget, is reported item by item in `--explain`, and records why a candidate was left out. Whole-class fallback rate: 0%.
- **Results (15 TypeScript tasks).** Required-fact recall 95.56% → **100%**, sibling-context recall 0% → **100%**, whole-file fallback 6.67% → **0%**, median context reduction 85.94% → 86.39%. The worst task dropped from 1,614 to 244 tokens because it now reaches full recall at a much smaller budget.
- **Java (15 tasks).** Required-fact recall and retrieval recall stay at 100%. Median context reduction moves 94.55% → 93.92%: composition recovers no fact there, because recall was already complete, and costs about 0.6 points.
- **Per-rule evidence.** Each heuristic was measured alone. The skeleton recovered both missing facts (11.56 facts per 1k tokens). The four state-sharing rules recovered none of the 30 real tasks' facts and are retained on a targeted corpus of 6 positive and 4 negative cases.
- Fixed: nested callables now record their enclosing callable, and a bare call resolves to the nearest lexical scope rather than only module level.

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
