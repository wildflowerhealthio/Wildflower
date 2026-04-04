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
