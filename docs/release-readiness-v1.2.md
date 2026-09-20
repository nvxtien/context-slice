# ContextSlice v1.2 Release Readiness

Context composition hardening. Package version 1.2.0, unpublished.

Evidence:

- [v1.2 composition benchmark](../benchmarks/results/v1.2-context-composition.md) — `npm run benchmark:v12`
- [v1.2 clean-room validation](../benchmarks/results/v1.2-release-validation.md)
- [v1.2 friction log](../benchmarks/results/v1.2-friction-log.md)
- [docs/context-composition.md](context-composition.md)

## Definition of done

- [x] build passes
- [x] all tests pass (65, including 4 composition tests)
- [x] Java regressions pass: required-fact recall 100%, retrieval recall 100%
- [x] TypeScript regressions pass: semantic call recall 100%, precision 100%
- [x] targeted composition tests pass, including negative cases
- [x] sibling context recall measured: 0% → 100% (TypeScript)
- [x] TypeScript required-fact recall reaches 100%
- [x] retrieval recall remains 100%
- [x] semantic call metrics do not regress
- [x] context reduction reported: TypeScript 86.39%, Java 94.55% (unchanged)
- [x] context inflation reported: median 0 tokens per task, worst case +181
- [x] whole-file fallback reported: 6.67% → 0%
- [x] whole-class fallback reported: 0%
- [x] minimum sufficient budget reported across a 256–8192 sweep
- [x] fact recovery efficiency reported per rule
- [x] no whole-class dump is used as the fix
- [x] large-class and large-TSX regressions pass
- [x] benchmark report generated
- [x] README and docs updated
- [x] no benchmark leakage (guard test in `tests/safety.test.ts`)
- [x] no framework-specific rules
- [x] each rule's benefit measured independently

## Results against the v1.1 baseline

| Metric                        | v1.1   | v1.2     |
| ----------------------------- | ------ | -------- |
| TS required-fact recall       | 95.56% | **100%** |
| TS sibling context recall     | 0%     | **100%** |
| TS whole-file fallback        | 6.67%  | **0%**   |
| TS median context reduction   | 85.94% | 86.39%   |
| Java required-fact recall     | 100%   | 100%     |
| Java retrieval recall         | 100%   | 100%     |
| Java median context reduction | 94.55% | 94.55%   |
| Whole-class fallback          | n/a    | 0%       |

## Heuristics retained

| Rule                    | Facts recovered | Added tokens | Facts per 1k tokens | Retained |
| ----------------------- | --------------- | ------------ | ------------------- | -------- |
| enclosing-type skeleton | 2               | 173          | 11.56               | yes      |

Four state-sharing rules (shared field, accessor, constructor dependency, lexical closure) were implemented, measured, and **removed**: across the 30 benchmark tasks they recovered no required fact and cost 966 tokens. Only the skeleton earned its place.

## Known limitations

- Declaration lines only: a required detail inside a sibling's body is not carried.
- Java fields are analysed from source but not indexed, so they never appear in search results.
- The skeleton caps at 12 member declaration lines; the rest is a count.
- Composition looks one level out, to the enclosing type, and never across files.

## Not done

- No npm publish, Git tag, or GitHub Release.
- No external developer trial; usability evidence remains a scripted self clean-room trial.
