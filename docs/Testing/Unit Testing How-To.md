# Unit Testing How-To

Case-based tests for specific scenarios: regressions, documentation, error paths, and domain rules. For property-based testing, see [Property Testing Reference](./Property%20Testing%20Reference.md).

## When to Write Cases

- **Reproducing a bug** — pin the exact input that triggered it
- **Documenting behavior** — show a human-readable example of how an API works
- **Testing error paths** — specific invalid inputs that should fail in specific ways
- **Domain rules** — business logic with a finite, enumerable set of states (e.g., status transitions, permission checks)

If you find yourself writing more than ~5 cases for the same function, consider a property test instead.

## Writing Clear Cases

Each test name should state the scenario and expected outcome. A failing test name alone should tell you what broke.

```typescript
describe('parseDate', () => {
  it('parses ISO 8601 date strings', () => {
    /* ... */
  })
  it('returns None for empty strings', () => {
    /* ... */
  })
  it('returns None for malformed dates', () => {
    /* ... */
  })
})
```

Avoid generic names like "works correctly" or "handles edge cases". Name the edge case.

## `it.each` for Tabular Cases

When multiple inputs share the same assertion logic, use `it.each`:

```typescript
it.each([
  { input: '2024-01-15', expected: { year: 2024, month: 1, day: 15 } },
  { input: '2024-12-31', expected: { year: 2024, month: 12, day: 31 } },
  { input: '2024-02-29', expected: { year: 2024, month: 2, day: 29 } },
])('parses "$input" correctly', ({ input, expected }) => {
  expect(parseDate(input)).toEqual(expected)
})
```

Use named object fields over positional tuples. Include the varying value in the test name with `$input` interpolation. When rows start needing different assertion logic, split into separate `describe` blocks.

## MECE Test Structure

Structure test suites to be **Mutually Exclusive, Completely Exhaustive**:

- Identify the edges of behavior
- Use nested `describe` blocks to delineate boundaries
- Ensure every possible state falls into exactly one bucket

## Testing Effects

Use stubbed contexts to run Effects with known inputs:

```typescript
const exit = await Effect.runPromiseExit(program)
expect(Exit.isFailure(exit)).toBe(true)
const error = pipe(exit, Exit.causeOption, Option.flatMap(Cause.failureOption), Option.getOrThrow)
expect(error._tag).toBe('SomeError')
```

## FHIR Resource Testing

### Compile-Time FHIR Check

```typescript
import { Composition } from './Composition'
import type { Composition as FhirComposition } from 'fhir/r4.d.ts'

// Compile-time check: Encoded schema must match FHIR R4 type
const _check: DeepReadonly<FhirComposition> = Composition.Encoded
```

### Round-Trip Property

```typescript
const compositionArb = Arbitrary.make(Composition)

fc.assert(
  fc.property(compositionArb, (val) => {
    const encoded = Schema.encodeSync(Composition)(val)
    const decoded = Schema.decodeSync(Composition)(encoded)
    expect(decoded).toEqual(val)
  })
)
```
