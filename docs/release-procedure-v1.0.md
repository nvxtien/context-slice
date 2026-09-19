# ContextSlice v1.0 Release Procedure

Exact commands for publishing 1.0.0. **Nothing in the "requires approval" sections has been run.** As of this document, ContextSlice has never been published, tagged, or released publicly.

## 0. Prerequisites

- An npm account with publish rights for the package name. Check the name first: `npm view context-slice version` (a 404 means the name is free).
- `npm login` (or a granular automation token in `NPM_TOKEN` for CI). Do not commit tokens or paste them into shell history, and do not log them.
- If the account has 2FA set to "Authorization and writes", `npm publish` will prompt for a one-time password. Use `npm publish --otp=<code>` for a non-interactive run.
- Decide visibility: this is an unscoped public package, so `npm publish` publishes it publicly. A scoped name such as `@yourname/context-slice` would need `--access public`, since scoped packages default to private.
- Push access to `github.com/nvxtien/context-slice`.

## 1. Verify the release commit (safe, no public effect)

```sh
git checkout main
git pull --ff-only
git status --short          # must be empty
git log --oneline -1        # the commit you intend to release
```

## 2. Full validation from a clean state (safe)

```sh
npm ci
npm run build
npm test
npm run benchmark:v06
npm run benchmark:v07
npm run benchmark:v08
npm pack
npm publish --dry-run
```

Or run everything the release validation covers, in one command:

```sh
npm run release:rc -- --label v1.0 --assistants
```

Requirements before proceeding: 0 BLOCKER, 0 unresolved MAJOR, and a GO recommendation in `benchmarks/results/v1.0-release-validation.md`.

## 3. Publish — REQUIRES EXPLICIT APPROVAL

```sh
npm publish                 # add --otp=<code> if 2FA is enforced
```

This is public and effectively permanent: unpublishing is restricted to a 72-hour window and the exact name and version can never be reused.

Verify afterwards:

```sh
npm view context-slice version
npx context-slice@1.0.0 --version
```

## 4. Tag — REQUIRES EXPLICIT APPROVAL

```sh
git tag -a v1.0.0 -m "ContextSlice 1.0.0"
git tag -v v1.0.0           # or: git show v1.0.0
git push origin main
git push origin v1.0.0
```

## 5. GitHub Release — REQUIRES EXPLICIT APPROVAL

Use the prepared draft at `docs/github-release-v1.0-draft.md`:

```sh
gh release create v1.0.0 --title "ContextSlice 1.0.0" --notes-file docs/github-release-v1.0-draft.md
```

Attach the tarball if you want a downloadable artifact:

```sh
gh release upload v1.0.0 context-slice-1.0.0.tgz
```

## 6. After publishing

- Update the README: replace the tarball instructions with `npm install -g context-slice`, and remove the "not published to npm" wording.
- Confirm `npx context-slice --version` works from a machine that has never seen the source checkout.

## Rollback

- A bad publish: `npm deprecate context-slice@1.0.0 "<reason>"` and release a fixed 1.0.1. Prefer this over `npm unpublish`, which is allowed only within 72 hours and burns the version number.
- A bad tag, before anyone depends on it: `git push origin :refs/tags/v1.0.0` and `git tag -d v1.0.0`.
