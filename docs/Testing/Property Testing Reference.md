# Property Testing Reference

Property-based testing is the default approach. Describe the general properties of your code rather than checking specific input/output pairs. Use example-based tests only for regression testing or documentation.

Reference implementation: `global/util/src/StreamEither.test.ts`

## Opaque Arbitraries

Generate opaque, branded values instead of concrete data. This forces tests to verify structural relationships (provenance, identity) rather than relying on specific values.

```typescript
type A = unknown & Brand.Brand<'A'>
const arbitraryA: fc.Arbitrary<A> = fc.anything().map((a) => vi.mockObject(a) as A)
```

Compose arbitraries to match the shape your code consumes:

```typescript
const eitherArb = fc.oneof(arbitraryA.map(Either.right), arbitraryE.map(Either.left))
const streamEitherArb = fc.array(eitherArb).map(Stream.fromIterable)
```

For FHIR resources and Effect Schemas, use `Arbitrary.make(Schema)` instead.

## Verified Mocks

Use `vi.fn` implementations that embed their input in the output. This lets you assert provenance — that a specific output came from a specific input — without knowing what the input was ahead of time.

```typescript
const f = vi.fn((a: A) => Effect.succeed({ mappedFrom: a }))
```

Then assert the chain: `f` was called with the input, and the output references it.

```typescript
expect(f).toHaveBeenCalledWith(input.right)
expect(out.right.mappedFrom).toBe(input.right) // referential identity
```

Use `.toBe` for provenance (same reference), `.toEqual` for preserved passthrough values.

## Apply-and-Collect Pattern

For stream or collection transformations, zip inputs with outputs and assert per-element:

```typescript
const applyAndCollect = <A, B>(
  inputStream: Stream.Stream<A>,
  transformation: (s: Stream.Stream<A>) => Stream.Stream<B>
): Effect.Effect<readonly [A, B][]> =>
  Effect.gen(function* () {
    const inputs = yield* collect(inputStream)
    const outputs = yield* collect(transformation(inputStream))
    return inputs.map((a, i) => [a, outputs[i]] as [A, B])
  })
```

## MECE Assertion Chains

For each input/output pair, enumerate every valid case and fail on anything else. Every element must fall into exactly one branch.

```typescript
for (const [input, out] of cases) {
  if (Either.isRight(input) && Either.isRight(out)) {
    expect(f).toHaveBeenCalledWith(input.right)
    expect(out.right.mappedFrom).toBe(input.right)
  } else if (Either.isLeft(input) && Either.isLeft(out)) {
    expect(input.left).toEqual(out.left)
  } else {
    assert.fail('Input and output should both be Left or both be Right')
  }
}
```

The `assert.fail` branch makes the exhaustiveness check explicit.

## Describe Blocks for Input Classes

When behavior depends on a parameter (e.g., whether `f` succeeds or fails), use separate `describe` blocks with tailored mocks:

```typescript
describe('mapEffect', () => {
  describe('with an effectful function that succeeds', () => {
    it.effect.prop('...', { stream: streamEitherArb }, ({ stream }) =>
      Effect.gen(function* () {
        const f = vi.fn((a: A) => Effect.succeed({ mappedFrom: a }))
        // ...
      })
    )
  })
  describe('with an effectful function that fails', () => {
    it.effect.prop('...', { stream: streamEitherArb }, ({ stream }) =>
      Effect.gen(function* () {
        const f = vi.fn((a: A) => Effect.fail({ mappedFrom: a }))
        // ...
      })
    )
  })
})
```

## Algebraic Properties

When applicable, test for mathematical truths:

- **Round-tripping:** `decode(encode(x)) === x` — the gold standard for schemas
- **Idempotence:** `f(f(x)) === f(x)`
- **Invariants:** "the list size never decreases", "the total remains constant"
- **Helper identity:** `get(with(x, val)) === val`

## Use raw `fast-check`, not `@fast-check/vitest`

`@fast-check/vitest`'s `it.prop(...)` is broken under Vite+ — it registers tests against the `vitest` package's runner instance, a different module instance than `vite-plus/test`'s, so collection dies with `Error: Vitest failed to find the current suite. This is a bug in Vitest.` (it isn't; it's the same dual-runner mismatch that breaks `@effect/vitest`). The `/javascript-testing-expert` skill's appendix recommends `@fast-check/vitest` — do not follow it on this repo.

The convention that works: import raw `fast-check`, write properties inside a normal `test(...)`/`it(...)`, and pass `numRuns` from `numRunsFor`. This is also what lets `test:changed` scale runs down.

```typescript
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { expect, test } from 'vite-plus/test'

test('property: every encoded value decodes back to itself', () => {
  fc.assert(
    fc.property(arb, (value) => {
      expect(Schema.decodeSync(S)(Schema.encodeSync(S)(value))).toEqual(value)
    }),
    { numRuns: numRunsFor({ base: 100 }) }
  )
})
```

Use `fc.asyncProperty` + `await fc.assert(...)` for effectful bodies. Canonical shape: [`effect-messaging-core/src/logging.test.ts`](../../global/effect-messaging/effect-messaging-core/src/logging.test.ts).

## Never hardcode `numRuns` — always `numRunsFor({ base })`

Pass every property's iteration count through `numRunsFor` from `kitchen-sink/test`, never a bare `{ numRuns: 100 }`. `numRunsFor({ base, minimum? })` resolves a per-package multiplier at call time so `vp run test:changed` can scale unchanged packages down without editing test source.

How the scaling resolves:

- `test:changed` sets `FC_RISK_MAP` from `scripts/risk-map.ts` — a `{ <pkgName>: <multiplier> }` map. Packages reachable from a change get ×1.0; everything else gets ×0.2 (floored at 10). Plain `vp test` leaves `FC_RISK_MAP` unset, so `base` is used as-is.
- `numRunsFor` identifies the calling package from the **test file's own path** (via Vitest's `expect.getState().testPath`, with a call-stack fallback), resolved per call. It does **not** use `process.cwd()`: under Vitest projects mode every worker's `cwd` is the monorepo root, so a `cwd`-based lookup silently never matched the risk map and the scaling was a no-op. Don't reintroduce a `cwd`-based package resolution.

## Keep property tests fast

`Arbitrary.make(WholeSchema)` walks the entire schema graph every iteration. For richly-linked schemas (FHIR resources: Reference→Identifier cycles, `CodeableConcept` with `Coding[]`, Element/Extension fan-out, JSON column encode/decode) the fan-out is untenable. Three levers, in order of impact:

- **Decompose by field.** Round-trip one field at a time instead of the whole schema — generate the field's content from the same component schema the struct embeds and spread it over a fixed shell value. Drove the (since-deleted) `emr-core` suite from 745s / 14 timeouts to ~78s / 0. Two viable variants: pick-only round-trip (fastest) and shell-spread + whole-schema round-trip (used in `fhir-r4` to keep wire-format coverage end-to-end).
- **Cap unbounded arrays for generation only.** `AnnotateArrayWithArbitrary({ maxLength: N })` (from `kitchen-sink/schema`) is a **test-only knob** — it only shapes `Arbitrary.make(...)`'s output; encode/decode behaviour and production array lengths are unchanged. Cap arrays whose size only matters for fan-out (e.g. `CodeableConcept.coding`, `Meta.security`/`tag`). Capping `CodeableConcept.coding` to `maxLength: 2` alone gave ~5× on every `CodeableConcept`-bearing test.
- **Don't normalise via `Arbitrary.make(...).map(v => decodeSync(S)(encodeSync(S)(v)))`.** It "fixes" `Schema.optional` fields that emit `undefined` from the arbitrary but get stripped on encode — at the cost of doubling every iteration's encode/decode work. Applied universally it tips other tests over their timeouts. Prefer a fixture-based test for the specific optional case, or constrain the field's arbitrary annotation.

### `Schema.pick(...)` and `Schema.suspend` — the sanctioned context cast

When a `Schema.Struct` has fields reaching `Schema.suspend(...)` (e.g. a Reference→Identifier cycle), `Schema.Struct.pick(...)` widens the result's `Context` parameter to `unknown` at the type level even though every column is no-context at runtime. `Schema.encodeSync`/`Schema.decodeSync` then fail to typecheck because they require `R = never`. In test files only, bridge the structural-vs-named-type mismatch with a cast plus an explanatory disable:

```typescript
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pick() widens R to unknown through Schema.suspend; runtime is no-context
const sub = WholeSchema.pick(name) as unknown as Schema.Schema.AnyNoContext
```

Use `as unknown as fc.Arbitrary<Pick<T, K>>` instead when the helper returns the Arbitrary. The runtime is correct; the cast only reconciles TS inference.
