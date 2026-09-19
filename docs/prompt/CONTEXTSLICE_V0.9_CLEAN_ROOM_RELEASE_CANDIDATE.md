# ContextSlice v0.9 — Clean-Room Release Candidate Validation

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice v0.1 through v0.8 are already implemented and validated.

Current v0.8 state:

- package version: `0.8.0`
- package metadata/license/engine/bin are present
- `context-slice --version` works
- `context-slice --help` works
- tarball contains only runtime-critical files
- smoke test works outside the source checkout
- package smoke test results:
  - 20 files
  - 16,275 bytes
- CLI works from installed package
- MCP works from installed package
- path-with-spaces passes
- nested working directory detection passes
- upgrade/uninstall/cache preservation passes
- `npm publish --dry-run` passes
- tests: 37/37 pass
- build passes
- v0.6 regression passes
- v0.7 regression passes

Deferred in v0.8:

- clean Git checkout validation in a separate fresh checkout
- external developer trial
- read-only installed package directory validation
- public npm publication
- public npx validation

Current product positioning:

> ContextSlice helps developers reduce the amount of source code placed into an AI coding assistant’s context window.

Tagline:

> Less code in context. Fewer tokens. Same required information.

The purpose of v0.9 is:

> Validate ContextSlice as a release candidate in a clean-room environment with no dependency on the original development checkout.

Do not add major features.

Do not publish publicly to npm in this phase unless explicitly authorized.

---

## 1. Primary objective

Prove that a release candidate can be built, packaged, installed, and used from scratch.

The validation must start from a clean Git checkout of ContextSlice itself.

The release candidate must work when:

- no build artifacts exist
- no local npm link exists
- no source-tree absolute paths are available
- no previous ContextSlice cache exists
- package directory is treated as immutable/read-only
- target Java repository is freshly cloned
- only documented commands are used

---

## 2. Release-candidate principle

Use this rule:

> If a step only works because the developer machine already contains hidden state from development, it is not release-ready.

Examples of hidden state:

- `npm link`
- stale global install
- previously built `dist/`
- untracked query files
- local benchmark checkout
- local absolute paths
- old cache
- workspace symlinks
- unpublished package assumptions

---

## 3. Clean checkout validation

Create a completely fresh checkout of ContextSlice in a temporary directory.

Do not reuse the original working tree.

Suggested flow:

```bash
git clone <repo-url> context-slice-clean
cd context-slice-clean

git status --short
npm ci
npm run build
npm test
npm run benchmark:v06
npm run benchmark:v07
npm pack
```

Record exact commit SHA.

The checkout must be clean before starting.

---

## 4. No untracked dependency

Before build, verify that all required source/query/runtime assets are tracked by Git.

The clean checkout must not depend on:

- manually copied files
- generated assets absent from Git
- local databases
- hidden workspace config

If the build generates runtime artifacts, generation must be reproducible from tracked sources.

---

## 5. Reproducible package artifact

Build the package from the clean checkout.

Record:

- commit SHA
- package version
- Node version
- npm version
- OS
- tarball filename
- tarball size
- file count
- package integrity/hash if practical

The resulting tarball becomes the v0.9 release-candidate artifact.

---

## 6. Isolated install environment

Create a separate clean install environment.

It must not be inside the ContextSlice source checkout.

Use:

- temporary HOME if practical
- isolated npm prefix
- clean PATH addition
- no npm link
- no source checkout references

Install only the tarball.

Example:

```bash
npm install -g ./context-slice-0.9.0.tgz --prefix <isolated-prefix>
```

Exact install strategy may vary.

---

## 7. Version bump

Set package version to:

```text
0.9.0
```

Use package metadata as the single source of truth.

Do not hard-code version in CLI source.

Verify:

```bash
context-slice --version
```

returns:

```text
0.9.0
```

from the installed release-candidate tarball.

---

## 8. Fresh Java repository

Clone a Java repository into another fresh directory.

Prefer one of the previously pinned repositories for reproducibility.

The target repository must not contain an existing ContextSlice cache.

Flow:

```bash
git clone ...
cd repo
context-slice status
context-slice init
context-slice preview "<task>"
context-slice status
```

Validate first-run behavior.

---

## 9. First-run expectations

Before init:

```text
status
```

should clearly indicate:

- repository detected
- ContextSlice not initialized or index absent

After init:

- cache created
- index ready
- no manual DB setup
- no package-directory writes

---

## 10. Preview from clean install

Run a representative task.

Example:

```bash
context-slice preview "explain the owner update flow"
```

Record:

- target symbol
- context tokens
- inclusions
- unresolved relations
- budget behavior
- latency
- whole-file fallback

The command must use only the installed package.

---

## 11. MCP release-candidate test

From the fresh Java repository run:

```bash
context-slice mcp
```

Send at least one valid MCP JSON-RPC request.

Verify:

- process starts
- stdout contains only protocol output
- stderr contains diagnostics if needed
- request succeeds
- response is valid
- stale-index auto-refresh works
- graceful shutdown works

---

## 12. Codex integration test

If Codex is available in the environment, configure it using only:

```text
command: context-slice
args: ["mcp"]
```

Do not use absolute paths into the ContextSlice source tree.

Run one representative query.

Record:

- whether MCP connected
- whether ContextSlice tools were visible
- whether one tool call succeeded

If Codex is unavailable, mark:

```text
DEFERRED — runtime unavailable
```

Do not fabricate validation.

---

## 13. Claude Code integration test

Apply the same principle for Claude Code.

Use only installed executable.

Record actual result or explicit deferred status.

Do not require both assistants to complete v0.9.

---

## 14. Read-only package directory

After installing the tarball, make the installed package directory read-only where practical.

Then run:

- `--version`
- `--help`
- `status`
- `init`
- `preview`
- `mcp`

Verify ContextSlice does not attempt to write into its installed package directory.

Expected writes should occur only in:

- repository cache
- temp directories
- user-specific config if intentionally designed

---

## 15. Package immutability test

Add an automated or semi-automated check.

The package install directory should have no modified files after normal use.

Record before/after hashes or file metadata where practical.

If package files change, treat as a release blocker.

---

## 16. Upgrade path

Simulate:

```text
0.8.0 installed
↓
repository indexed
↓
replace with 0.9.0 release candidate
↓
status
↓
preview
```

Validate:

- CLI upgrade works
- cache schema compatibility handled
- incompatible cache rebuild is automatic
- source repository unchanged
- no manual cache deletion required unless explicitly unavoidable

---

## 17. Downgrade behavior

Evaluate what happens if a developer attempts to run 0.8.0 against cache produced by 0.9.0.

Do not require downgrade compatibility if unsupported.

But behavior must be safe and explicit.

Preferred:

```text
cache version unsupported
→ rebuild or clear actionable error
```

Never silently misinterpret newer cache data.

---

## 18. Uninstall safety

From isolated install:

```bash
npm uninstall ...
```

Then verify:

- executable removed
- target Java repository unchanged
- source files unchanged
- Git status unchanged except intentional ContextSlice cache
- cache retention/removal behavior documented

Do not remove repository cache automatically unless explicitly designed.

---

## 19. Cache cleanup command

Evaluate whether users need an explicit cleanup command.

If useful, add:

```bash
context-slice clean
```

only if justified.

Do not expand CLI without need.

Alternative is documentation:

```text
remove .context-slice/
```

Prefer minimal scope.

---

## 20. Git cleanliness in target repository

After:

- init
- index
- preview
- MCP
- upgrade

run:

```bash
git status --short
```

The only expected untracked/ignored change should be ContextSlice-owned cache if applicable.

No source files may be modified.

---

## 21. .gitignore behavior

Verify the cache path is ignored or clearly documented.

If ContextSlice automatically edits `.gitignore`, evaluate whether that is desirable.

Prefer not to mutate developer repository metadata silently.

If users must add a cache path manually, document it clearly.

---

## 22. Temp HOME test

Use a temporary HOME directory if practical.

Validate that ContextSlice does not depend on:

- existing user config
- previous npm config
- previous ContextSlice settings

Record any required environment variables.

---

## 23. PATH robustness

Test installed executable through PATH only.

Do not invoke:

```text
node /absolute/path/to/dist/cli.js
```

This is essential.

---

## 24. Shell path robustness

Repeat key commands in:

- repository path containing spaces
- nested working directory
- temporary install prefix containing spaces if practical

Do not assume cwd equals repository root.

---

## 25. Clean npm cache independence

Where practical, test package install without relying on development npm cache.

A complete offline test is optional.

At minimum avoid local workspace resolution.

Document any registry/network requirement.

---

## 26. Node engine boundary

Test the declared minimum supported Node version if feasible.

At least verify:

- current supported Node passes
- package metadata rejects clearly unsupported Node where npm enforces it

Do not claim support for Node versions not exercised.

---

## 27. Package content audit

Re-run package content checks.

Verify no:

- absolute local paths
- benchmark clone directories
- temp databases
- developer-specific files
- credentials
- private keys
- editor metadata
- local logs
- coverage data

The tarball should remain intentionally minimal.

---

## 28. Source path leak scan

Search the packed artifact for strings such as:

```text
/Volumes/
/Users/
/home/
C:\
context-slice/src
```

Use reasonable false-positive filtering.

Any real developer-machine absolute path embedded in runtime code/config is a release blocker unless unavoidable and harmless.

---

## 29. Secret scan

Perform a lightweight scan for:

- API keys
- tokens
- private keys
- credentials
- auth headers
- environment dumps

Do not claim formal security certification.

This is release hygiene.

---

## 30. External developer trial

Preferred:

- at least 1 developer who did not implement ContextSlice

Ask them to follow only README instructions.

Trial:

1. install release candidate
2. clone/open Java repo
3. init
4. preview one task
5. run doctor
6. connect Codex or Claude Code if available
7. report friction

Do not coach beyond the documented instructions unless they get blocked.

Record every undocumented intervention.

---

## 31. Self clean-room fallback

If no external developer is available:

Perform a clean-room self-trial.

Rules:

- use clean checkout
- use packaged tarball
- use only README instructions
- do not inspect source code to fix usage mistakes during the trial
- record any missing documentation

Label result:

```text
SELF CLEAN-ROOM TRIAL
```

not:

```text
external developer trial
```

---

## 32. Friction categories

Continue the friction log with:

```text
INSTALL
PACKAGE
PATH
NODE
CLI
MCP
CODEX
CLAUDE
DOCS
CACHE
UPGRADE
UNINSTALL
REPOSITORY_DETECTION
OTHER
```

For every issue record:

- step
- symptom
- severity
- root cause
- fix
- regression test added?
- status

---

## 33. Severity model

Use simple severity:

```text
BLOCKER
MAJOR
MINOR
COSMETIC
```

Release candidate must have:

```text
0 BLOCKER
```

before completion.

Document any remaining MAJOR issues.

---

## 34. Release candidate report

Generate:

```text
benchmarks/results/v0.9-clean-room-release-candidate.md
benchmarks/results/v0.9-clean-room-release-candidate.json
```

Include:

1. commit SHA
2. environment
3. clean checkout result
4. clean build result
5. tests
6. package artifact
7. isolated install
8. fresh repository flow
9. preview
10. MCP
11. Codex
12. Claude Code
13. read-only package result
14. upgrade
15. downgrade behavior
16. uninstall
17. Git cleanliness
18. source-path scan
19. secret scan
20. developer trial
21. friction log
22. release blockers
23. release recommendation

---

## 35. Release recommendation

At the end classify:

```text
NOT READY
RC READY
V1 CANDIDATE
```

Definitions:

### NOT READY

Any release blocker remains.

### RC READY

Clean-room package and installation flow are validated, but one or more non-blocking real-world validations remain.

### V1 CANDIDATE

Clean-room validation passes, no blockers remain, core docs are accurate, and external/self clean-room trial confirms normal usability.

Do not automatically publish.

---

## 36. Release-readiness checklist

Create/update:

```text
docs/release-readiness-v0.9.md
```

Checklist:

```text
[ ] clean checkout
[ ] npm ci
[ ] build
[ ] tests
[ ] v0.6 regression
[ ] v0.7 regression
[ ] npm pack
[ ] isolated install
[ ] --version
[ ] --help
[ ] fresh Java repo
[ ] init
[ ] preview
[ ] MCP request
[ ] read-only package
[ ] upgrade
[ ] downgrade safe behavior
[ ] uninstall
[ ] Git cleanliness
[ ] path with spaces
[ ] nested cwd
[ ] source-path scan
[ ] secret scan
[ ] developer trial or clean-room fallback
[ ] 0 blockers
```

---

## 37. README validation

Do not only edit README.

Actually follow it from the clean-room environment.

Every command in Quick Start should be executable as written or clearly parameterized.

Record documentation defects discovered during the trial.

---

## 38. Changelog

Add or update:

```text
CHANGELOG.md
```

Include concise entries for:

- 0.8.0 packaging milestone
- 0.9.0 release-candidate validation

Do not retroactively invent unsupported historical details.

---

## 39. Release notes draft

Create:

```text
docs/release-notes-v0.9.md
```

Include:

- what ContextSlice does
- current benchmark scope
- install method
- known limitations
- Java-only scope
- no JDT/LSP
- package status
- whether npm publication is deferred

This is a draft, not a public release announcement.

---

## 40. No public publication

Do not:

- `npm publish`
- create a public release
- create GitHub Release
- create tags

unless explicitly authorized.

v0.9 validates readiness only.

---

## 41. No feature expansion

Do not add:

- new languages
- new semantic resolver
- embeddings
- vector database
- UI
- cloud service
- code editing

Allowed:

- packaging fixes
- CLI fixes
- path fixes
- cache compatibility fixes
- documentation fixes
- integration fixes
- release hygiene

---

## 42. Preserve benchmark correctness

Rerun:

```bash
npm run benchmark:v06
npm run benchmark:v07
```

Required:

```text
required-fact recall = 1.0
retrieval recall = 1.0
```

If v0.5 benchmark is lightweight enough, rerun it too.

Do not let release work regress retrieval correctness.

---

## 43. Definition of done

v0.9 is complete when:

- package version is 0.9.0
- clean Git checkout is validated
- npm ci works
- build passes
- all tests pass
- v0.6/v0.7 regressions pass
- npm pack succeeds
- release-candidate tarball is recorded
- isolated install works
- installed CLI works through PATH
- fresh Java repo init works
- preview works
- MCP request works
- package directory read-only test passes or is explicitly blocked by environment
- upgrade 0.8.0 → 0.9.0 is validated
- downgrade behavior is safe/documented
- uninstall is safe
- target repo Git cleanliness is verified
- path-with-spaces passes
- nested cwd passes
- source-path scan passes
- secret scan passes
- README is validated by following it
- developer trial or self clean-room trial is completed
- friction log is updated
- release-readiness checklist is complete
- 0 BLOCKER issues remain
- release recommendation is produced
- no public publication occurs

---

## 44. Final implementation report

At completion output:

```text
STATUS

VERSION

COMMIT

ENVIRONMENT

CLEAN CHECKOUT

NPM CI

BUILD / TESTS

V0.6 / V0.7 REGRESSION

PACKAGE ARTIFACT

ISOLATED INSTALL

CLI THROUGH PATH

FRESH JAVA REPOSITORY

INIT / STATUS / PREVIEW

MCP REQUEST

CODEX

CLAUDE CODE

READ-ONLY PACKAGE

UPGRADE 0.8 → 0.9

DOWNGRADE BEHAVIOR

UNINSTALL

GIT CLEANLINESS

PATH WITH SPACES

NESTED CWD

SOURCE-PATH SCAN

SECRET SCAN

README CLEAN-ROOM VALIDATION

DEVELOPER TRIAL

FRICTION LOG

BLOCKERS

RELEASE RECOMMENDATION

KNOWN LIMITATIONS

NEXT STEP
```

Every item must be:

- PASS
- FAIL
- DEFERRED

with evidence.

---

## 45. Guiding principle

The central question for v0.9 is:

> Can ContextSlice be treated as a real release candidate rather than a tool that only works on the developer’s machine?

Do not add features.

Remove hidden assumptions.
