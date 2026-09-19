# Changelog

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
