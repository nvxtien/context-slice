# Java DI AST Migration — Phase 1 Complete

## Summary

Migrated `dependency-injection.ts` field and setter detection from regex-scanning `memberLevelBody` text onto direct iteration over AST field/method symbols, eliminating two sources of brittleness and fixing latent bugs.

## What changed

**Deleted:** `memberLevelBody()` helper and `INJECT_RE` regex.

**Added:**
- `bareName()` helper (strips leading package path from annotation names)
- `INJECT_ANNOTATIONS` set (covers `@Inject`, `@Autowired`, `@Resource`)
- Two new loops replacing the old regex scan:
  - **Field injection:** iterates AST field symbols, reads `declaredType`, `name`, and `@Qualifier` value directly from `field.source`
  - **Setter injection:** iterates AST method symbols, extracts parameter list, and reads `@Qualifier` off `method.source`

## Accepted divergence: multi-declarator `@Qualifier` loss

Multi-declarator fields like `@Qualifier("foo") Type a, b;` lose their qualifier value and are detected as injection points without it. This divergence is accepted because:
- Multi-declarator fields with qualifiers are extraordinarily rare in real code
- The previous regex implementation had a deeper bug: it dropped ALL relations (not just the qualifier) for multi-declarator fields — both `a` and `b` were lost entirely
- The AST migration genuinely improves the situation for multi-declarator fields (see "Real improvement" below)

## Real bug found and fixed

**Bug:** The setter loop's `params = firstParenGroup(method.source)` grabbed the *annotation's* parentheses when the method carried a parenthesized annotation argument (e.g. `@Autowired(required = false)`), causing `method.source` to include leading annotation text.

**Fix:** Strip leading annotations from `method.source` using the pattern `/^(?:\s*@[\w.]+(?:\s*\([^)]*\))?\s*)*/` before calling `firstParenGroup`, ensuring the method's own parameter-list parens are found, not the annotation's.

**Impact:** Multi-line `@Autowired`-with-arguments setters now resolve correctly; previously they produced zero relations.

## Real improvement: multi-declarator fields

The old regex implementation silently dropped both declarators in multi-declarator injection fields entirely (both `a` and `b` in `Type a, b;` were lost). The AST migration detects both as injection points, though without the qualifier value. This is a genuine correctness improvement.

## Verified: regression testing, Phase 2 benchmark

**Test suite:** All 30 target tests pass (5 new, 25 pre-existing); broader regression suite 146 tests all green.

**Real-repository benchmark (`npm run benchmark:v14-phase2`):**

| Metric | Result |
|---|---|
| Oracle bean total | 35 |
| Matched | 35 |
| False positives | 0 |
| Dependency linkage recall | 100% |
| Dependency linkage precision | 100% |
| Spring petclinic (ctor/field/setter) | 6/0/0 matched |
| Petclinic-rest (ctor/field/setter) | 28/1/0 matched |

Byte-for-byte identical to committed baseline — zero regression. No commit needed for Task 2 (benchmark verification).

## Next phase: Phase 2 candidate extractors

Three enterprise extractors are candidates for AST migration in the next phase:
- Spring MVC routes extraction (`@RequestMapping`, `@PostMapping`, etc.)
- `@Transactional` boundary detection
- JPA/Spring Data repository query detection (`@Query`, derived queries, relationship annotations)

Phase 2 will be scoped, designed, and prioritized separately.
