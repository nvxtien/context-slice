# ContextSlice v1.3 Release Readiness

Python language support. Package version 1.3.0, unpublished.

Evidence:

- [v1.3 Python benchmark](../benchmarks/results/v1.3-python-support.md) — `npm run benchmark:v13`
- [v1.3 clean-room validation](../benchmarks/results/v1.3-release-validation.md)
- [v1.3 friction log](../benchmarks/results/v1.3-friction-log.md)
- [docs/python-support.md](python-support.md)

## Definition of done

- [x] build passes; all tests pass (74, including 9 Python tests)
- [x] Java regression: required-fact recall 100%, retrieval recall 100%
- [x] TypeScript regression: required-fact recall 100%, semantic call recall and precision 100%
- [x] `.py` indexing, functions, async functions, classes, methods
- [x] decorators retained as searchable metadata
- [x] `self` and `cls` resolution where deterministic
- [x] imports, aliases, module aliases, relative imports
- [x] `__init__.py` re-exports with cycle protection
- [x] `__all__` read when statically available
- [x] module-level calls attributed to a module symbol
- [x] dynamic behaviour stays conservative (factories, `getattr`, dynamic imports, monkey patching)
- [x] mixed Java/TypeScript/Python repository works with no id collisions
- [x] benchmark uses 3 pinned repositories fetched reproducibly
- [x] required-fact recall reported: 100%
- [x] retrieval recall reported: 100%
- [x] semantic call recall and precision reported: 100% / 100%
- [x] context reduction reported: 94.14% median
- [x] whole-file and whole-module fallback reported: 0% / 0%
- [x] minimum sufficient budget reported over a 256–8192 sweep
- [x] dynamic failure attribution reported
- [x] type-checker decision is evidence-based: not added, 0 facts lost
- [x] packaging and clean-room Python smoke pass
- [x] README and docs updated
- [x] no benchmark leakage (guard in `tests/safety.test.ts`)
- [x] no framework-specific rules

## Results

| Metric                             | Python v1.3 (15 tasks, 3 repos)              |
| ---------------------------------- | -------------------------------------------- |
| Required-fact recall               | 100%                                         |
| Retrieval recall                   | 100%                                         |
| Semantic call recall / precision   | 100% / 100%                                  |
| Median context reduction           | 94.14%                                       |
| Whole-file / whole-module fallback | 0% / 0%                                      |
| Median dynamic unresolved rate     | ~49% of call edges, costing 0 required facts |
| Parse errors                       | 0 across 366 Python files                    |

Repository scale: itsdangerous 15 files, Flask 65, Django ORM 286 (1.5 s cold index).

## Per-rule attribution

Measured alone against the fixture ground truth, 20 edges:

| Rule                      | Semantic call recall |
| ------------------------- | -------------------- |
| core resolution only      | 80.00%               |
| + self attribute receiver | 86.67%               |
| + instance receiver       | 86.67%               |
| + class receiver          | 86.67%               |
| all three                 | 100.00%              |

Each receiver rule recovers an edge no other rule reaches, so all three are retained. The first measurement showed the instance rule recovering nothing; that turned out to be a gap in the fixture, not a dead rule, and the fixture was fixed rather than the result being accepted.

## Known limitations

- Python is dynamic. Roughly half of all call edges in these repositories stay unresolved; that cost zero required facts here but will differ per project.
- Instance fields are not indexed as symbols, so a Python class skeleton lists methods and class-level assignments only.
- Receiver typing uses a single unambiguous binding; a reassigned variable drops the evidence.
- `pyproject.toml` is not parsed; package roots come from the directory layout.
- Django is measured as a sparse checkout of `django/db`, `django/core` and `django/utils`; imports leaving those packages are reported unresolved rather than guessed.

## Not done

- No npm publish, Git tag, or GitHub Release.
- No external developer trial; usability evidence remains a scripted self clean-room trial.
