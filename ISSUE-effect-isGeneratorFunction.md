# `Effect.fn` misclassifies generator functions under Hermes (constructor reference identity fails)

## Summary

`Effect.fn(name)(genFn, ...pipeables)` and the underlying `isGeneratorFunction` helper in `effect/Utils.ts` use **reference identity** to decide whether a function is a generator:

```ts
const genConstructor = function* () {}.constructor
export const isGeneratorFunction = (u) => isObject(u) && u.constructor === genConstructor
```

In a React Native + Hermes (bytecode) environment, generator functions can have a `.constructor` whose **name is `"GeneratorFunction"`** but whose **reference is not equal** to the `genConstructor` captured at module init. The check therefore returns `false`, `fnApply` takes the wrong branch, and the bare `Generator` instance — not an `Effect` — flows through the rest of the pipeline.

## Symptom

Eventually the runtime tries to evaluate a `Generator` as an Effect and dies with:

```
RuntimeException: Not a valid effect: {}
```

…thrown from `fiberRuntime`'s `dieMessage` call. The `{}` is `JSON.stringify(<Generator>)` (a Generator object has no enumerable own properties).

## Mechanism (traced)

1. User code in `@livestore/common` defines `Effect.fn(name)(function*() {...}, Effect.withPerformanceMeasure(name))`.
2. When invoked, `fnApply` runs:
   ```ts
   if (isGeneratorFunction(options.body)) {
     effect = core.fromIterator(() => options.body.apply(options.self, options.args))
   } else {
     effect = options.body.apply(options.self, options.args) // ← taken in error
   }
   ```
3. Because `isGeneratorFunction` returns `false`, `effect` is now a raw `Generator`.
4. The pipeable `withPerformanceMeasure(label)` wraps it:
   ```ts
   Effect.acquireUseRelease(
     start,
     () => effect /* Generator */,
     () => end
   )
   ```
5. `acquireUseRelease` later calls `restore(use(a))` → `interruptible(<Generator>)` → constructs an `OP_UPDATE_RUNTIME_FLAGS` Effect whose `effect_instruction_i1` returns the `Generator`.
6. The fiber runtime evaluates that op, sets `cur = Generator`, and the next iteration's `cur[EffectTypeId]._V` access throws `TypeError: Cannot read property '_V' of undefined`. The catch in `runLoop` checks `_op in this` (false), falls into `dieMessage`, and the user sees the cryptic crash.

## Repro environment

- `effect@3.21.2`, `@effect/platform@0.96.1`
- `@livestore/livestore@0.4.0-dev.26` (uses `Effect.fn(name)(genFn, Effect.withPerformanceMeasure(name))` at `@livestore/common/dist/leader-thread/rematerialize-from-eventlog.js:8`)
- React Native 0.81.5 with Hermes + bytecode (`transform.engine=hermes&transform.bytecode=1&unstable_transformProfile=hermes-stable`)
- Expo SDK 54, `babel-preset-expo@~54.0.10`
- Metro bundler (Expo default config)

Mounting any LiveStore-backed component (`useStore({ adapter, ... })`) reliably triggers the crash on iOS dev builds.

## Diagnostic snippet that confirms the cause

When we patch `isGeneratorFunction` to log misses where the constructor name is still `"GeneratorFunction"` but the identity check fails, we observe exactly that case for generator functions inside `@livestore/common`. When we additionally patch `fnApply`'s else-branch to wrap any `Generator` returned by `body.apply()` via `fromIterator`, the crash disappears.

Minimal probe equivalent (not a fix, just for confirmation):

```ts
export const isGeneratorFunction = (u) => {
  const result = isObject(u) && u.constructor === genConstructor
  if (!result && typeof u === 'function' && u.constructor?.name === 'GeneratorFunction') {
    console.warn('[effect] isGeneratorFunction miss', {
      ctorEqual: u.constructor === genConstructor,
      ctorName: u.constructor.name,
      capturedName: genConstructor.name,
    })
  }
  return result
}
```

## Suggested fix

Make `isGeneratorFunction` resilient to host-environment quirks by falling back to a name check:

```ts
const genConstructor = function* () {}.constructor

export const isGeneratorFunction = (u) =>
  isObject(u) &&
  (u.constructor === genConstructor ||
    (u.constructor != null && u.constructor.name === 'GeneratorFunction'))
```

Optionally, also defend `fnApply` so that an undetected generator function returning a native `Generator` is still wrapped instead of leaking into the pipeline:

```ts
} else {
  try {
    effect = options.body.apply(options.self, options.args)
    if (
      effect != null &&
      typeof effect === 'object' &&
      effect.constructor === (function* () {})().constructor
    ) {
      const gen = effect
      effect = core.fromIterator(() => gen)
    }
  } catch (error) { ... }
}
```

Either change alone resolves the crash in our environment; together they're defense-in-depth.

## Open question

We have not yet root-caused **why** Hermes produces a `.constructor` reference that fails identity with the realm's captured `GeneratorFunction`. Candidates:

- Babel transform of `function*` producing a wrapper whose `.constructor.name` is still `"GeneratorFunction"` but is a distinct object
- A Hermes module/realm quirk where intrinsics are duplicated between modules
- Metro bundling effect at two paths (ESM + CJS) and each captures its own `genConstructor`

Regardless of the root cause, `isGeneratorFunction` is too strict — a name-based fallback is a defensible improvement.
