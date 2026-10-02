# Rust support

ContextSlice indexes Rust with Tree-sitter. There is no rust-analyzer, no rustc, and no Cargo build execution: resolution is structural, and anything that cannot be established from syntax is reported as unresolved (or `probable`) rather than guessed.

Measured behaviour is in [benchmarks/results/v1.5-phase3-rust-tasks.md](../benchmarks/results/v1.5-phase3-rust-tasks.md), with module/`use`/re-export numbers in [v1.5 Phase 1](../benchmarks/results/v1.5-phase1-rust-real-repositories.md) and call-resolution numbers in [v1.5 Phase 2](../benchmarks/results/v1.5-phase2-rust-semantic-calls.md).

## Files

`.rs` is indexed.

## Symbols

Indexed: functions (including `async` and trait default/signature methods), structs (including tuple structs), enums, traits, impl blocks (inherent and trait), modules (file-backed declarations and inline `mod` bodies), consts, statics, and type aliases.

Identity example:

```text
src/lib.rs::struct::WalkDir
src/lib.rs::impl::WalkDir::method::into_iter()
crates/ignore/src/dir.rs::mod::tests::function::td_path()
```

Not yet indexed: macros, closures, tests as a distinct category, and generics/where-clause detail beyond the raw signature text.

## Modules, `use`, and re-exports

Module paths follow the Rust filesystem convention: crate roots (`src/lib.rs`, `src/main.rs`) get module path `[]`, and each file-backed `mod foo;` extends the path by one segment, including declarations nested inside inline `mod` bodies.

`use` declarations are parsed with one recursive use-tree parser covering top-level lists, nested groups, `self` (with and without alias), wildcards, and aliases. Anchored imports (`crate::`, `self::`, `super::`) resolve to a file; non-anchored paths are classified external (std or a declared Cargo dependency) unless the first segment is bound locally in the same file, in which case they are left unresolved rather than called external. `pub use` re-exports are followed to the symbol they name.

Measured on three real repositories (walkdir, mini-redis, ripgrep's `crates/ignore`): anchored `use` resolution 100%, re-export resolution 100%. Module-path assignment agrees with an independent oracle 64-100% depending on crate layout — every disagreement is a `src/bin/*`, `tests/*`, `examples/*` or `build.rs` file, each its own Cargo-recognized crate root that this adapter still paths as if nested under `src/` (see Cargo workspace handling, below). See [v1.5 Phase 1](../benchmarks/results/v1.5-phase1-rust-real-repositories.md) for the full numbers.

## Structs, enums, traits, impls

Structs (including tuple structs), enums, traits, and inherent/trait impl blocks are indexed as symbols with their declaration text. An impl block's methods are indexed as members of that block, so an inherent impl and a trait impl of the same type are kept distinct.

## Call resolution

| Kind | Example | Confidence |
| --- | --- | --- |
| same-file / bare-fn | `helper()` declared in the same file | exact |
| self-method | `self.validate()` | exact |
| field-method / param-method | `self.repo.save()`, a typed parameter's method | exact, when the receiver's type is known |
| local-method | a local variable's method, single unambiguous binding | exact, when the receiver's type is known from one binding |
| associated (`Type::f()`) | `WalkDir::new()` | exact |
| trait dispatch | a call through `Box<dyn Trait>` or a trait-typed receiver | `probable` |
| external | std or a declared Cargo dependency | unresolved, package recorded |

Conservative, honestly-labelled rules layered on top of typed-receiver resolution:

- **Match-arm receiver typing.** A receiver bound by a `match` arm pattern is typed from the arm, not left unknown.
- **Macro-argument call recovery.** Calls written inside selected macro arguments are recovered on a best-effort basis; macros not on the denylist are attempted, format/log/assert-style macros (plus `anyhow!`/`bail!`/`matches!`) are denylisted (see What stays unresolved).
- **cfg-duplicate handling.** When `#[cfg(...)]` produces multiple candidate definitions of the same symbol, all candidates are attached as `probable` targets AND are all reachable via caller/callee context composition (`runtimeTargetIds`), not just the first-listed alternative.

Trait dispatch and any receiver whose type needs more than one unambiguous local binding are resolved as `probable` at best, or left unresolved. A variable reassigned within its scope loses receiver-type evidence (the same single-binding rule as Python).

## What stays unresolved

By design, and reported rather than guessed:

- receivers whose type needs inference beyond a single local binding, `getattr`-style dynamism does not apply to Rust, but shadowed/reassigned bindings do lose evidence the same way
- calls inside macro arguments for macros on the denylist (`anyhow!`, `bail!`, `matches!`, plus the format/print/write/assert/panic/vec/logging group), or any macro invocation itself (macros are structural only — no expansion). `ensure!` and `dbg!` are deliberately NOT denylisted: `ensure!`'s first argument is a real boolean condition and `dbg!`'s sole argument is the real expression being inspected, both genuine control flow, not format-string values.
- crate-name imports of a repository's own library crate from `tests/`, `src/bin/*` or `examples/*` (classified external; needs Cargo.toml-derived crate identity, not yet implemented)
- imports that leave the checked-out source

## Cargo workspace handling

`Cargo.toml` is now read for workspace crate identity: a root `[package]` name and every `[workspace].members` entry's own `[package]` name (including a simple trailing `dir/*` glob) are mapped to that crate's directory, each with its own, separate module index. A `use` path whose first segment names a sibling workspace crate resolves into that crate's files instead of being reported external, and two crates' own root files (both `src/lib.rs`) no longer collide into one "ambiguous" module-path key the way a single project-wide index would.

Still inferred purely from directory layout, not from Cargo.toml, within a single crate:

- `src/bin/*.rs`, `tests/*.rs`, `examples/*.rs`, and `build.rs` are each their own Cargo-recognized crate root, but the adapter paths them as if nested under `src/` (e.g. `src/bin/cli.rs` gets module path `[bin, cli]` instead of `[]`).
- Crate-name imports of a repository's own library from one of those (`use my_crate::...` from `tests/`, not inside a `[workspace]`) are not mapped back to the local crate and are classified external — this needs `[[bin]]`/`[lib] path` override awareness, not yet implemented.
- `[[bin]]`/`[lib] path` overrides and dependency renames (`package = "..."` in `[dependencies]`) are not read.

## Why no rust-analyzer

The Phase 3→4 recommendation's §75 decision gate requires all four conditions — required facts lost, real tasks harmed, failures repeating across repositories, and structural analysis being unable to solve them — before rust-analyzer is warranted. After Phase 4's import-context composer closed the one remaining gap (an import line outside any symbol's source), required-fact recall reached 100% on all 15 tasks with structural fixes alone (match-arm receiver typing, best-effort macro-argument call recovery, and cfg-duplicate handling). **Verdict: rust-analyzer is not warranted.** See `docs/superpowers/plans/2026-09-26-v1.5-phase3-phase4-recommendation.md` for the full gate analysis.

## Limitations

- The module-import-context composer's scope is caller and callee files only, not the target's own file — it recovers an import line's context from the files it composes around the target, not from the target's own module header.
