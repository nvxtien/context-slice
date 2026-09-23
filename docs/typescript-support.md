# TypeScript and TSX support

ContextSlice indexes TypeScript and TSX with Tree-sitter. There is no tsserver, no TypeScript Compiler API and no project-system emulation: resolution is structural, and anything that cannot be established from syntax is reported as unresolved rather than guessed.

Measured behaviour is in [benchmarks/results/v1.1-typescript-support.md](../benchmarks/results/v1.1-typescript-support.md).

## Files

| Extension             | Behaviour                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `.ts`, `.mts`, `.cts` | Full indexing and call extraction                                                                   |
| `.tsx`                | Full indexing, plus JSX component references                                                        |
| `.d.ts`               | Declarations are indexed as API symbols and marked `declarationOnly`; they never produce call edges |

Ignored directories: `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.turbo`, `.cache`, `storybook-static`.

## Symbols

Indexed: classes, interfaces, type aliases, enums, namespaces, functions, methods, constructors, getters, setters, properties, and function-valued variables — both arrow functions and named function expressions, at any nesting depth.

Symbol identity is the file, the enclosing chain, the kind, the name and the parameter signature:

```text
src/services/order.ts::OrderService::method::create(CreateOrderInput)
src/utils/math.ts::function::calculateTotal(OrderItem[])
src/components/CheckoutButton.tsx::CheckoutButton::function::handleClick()
```

Identities never use source offsets, so they survive edits elsewhere in the file. A file's top-level statements (imports, configuration, route registration, side effects) are owned by a synthetic module symbol named after the file, so top-level calls are not lost.

Local variables that are not function-valued are only indexed at module level, so ordinary locals do not pollute search.

**Overloads.** Each overload signature is indexed separately and marked `overloadSignature`; the implementation is the call target. Signatures and implementation never collide.

**React.** A PascalCase function in a `.tsx` file that returns JSX is labelled `reactComponent`. The label is metadata only: nothing in retrieval or ranking depends on it, and no framework is special-cased.

## Imports and exports

Recorded per binding: module specifier, imported name, local alias, kind (named, default, namespace, side-effect) and type-only status.

Module resolution is deliberately smaller than Node's algorithm:

- relative specifiers, including `./x`, `../x`, directory `index` files and `.js` specifiers that mean `.ts`
- simple `tsconfig.json` `baseUrl` and `paths` aliases, including a single `*` wildcard
- anything else is an external package, recorded by package name

Re-exports and barrel files are followed, including `export { a as b } from "./m"` and `export * from "./m"`. Chains are followed with cycle protection, so mutually re-exporting barrels terminate and are reported instead of looping.

An alias that is configured but does not land on repository source is left unresolved. It is never reported as an external package, because that would hide a missing file.

Stylesheet and image imports (`.css`, `.scss`, `.svg`, …) are marked as assets and excluded from resolution metrics.

## Call resolution

| Kind               | Example                                          | Confidence                          |
| ------------------ | ------------------------------------------------ | ----------------------------------- |
| `same-file`        | `helper()` declared in the same file             | exact                               |
| `imported`         | `createOrder()` from `./order-api`               | exact                               |
| `aliased-import`   | `import { createOrder as makeOrder }`            | exact                               |
| `default-import`   | `import handler from "./order-api"`              | exact                               |
| `namespace-import` | `math.calculateTotal()`                          | exact                               |
| `this-member`      | `this.assertValid()`                             | exact                               |
| `declared-type`    | `const service: OrderService`, `this.repository` | exact, or probable for an interface |
| `constructor`      | `new OrderService()`                             | exact                               |
| `static`           | `OrderService.create()`                          | exact                               |
| `jsx-reference`    | `<OrderSummary />`                               | exact, separate edge kind           |
| `external-package` | `express()`, `useEffect()`                       | unresolved, package recorded        |

`await` does not change a call's meaning, and optional chaining (`service?.run()`) is preserved as a call without inventing a receiver type.

## What stays unresolved

By design, and reported rather than guessed:

- receivers whose type needs inference, such as `const x = factory(); x.run()`
- promise callbacks and other library-driven dispatch
- CommonJS `require` and `module.exports`, which are parsed safely but not resolved
- imports that leave the checked-out source, for example another package in a monorepo you have not checked out
- anything inside a `.d.ts` file, which declares an API and executes nothing

## Mixed repositories

Java and TypeScript coexist in one index. Each language resolves only its own call edges, symbol identities cannot collide across languages, and `context-slice status` reports the file count per extension. Cross-language calls are not resolved.

## Cache compatibility

The cache schema is `1.2.0` and records a language per file, symbol and call. Upgrading from an earlier version drops the old cache and rebuilds it on the next command, with nothing to delete by hand.

Downgrading to 1.0.0 or earlier requires deleting the cache first:

```sh
rm -rf .context-slice
```

Older versions predate the language column and will fail with an error until the directory is removed. A cache written by a different schema is never reinterpreted.

## Why no tsserver

In the v1.1 benchmark no required fact was lost because a type could not be inferred. Structural resolution covered every measured task, so a compiler service would add a heavy dependency and a project system without a measured benefit. The decision is recorded with its evidence in the benchmark report and should be revisited if that changes.
