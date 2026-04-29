# Doc Comments Reference

Quick-lookup for writing TSDoc comments in this codebase. Enforced via `eslint-plugin-tsdoc`. For background on documentation philosophy, see the [Documentation Explanation](./Explanation.md).

## When to Write a Doc Comment

Every exported symbol should have a doc comment. Internal helpers benefit from one when their name alone doesn't explain _why_ they exist or _what_ contract they enforce.

## Section Ordering

A comment has up to four sections. **The order matters** — these docs are primarily consumed through IDE hover windows and by AI agents, so the most immediately useful information must come first:

1. **Summary** — the first paragraph (before any blank line). One or two sentences: _what is this, am I looking at the right code?_ For a simple function or value, this may be all that's needed.
2. **`@typeParam` / `@param` / `@returns`** — the contract. Enough detail to call the function correctly. The reader has just read the summary, so these can trust that context rather than restating it.
3. **`@remarks`** — theory, rationale, edge cases, invariants. Speak in terms of the params and return value defined above. This section is for readers who need to understand _why_, not just _how to call it_.
4. **`@example`** — runnable code showing typical usage.

This ordering front-loads what matters most in a hover tooltip: _what is it?_ then _how do I use it?_ then _why does it work this way?_

### Short Comment (Summary Only)

```ts
/** Displays a participant's username with a "(you)" suffix for the local user. */
```

### Full Comment

````ts
/**
 * Narrows `value` with a type-guard, failing the Effect when the guard
 * returns false.
 *
 * @typeParam AIn - The input type before narrowing
 * @typeParam AOut - The narrowed output type (must extend `AIn`)
 * @typeParam E - The error produced on predicate failure
 * @param cond - Type-guard predicate that narrows `AIn` to `AOut`
 * @param makeErr - Constructor called with the original value on failure
 * @returns A pipeable function `(val: AIn) => Effect<AOut, E>`
 *
 * @remarks
 * This is the foundational predicate-based refinement used across the
 * domain layer. It bridges TypeScript's type-narrowing with Effect's
 * error channel — a guard failure becomes a typed `E` in the Effect,
 * not a thrown exception.
 *
 * Prefer {@link Effect.liftPredicate} for new code (see `@deprecated`).
 *
 * @example
 * ```ts
 * pipe(
 *   unknownVal,
 *   refineOrFail(
 *     isString,
 *     (a) => new DataIntegrityError({ message: `Expected string, got ${typeof a}` })
 *   )
 * )
 * ```
 */
````

### When the Comment Is Bigger Than the Code

That's fine. A small type alias or utility with many subtle edge cases (e.g. `DeepReadonly`) justifies a hefty `@remarks` block. The comment is the documentation — if the gotchas are real, document them.

## Tag Reference

### Parameters, Types, and Return Values

| Tag                      | Use for                    | Example                                    |
| ------------------------ | -------------------------- | ------------------------------------------ |
| `@typeParam Name - desc` | Generic type parameters    | `@typeParam E - The error type on failure` |
| `@param name - desc`     | Function/method parameters | `@param cond - Type-guard predicate`       |
| `@returns desc`          | Return value semantics     | `@returns A Promise suitable for use()`    |

Write `@param` and `@returns` whenever the meaning is non-obvious from the name and summary. Prefer trusting the reader's understanding of the summary over being overly verbose — describe _meaning_, not type signatures the reader can already see.

### Complex Return Values

When a function returns a tuple or object with multiple fields, describe each field in the `@returns` block. Use markdown lists:

```ts
/**
 * A controllable promise whose resolution can be driven imperatively.
 *
 * @typeParam A - The type the promise resolves to
 * @returns A tuple `[promise, callbacks]` where:
 *   - `promise` — the current `Promise<A>`, stable until `reset`
 *   - `callbacks.resolve(a)` — resolves the promise (applies queued maps),
 *     or replaces an already-settled promise with a new resolved one
 *   - `callbacks.reject(reason)` — rejects similarly
 *   - `callbacks.reset()` — replaces a settled promise with a fresh pending one
 *   - `callbacks.map(f)` — transforms the resolved value, or queues `f` if pending
 *
 * @remarks
 * This is the low-level primitive behind {@link useEffectTs} and
 * {@link useStream}. The `map` callback composes transformations that
 * are applied atomically at resolve time, enabling optimistic-update
 * patterns without re-creating the promise identity.
 */
```

### Options Objects

When a function accepts an options bag (an object parameter with multiple optional fields), extract a named `interface` and document its properties there instead of using nested `@param` tags. This keeps the function's doc comment focused on _what the function does_ while letting the interface document _what each option means_:

```ts
/**
 * Options for {@link safeDebugString}.
 */
export interface SafeDebugStringOptions {
  /** Maximum character length before truncation (default: 2000). */
  maxLength?: number
  /** Number of spaces for JSON indentation (default: 2). */
  indent?: number
}

/**
 * Safely converts an unknown value to a human-readable debug string.
 *
 * @param value - The value to represent as a debug string
 * @param options - Optional configuration for the output
 * @returns A string representation suitable for error messages and logging
 */
export const safeDebugString = (
  value: unknown,
  options?: SafeDebugStringOptions
): string => { … }
```

Why: TSDoc's `@param options.maxLength` syntax is non-standard and not supported by `eslint-plugin-tsdoc`. A named interface gives each property its own doc comment, renders correctly in IDE hover tooltips, and is reusable if multiple functions share the same shape.

Name the interface `{FunctionName}Options` (PascalCase) and place it immediately above the function it belongs to. Use `{@link fn}` in the interface's summary to cross-reference the consumer.

### Linking and Cross-Referencing

Use `{@link Symbol}` to reference in-project symbols inline. Use `@see` on its own line for related-reading pointers:

| Tag              | Use for           | Example                                                    |
| ---------------- | ----------------- | ---------------------------------------------------------- |
| `{@link Symbol}` | In-project symbol | `{@link LoadedResult}`                                     |
| `@see`           | Related reading   | `@see {@link LoadedResultStream} for the reactive variant` |

Reference external packages with backtick-quoted names (e.g. `` `@daily-co/daily-react` ``) or a `@see` with a URL.

### Deprecation

Mark deprecated symbols with `@deprecated` and a concrete before/after migration:

````ts
/**
 * @deprecated Use {@link Effect.liftPredicate} instead:
 * ```ts
 * // Before
 * pipe(val, refineOrFail(isString, (a) => new MyError(a)))
 * // After
 * Effect.liftPredicate(val, isString, (a) => new MyError(a))
 * ```
 */
````

### Events and Implicit State

Document event subscriptions and non-prop state sources directly in the summary and `@remarks`. Mention the provider in the summary so it's visible on hover; detail specific events in `@remarks`:

```ts
/**
 * Main video call view. Global call state is provided by
 * `@daily-co/daily-react`.
 *
 * @remarks
 * Listens for `camera-error` via `useDailyEvent` — sets an error flag
 * that replaces the call UI with {@link UserMediaError}.
 */
```

### Type-Level Constructs

Use `@typeParam` to describe each type parameter on exported types, classes, and functions:

```ts
/**
 * Raised when a requested resource cannot be located.
 *
 * @typeParam ResourceType - A string literal identifying the kind of resource
 * @typeParam Parameters - The lookup parameters that failed to match
 */
```

### File-Level Documentation

Use `@packageDocumentation` at the top of package entry points to describe the module as a whole:

```ts
/**
 * SVG icon components for the call tray UI. Each renders a 24x24 SVG.
 * "Off" variants use a red fill to indicate disabled state.
 *
 * @packageDocumentation
 */
```

For non-entry-point files that export a cohesive group, a plain block comment at the top is sufficient.

## Describing Non-Prop State Sources

React components often derive state from hooks, context, or event subscriptions rather than props. **Mention these in the summary** so readers understand where data comes from without reading the implementation.

Good:

```ts
/**
 * Bottom control bar for an active call. Global call state is provided by
 * `@daily-co/daily-react`.
 *
 * @remarks
 * Listens for `app-message` events via `useAppMessage` — highlights
 * the chat icon when a remote participant sends a message.
 */
```

Bad (state sources invisible):

```ts
/** Bottom control bar for an active call. */
```

## Markdown in Comments

Use markdown freely — these docs are viewed in hover windows that render it, and edited by AI agents that parse it. **Bold**, lists, backtick-quoted code, and tables all help readability.

## Style Rules

1. **Lead with _what_, not _how_** — "Adapts a SubscriptionRef into a Subscribable" beats "Calls Subscribable.make and pipes through StreamEither.unwrap".
2. **Be precise about edge cases** — If a type only treats `number | string | symbol` as primitives, say that, not "primitives".
3. **Don't repeat the type signature** — `@param id - string` adds nothing when the signature already says `id: string`. Describe _meaning_ instead: `@param id - Daily.co session ID of the participant`.
4. **Use `@deprecated` with migration code** — A deprecation notice without a replacement is not actionable.
5. **Front-load the contract** — `@typeParam`, `@param`, `@returns` come before `@remarks` so hover tooltips show the most useful information first.
6. **Trust the summary** — Param descriptions can reference concepts introduced in the summary without re-explaining them.
7. **`@remarks` speaks in terms of the params** — By this point the reader knows the inputs and outputs. Explain _why_, not _what_.
8. **Big comments on small code are fine** — A small utility with many gotchas justifies a long `@remarks`.

## Differences from JSDoc

This project uses [TSDoc](https://tsdoc.org/) rather than JSDoc. Key differences:

| JSDoc                  | TSDoc equivalent                                |
| ---------------------- | ----------------------------------------------- |
| `@template`            | `@typeParam`                                    |
| `@module`              | `@packageDocumentation`                         |
| `@description`         | First paragraph (summary) + `@remarks`          |
| `@summary`             | First paragraph (automatic)                     |
| `{@link external:pkg}` | Backtick-quoted package name or `@see` with URL |
| `@listens` / `@fires`  | Describe in summary and `@remarks`              |
| `@default`.            | Use `@defaultValue`                             |

The `eslint-plugin-tsdoc` rule (`tsdoc/syntax: warn`) flags non-standard tags automatically.
