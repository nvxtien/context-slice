# Context composition

A preview is built around one target symbol. Composition decides what else belongs in the slice, and what does not.

Measured behaviour: [benchmarks/results/v1.2-context-composition.md](../benchmarks/results/v1.2-context-composition.md).

## Order

```text
task target
  ↓ direct callers
  ↓ direct callees
  ↓ same-enclosing-type composition
```

Callers and callees are chosen first, so composition can only use budget they left. Within composition, candidates are ordered by evidence score.

## Same-type expansion

A member of the target's enclosing type is included only with structural evidence:

| Reason                   | Evidence                                                                      | What is included                       |
| ------------------------ | ----------------------------------------------------------------------------- | -------------------------------------- |
| `same-type shared state` | the target and the sibling read or write the same field                       | the sibling, and the field declaration |
| `state accessor`         | the sibling is a getter or setter for a field the target touches              | the accessor                           |
| `constructor dependency` | the constructor supplies a field the target uses                              | the constructor declaration line       |
| `lexical shared state`   | the target and a sibling closure use the same local of the enclosing function | the sibling closure                    |
| `enclosing type`         | the target is a member of a type                                              | declaration lines only, never bodies   |

Shared state is read syntactically: `this.member` in both languages, plus bare member names in Java. There is no alias or data-flow analysis, so a field reached only through an intermediate object is not detected.

A sibling that shares nothing with the target is never included. That is the point: an unrelated method in the same class costs tokens and teaches the assistant nothing about the task.

## The enclosing-type skeleton

For a member target, the slice carries a skeleton of its type: the type's own declaration line, its field declarations, and up to 12 member declaration lines, with the remainder reported as a count. No member body comes from the skeleton, and members already in the slice are not repeated.

This is what tells you that `build()` exists next to `apply()`, without sending either body.

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

- Syntactic evidence only. A sibling that shares state through a helper object, a closure passed elsewhere, or reflection is not detected.
- Java fields are read from the enclosing type's source for analysis; they are not indexed as symbols, so they never appear in search results, and a Java skeleton lists fields plus methods but no nested type members.
- The skeleton caps at 12 member declaration lines. A very large class reports the rest as a count rather than listing it.
- Composition looks one level out: the enclosing type or function. It does not walk up to outer classes or across files.
- In the 15 Java tasks, composition recovered no required fact because Java recall was already complete; it costs those slices about 0.6 percentage points of context reduction.
