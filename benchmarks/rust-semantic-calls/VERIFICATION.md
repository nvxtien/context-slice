# Verification of the Rust semantic-call ground truth (Task 5)

Three independent blind re-derivations, one per repo, by a different model tier than the labellers (labellers: Sonnet; verifiers: Opus). Each verifier re-labelled ALL entries: walkdir 28, mini-redis 30, ripgrep-ignore 41 = 99 (86 main + 13 trait-candidate supplement), then compared with the committed labels.

## Agreement

| measure                        | result                                              |
| ------------------------------ | --------------------------------------------------- |
| kind                           | 99/99                                               |
| resolved targets (file + line) | 43/43 (walkdir 13, mini-redis 6, ripgrep-ignore 24) |
| confidence                     | 99/99                                               |
| disagreements                  | 0                                                   |

## Blind protocol

Each verifier read the README and plan, derived labels from the sampler fields and the pinned checkout source only, and wrote its labels plus a `blind-done.txt` before opening the label file, its git history, or any labeller report. This is attested by the verifier, not enforced by tooling. No indexer/adapter or benchmark result was used.

## Fragile-but-agreeing entries

walkdir:

- `src/lib.rs:1074` `self.it.next()`: correct only because the impl is specialised to `FilterEntry<IntoIter, P>` (lib.rs:1060); `next` is also a std name.
- `src/tests/recursive.rs:915` `it.skip_current_dir()`: two return-type hops (`WalkDir::new` -> `Self`, `into_iter()` via in-repo `IntoIterator`).
- `recursive.rs:447` `sorted_ents`, `recursive.rs:687` `assert_no_errors`: receiver type via `run_recursive` return type through a `let`.
- `recursive.rs:113`, `recursive.rs:1083` `dir.path()`: `path` exists on `DirEntry`, `TempDir`, `Error` and std; only the `let` type disambiguates.
- `src/dent.rs:214` `ent.ino()` and `dent.rs:271` `md.ino()`: cfg(unix) only, share a name with in-repo `DirEntryExt::ino`; external is correct (std receivers).
- `src/dent.rs:192` `map_err`: exists only in the cfg(windows) variant.
- `recursive.rs:18` `assert_send::<..>()`: nested fn, depends on the `outer::inner` rule (sibling `assert_sync` at line 12).
- `walkdir-list/main.rs:210` `.arg`, `:244` `.help`: external via fn-local `use clap::{..}`.
- `src/lib.rs:694` `itry!`: unresolvable per macro rule (macro_rules at lib.rs:137).

mini-redis:

- The three `&str.into()` sites (`parse.rs:111`, `parse.rs:121`, `frame.rs:90`): external because the called method is core `Into::into`, although it reaches in-checkout `From<&str>` impls.
- `tests/client.rs:36` `client.set`: needs `Client::connect(..).await.unwrap()` typing; `set` exists on four types; relies on `tests/` being in scope.
- `src/clients/client.rs:482` `frame.as_slice()`: `ref` pattern over `Vec<Frame>`.
- `src/db.rs:135` `shared.clone()`: needs `shared: Arc<Shared>` from db.rs:124.
- `src/db.rs:307` `Instant::now`: external via `use tokio::time::Instant` (low risk).
- `tests/server.rs:166`, `:238` `.unwrap()`: needs tokio `AsyncReadExt` (low risk).

ripgrep-ignore:

- `dir.rs:537` `mat.is_ignore()`: receiver from `matched_ignore` return type; `IncrementalMatch::is_ignore` is a same-name distractor.
- `dir.rs:1050` `errs.into_error_option()`: receiver from derived `Default`.
- `dir.rs:1203`, `dir.rs:1537` `td.path()`: target in a `#[cfg(test)]` module; many other `path` methods.
- `walk.rs:90` `self.dent.ino()`: cfg(unix)-only target at walk.rs:219; three `ino` methods in walk.rs.
- `walk.rs:301` `fs::metadata`: inside the `cfg(not(windows))` variant (external either way).
- `incremental.rs:835`, `dir.rs:1473` `mkdirp`, `walk.rs:2728` `tmpdir`: each test module defines its own helper.
- Supplement chains `gitignore.rs:873`, `overrides.rs:276`: depend on std `Result::unwrap` typing.
- qualifiedName of `tests::TempDir::path` / `tests::mkdirp` omits the file module (harmless: evaluator matches file, simple name, line).

## Schema gaps found and resolution

| gap                                                               | resolved by (README rule)                      |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| `confidence` undefined for external/unresolvable                  | exact by convention, not scored                |
| qualifiedName format unspecified                                  | format rule                                    |
| `target.line` with attributes/doc comments, multi-line signatures | first token of the item                        |
| which cfg variant to label                                        | Unix/cfg-neutral variant, named in `why`       |
| `.into()` through std blanket impl reaching an in-checkout `From` | called std/core trait method => external       |
| `tests/`, `examples/`, `src/bin/` scope                           | in scope; reaching a checkout item => resolved |
| `why` errors go unnoticed                                         | corrected via `CORRECTIONS.md`                 |

Not changed: trait-impl method vs inherent method share kind `method`; derived-`Default` receiver typing (ripgrep-ignore `dir.rs:1050`) is not addressed by the derive rule (both sides labelled the called method resolved).

## Limitations

- Labels and verification are both LLM-derived; there was no human review.
- The blind protocol is honor-based, not tool-enforced.
- Agreement between two models is evidence of consistency, not proof of correctness; correlated errors are possible.
- Sample sizes are small (86 main + 13 supplement); per-repo held-out counts are tiny.
- `Self::` associated calls and `<T as Trait>::` calls have zero real sites in these repos.
- Only 2 entries exercise real in-repo trait dispatch (`probable`: ripgrep-ignore `walk.rs:1821`, `walk.rs:1837`); the other 11 supplement entries are same-name distractors.
