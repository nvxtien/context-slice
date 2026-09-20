# Context composition

A preview is built around one target symbol. Composition decides what else belongs in the slice, and what does not.

Measured behaviour: [benchmarks/results/v1.2-context-composition.md](../benchmarks/results/v1.2-context-composition.md).

## Order

```text
task target
  ↓ direct callers
  ↓ direct callees
  ↓ enclosing-type skeleton
```

Callers and callees are chosen first, so composition can only use the budget they left.

## The enclosing-type skeleton

For a member target, the slice carries a skeleton of its type: the type's own declaration line, its field declarations, and up to 12 member declaration lines, with the remainder reported as a count. No member body comes from the skeleton, and members already in the slice are not repeated.

This is what tells you that `build()` exists next to `apply()`, without sending either body.

Java fields are read from the enclosing type's source for this purpose. They are not indexed as symbols, so they never appear in search results.

## Budget

Composition may use at most **35%** of the token budget. Sibling context fills spare capacity; it never displaces the target, its callers or its callees. When a candidate does not fit, it is reported in `omitted` with the reason `composition budget share`, alongside the ordinary `context budget` omissions.

Whole-class inclusion is not a fallback. If a required detail is not reachable under the budget, the slice stays small and says what it left out.

## Explaining a slice

`--explain` shows each composed item with its evidence:

```text
- state accessor: Cart.getTotal — getTotal reads total, also used by add
- same-type shared state: Cart.total — target writes total
- enclosing type: Cart — add is declared in Cart; declaration lines only, 4 of 4 members
```

Normal output stays compact; evidence appears only in explain or JSON mode.

## Limitations

- The skeleton caps at 12 member declaration lines. A larger type reports the rest as a count.
- Composition looks one level out, to the enclosing type, and never across files or into outer types.
- Declaration lines only: if a required detail lives inside a sibling's body, the slice does not carry it.
- Earlier drafts also composed siblings by shared field/local state (accessors, constructor dependencies, closures). Measured across 30 benchmark tasks they recovered no required fact and cost tokens, so they were removed. The benchmark report keeps the numbers.
