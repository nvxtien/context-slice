# ContextSlice v1.1 Release Readiness

TypeScript and TSX support. Package version 1.1.0, unpublished.

Evidence:

- [v1.1 TypeScript benchmark](../benchmarks/results/v1.1-typescript-support.md) — `npm run benchmark:v11`
- [v1.1 clean-room validation](../benchmarks/results/v1.1-release-validation.md) — `npm run release:rc -- --label v1.1 --baseline-ref 08d991c --assistants`
- [v1.1 friction log](../benchmarks/results/v1.1-friction-log.md)
- [docs/typescript-support.md](typescript-support.md)

## Definition of done

- [x] language-adapter boundary exists, and the core has no per-language branches
- [x] Java tests and regressions pass unchanged (v0.6: 100% required-fact recall, 100% retrieval recall, 94.55% median context reduction)
- [x] `.ts` and `.tsx` parsing, including files of any size
- [x] TypeScript symbols indexed, including arrow functions and named function expressions at any nesting depth
- [x] imports indexed with name, alias, kind and type-only status
- [x] relative imports, directory index files, and simple tsconfig aliases resolve
- [x] aliased, default and namespace imports resolve
- [x] exports, re-exports and barrel files resolve, with cycle protection
- [x] class, `this`, declared-receiver-type and constructor calls resolve
- [x] calls needing type inference stay unresolved rather than guessed
- [x] `.d.ts` behaviour is explicit: API symbols, no call edges
- [x] TSX components, handlers and JSX references parse and resolve
- [x] same CLI and MCP workflow for TypeScript; no language-specific commands or tools
- [x] mixed Java/TypeScript repositories work with no identity collisions
- [x] benchmark uses 3 pinned repositories, fetched reproducibly
- [x] required-fact recall reported: 95.56%
- [x] retrieval recall reported: 100%
- [x] semantic call precision and recall reported: 100% and 100% on the fixture ground truth
- [x] context reduction reported: 83.32% median
- [x] whole-file fallback reported: 6.67%
- [x] npm package contains the TypeScript runtime assets
- [x] clean-room TypeScript smoke test passes from an installed tarball
- [x] tsserver decision is evidence-based: not added, 0 facts lost to type inference
- [x] README and docs updated
- [x] 0 blockers, 0 unresolved MAJOR issues

## Cache compatibility

Schema `1.1.0` stores a language per file, symbol and call.

- **Upgrade** from 1.0.0: the old cache is dropped and rebuilt on the next command. Nothing to delete by hand.
- **Downgrade** to 1.0.0: requires `rm -rf .context-slice` first. The older binary predates the language column and fails loudly rather than misreading the cache. This is documented in the changelog, release notes and TypeScript docs.
- A cache written by any other schema is never reinterpreted.

## Known limitations

- Required-fact recall is 95.56%, not 100%. Two facts in one Nest task describe sibling members of the target's class, which a method-centred slice does not include. Attributed to context composition, not type resolution.
- Receivers needing type inference, CommonJS `require`, and imports leaving the checked-out source stay unresolved.
- 4 of 597 Excalidraw files still fail to parse (test files using syntax the grammar rejects). Java and Nest parse cleanly.
- Benchmark scope is 15 tasks over 3 pinned repositories on macOS arm64.

## Not done

- No npm publish, Git tag, or GitHub Release. v1.1 is implementation and validation only.
- No external developer trial; the usability evidence remains a scripted self clean-room trial.
