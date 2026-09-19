# ContextSlice 1.0.0 — Release Notes (DRAFT)

> Draft for internal review. Not a public announcement. 1.0.0 has **not** been published to npm and has no Git tag or GitHub release.

## What ContextSlice does

ContextSlice helps developers reduce the amount of source code placed into an AI coding assistant's context window. **Less code in context. Fewer tokens. Same required information.**

For a task such as `explain the owner update flow`, it selects the target Java method and adds compact skeletons of its direct callers and callees, within a strict token budget. It reports what it included, what the budget forced it to omit, and which calls it could not resolve. You can use it from the CLI (`context-slice preview`) or from any MCP client through `context-slice mcp`, such as Codex or Claude Code.

## What 1.0.0 is

The first release-ready version, validated in a clean room. There are no new features since 0.9.0. The tarball was built from a fresh Git clone of the final merged commit, installed with a temporary `HOME` and an empty npm cache, invoked only through `PATH`, and run with its package directory set read-only. Evidence is in [benchmarks/results/v1.0-release-validation.md](../benchmarks/results/v1.0-release-validation.md).

Changes since 0.8.0:

- The `.context-slice/` cache directory now contains its own `.gitignore`, so it no longer appears in `git status`.
- The pinned benchmark repositories are fetched by `npm run benchmark:checkouts`, so regressions can be reproduced from a clean clone.
- README install steps have been corrected (`npm ci` before `npm pack`, the current tarball name), and cleanup and uninstall are now documented.

## Current benchmark scope

- v0.6 developer context efficiency: 15 tasks on three pinned open-source Java repositories (spring-petclinic, spring-petclinic-rest, and keycloak services). Required-fact recall is 100% and retrieval recall is 100%. Token counts are deterministic estimates, not provider telemetry.
- v0.7 workflow benchmark: init, index, preview, and MCP timings on a small fixture. The timings apply only to the recorded machine.

## Install

The package is not on the npm registry yet. Install it from a tarball:

```sh
git clone https://github.com/nvxtien/context-slice.git && cd context-slice
npm ci
npm pack
npm install -g ./context-slice-1.0.0.tgz
context-slice --version
```

Requirements: Node.js 20 or newer. Installation needs registry access to download the native `better-sqlite3` and `tree-sitter` builds. Validated on macOS arm64 with Node 20.19.5 and 22.12.0; Linux and Windows are unverified.

## Known limitations

- **Java only.** No other languages.
- **No JDT or LSP.** Analysis is syntactic (Tree-sitter), with heuristic call resolution. Runtime dispatch, framework-generated implementations, and some generic or fluent calls stay unresolved, and are reported as unresolved rather than guessed.
- Token counts are estimates.
- Downgrading is not supported as a feature. An older CLI facing a cache with an unknown schema discards and rebuilds it rather than misreading it. A corrupt (non-SQLite) cache file stops with `INDEX_CORRUPT` and the remediation `rm -rf .context-slice && context-slice init`.
- Task-text targeting is heuristic. For "explain the owner update flow" on spring-petclinic, it picks `initUpdateOwnerForm` rather than `processUpdateOwnerForm`. Naming the method in the task gives a better slice.
- No external developer has tried it yet. The usability evidence is a scripted self clean-room trial.

## Package status

- Version 1.0.0, license MIT, about 20 runtime files. No tests, benchmarks, fixtures, or local paths in the tarball.
- npm publication: **deferred** until explicitly authorized. `npx context-slice` and `npm install -g context-slice` will not work until then.
