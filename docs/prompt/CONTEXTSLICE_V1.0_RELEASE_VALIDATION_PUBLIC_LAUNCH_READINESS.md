# ContextSlice v1.0 — Release Validation & Public Launch Readiness

You are preparing **ContextSlice** for a potential v1.0 release.

ContextSlice is a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

Current product positioning:

> ContextSlice helps developers reduce the amount of source code placed into an AI coding assistant’s context window.

Tagline:

> Less code in context. Fewer tokens. Same required information.

ContextSlice v0.1 through v0.9 are already implemented.

The current v0.9 release-candidate status is:

- STATUS: RC READY
- 0 BLOCKER issues
- 0 open MAJOR issues
- version: 0.9.0
- release-candidate code commit: `70b6ee2`
- reports/docs commit: `e221f70`
- branch: `release/v0.9-rc`

Current verified v0.9 results:

- clean checkout: PASS
- `npm ci`: PASS
- build/tests: PASS, 41/41
- v0.6/v0.7 regression: PASS
- package artifact: PASS
- isolated install: PASS
- CLI through PATH: PASS
- fresh Java repository: PASS
- init/status/preview: PASS
- MCP request: PASS
- Claude Code integration: PASS
- read-only package directory: PASS
- upgrade 0.8 → 0.9: PASS
- downgrade behavior: PASS
- uninstall safety: PASS
- Git cleanliness: PASS
- path with spaces: PASS
- nested cwd: PASS
- source-path scan: PASS
- secret scan: PASS
- README clean-room validation: PASS
- self clean-room trial: PASS
- Codex integration: DEFERRED because the account hit its usage limit
- external developer trial: DEFERRED

Known limitations accepted in v0.9:

- the task `explain the owner update flow` may rank `initUpdateOwnerForm` and return only one item
- running `status` before `init` creates an empty cache directory
- these are not current release blockers

The purpose of v1.0 is:

> Close the remaining release evidence gaps, validate the final merged commit, prepare exact public-release steps, and produce a final go/no-go decision without automatically publishing anything.

Do not add product features unless a real release blocker is discovered.

---

## 1. Primary objective

The v1.0 validation must answer:

1. Does Codex integration work with the installed package?
2. Can an external developer follow the docs successfully?
3. Does the final merged `main` commit pass the same clean-room release-candidate validation?
4. Is the npm package name viable?
5. Are changelog and release notes accurate?
6. Are the benchmark claims scoped correctly?
7. Is there any remaining release blocker?
8. What exact commands would be used to publish if authorization is given?
9. Is ContextSlice ready for v1.0?

The final output must produce:

```text
GO
or
NO-GO
```

with evidence.

---

## 2. No automatic publication

Do not perform any of the following unless explicitly authorized:

- `npm publish`
- create Git tags
- push release tags
- create a GitHub Release
- publish release notes publicly
- change package visibility
- announce the release

The v1.0 deliverable is:

```text
release-ready evidence + exact release procedure
```

not publication itself.

---

## 3. No feature expansion

Do not add:

- new languages
- JDT/LSP
- embeddings
- vector search
- UI
- cloud service
- code editing
- major ranking changes
- new semantic architecture

Allowed changes:

- release blockers
- integration fixes
- packaging fixes
- documentation fixes
- setup fixes
- security/release hygiene
- correctness regressions

If a known non-blocking limitation is encountered, document it instead of expanding scope.

---

## 4. Close the Codex integration gap

Rerun Codex validation when runtime/quota is available.

Use the installed package only.

MCP config must use:

```text
command: context-slice
args: ["mcp"]
```

Do not reference source checkout paths.

Validate at minimum:

- Codex starts/connects to ContextSlice MCP
- ContextSlice tools are visible
- at least one ContextSlice tool call succeeds
- response is valid
- no MCP stdout corruption
- no source checkout dependency

Record exact evidence.

If Codex remains unavailable due to external quota/service issues, mark:

```text
DEFERRED — external runtime unavailable
```

and do not misclassify it as a ContextSlice defect.

---

## 5. External developer trial

Preferred requirement:

- at least 1 developer who did not implement ContextSlice

The developer should use only documented instructions.

Trial protocol:

1. obtain/install the release candidate
2. open or clone a Java repository
3. run `context-slice --version`
4. run `context-slice doctor`
5. run `context-slice init`
6. run `context-slice preview "<task>"`
7. connect Codex or Claude Code if available
8. perform one ContextSlice-assisted coding/reasoning task
9. report friction

Do not coach beyond the documentation unless the participant is blocked.

Record all interventions.

---

## 6. External trial evidence

Capture:

- install success/failure
- commands followed
- time-consuming/friction points
- undocumented assumptions
- confusing output
- MCP setup issues
- context preview clarity
- whether context savings were understandable
- whether the developer trusted inclusion/omission explanations
- whether whole-file fallback occurred
- whether the participant would understand how to repeat the workflow

Do not convert qualitative feedback into fake quantitative claims.

---

## 7. External trial fallback

If no external developer is available:

Do not silently treat the self clean-room trial as equivalent.

Record:

```text
EXTERNAL DEVELOPER TRIAL — DEFERRED
SELF CLEAN-ROOM TRIAL — PASS
```

The final GO/NO-GO decision may still be GO if every technical release criterion passes and the missing external trial is explicitly classified as non-blocking.

But explain why.

---

## 8. Merge release branch

Merge:

```text
release/v0.9-rc
→
main
```

only when appropriate in the local validation workflow.

Do not push unless explicitly requested.

Record the resulting final merge/main commit SHA.

Important:

All final release validation must run against the final merged commit, not only:

```text
70b6ee2
```

or:

```text
e221f70
```

---

## 9. Final clean checkout

Create a new clean checkout of the final merged commit.

This checkout must contain no:

- `dist/`
- `node_modules/`
- old caches
- local npm links
- benchmark checkout leftovers
- untracked files

Record:

```text
final_release_commit
```

All final release evidence must reference this commit.

---

## 10. Final clean-room command sequence

From the final clean checkout run:

```bash
npm ci
npm run build
npm test
npm run benchmark:v06
npm run benchmark:v07
npm run benchmark:v08
npm run benchmark:v09
npm pack
npm publish --dry-run
git diff --check
git status --short
```

Adapt script names only if they differ.

Do not omit failures.

---

## 11. Benchmark checkout reproducibility

Verify that the v0.3–v0.6 repository benchmark checkouts are fetched automatically from pinned commits.

Run the checkout/bootstrap command from a truly clean checkout.

Ensure no manually cloned benchmark repository is required.

This was a v0.9 MAJOR defect and must remain fixed.

---

## 12. Final package version

Decide the final package version strategy.

If preparing an actual v1.0 package artifact, update:

```text
package version = 1.0.0
```

only when release validation is intentionally testing the final v1 package.

If keeping the package at 0.9.0 until explicit publication approval, document that choice.

Do not create inconsistent version sources.

Package metadata remains the single source of truth.

---

## 13. Version consistency

Verify all user-facing version references match.

Search:

- README
- release notes
- changelog
- package.json
- examples
- tarball names
- docs

There must be no stale:

```text
0.8.0
0.9.0
v0.7
```

references where v1.0 should appear.

Historical references are allowed when clearly historical.

---

## 14. Final package artifact

Build the final candidate tarball.

Record:

- filename
- size
- file count
- integrity/hash
- package version
- final commit SHA

Verify runtime-critical contents.

---

## 15. Isolated final install

Install the final tarball into an isolated prefix with:

- temporary HOME
- clean npm prefix
- PATH using installed binary
- no source checkout references

Validate:

- `context-slice --version`
- `context-slice --help`
- `context-slice doctor`

---

## 16. Fresh Java repository final test

Use a fresh pinned Java repository.

Run:

```bash
context-slice status
context-slice init
context-slice preview "<task>"
context-slice status
```

Record:

- files indexed
- symbols
- context tokens
- fallback
- latency

The target repository must start with no ContextSlice cache.

---

## 17. Final MCP validation

Run:

```bash
context-slice mcp
```

Perform MCP JSON-RPC smoke requests.

Verify:

- tool listing
- one preview/slice call
- stale file incremental reparse
- clean stdout
- graceful shutdown

---

## 18. Final Claude Code validation

Repeat Claude Code integration using the final candidate package.

Do not rely solely on v0.9 evidence.

Validate against the final merged commit/package.

Record:

- connected
- tools visible
- one tool invocation
- result

---

## 19. Final Codex validation

Repeat Codex integration against the final candidate package if runtime is available.

This closes the v0.9 deferred item.

If still externally unavailable, record exact reason.

Do not block on an unrelated account/service outage unless release policy explicitly requires both assistants.

---

## 20. Read-only package final check

Make the final installed package directory read-only.

Run:

- version
- help
- doctor
- init
- preview
- MCP

Verify package files remain unchanged.

---

## 21. Upgrade path to v1

If final artifact is version 1.0.0, validate:

```text
0.9.0 installed
↓
repository indexed
↓
1.0.0 installed
↓
status
↓
preview
```

Validate cache compatibility/rebuild behavior.

No manual deletion should be required for normal upgrade.

---

## 22. Downgrade safety

Validate older version behavior against a v1-produced cache when practical.

Safe outcomes:

- compatible read
- explicit rebuild
- explicit unsupported-schema message

Unsafe:

- silent corruption
- incorrect context
- source modification

---

## 23. Package name availability

Check npm package-name availability before public launch.

Do not reserve or publish the name.

Record:

```text
AVAILABLE
TAKEN
UNCERTAIN
```

If the desired name is taken, identify candidate alternatives.

Do not rename the package automatically.

---

## 24. Public package naming decision

If package naming needs resolution, produce a recommendation.

Possible alternatives may include scoped package names.

But do not execute naming changes unless explicitly authorized.

Keep this decision separate from technical readiness.

---

## 25. npm account/auth readiness

Without publishing, verify what is needed for release.

Document:

- npm account requirement
- authentication requirement
- 2FA/token considerations if applicable
- package visibility
- scope

Do not expose credentials.

Do not log tokens.

---

## 26. Exact release commands

Produce a release procedure document.

Suggested:

```text
docs/release-procedure-v1.0.md
```

It should list exact commands in order.

Example structure:

```bash
git checkout main
git pull --ff-only

npm ci
npm run build
npm test
npm run benchmark:v06
npm run benchmark:v07
npm pack
npm publish --dry-run

# only after explicit approval:
npm publish
git tag v1.0.0
git push origin v1.0.0
```

Do not execute public-state-changing commands.

---

## 27. Git release procedure

Document exact safe Git steps.

Include:

- final commit check
- clean worktree
- tag creation
- tag verification
- push command

But do not create or push the tag.

---

## 28. GitHub Release draft

Prepare content for a future GitHub Release.

Create:

```text
docs/github-release-v1.0-draft.md
```

Include:

- what ContextSlice does
- install instructions
- benchmark scope
- supported language
- limitations
- MCP integration
- package status

Do not create the actual GitHub Release.

---

## 29. Final changelog

Update `CHANGELOG.md`.

Add a v1.0 section only if preparing v1.0 final package.

Summarize:

- minimum sufficient context
- developer context/token reduction
- MCP integration
- package/CLI
- clean-room validation
- known limitations

Do not include inflated marketing claims.

---

## 30. Benchmark claim validation

Public claims must remain scoped.

Approved pattern:

> In the current 15-task benchmark across three pinned Java repositories, ContextSlice reduced median context size by 94.55% while preserving 100% required-fact recall and 100% retrieval recall.

Do not say:

> ContextSlice saves 95% tokens.

without the benchmark scope.

---

## 31. Token wording

Be precise:

- use `context reduction` for deterministic benchmark context size
- use `estimated token reduction` when using an estimator
- use `observed input token reduction` only when actual assistant telemetry exists

Do not mix them.

---

## 32. Supported scope

README/release docs must clearly state current scope:

- Java source code
- Tree-sitter-based structural/semantic analysis
- no compiler/JDT dependency
- local MCP server
- local SQLite cache
- Codex/Claude Code integration

Do not imply multi-language support.

---

## 33. Known limitations

Carry forward real known limitations.

Include at least:

- ranking may occasionally choose a nearby but not ideal target
- semantic/runtime dispatch remains intentionally conservative
- framework-generated runtime behavior may remain unresolved
- external developer validation status

Do not hide them.

---

## 34. Security/release hygiene

Repeat:

- secret scan
- source-path leak scan
- package content audit
- tarball audit
- local absolute path scan

Record results against the final package.

---

## 35. Dependency audit

Run appropriate npm dependency checks.

Examples:

```bash
npm audit
npm outdated
```

Do not blindly upgrade dependencies during release validation.

Classify findings:

- release blocker
- non-blocking
- dev-only
- false positive / not applicable

Document them.

---

## 36. License audit

Verify:

- project LICENSE present
- `package.json` license field matches
- major runtime dependencies have compatible/known licensing metadata

Do not claim formal legal review.

Record this as release hygiene only.

---

## 37. Node support

Revalidate declared Node engine range.

Current evidence:

- Node 22.12.0 works
- Node 20.19.5 works
- Node 18.20.8 rejected under engine-strict

Ensure README/package metadata agree.

Do not claim broader support.

---

## 38. Platform support wording

Current strong evidence is macOS arm64.

Do not claim Windows/Linux support unless exercised.

Use wording such as:

> Validated on macOS arm64 with Node 20 and Node 22.

Other platforms may be expected to work but remain unverified.

---

## 39. Final friction log

Update:

```text
benchmarks/results/v1.0-friction-log.md
```

Include all final release-validation friction.

Severity:

```text
BLOCKER
MAJOR
MINOR
COSMETIC
```

GO requires:

```text
0 BLOCKER
0 unresolved MAJOR
```

---

## 40. Go/no-go criteria

Final release decision is:

### GO

Only if:

- final merged commit clean-room validation passes
- build/tests pass
- correctness regressions pass
- package installs outside source checkout
- MCP works
- Claude integration passes
- Codex passes or is explicitly external-runtime deferred and classified non-blocking
- external developer trial passes or is explicitly deferred and classified non-blocking
- 0 BLOCKER
- 0 unresolved MAJOR
- package/release docs are accurate
- no public action has been executed accidentally

### NO-GO

If any of:

- package depends on source checkout
- correctness regression
- package corruption
- MCP protocol corruption
- unsafe upgrade
- source modification
- hidden release dependency
- unresolved BLOCKER
- unresolved MAJOR affecting normal usage

---

## 41. Release-readiness document

Create:

```text
docs/release-readiness-v1.0.md
```

Checklist:

```text
[ ] final main commit identified
[ ] clean checkout
[ ] npm ci
[ ] build
[ ] tests
[ ] v0.6 regression
[ ] v0.7 regression
[ ] package artifact
[ ] isolated install
[ ] fresh Java repo
[ ] preview
[ ] MCP
[ ] Claude Code
[ ] Codex or external-deferred classification
[ ] read-only package
[ ] upgrade
[ ] downgrade safety
[ ] uninstall
[ ] Git cleanliness
[ ] source-path scan
[ ] secret scan
[ ] dependency audit
[ ] license consistency
[ ] package-name availability checked
[ ] external developer trial or explicit deferred classification
[ ] changelog
[ ] release notes
[ ] GitHub Release draft
[ ] exact release procedure
[ ] 0 BLOCKER
[ ] 0 unresolved MAJOR
[ ] GO/NO-GO decision
```

---

## 42. Final release report

Generate:

```text
benchmarks/results/v1.0-release-validation.md
benchmarks/results/v1.0-release-validation.json
```

Include:

1. final commit
2. environment
3. clean checkout
4. build/tests
5. benchmark regressions
6. package artifact
7. isolated install
8. Java repo flow
9. MCP
10. Claude
11. Codex
12. external developer trial
13. read-only package
14. upgrade/downgrade
15. package-name availability
16. dependency audit
17. security/release hygiene
18. friction
19. blockers/majors
20. GO/NO-GO
21. exact next release steps

---

## 43. Final implementation report

At completion output:

```text
STATUS

FINAL COMMIT

VERSION

ENVIRONMENT

CLEAN CHECKOUT

BUILD / TESTS

REGRESSION BENCHMARKS

PACKAGE ARTIFACT

ISOLATED INSTALL

FRESH JAVA REPO

PREVIEW

MCP

CLAUDE CODE

CODEX

EXTERNAL DEVELOPER TRIAL

READ-ONLY PACKAGE

UPGRADE

DOWNGRADE

UNINSTALL

PACKAGE NAME

DEPENDENCY AUDIT

LICENSE CHECK

SOURCE-PATH SCAN

SECRET SCAN

FRICTION

BLOCKERS

MAJOR ISSUES

RELEASE DOCS

GO / NO-GO

EXACT RELEASE COMMANDS

KNOWN LIMITATIONS

NEXT STEP
```

Every line must be:

- PASS
- FAIL
- DEFERRED
- INFO

with evidence.

---

## 44. Guiding principle

The central question for v1.0 is:

> Is ContextSlice ready to be released publicly as a developer tool without relying on hidden development state or overstating what has been validated?

Do not add features.

Prove release readiness.
