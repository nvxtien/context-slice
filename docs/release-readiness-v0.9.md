# ContextSlice v0.9 Release Readiness

Evidence comes from `npm run release:rc -- --assistants --node <node 20 bin> --unsupported-node <node 18 bin>`, run against commit `70b6ee2` (package 0.9.0) with Node 22.12.0 / npm 11.7.0 on darwin arm64. See the [Markdown report](../benchmarks/results/v0.9-clean-room-release-candidate.md) and the [JSON report](../benchmarks/results/v0.9-clean-room-release-candidate.json).

**Recommendation: RC READY.** There are 0 blockers and 0 open MAJOR issues. It is not a V1 CANDIDATE yet because the external developer trial and the Codex check are still pending.

- [x] clean checkout: fresh `git clone` of the committed branch, with no `dist/`, no untracked or ignored files, and no `npm link`
- [x] npm ci: temporary `HOME` and an empty npm cache, from registry.npmjs.org
- [x] build
- [x] tests: 41/41
- [x] v0.6 regression: 15 tasks, required-fact recall 1.0, retrieval recall 1.0. The pinned checkouts are fetched by `npm run benchmark:checkouts`.
- [x] v0.7 regression: usability checklist all passed
- [x] npm pack: `context-slice-0.9.0.tgz`, 16,960 bytes, 20 files, sha1 `9cd79a14…`
- [x] isolated install: README command `npm install -g ./context-slice-0.9.0.tgz`, with a prefix containing a space
- [x] --version: `0.9.0`, resolved through PATH only
- [x] --help
- [x] fresh Java repo: spring-petclinic @ `818c4136`, cloned fresh with no prior cache
- [x] init: 50 Java files, 266 symbols
- [x] preview: within budget, no whole-file fallback
- [x] MCP request: 6 tools, `context.preview` OK, stale-index auto-refresh (1 file reparsed), protocol-only stdout, exit 0 when stdin closes
- [x] read-only package: `chmod -R a-w`; 3,888 files hashed and unchanged after every command
- [x] upgrade: 0.8.0 → 0.9.0 reuses the cache (CURRENT); a forged older schema is rebuilt automatically
- [x] downgrade safe behavior: 0.8.0 reads a 0.9.0 cache (same schema 0.5.2); a forged newer schema is discarded and rebuilt; a corrupt cache gives `INDEX_CORRUPT` with remediation (0.9.0)
- [x] uninstall: the executable is removed and the repository cache is kept, as documented
- [x] Git cleanliness: target repository `git status` is clean; `.context-slice/` ignores itself; `.gitignore` is not edited
- [x] path with spaces: repository and install prefix
- [x] nested cwd: run from `src/main/java/.../owner`
- [x] source-path scan: 0 matches in the tarball
- [x] secret scan: 0 matches (lightweight pattern scan)
- [x] developer trial or clean-room fallback: SELF CLEAN-ROOM TRIAL, scripted. The external developer trial is deferred.
- [x] 0 blockers

Also exercised:

- Node engine boundary: Node 20.19.5 installs and runs init and preview. Node 18.20.8 is rejected under `--engine-strict` (EBADENGINE).
- Claude Code 2.1.277: `command: context-slice`, `args: ["mcp"]`. The server connected, all 6 tools were visible, and `context_preview` succeeded.

Deferred:

- Codex: **DEFERRED — runtime unavailable.** codex-cli 0.153.4 hit the account usage limit before any MCP call. Rerun `npm run release:rc -- --assistants` after the quota resets.
- External developer trial: no external developer was available.
- Public npm publication and `npx` validation: not authorized. No `npm publish`, tag, or GitHub release was made.
