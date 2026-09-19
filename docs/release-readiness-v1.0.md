# ContextSlice v1.0 Release Readiness

Final commit: `6e27d10` (package 1.0.0), Node 22.12.0 / npm 11.7.0 on macOS arm64.

Evidence: `npm run release:rc -- --label v1.0 --baseline-ref cb9b11a --assistants --node <node 20 bin> --unsupported-node <node 18 bin>`, run from a fresh clone of the final `main` commit. Reports: [Markdown](../benchmarks/results/v1.0-release-validation.md), [JSON](../benchmarks/results/v1.0-release-validation.json), [friction log](../benchmarks/results/v1.0-friction-log.md).

- [x] final main commit identified
- [x] clean checkout
- [x] npm ci
- [x] build
- [x] tests
- [x] v0.6 regression
- [x] v0.7 regression
- [x] package artifact
- [x] isolated install
- [x] fresh Java repo
- [x] preview
- [x] MCP
- [x] Claude Code
- [x] Codex
- [x] read-only package
- [x] upgrade
- [x] downgrade safety
- [x] uninstall
- [x] Git cleanliness
- [x] source-path scan
- [x] secret scan
- [x] dependency audit
- [x] license consistency
- [x] package-name availability checked
- [ ] external developer trial — **DEFERRED**, classified non-blocking
- [x] changelog
- [x] release notes
- [x] GitHub Release draft
- [x] exact release procedure
- [x] 0 BLOCKER
- [x] 0 unresolved MAJOR
- [x] GO/NO-GO decision

## Trial status

```text
EXTERNAL DEVELOPER TRIAL — DEFERRED
SELF CLEAN-ROOM TRIAL — PASS
```

No developer outside this implementation was available. The self clean-room trial is not equivalent: it proves the documented commands work from a clean machine state, but it cannot show whether the docs are understandable to someone who has never seen the tool, nor whether the inclusion and omission explanations earn a newcomer's trust.

It is classified non-blocking because every technical release criterion passes from a clean checkout, the risk it leaves open is documentation clarity rather than correctness or data safety, and the gap is stated plainly in the README, release notes and GitHub Release draft instead of being papered over. It should be closed before any wide announcement.

## Deferred or out of scope

- External developer trial, as above.
- Public npm publication, Git tag, and GitHub Release: prepared but not executed. See [release-procedure-v1.0.md](release-procedure-v1.0.md).
- Linux and Windows: unverified. Validation covers macOS arm64 with Node 20.19.5 and 22.12.0.
