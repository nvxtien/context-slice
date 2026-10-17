# CLAUDE.md

## Bumping the version

Every bump touches **all** of these files, in one commit named
`chore: bump version to X.Y.Z`:

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | `version` on line 3 and in `packages[""]` (line 9) — not the dependency versions below it |
| `plugin.json` | `version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | the plugin entry's `version` |
| `tests/package-metadata.test.ts` | hardcoded expected version in the `packageJson.version` assertion |
| `CHANGELOG.md` | new `## X.Y.Z` section at the top |

Before committing, check nothing was missed:

```sh
git grep -n '<previous version>' -- . ':!CHANGELOG.md' ':!benchmarks' ':!docs'
npm test
```

The grep must return nothing except unrelated matches (e.g. `better-sqlite3`
in the lockfile).

`INDEX_VERSION` in `src/storage/sqlite.ts` is a separate number. Bump it only
when parser output or the stored symbol shape changes (it invalidates users'
cached indexes), and regenerate `tests/fixtures/rust-parse-snapshot.json` with
`UPDATE_RUST_PARSE_SNAPSHOT=1 npx tsx --test tests/rust-parse-snapshot.test.ts`.

## Releasing

1. Bump the version (above) and commit.
2. `git tag vX.Y.Z`, then push `main` and the tag.
3. `gh release create vX.Y.Z --title "ContextSlice X.Y.Z" --latest` with the
   CHANGELOG section as the notes. A tag alone does not create a GitHub
   release.
4. The plugin runs the latest published npm `context-slice`, so fixes only
   reach users after `npm publish`.

## Commits

Short messages. No `Co-Authored-By` trailer.
