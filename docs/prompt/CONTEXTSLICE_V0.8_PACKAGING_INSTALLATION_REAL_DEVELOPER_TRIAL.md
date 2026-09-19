# ContextSlice v0.8 — Packaging, Installation & Real Developer Trial

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice v0.1 through v0.7 are already implemented and validated.

Current v0.7 state:

- stable CLI executable: `context-slice`
- commands:
  - `init`
  - `index`
  - `status`
  - `doctor`
  - `preview`
  - `mcp`
- preview uses strict context budgets
- preview explains inclusion/omission
- unresolved calls are surfaced
- MCP auto-refreshes on every request
- MCP stdout remains clean JSON-RPC
- overload ambiguity is preserved
- README onboarding exists
- local `npm link` flow documented
- Codex setup documented
- Claude Code setup documented
- v0.7 workflow benchmark and reports exist

Current verification:

- `npm test`: 33/33 pass
- `npm run build`: pass
- `npm run benchmark:v06`: required-fact recall = 1.0, retrieval recall = 1.0
- `npm run benchmark:v07`: pass
- `git diff --check`: clean

Current product positioning:

> ContextSlice helps developers reduce the amount of source code placed into an AI coding assistant’s context window.

Tagline:

> Less code in context. Fewer tokens. Same required information.

The purpose of v0.8 is not to add semantic features.

The purpose is:

> Prove that ContextSlice can be packaged, installed, upgraded, removed, and used outside the source repository by a real developer with minimal friction.

---

## 1. Primary objective

Validate shipping quality.

A developer who has never cloned the ContextSlice source repository should be able to:

1. obtain an installable package,
2. install it,
3. run `context-slice`,
4. initialize a Java repository,
5. preview context,
6. start MCP,
7. connect Codex or Claude Code,
8. upgrade safely,
9. uninstall cleanly,

without relying on undocumented source-tree paths.

---

## 2. Core questions

Answer:

1. Does the packaged artifact contain every runtime file?
2. Does the CLI work when installed outside the repository?
3. Do Tree-sitter query files ship correctly?
4. Does SQLite/cache creation work from an installed package?
5. Does MCP start correctly from the packaged binary?
6. Are runtime assets resolved relative to the package, not the source checkout?
7. Can a developer install from a tarball?
8. Can a developer install globally?
9. Can `npx` or an equivalent ephemeral flow work if supported?
10. Can the package be upgraded without corrupting cache?
11. Can it be uninstalled without touching the user repository?
12. Can a second developer follow the docs successfully?

---

## 3. No source-checkout dependency

This is release-critical.

The installed tool must not assume paths such as:

```text
/Volumes/Work/dev/context-slice
src/
queries/ relative to cwd
benchmarks/
test fixtures
```

Production runtime assets must resolve from the installed package location.

Add regression tests for this.

---

## 4. npm package metadata

Audit `package.json`.

Ensure:

- correct package name
- version present
- license present
- repository metadata present
- executable `bin` configured
- Node engine range explicit
- runtime dependencies complete
- dev dependencies separated
- build output included
- source-only files excluded if unnecessary

Do not publish during v0.8 unless explicitly requested.

The default goal is to produce a publishable artifact.

---

## 5. npm pack validation

Add a packaging test based on:

```bash
npm pack
```

Inspect the resulting tarball.

Verify it contains all runtime-critical files.

At minimum verify:

- compiled JS
- package metadata
- CLI entry point
- MCP server code
- Tree-sitter query files
- any runtime schema/config assets
- README
- license if present

Verify it excludes unnecessary large development artifacts where practical.

---

## 6. Tarball install test

Automate:

```text
npm pack
↓
fresh temp directory
↓
npm install -g <tarball>
or isolated prefix install
↓
context-slice --version
↓
context-slice doctor
```

Do not run against the source checkout.

The install test must execute the packaged artifact.

---

## 7. Clean-machine simulation

Create a temporary isolated environment approximating a clean machine.

Do not rely on:

- local npm link
- monorepo paths
- workspace symlinks
- source checkout resolution

Where practical use:

- temp HOME
- temp npm prefix
- clean PATH additions
- fresh Java fixture/repository checkout

Document what remains shared with the host system.

---

## 8. Package smoke test

Create a smoke-test script.

Suggested:

```text
scripts/package-smoke-test.ts
```

Flow:

1. build
2. npm pack
3. install tarball into isolated prefix
4. create/fetch test Java repo
5. run `context-slice init`
6. run `context-slice status`
7. run `context-slice preview "..."`
8. start `context-slice mcp`
9. perform one MCP request if practical
10. uninstall package

The script should fail fast.

---

## 9. Runtime asset resolution

Audit all asset lookups.

Examples:

- Tree-sitter query files
- schema/version files
- packaged defaults

Use package-relative resolution.

Do not use current working directory for package-internal assets.

Add tests that change cwd before invoking commands.

---

## 10. Version command

Add:

```bash
context-slice --version
```

or:

```bash
context-slice version
```

Prefer conventional `--version`.

It must read the installed package version reliably.

Do not hard-code version separately in source.

Use one source of truth.

---

## 11. Help UX

Audit:

```bash
context-slice --help
```

Ensure it lists:

- init
- index
- status
- doctor
- preview
- mcp

Include short descriptions.

Avoid dumping implementation details.

---

## 12. Install documentation

Document at least these states accurately:

### Local development

```bash
npm install
npm run build
npm link
```

### Tarball validation

```bash
npm pack
npm install -g ./context-slice-<version>.tgz
```

### Published package

Only document registry installation if the package is actually published.

Do not claim:

```bash
npm install -g context-slice
```

works publicly unless verified.

---

## 13. npx support

Evaluate whether:

```bash
npx context-slice ...
```

can work with the chosen packaging model.

If the package is not published, mark this as future/publication-dependent.

Do not fake npx support.

---

## 14. Upgrade test

Test:

```text
install package A
initialize/index repository
replace with package B
run status/index/preview
```

At minimum simulate version transition using two local package builds if practical.

Validate:

- cache schema handling
- automatic cache rebuild when incompatible
- no source repository corruption
- no manual cleanup required in normal cases

---

## 15. Cache ownership

Confirm ContextSlice only mutates its own cache.

Document default cache path.

Verify uninstalling the npm package does not remove repository cache automatically unless explicitly designed.

Do not delete developer source or Git files.

---

## 16. Uninstall test

Validate:

```bash
npm uninstall -g ...
```

or isolated-prefix equivalent.

After uninstall:

- executable is gone
- developer repository remains intact
- source files unchanged
- cache behavior documented

If cache remains, document how to remove it manually.

---

## 17. Corrupt package/cache behavior

Add packaging-focused failure cases:

- missing query asset
- unreadable package file
- invalid cache schema
- incompatible cache version
- corrupt SQLite file

`doctor` should produce actionable messages.

Avoid stack traces by default for expected user errors.

---

## 18. Fresh repository test

Use at least one fresh Java repository checkout not previously indexed.

Flow:

```text
fresh clone
↓
context-slice init
↓
context-slice preview
↓
context-slice status
```

Verify no hidden dependency on existing benchmark cache.

---

## 19. Existing repository test

Also validate on a repository that already contains a ContextSlice cache.

Flow:

```text
install packaged version
↓
open previously indexed repo
↓
status
↓
upgrade/rebuild if required
↓
preview
```

---

## 20. MCP packaged integration test

Start the MCP server using only:

```bash
context-slice mcp
```

from the installed package.

Do not reference:

- `dist/server/mcp-server.js`
- source files
- repository-local paths

Validate:

- JSON-RPC stdout remains clean
- stderr diagnostics remain separate
- server responds
- graceful shutdown works

---

## 21. Codex packaged setup

Update Codex docs to use only the installed executable.

Example conceptual config:

```text
command: context-slice
args: ["mcp"]
```

Do not use source checkout absolute paths.

Exercise this configuration where the environment permits.

If not exercised, label it as documented but not runtime-verified.

---

## 22. Claude Code packaged setup

Do the same for Claude Code.

Use:

```text
context-slice mcp
```

as the stable entry point.

Avoid package-internal paths.

---

## 23. Shell compatibility

Validate at least the primary supported environments practical in the current workspace.

Document tested environments.

Do not claim universal Windows/macOS/Linux support unless tested.

Pay attention to:

- path separators
- executable shebang
- spaces in paths
- temp directories
- npm global prefix differences

---

## 24. Path-with-spaces test

Create an install/test path containing spaces.

Example:

```text
/tmp/context slice test/
```

Run:

- init
- status
- preview

This catches brittle shell/path handling.

---

## 25. Nested working directory test

From:

```text
repo/src/main/java/...
```

run:

```bash
context-slice status
context-slice preview "..."
```

Verify nearest Git root detection still works after package installation.

---

## 26. Read-only package location

Where practical, make package installation directory read-only after install.

Verify runtime writes only to:

- repository cache
- temp files where intended

Do not write generated data into the installed package directory.

---

## 27. Package size

Record:

```text
tarball size
installed size
file count
```

Do not optimize aggressively unless obviously bloated.

Flag accidentally packaged artifacts such as:

- benchmark clones
- coverage
- temp databases
- node_modules
- large reports not intended for runtime

---

## 28. Publish dry run

Use:

```bash
npm publish --dry-run
```

if supported and safe.

Record output.

Do not perform a real publish.

The goal is to identify packaging issues before publication.

---

## 29. Real developer trial

Run a lightweight real-developer validation.

Preferred:

- 1–3 developers
- 3–5 representative tasks each

Minimum acceptable if external developers are unavailable:

- one clean-room self-trial using only published/tarball-style install instructions

Do not call a self-trial a multi-user study.

---

## 30. Trial protocol

Ask the developer to perform:

1. install
2. navigate to Java repo
3. init
4. preview one task
5. connect one coding assistant if available
6. run one task
7. inspect context savings
8. report friction

Record:

- setup failures
- confusing output
- undocumented steps
- whole-file fallback
- context reduction
- whether doctor helped
- whether MCP setup was understandable

---

## 31. Developer friction log

Create:

```text
benchmarks/results/v0.8-friction-log.md
```

Categorize issues:

```text
INSTALL
PATH
NODE_RUNTIME
PACKAGE_ASSET
CLI
MCP
DOCS
CACHE
REPOSITORY_DETECTION
ASSISTANT_SETUP
OTHER
```

Each issue should record:

- symptom
- root cause
- fix
- status

Do not hide setup failures.

---

## 32. Packaging benchmark report

Generate:

```text
benchmarks/results/v0.8-packaging-installation.md
benchmarks/results/v0.8-packaging-installation.json
```

Include:

1. package metadata
2. npm pack contents
3. tarball size
4. isolated install
5. fresh repo smoke test
6. existing repo test
7. version/help
8. MCP package integration
9. upgrade
10. uninstall
11. path-with-spaces
12. nested cwd
13. publish dry run
14. real developer trial
15. friction log summary
16. limitations
17. next step

---

## 33. Packaging regression test

Add an automated test or script that fails when critical runtime assets are missing from the tarball.

For example, verify required patterns.

Do not manually inspect the tarball only.

---

## 34. Package manifest

If useful, define an explicit `files` list in `package.json`.

Prefer intentional packaging.

Avoid accidentally shipping the whole repository.

Make sure runtime query files are included.

---

## 35. Source maps

Decide whether to ship source maps.

If included:

- verify paths are safe
- verify package size impact

If excluded:

- ensure production stack traces remain usable enough

Document the choice.

---

## 36. License and third-party notices

Verify package licensing is clear.

Check Tree-sitter grammar/runtime dependency licensing where required.

Do not invent legal conclusions.

At minimum ensure project license metadata is internally consistent.

---

## 37. Security hygiene

Before package readiness:

- ensure no secrets
- no local absolute paths
- no benchmark credentials
- no private repository URLs unless intentionally public/documented
- no temp files
- no developer machine paths in generated runtime assets

Search the package tarball for suspicious local paths.

---

## 38. Reproducible build

Run:

```text
clean checkout
npm ci
npm run build
npm test
npm pack
```

Record versions:

- Node
- npm
- OS

Do not require generated files that are absent from Git.

---

## 39. Clean checkout validation

This is release-critical.

Use a clean Git checkout of ContextSlice itself.

Do not use an untracked local build artifact.

Verify:

```text
npm ci
npm run build
npm test
npm pack
```

works.

---

## 40. Git cleanliness

After build/test/package commands, inspect:

```bash
git status --short
git diff --check
```

Document intentional generated files.

Avoid commands that unexpectedly modify tracked source.

---

## 41. README update

Refactor README Quick Start toward package usage.

Recommended sections:

1. What ContextSlice does
2. Current benchmark result
3. Installation
4. Quick Start
5. Preview example
6. Codex MCP setup
7. Claude Code MCP setup
8. Commands
9. How context reduction works
10. Trust and diagnostics
11. Benchmarks
12. Limitations
13. Development install

Clearly separate:

```text
published install
```

from:

```text
local development install
```

if package publication has not happened.

---

## 42. Do not publish yet by default

v0.8 should produce a **publish-ready** package.

Do not publish to npm unless explicitly authorized.

A real package publication changes external state and naming expectations.

The deliverable is:

```text
publish-ready
```

not necessarily:

```text
published
```

---

## 43. Release readiness checklist

Create:

```text
docs/release-readiness-v0.8.md
```

Checklist:

```text
[ ] clean checkout builds
[ ] tests pass
[ ] npm pack succeeds
[ ] tarball contains runtime assets
[ ] isolated install works
[ ] version works
[ ] help works
[ ] init works
[ ] preview works
[ ] MCP works
[ ] upgrade works
[ ] uninstall safe
[ ] docs use packaged executable
[ ] no local absolute paths
[ ] no secrets
[ ] publish dry run passes
[ ] real developer trial completed or explicitly deferred
```

---

## 44. Keep v0.6/v0.7 correctness

Packaging work must not regress core behavior.

Rerun:

```text
npm test
npm run build
npm run benchmark:v06
npm run benchmark:v07
```

Required:

```text
required-fact recall = 1.0
retrieval recall = 1.0
```

Do not trade correctness for packaging convenience.

---

## 45. Definition of done

v0.8 is complete when:

- clean checkout builds
- all tests pass
- v0.6/v0.7 regressions pass
- npm pack succeeds
- packaged runtime assets are verified
- isolated tarball installation works
- CLI works outside source checkout
- version/help work
- fresh Java repo init works
- preview works
- MCP starts from packaged executable
- package does not rely on absolute source paths
- path-with-spaces test passes
- nested cwd repository detection passes
- upgrade path is tested
- uninstall safety is tested
- package size is reported
- npm publish dry-run succeeds if available
- release-readiness checklist is generated
- README package onboarding is accurate
- real developer trial is completed or explicitly documented as deferred
- friction findings are recorded honestly

---

## 46. Final implementation report

At completion output:

```text
STATUS

CLEAN CHECKOUT

BUILD / TESTS

PACKAGE METADATA

NPM PACK

TARBALL CONTENTS

PACKAGE SIZE

ISOLATED INSTALL

CLI OUTSIDE SOURCE CHECKOUT

VERSION / HELP

FRESH REPOSITORY

EXISTING REPOSITORY

MCP PACKAGED INTEGRATION

CODEX SETUP

CLAUDE CODE SETUP

UPGRADE

UNINSTALL

PATH WITH SPACES

NESTED CWD

PUBLISH DRY RUN

REAL DEVELOPER TRIAL

FRICTION LOG

V0.6 / V0.7 REGRESSION

SECURITY / LOCAL PATH CHECK

KNOWN LIMITATIONS

RELEASE READINESS

NEXT STEP
```

Every claim must be exercised or explicitly marked as deferred.

---

## 47. Guiding principle

The central question for v0.8 is:

> Can a developer use ContextSlice as an installed tool, not as a source checkout?

The engine already works.

Now prove that the package ships cleanly.
