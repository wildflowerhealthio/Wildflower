import { Arbitrary, Either, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { expect } from 'vite-plus/test'

/**
 * Arbitrary over the decoded slots of one choice element (`value[x]`,
 * `effective[x]`, …) that populates at most one of them — the only shapes
 * `filterForExclusiveChoiceElementSet` lets through. Each field schema must accept
 * `null` (e.g. `Schema.NullOr(Period.Schema)`); every slot but the chosen one
 * is set to `null`, and choosing index `fields.length` leaves them all `null`.
 */
const atMostOnePopulatedSlot = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Struct.Type<Fields>> =>
  fc
    .tuple(
      Arbitrary.make(Schema.Struct(fields)),
      fc.integer({ min: 0, max: Object.keys(fields).length })
    )
    .map(
      ([record, keep]) =>
        Object.fromEntries(
          Object.entries(record).map(([key, value], index) => [key, index === keep ? value : null])
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries widens to Record<string, unknown>; every key comes from `record` and each value is either its own or `null`, which every field schema accepts.
        ) as Schema.Struct.Type<Fields>
    )

/**
 * Arbitrary over two or more of a choice element's slots, each paired with a
 * non-null decoded value — the shapes `filterForExclusiveChoiceElementSet`
 * rejects. Each field schema is the slot's non-null decoded type (e.g.
 * `Period.Schema`, not `Schema.NullOr(Period.Schema)`).
 */
const atLeastTwoPopulatedSlots = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<readonly (readonly [keyof Fields & string, unknown])[]> =>
  Arbitrary.make(Schema.Struct(fields)).chain((values) =>
    fc.subarray(
      // Object.entries widens keys to `string`; every key comes from `values`, a
      // struct over exactly `fields`.
      Object.entries(values) as [keyof Fields & string, unknown][],
      { minLength: 2 }
    )
  )

/**
 * Asserts `result` failed with the at-most-one issue for the `prefix[x]`
 * choice element, naming the count and every populated slot in `slots`.
 */
const expectChoiceElementGuardFailure = (
  result: Either.Either<unknown, ParseResult.ParseError>,
  prefix: string,
  slots: readonly (readonly [string, unknown])[]
): void => {
  const message = Either.match(result, {
    onLeft: (error) => error.message,
    onRight: () => 'succeeded without error',
  })
  expect(message).toContain(
    `choice element ${prefix}[x] allows at most one populated slot, but found ${slots.length}:`
  )
  for (const [key] of slots) expect(message).toContain(key)
}

export { atLeastTwoPopulatedSlots, atMostOnePopulatedSlot, expectChoiceElementGuardFailure }
