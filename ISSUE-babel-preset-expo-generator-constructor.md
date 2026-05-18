# `function*` generator functions end up with `.constructor !== GeneratorFunction` under babel-preset-expo + Hermes bytecode

## Summary

In an Expo SDK 54 app running on Hermes (bytecode), some `function*` declarations end up at runtime with a `.constructor` that is **not** reference-equal to the realm's `GeneratorFunction` constructor:

```js
const f = function* () {}
const cap = function* () {}.constructor

f.constructor === cap // expected true — but observed false in our app
f.constructor.name // "GeneratorFunction"
cap.name // "GeneratorFunction"
```

This breaks any library that uses `.constructor === GeneratorFunction` reference identity to detect generator functions — e.g. `effect`'s `Effect.fn` (see [related issue](#) — Effect's `isGeneratorFunction`).

## Impact

When `effect`'s `Effect.fn(name)(genFn, ...pipeables)` is called with `genFn = function*() {...}`:

1. `isGeneratorFunction(genFn)` → `false` (identity check fails)
2. `Effect.fn` takes the non-generator branch and invokes `genFn()` directly, getting back a raw `Generator`
3. The `Generator` flows through subsequent operators (`Effect.withPerformanceMeasure`, `Effect.acquireUseRelease`, …) and is eventually passed to the Effect runtime, which crashes with `RuntimeException: Not a valid effect: {}`.

The crash is hard to debug because the runtime stack lands deep inside `fiberRuntime`'s op dispatch and `JSON.stringify(<Generator>)` is `{}` (no enumerable own properties), so the error message gives no clue about the offending value.

## Reproducer

A minimal in-app probe shows the discrepancy:

```ts
const f = function* () {}
const captured = function* () {}.constructor
console.log({
  identityEqual: f.constructor === captured,
  fName: f.constructor.name,
  capName: captured.name,
})
```

In a vanilla Node or Chrome environment, `identityEqual` is `true`. In our Expo / Hermes / bytecode build it is `false` — at least for the generator functions inside `@livestore/common@0.4.0-dev.26`'s `Effect.fn(...)` call sites.

## Environment

- Expo SDK 54
- `babel-preset-expo: ~54.0.10`
- React Native 0.81.5 with Hermes + bytecode (`transform.engine=hermes&transform.bytecode=1&unstable_transformProfile=hermes-stable`)
- Metro bundler (Expo default config)
- `babel.config.js`:
  ```js
  module.exports = (api) => {
    api.cache(true)
    return {
      presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
      plugins: ['babel-plugin-transform-vite-meta-env', '@babel/plugin-syntax-import-attributes'],
    }
  }
  ```

## Open questions

1. Is `babel-preset-expo` running `@babel/plugin-transform-regenerator` (or similar) against `function*` declarations even though Hermes natively supports generators? If so, can it be disabled for Hermes targets?
2. Is `unstable_transformProfile=hermes-stable` intended to leave generators untransformed? If so, why is the constructor identity diverging?
3. Could Metro be bundling two copies of a module that captures `GeneratorFunction` separately at init time (so different modules see different "captured" constructors)?

## Workaround we applied

We patched `effect@3.21.2` locally to make `isGeneratorFunction` fall back to a name check, and to defensively wrap any `Generator` that `body.apply()` returns inside `fnApply`:

```diff
-export const isGeneratorFunction = u =>
-  isObject(u) && u.constructor === genConstructor
+export const isGeneratorFunction = u =>
+  isObject(u) && (
+    u.constructor === genConstructor ||
+    (u.constructor && u.constructor.name === 'GeneratorFunction')
+  )
```

This resolves the visible crash, but the underlying constructor-identity discrepancy is the real bug.

## Why this matters

- Any third-party library that uses `u.constructor === GeneratorFunction` (an idiomatic and widely-used check) will silently miss generator functions in Hermes/Expo apps.
- The failure mode is typically **silent + delayed**: the misclassified generator runs as a regular function, returns a `Generator` object, that object survives several function passes, and only crashes much later — making the root cause invisible without library-level instrumentation.

## Related

- Reported separately against `effect`: [`Effect.fn` misclassifies generator functions](./ISSUE-effect-isGeneratorFunction.md). The fix on the Effect side is a strict superset of the workaround above; this issue is about the toolchain producing surprising `.constructor` identities in the first place.
