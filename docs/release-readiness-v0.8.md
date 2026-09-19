# ContextSlice v0.8 Release Readiness

This checklist records the local tarball validation performed by `npm run benchmark:v08`. The package is publish-ready in scope, but has not been published to npm.

- [ ] clean checkout builds — deferred; tarball installation was clean-room isolated, but this run did not create a second Git checkout
- [x] tests pass
- [x] npm pack succeeds
- [x] tarball contains runtime assets
- [x] isolated install works
- [x] version works
- [x] help works
- [x] init works
- [x] preview works
- [x] MCP works from `context-slice mcp`
- [x] reinstall/upgrade simulation works
- [x] uninstall leaves the repository intact
- [x] docs use the packaged executable
- [x] no local absolute paths in the tarball
- [x] no secrets detected in packaged filenames
- [x] npm publish dry-run passes
- [x] clean-room self-trial completed
- [x] external developer trial explicitly deferred

Evidence:

- [Packaging JSON report](../benchmarks/results/v0.8-packaging-installation.json)
- [Packaging Markdown report](../benchmarks/results/v0.8-packaging-installation.md)
- [Friction log](../benchmarks/results/v0.8-friction-log.md)

Deferred or publication-dependent items:

- A separate clean Git checkout build/test run is deferred; current checkout build/test and isolated tarball install passed.
- Public registry install and `npx` require an authorized npm publication.
- Read-only installation-directory validation is deferred on the current host.
- A 1–3 person external developer trial is deferred; the completed validation is a clean-room self-trial.
